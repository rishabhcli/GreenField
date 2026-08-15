/**
 * Commerce persistence: catalogue, customers, orders, payments, shipments.
 *
 * `applyEvent` is the only way an order's status changes. It runs SERIALIZABLE
 * and does four things atomically: reject a duplicate provider event, reject an
 * illegal transition, ignore a stale out-of-order event, and append the
 * immutable event row alongside the updated order. Every other path into the
 * orders table is additive detail, never a status change.
 */

import { z } from 'zod';
import {
  ConflictError,
  NotFoundError,
  ORDER_STATUSES,
  assertPaymentRoute,
  assertTransition,
  canTransition,
  isStaleTransition,
  maxRefundableMinor,
  newId,
  type Address,
  type OrderEventKind,
  type OrderStatus,
  type PaymentRoute,
  type ProductKind,
} from '@foundry/core';
import { getLogger, metrics } from '@foundry/obs';
import { exec, q, qMaybe, qOne, withRowLockTransaction, withSerializableTransaction, type DbClient, type DbPool, type Queryable } from '../pool.js';

/* -------------------------------------------------------------------------- */
/* Rows                                                                        */
/* -------------------------------------------------------------------------- */

const ProductRow = z.object({
  id: z.string(),
  company_id: z.string(),
  opportunity_id: z.string().nullable(),
  brand_id: z.string().nullable(),
  sku: z.string(),
  name: z.string(),
  kind: z.string(),
  description: z.string(),
  physical: z.unknown().nullable(),
  payment_route: z.string(),
  external_refs: z.record(z.string(), z.string()),
  price_minor: z.number(),
  currency: z.string(),
  compare_at_price_minor: z.number().nullable(),
  supplier_id: z.string().nullable(),
  landed_cost_model_id: z.string().nullable(),
  inventory_policy: z.string(),
  inventory_on_hand: z.number(),
  inventory_reserved: z.number(),
  status: z.string(),
  created_at: z.date(),
  updated_at: z.date(),
});

const CustomerRow = z.object({
  id: z.string(),
  company_id: z.string(),
  email: z.string().nullable(),
  phone_e164: z.string().nullable(),
  name: z.string().nullable(),
  external_refs: z.record(z.string(), z.string()),
  marketing_consent: z.record(z.string(), z.unknown()),
  total_orders: z.number(),
  lifetime_value_minor: z.number(),
});

const OrderRow = z.object({
  id: z.string(),
  company_id: z.string(),
  site_id: z.string().nullable(),
  order_number: z.string(),
  customer_id: z.string(),
  status: z.string(),
  payment_route: z.string(),
  currency: z.string(),
  subtotal_minor: z.number(),
  shipping_minor: z.number(),
  tax_minor: z.number(),
  discount_minor: z.number(),
  total_minor: z.number(),
  amount_paid_minor: z.number(),
  amount_refunded_minor: z.number(),
  shipping_address: z.unknown().nullable(),
  billing_address: z.unknown().nullable(),
  external_refs: z.record(z.string(), z.string()),
  attribution: z.record(z.string(), z.string()),
  supplier_reference: z.string().nullable(),
  three_pl_reference: z.string().nullable(),
  risk_level: z.string(),
  manual_review_reason: z.string().nullable(),
  placed_at: z.date().nullable(),
  paid_at: z.date().nullable(),
  shipped_at: z.date().nullable(),
  delivered_at: z.date().nullable(),
  created_at: z.date(),
  updated_at: z.date(),
});

const LineItemRow = z.object({
  id: z.string(),
  order_id: z.string(),
  product_id: z.string(),
  sku: z.string(),
  name: z.string(),
  quantity: z.number(),
  unit_price_minor: z.number(),
  subtotal_minor: z.number(),
  tax_minor: z.number(),
  discount_minor: z.number(),
  landed_unit_cost_minor: z.number().nullable(),
  fulfilled_quantity: z.number(),
  refunded_quantity: z.number(),
});

const PaymentRow = z.object({
  id: z.string(),
  company_id: z.string(),
  order_id: z.string(),
  provider: z.string(),
  external_id: z.string(),
  status: z.string(),
  amount_minor: z.number(),
  currency: z.string(),
  fee_minor: z.number().nullable(),
  net_minor: z.number().nullable(),
  payment_method_brand: z.string().nullable(),
  payment_method_last4: z.string().nullable(),
  risk_score: z.number().nullable(),
  risk_level: z.string().nullable(),
  captured_at: z.date().nullable(),
});

export type ProductRow = z.infer<typeof ProductRow>;
export type CustomerRow = z.infer<typeof CustomerRow>;
export type OrderRow = z.infer<typeof OrderRow>;
export type LineItemRow = z.infer<typeof LineItemRow>;
export type PaymentRow = z.infer<typeof PaymentRow>;

const ORDER_COLUMNS = `id, company_id, site_id, order_number, customer_id, status, payment_route, currency,
  subtotal_minor, shipping_minor, tax_minor, discount_minor, total_minor, amount_paid_minor,
  amount_refunded_minor, shipping_address, billing_address, external_refs, attribution,
  supplier_reference, three_pl_reference, risk_level, manual_review_reason, placed_at, paid_at,
  shipped_at, delivered_at, created_at, updated_at`;

const PRODUCT_COLUMNS = `id, company_id, opportunity_id, brand_id, sku, name, kind, description, physical,
  payment_route, external_refs, price_minor, currency, compare_at_price_minor, supplier_id,
  landed_cost_model_id, inventory_policy, inventory_on_hand, inventory_reserved, status, created_at, updated_at`;

const CUSTOMER_COLUMNS = `id, company_id, email, phone_e164, name, external_refs, marketing_consent,
  total_orders, lifetime_value_minor`;

const PAYMENT_COLUMNS = `id, company_id, order_id, provider, external_id, status, amount_minor, currency,
  fee_minor, net_minor, payment_method_brand, payment_method_last4, risk_score, risk_level, captured_at`;

/* -------------------------------------------------------------------------- */
/* Products                                                                    */
/* -------------------------------------------------------------------------- */

export class ProductRepository {
  constructor(private readonly db: Queryable) {}

  async create(input: {
    companyId: string;
    sku: string;
    name: string;
    kind: ProductKind;
    description: string;
    paymentRoute: PaymentRoute;
    priceMinor: number;
    currency: string;
    physical?: Record<string, unknown> | null;
    opportunityId?: string | null;
    brandId?: string | null;
    supplierId?: string | null;
    landedCostModelId?: string | null;
    compareAtPriceMinor?: number | null;
  }): Promise<ProductRow> {
    // Refuses at the domain level before the database CHECK does, so the error
    // explains the compliance reason rather than naming a constraint.
    assertPaymentRoute(input.kind, input.paymentRoute);

    return qOne(
      this.db,
      `INSERT INTO products (id, company_id, opportunity_id, brand_id, sku, name, kind, description,
                             physical, payment_route, price_minor, currency, compare_at_price_minor,
                             supplier_id, landed_cost_model_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,$14,$15)
       RETURNING ${PRODUCT_COLUMNS}`,
      [
        newId('product'),
        input.companyId,
        input.opportunityId ?? null,
        input.brandId ?? null,
        input.sku,
        input.name,
        input.kind,
        input.description,
        input.physical ? JSON.stringify(input.physical) : null,
        input.paymentRoute,
        input.priceMinor,
        input.currency,
        input.compareAtPriceMinor ?? null,
        input.supplierId ?? null,
        input.landedCostModelId ?? null,
      ],
      ProductRow,
      'product',
      input.sku,
    );
  }

  async bySku(companyId: string, sku: string): Promise<ProductRow | undefined> {
    return qMaybe(this.db, `SELECT ${PRODUCT_COLUMNS} FROM products WHERE company_id=$1 AND sku=$2`, [companyId, sku], ProductRow);
  }

  async byId(id: string): Promise<ProductRow> {
    return qOne(this.db, `SELECT ${PRODUCT_COLUMNS} FROM products WHERE id=$1`, [id], ProductRow, 'product', id);
  }

  async listActive(companyId: string): Promise<readonly ProductRow[]> {
    return q(this.db, `SELECT ${PRODUCT_COLUMNS} FROM products WHERE company_id=$1 AND status='active' ORDER BY name`, [companyId], ProductRow);
  }

  async setExternalRef(id: string, key: string, value: string): Promise<void> {
    await exec(
      this.db,
      `UPDATE products SET external_refs = external_refs || jsonb_build_object($2::text, $3::text) WHERE id=$1`,
      [id, key, value],
    );
  }

  async setStatus(id: string, status: string): Promise<void> {
    await exec(this.db, `UPDATE products SET status=$2 WHERE id=$1`, [id, status]);
  }

  /**
   * Reserves stock atomically. Same pattern as budget reservation: the WHERE
   * clause makes overselling impossible under concurrency rather than unlikely.
   */
  async reserveInventory(productId: string, quantity: number): Promise<boolean> {
    const rows = await q(
      this.db,
      `UPDATE products
          SET inventory_reserved = inventory_reserved + $2
        WHERE id = $1
          AND (inventory_policy <> 'track' OR inventory_on_hand - inventory_reserved >= $2)
        RETURNING ${PRODUCT_COLUMNS}`,
      [productId, quantity],
      ProductRow,
    );
    return rows.length > 0;
  }

  async releaseInventory(productId: string, quantity: number): Promise<void> {
    await exec(
      this.db,
      `UPDATE products SET inventory_reserved = GREATEST(0, inventory_reserved - $2) WHERE id=$1`,
      [productId, quantity],
    );
  }

  async consumeInventory(productId: string, quantity: number): Promise<void> {
    await exec(
      this.db,
      `UPDATE products
          SET inventory_reserved = GREATEST(0, inventory_reserved - $2),
              inventory_on_hand  = GREATEST(0, inventory_on_hand - $2)
        WHERE id = $1`,
      [productId, quantity],
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Customers                                                                   */
/* -------------------------------------------------------------------------- */

export class CustomerRepository {
  constructor(private readonly db: Queryable) {}

  /** Matches on email first, then phone; creates only when neither matches. */
  async upsert(input: {
    companyId: string;
    email?: string | null;
    phoneE164?: string | null;
    name?: string | null;
    externalRefs?: Record<string, string>;
  }): Promise<CustomerRow> {
    if (!input.email && !input.phoneE164) {
      throw new ConflictError('A customer needs at least an email address or a phone number');
    }

    const existing = await qMaybe(
      this.db,
      `SELECT ${CUSTOMER_COLUMNS} FROM customers
        WHERE company_id = $1
          AND (($2::text IS NOT NULL AND lower(email) = lower($2)) OR ($3::text IS NOT NULL AND phone_e164 = $3))
        LIMIT 1`,
      [input.companyId, input.email ?? null, input.phoneE164 ?? null],
      CustomerRow,
    );

    if (existing) {
      return qOne(
        this.db,
        `UPDATE customers
            SET email = COALESCE($2, email),
                phone_e164 = COALESCE($3, phone_e164),
                name = COALESCE($4, name),
                external_refs = external_refs || $5::jsonb
          WHERE id = $1
          RETURNING ${CUSTOMER_COLUMNS}`,
        [existing.id, input.email ?? null, input.phoneE164 ?? null, input.name ?? null, JSON.stringify(input.externalRefs ?? {})],
        CustomerRow,
        'customer',
        existing.id,
      );
    }

    return qOne(
      this.db,
      `INSERT INTO customers (id, company_id, email, phone_e164, name, external_refs)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb)
       RETURNING ${CUSTOMER_COLUMNS}`,
      [newId('customer'), input.companyId, input.email ?? null, input.phoneE164 ?? null, input.name ?? null, JSON.stringify(input.externalRefs ?? {})],
      CustomerRow,
      'customer',
      input.email ?? input.phoneE164 ?? 'new',
    );
  }

  async byId(id: string): Promise<CustomerRow> {
    return qOne(this.db, `SELECT ${CUSTOMER_COLUMNS} FROM customers WHERE id=$1`, [id], CustomerRow, 'customer', id);
  }

  async byPhone(companyId: string, phoneE164: string): Promise<CustomerRow | undefined> {
    return qMaybe(this.db, `SELECT ${CUSTOMER_COLUMNS} FROM customers WHERE company_id=$1 AND phone_e164=$2`, [companyId, phoneE164], CustomerRow);
  }

  /** Records marketing consent with the provenance SMS compliance requires. */
  async recordConsent(id: string, channel: 'email' | 'sms', granted: boolean, source: string): Promise<void> {
    const patch = granted
      ? { [channel]: true, capturedAt: new Date().toISOString(), capturedSource: source, optedOutAt: null }
      : { [channel]: false, optedOutAt: new Date().toISOString() };
    await exec(
      this.db,
      `UPDATE customers SET marketing_consent = marketing_consent || $2::jsonb WHERE id=$1`,
      [id, JSON.stringify(patch)],
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Orders                                                                      */
/* -------------------------------------------------------------------------- */

export interface CreateOrderInput {
  readonly companyId: string;
  readonly customerId: string;
  readonly siteId?: string | null;
  readonly currency: string;
  readonly paymentRoute: PaymentRoute;
  readonly lineItems: readonly {
    productId: string;
    sku: string;
    name: string;
    quantity: number;
    unitPriceMinor: number;
    taxMinor?: number;
    discountMinor?: number;
    landedUnitCostMinor?: number | null;
  }[];
  readonly shippingMinor?: number;
  readonly shippingAddress?: Address | null;
  readonly billingAddress?: Address | null;
  readonly attribution?: Record<string, string>;
  readonly externalRefs?: Record<string, string>;
}

export type ApplyEventResult =
  | { outcome: 'applied'; order: OrderRow; eventId: string }
  /** The provider redelivered an event we already processed. */
  | { outcome: 'duplicate'; order: OrderRow; existingEventId: string }
  /** A late event that would move the order backwards. Recorded, not applied. */
  | { outcome: 'stale'; order: OrderRow; eventId: string };

export class OrderRepository {
  constructor(private readonly pool: DbPool) {}

  async create(input: CreateOrderInput): Promise<{ order: OrderRow; lineItems: readonly LineItemRow[] }> {
    const subtotal = input.lineItems.reduce((a, li) => a + li.unitPriceMinor * li.quantity, 0);
    const tax = input.lineItems.reduce((a, li) => a + (li.taxMinor ?? 0), 0);
    const discount = input.lineItems.reduce((a, li) => a + (li.discountMinor ?? 0), 0);
    const shipping = input.shippingMinor ?? 0;
    const total = subtotal + tax + shipping - discount;

    return withSerializableTransaction(this.pool, async (client) => {
      // Order numbers are human-facing and must be sequential per company.
      const seq = await qOne(
        client,
        `SELECT COALESCE(MAX(CAST(NULLIF(regexp_replace(order_number, '\\D', '', 'g'), '') AS BIGINT)), 1000) + 1 AS next
           FROM orders WHERE company_id = $1`,
        [input.companyId],
        z.object({ next: z.number() }),
      );

      const orderId = newId('order');
      const rows = await q(
        client,
        `INSERT INTO orders (id, company_id, site_id, order_number, customer_id, status, payment_route,
                             currency, subtotal_minor, shipping_minor, tax_minor, discount_minor, total_minor,
                             shipping_address, billing_address, external_refs, attribution, placed_at)
         VALUES ($1,$2,$3,$4,$5,'CREATED',$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14::jsonb,$15::jsonb,$16::jsonb, now())
         RETURNING ${ORDER_COLUMNS}`,
        [
          orderId,
          input.companyId,
          input.siteId ?? null,
          `ORD-${seq.next}`,
          input.customerId,
          input.paymentRoute,
          input.currency,
          subtotal,
          shipping,
          tax,
          discount,
          total,
          input.shippingAddress ? JSON.stringify(input.shippingAddress) : null,
          input.billingAddress ? JSON.stringify(input.billingAddress) : null,
          JSON.stringify(input.externalRefs ?? {}),
          JSON.stringify(input.attribution ?? {}),
        ],
        OrderRow,
      );
      const order = rows[0]!;

      const lineItems: LineItemRow[] = [];
      for (const li of input.lineItems) {
        const created = await q(
          client,
          `INSERT INTO order_line_items (id, order_id, product_id, sku, name, quantity, unit_price_minor,
                                         subtotal_minor, tax_minor, discount_minor, landed_unit_cost_minor)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
           RETURNING id, order_id, product_id, sku, name, quantity, unit_price_minor, subtotal_minor,
                     tax_minor, discount_minor, landed_unit_cost_minor, fulfilled_quantity, refunded_quantity`,
          [
            newId('lineItem'),
            orderId,
            li.productId,
            li.sku,
            li.name,
            li.quantity,
            li.unitPriceMinor,
            li.unitPriceMinor * li.quantity,
            li.taxMinor ?? 0,
            li.discountMinor ?? 0,
            li.landedUnitCostMinor ?? null,
          ],
          LineItemRow,
        );
        lineItems.push(created[0]!);
      }

      await this.#insertEvent(client, {
        orderId,
        kind: 'created',
        fromStatus: null,
        toStatus: 'CREATED',
        actor: 'system:checkout',
        externalEventId: null,
        payload: { total, currency: input.currency },
        occurredAt: new Date(),
      });

      metrics.ordersByStatus.inc({ status: 'CREATED' });
      return { order, lineItems };
    });
  }

  /**
   * The single entry point for changing an order's status.
   *
   * Ordering of the checks matters: duplicate detection comes first so a
   * redelivered webhook is cheap and side-effect free; staleness is checked
   * before legality so a late event is recorded as history rather than raising
   * a spurious illegal-transition error.
   */
  async applyEvent(input: {
    orderId: string;
    kind: OrderEventKind;
    toStatus: OrderStatus | null;
    actor: string;
    externalEventId?: string | null;
    payload?: Record<string, unknown>;
    occurredAt?: Date;
    /** Money deltas applied atomically with the transition. */
    amountPaidDeltaMinor?: number;
    amountRefundedDeltaMinor?: number;
    manualReviewReason?: string | null;
  }): Promise<ApplyEventResult> {
    // Cheap non-transactional pre-check. A provider retry storm is the common
    // case, and letting five redeliveries all contend on a SERIALIZABLE
    // transaction makes one of them exhaust its retry budget for no reason.
    // The transaction still re-checks, so this is an optimisation, not the
    // guarantee.
    if (input.externalEventId) {
      const seen = await qMaybe(
        this.pool,
        `SELECT id FROM order_events WHERE order_id = $1 AND external_event_id = $2`,
        [input.orderId, input.externalEventId],
        z.object({ id: z.string() }),
      );
      if (seen) {
        return { outcome: 'duplicate', order: await this.byId(input.orderId), existingEventId: seen.id };
      }
    }

    try {
      return await this.#applyEventInner(input);
    } catch (error) {
      // Under SERIALIZABLE snapshot isolation, concurrent deliveries of the
      // same provider event each read "no duplicate" and then race on the
      // insert. Exactly one wins; the losers hit the unique index. That is a
      // duplicate delivery, not a failure, and a provider retry storm must
      // resolve to one applied event rather than a pile of errors.
      if (
        input.externalEventId &&
        error instanceof ConflictError &&
        String(error.context['constraint'] ?? '').includes('order_events_external_unique')
      ) {
        const order = await this.byId(input.orderId);
        const existing = await qMaybe(
          this.pool,
          `SELECT id FROM order_events WHERE order_id = $1 AND external_event_id = $2`,
          [input.orderId, input.externalEventId],
          z.object({ id: z.string() }),
        );
        getLogger().debug(
          { orderId: input.orderId, externalEventId: input.externalEventId },
          'concurrent duplicate provider event resolved to duplicate',
        );
        return { outcome: 'duplicate', order, existingEventId: existing?.id ?? '' };
      }
      throw error;
    }
  }

  async #applyEventInner(input: {
    orderId: string;
    kind: OrderEventKind;
    toStatus: OrderStatus | null;
    actor: string;
    externalEventId?: string | null;
    payload?: Record<string, unknown>;
    occurredAt?: Date;
    amountPaidDeltaMinor?: number;
    amountRefundedDeltaMinor?: number;
    manualReviewReason?: string | null;
  }): Promise<ApplyEventResult> {
    // The contended resource is one identified order row, so a row lock under
    // READ COMMITTED is the right primitive: waiters queue on the lock and then
    // read the freshly committed state, instead of every waiter being aborted
    // with a serialization failure the instant the winner commits.
    return withRowLockTransaction(this.pool, async (client) => {
      const order = await qOne(
        client,
        `SELECT ${ORDER_COLUMNS} FROM orders WHERE id = $1 FOR UPDATE`,
        [input.orderId],
        OrderRow,
        'order',
        input.orderId,
      );

      // 1. Duplicate provider delivery.
      if (input.externalEventId) {
        const existing = await qMaybe(
          client,
          `SELECT id FROM order_events WHERE order_id = $1 AND external_event_id = $2`,
          [input.orderId, input.externalEventId],
          z.object({ id: z.string() }),
        );
        if (existing) {
          getLogger().debug(
            { orderId: input.orderId, externalEventId: input.externalEventId },
            'ignoring duplicate provider event',
          );
          return { outcome: 'duplicate', order, existingEventId: existing.id };
        }
      }

      const currentStatus = order.status as OrderStatus;
      const occurredAt = input.occurredAt ?? new Date();

      // 2. No status change requested — record the event and stop.
      if (input.toStatus === null || input.toStatus === currentStatus) {
        const eventId = await this.#insertEvent(client, {
          orderId: input.orderId,
          kind: input.kind,
          fromStatus: currentStatus,
          toStatus: input.toStatus,
          actor: input.actor,
          externalEventId: input.externalEventId ?? null,
          payload: input.payload ?? {},
          occurredAt,
        });
        const updated = await this.#applyMoneyDeltas(client, order, input);
        return { outcome: 'applied', order: updated, eventId };
      }

      // 3. Late, out-of-order delivery. Real: providers do this routinely.
      if (isStaleTransition(currentStatus, input.toStatus)) {
        const eventId = await this.#insertEvent(client, {
          orderId: input.orderId,
          kind: input.kind,
          fromStatus: currentStatus,
          toStatus: input.toStatus,
          actor: input.actor,
          externalEventId: input.externalEventId ?? null,
          payload: { ...(input.payload ?? {}), staleIgnored: true, currentStatus },
          occurredAt,
        });
        getLogger().info(
          { orderId: input.orderId, currentStatus, incoming: input.toStatus },
          'recorded a stale out-of-order event without applying it',
        );
        return { outcome: 'stale', order, eventId };
      }

      // 4. Legality.
      assertTransition(currentStatus, input.toStatus, input.orderId);

      const eventId = await this.#insertEvent(client, {
        orderId: input.orderId,
        kind: input.kind,
        fromStatus: currentStatus,
        toStatus: input.toStatus,
        actor: input.actor,
        externalEventId: input.externalEventId ?? null,
        payload: input.payload ?? {},
        occurredAt,
      });

      const updated = await this.#applyStatusAndMoney(client, order, input.toStatus, input, occurredAt);
      metrics.ordersByStatus.dec({ status: currentStatus });
      metrics.ordersByStatus.inc({ status: input.toStatus });
      return { outcome: 'applied', order: updated, eventId };
    });
  }

  async #applyMoneyDeltas(
    client: DbClient,
    order: OrderRow,
    input: { amountPaidDeltaMinor?: number; amountRefundedDeltaMinor?: number },
  ): Promise<OrderRow> {
    if (!input.amountPaidDeltaMinor && !input.amountRefundedDeltaMinor) return order;
    return this.#updateMoney(client, order, input.amountPaidDeltaMinor ?? 0, input.amountRefundedDeltaMinor ?? 0);
  }

  async #updateMoney(client: DbClient, order: OrderRow, paidDelta: number, refundDelta: number): Promise<OrderRow> {
    if (refundDelta > 0) {
      const ceiling = maxRefundableMinor({
        amountPaidMinor: order.amount_paid_minor + paidDelta,
        amountRefundedMinor: order.amount_refunded_minor,
      });
      if (refundDelta > ceiling) {
        throw new ConflictError(
          `Refund of ${refundDelta} exceeds the refundable balance of ${ceiling} on order ${order.id}`,
          { orderId: order.id, refundDelta, ceiling },
        );
      }
    }
    return qOne(
      client,
      `UPDATE orders
          SET amount_paid_minor = amount_paid_minor + $2,
              amount_refunded_minor = amount_refunded_minor + $3
        WHERE id = $1
        RETURNING ${ORDER_COLUMNS}`,
      [order.id, paidDelta, refundDelta],
      OrderRow,
      'order',
      order.id,
    );
  }

  async #applyStatusAndMoney(
    client: DbClient,
    order: OrderRow,
    toStatus: OrderStatus,
    input: { amountPaidDeltaMinor?: number; amountRefundedDeltaMinor?: number; manualReviewReason?: string | null },
    occurredAt: Date,
  ): Promise<OrderRow> {
    const paidDelta = input.amountPaidDeltaMinor ?? 0;
    const refundDelta = input.amountRefundedDeltaMinor ?? 0;

    if (refundDelta > 0) {
      const ceiling = maxRefundableMinor({
        amountPaidMinor: order.amount_paid_minor + paidDelta,
        amountRefundedMinor: order.amount_refunded_minor,
      });
      if (refundDelta > ceiling) {
        throw new ConflictError(
          `Refund of ${refundDelta} exceeds the refundable balance of ${ceiling} on order ${order.id}`,
          { orderId: order.id, refundDelta, ceiling },
        );
      }
    }

    return qOne(
      client,
      `UPDATE orders
          SET status = $2,
              amount_paid_minor = amount_paid_minor + $3,
              amount_refunded_minor = amount_refunded_minor + $4,
              manual_review_reason = CASE WHEN $2 = 'MANUAL_REVIEW' THEN COALESCE($5, manual_review_reason)
                                          ELSE NULL END,
              paid_at      = CASE WHEN $2 = 'PAID' AND paid_at IS NULL THEN $6 ELSE paid_at END,
              shipped_at   = CASE WHEN $2 = 'SHIPPED' AND shipped_at IS NULL THEN $6 ELSE shipped_at END,
              delivered_at = CASE WHEN $2 = 'DELIVERED' AND delivered_at IS NULL THEN $6 ELSE delivered_at END
        WHERE id = $1
        RETURNING ${ORDER_COLUMNS}`,
      [order.id, toStatus, paidDelta, refundDelta, input.manualReviewReason ?? null, occurredAt],
      OrderRow,
      'order',
      order.id,
    );
  }

  async #insertEvent(
    client: DbClient,
    input: {
      orderId: string;
      kind: OrderEventKind;
      fromStatus: OrderStatus | null;
      toStatus: OrderStatus | null;
      actor: string;
      externalEventId: string | null;
      payload: Record<string, unknown>;
      occurredAt: Date;
    },
  ): Promise<string> {
    const id = newId('orderEvent');
    await exec(
      client,
      `INSERT INTO order_events (id, order_id, kind, from_status, to_status, actor, external_event_id, payload, occurred_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)`,
      [
        id,
        input.orderId,
        input.kind,
        input.fromStatus,
        input.toStatus,
        input.actor,
        input.externalEventId,
        JSON.stringify(input.payload),
        input.occurredAt,
      ],
    );
    return id;
  }

  async byId(id: string): Promise<OrderRow> {
    return qOne(this.pool, `SELECT ${ORDER_COLUMNS} FROM orders WHERE id=$1`, [id], OrderRow, 'order', id);
  }

  async byExternalRef(companyId: string, key: string, value: string): Promise<OrderRow | undefined> {
    return qMaybe(
      this.pool,
      `SELECT ${ORDER_COLUMNS} FROM orders WHERE company_id=$1 AND external_refs->>$2 = $3 LIMIT 1`,
      [companyId, key, value],
      OrderRow,
    );
  }

  async lineItems(orderId: string): Promise<readonly LineItemRow[]> {
    return q(
      this.pool,
      `SELECT id, order_id, product_id, sku, name, quantity, unit_price_minor, subtotal_minor,
              tax_minor, discount_minor, landed_unit_cost_minor, fulfilled_quantity, refunded_quantity
         FROM order_line_items WHERE order_id=$1 ORDER BY id`,
      [orderId],
      LineItemRow,
    );
  }

  async events(orderId: string): Promise<readonly Record<string, unknown>[]> {
    return q(
      this.pool,
      `SELECT id, kind, from_status, to_status, actor, external_event_id, payload, occurred_at, recorded_at
         FROM order_events WHERE order_id=$1 ORDER BY occurred_at, recorded_at`,
      [orderId],
      z.record(z.string(), z.unknown()),
    );
  }

  async setExternalRef(orderId: string, key: string, value: string): Promise<void> {
    await exec(
      this.pool,
      `UPDATE orders SET external_refs = external_refs || jsonb_build_object($2::text, $3::text) WHERE id=$1`,
      [orderId, key, value],
    );
  }

  /**
   * Disputed share of paid orders over a trailing window, in basis points.
   *
   * Card networks judge merchants on exactly this ratio, so it is computed the
   * same way they do — disputes over *paid* orders in the window, not over all
   * orders — rather than on a definition that flatters the number.
   */
  async disputeRateBps(companyId: string, windowDays: number): Promise<number> {
    const row = await qOne(
      this.pool,
      `SELECT
         COUNT(*) FILTER (WHERE amount_paid_minor > 0)::int                          AS paid,
         COUNT(*) FILTER (WHERE amount_paid_minor > 0 AND status = 'DISPUTED')::int  AS disputed
       FROM orders
       WHERE company_id = $1
         AND paid_at IS NOT NULL
         AND paid_at >= now() - make_interval(days => $2)`,
      [companyId, windowDays],
      z.object({ paid: z.number(), disputed: z.number() }),
      'orders',
      companyId,
    );
    if (row.paid === 0) return 0;
    return Math.round((row.disputed / row.paid) * 10_000);
  }

  async listByStatus(companyId: string, statuses: readonly OrderStatus[], limit = 100): Promise<readonly OrderRow[]> {
    return q(
      this.pool,
      `SELECT ${ORDER_COLUMNS} FROM orders WHERE company_id=$1 AND status = ANY($2) ORDER BY created_at DESC LIMIT $3`,
      [companyId, statuses, limit],
      OrderRow,
    );
  }

  /** Legal next statuses, for a support agent or the CEO's situation report. */
  allowedTransitions(from: OrderStatus): readonly OrderStatus[] {
    return ORDER_STATUSES.filter((to) => to !== from && canTransition(from, to));
  }
}

/* -------------------------------------------------------------------------- */
/* Payments                                                                    */
/* -------------------------------------------------------------------------- */

export class PaymentRepository {
  constructor(private readonly db: Queryable) {}

  /** Idempotent on (provider, external_id) — the reconciliation key. */
  async upsert(input: {
    companyId: string;
    orderId: string;
    provider: 'stripe' | 'dodo' | 'whop';
    externalId: string;
    status: string;
    amountMinor: number;
    currency: string;
    feeMinor?: number | null;
    netMinor?: number | null;
    brand?: string | null;
    last4?: string | null;
    riskScore?: number | null;
    riskLevel?: string | null;
    capturedAt?: Date | null;
  }): Promise<PaymentRow> {
    return qOne(
      this.db,
      `INSERT INTO payments (id, company_id, order_id, provider, external_id, status, amount_minor, currency,
                             fee_minor, net_minor, payment_method_brand, payment_method_last4,
                             risk_score, risk_level, captured_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       ON CONFLICT (provider, external_id) DO UPDATE
         SET status = EXCLUDED.status,
             -- Fee and net arrive later than the charge; never overwrite a known
             -- value with NULL when a later event omits it.
             fee_minor = COALESCE(EXCLUDED.fee_minor, payments.fee_minor),
             net_minor = COALESCE(EXCLUDED.net_minor, payments.net_minor),
             risk_score = COALESCE(EXCLUDED.risk_score, payments.risk_score),
             risk_level = COALESCE(EXCLUDED.risk_level, payments.risk_level),
             captured_at = COALESCE(EXCLUDED.captured_at, payments.captured_at)
       RETURNING ${PAYMENT_COLUMNS}`,
      [
        newId('payment'),
        input.companyId,
        input.orderId,
        input.provider,
        input.externalId,
        input.status,
        input.amountMinor,
        input.currency,
        input.feeMinor ?? null,
        input.netMinor ?? null,
        input.brand ?? null,
        input.last4 ?? null,
        input.riskScore ?? null,
        input.riskLevel ?? null,
        input.capturedAt ?? null,
      ],
      PaymentRow,
      'payment',
      input.externalId,
    );
  }

  async byExternalId(provider: string, externalId: string): Promise<PaymentRow | undefined> {
    return qMaybe(this.db, `SELECT ${PAYMENT_COLUMNS} FROM payments WHERE provider=$1 AND external_id=$2`, [provider, externalId], PaymentRow);
  }

  async listForReconciliation(companyId: string, provider: string, since: Date): Promise<readonly PaymentRow[]> {
    return q(
      this.db,
      `SELECT ${PAYMENT_COLUMNS} FROM payments WHERE company_id=$1 AND provider=$2 AND created_at >= $3 ORDER BY created_at`,
      [companyId, provider, since],
      PaymentRow,
    );
  }

  async recordRefund(input: {
    companyId: string;
    orderId: string;
    paymentId: string;
    provider: string;
    externalId: string;
    amountMinor: number;
    currency: string;
    reason?: string | null;
    status: string;
    authorisedBy: string;
    approvalId?: string | null;
  }): Promise<string> {
    const id = newId('refund');
    await exec(
      this.db,
      `INSERT INTO refunds (id, company_id, order_id, payment_id, provider, external_id, amount_minor,
                            currency, reason, status, authorised_by, approval_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (provider, external_id) DO UPDATE SET status = EXCLUDED.status`,
      [
        id, input.companyId, input.orderId, input.paymentId, input.provider, input.externalId,
        input.amountMinor, input.currency, input.reason ?? null, input.status,
        input.authorisedBy, input.approvalId ?? null,
      ],
    );
    return id;
  }

  async upsertDispute(input: {
    companyId: string;
    orderId: string | null;
    paymentId: string | null;
    provider: string;
    externalId: string;
    amountMinor: number;
    currency: string;
    reason?: string | null;
    status: string;
    evidenceDueBy?: Date | null;
    outcome?: string | null;
  }): Promise<void> {
    await exec(
      this.db,
      `INSERT INTO disputes (id, company_id, order_id, payment_id, provider, external_id, amount_minor,
                             currency, reason, status, evidence_due_by, outcome)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (provider, external_id) DO UPDATE
         SET status = EXCLUDED.status,
             evidence_due_by = COALESCE(EXCLUDED.evidence_due_by, disputes.evidence_due_by),
             outcome = COALESCE(EXCLUDED.outcome, disputes.outcome)`,
      [
        newId('dispute'), input.companyId, input.orderId, input.paymentId, input.provider, input.externalId,
        input.amountMinor, input.currency, input.reason ?? null, input.status,
        input.evidenceDueBy ?? null, input.outcome ?? null,
      ],
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Facade                                                                      */
/* -------------------------------------------------------------------------- */

/* -------------------------------------------------------------------------- */
/* Shipments                                                                   */
/* -------------------------------------------------------------------------- */

const ShipmentRow = z.object({
  id: z.string(),
  company_id: z.string(),
  order_id: z.string(),
  carrier: z.string(),
  service: z.string().nullable(),
  tracking_number: z.string().nullable(),
  tracking_url: z.string().nullable(),
  label_url: z.string().nullable(),
  cost_minor: z.number().nullable(),
  currency: z.string().nullable(),
  provider: z.string().nullable(),
  external_id: z.string().nullable(),
  status: z.string(),
  line_item_ids: z.array(z.string()),
  shipped_at: z.date().nullable(),
  delivered_at: z.date().nullable(),
  created_at: z.date(),
  updated_at: z.date(),
});
export type ShipmentRow = z.infer<typeof ShipmentRow>;

const SHIPMENT_COLUMNS = `id, company_id, order_id, carrier, service, tracking_number, tracking_url,
  label_url, cost_minor, currency, provider, external_id, status, line_item_ids,
  shipped_at, delivered_at, created_at, updated_at`;

export class ShipmentRepository {
  constructor(private readonly db: Queryable) {}

  /**
   * Records a purchased label.
   *
   * Idempotent on `(provider, external_id)`, which the schema enforces with a
   * unique index: a retried fulfilment job must never buy a second label, and a
   * duplicate here is real money spent twice.
   */
  async create(input: {
    companyId: string;
    orderId: string;
    provider: string;
    externalId: string;
    carrier: string;
    service?: string | null;
    trackingNumber?: string | null;
    trackingUrl?: string | null;
    labelUrl?: string | null;
    costMinor?: number | null;
    currency?: string | null;
    status: string;
    lineItemIds?: readonly string[];
  }): Promise<ShipmentRow> {
    return qOne(
      this.db,
      `INSERT INTO shipments (id, company_id, order_id, carrier, service, tracking_number, tracking_url,
                              label_url, cost_minor, currency, provider, external_id, status, line_item_ids,
                              shipped_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,
               CASE WHEN $6::text IS NOT NULL THEN now() ELSE NULL END)
       ON CONFLICT (provider, external_id) WHERE external_id IS NOT NULL DO UPDATE
         SET status          = EXCLUDED.status,
             tracking_number = COALESCE(EXCLUDED.tracking_number, shipments.tracking_number),
             tracking_url    = COALESCE(EXCLUDED.tracking_url, shipments.tracking_url),
             label_url       = COALESCE(EXCLUDED.label_url, shipments.label_url)
       RETURNING ${SHIPMENT_COLUMNS}`,
      [
        newId('shipment'),
        input.companyId,
        input.orderId,
        input.carrier,
        input.service ?? null,
        input.trackingNumber ?? null,
        input.trackingUrl ?? null,
        input.labelUrl ?? null,
        input.costMinor ?? null,
        input.currency ?? null,
        input.provider,
        input.externalId,
        input.status,
        [...(input.lineItemIds ?? [])],
      ],
      ShipmentRow,
      'shipment',
      input.externalId,
    );
  }

  async forOrder(orderId: string): Promise<readonly ShipmentRow[]> {
    return q(
      this.db,
      `SELECT ${SHIPMENT_COLUMNS} FROM shipments WHERE order_id=$1 ORDER BY created_at`,
      [orderId],
      ShipmentRow,
    );
  }

  /** Shipments a carrier is still moving; the tracking sweep reads this. */
  async inFlight(companyId: string, limit = 200): Promise<readonly ShipmentRow[]> {
    return q(
      this.db,
      `SELECT ${SHIPMENT_COLUMNS} FROM shipments
        WHERE company_id=$1 AND status IN ('label_purchased','in_transit','out_for_delivery')
        ORDER BY shipped_at NULLS FIRST LIMIT $2`,
      [companyId, limit],
      ShipmentRow,
    );
  }

  async updateStatus(
    id: string,
    input: { status: string; deliveredAt?: Date; lastEvent?: string },
  ): Promise<ShipmentRow> {
    return qOne(
      this.db,
      `UPDATE shipments
          SET status = $2,
              delivered_at = COALESCE($3, delivered_at)
        WHERE id = $1
        RETURNING ${SHIPMENT_COLUMNS}`,
      [id, input.status, input.deliveredAt ?? null],
      ShipmentRow,
      'shipment',
      id,
    );
  }
}

export class CommerceRepositories {
  readonly products: ProductRepository;
  readonly customers: CustomerRepository;
  readonly orders: OrderRepository;
  readonly payments: PaymentRepository;
  readonly shipments: ShipmentRepository;

  constructor(pool: DbPool) {
    this.products = new ProductRepository(pool);
    this.customers = new CustomerRepository(pool);
    this.orders = new OrderRepository(pool);
    this.payments = new PaymentRepository(pool);
    this.shipments = new ShipmentRepository(pool);
  }
}

export { NotFoundError };
