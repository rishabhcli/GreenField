/**
 * Commerce API — what the generated storefront actually calls.
 *
 * The storefront is untrusted code running in a browser, so this surface
 * assumes nothing it sends is honest: prices come from the database, never from
 * the request; the order is created server-side before any payment session
 * exists; and the checkout URL is only ever produced by the payment provider.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  NotFoundError,
  PaymentRoute,
  ProductKind,
  ValidationError,
  assertPaymentRoute,
  idempotencyKey,
} from '@foundry/core';
import { getLogger } from '@foundry/obs';
import type { StripeAdapter } from '@foundry/providers';
import { companyConfig } from '@foundry/db';
import type { AppContext } from '@foundry/runtime';
import { requireOperator } from '../auth.js';
import { checkoutRedirectAllowed } from '../http-policy.js';

/** Catalogue prices only. A storefront that sends an amount is ignored as untrusted. */
const CUSTOMER_TYPED_AMOUNT_KEYS = [
  'amount',
  'amountMinor',
  'priceMinor',
  'unit_amount',
  'unitAmount',
  'custom_amount',
  'customAmount',
  'unitPriceMinor',
] as const;

export function rejectCustomerTypedCheckoutAmount(body: unknown): void {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return;
  const rec = body as Record<string, unknown>;
  const hit = CUSTOMER_TYPED_AMOUNT_KEYS.find((key) => key in rec);
  if (hit) {
    throw new ValidationError(`Checkout amounts come from the catalogue, not the request. Remove "${hit}".`, {
      field: hit,
    });
  }
  const items = rec['items'];
  if (!Array.isArray(items)) return;
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const itemHit = CUSTOMER_TYPED_AMOUNT_KEYS.find((key) => key in (item as object));
    if (itemHit) {
      throw new ValidationError(`Checkout amounts come from the catalogue, not the request. Remove "${itemHit}".`, {
        field: itemHit,
      });
    }
  }
}

export function assertCheckoutPaymentRoute(kind: string, route: string): void {
  assertPaymentRoute(ProductKind.parse(kind), PaymentRoute.parse(route));
}

/** True when tracked inventory cannot cover this quantity. Untracked stock is never blocked here. */
export function trackedProductOutOfStock(
  product: {
    sku: string;
    inventory_policy: string;
    inventory_on_hand: number;
    inventory_reserved: number;
  },
  quantity: number,
): boolean {
  if (product.inventory_policy !== 'track') return false;
  return product.inventory_on_hand - product.inventory_reserved < quantity;
}

const CreateCheckout = z.object({
  items: z
    .array(z.object({ sku: z.string().min(1), quantity: z.number().int().positive().max(20) }))
    .min(1)
    .max(20),
  email: z.string().email().optional(),
  /** Click ids and experiment arm, so revenue attributes to the creative. */
  attribution: z.record(z.string(), z.string()).optional(),
  successUrl: z.string().url(),
  cancelUrl: z.string().url(),
});

export async function registerCommerceRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const log = getLogger();

  const company = async () => {
    const row = await ctx.repos.companies.first();
    if (!row) throw new ValidationError('No company is configured yet.');
    return row;
  };

  /** Public catalogue. Only active products, and only public fields. */
  app.get('/api/products', async () => {
    const row = await company();
    const products = await ctx.repos.commerce.products.listActive(row.id);
    return {
      currency: companyConfig(row).commerce.baseCurrency,
      products: products.map((p) => ({
        sku: p.sku,
        name: p.name,
        description: p.description,
        priceMinor: p.price_minor,
        compareAtPriceMinor: p.compare_at_price_minor,
        currency: p.currency,
        kind: p.kind,
        inStock: p.inventory_policy !== 'track' || p.inventory_on_hand - p.inventory_reserved > 0,
      })),
    };
  });

  /**
   * Creates an order and a payment session.
   *
   * Prices are read from the database, not the request. A storefront that sends
   * `priceMinor` is ignored — that is the single most common way a client-side
   * checkout gets exploited.
   */
  app.post<{ Body: unknown }>('/api/checkout', async (request, reply) => {
    rejectCustomerTypedCheckoutAmount(request.body);
    const body = CreateCheckout.parse(request.body);
    if (
      !checkoutRedirectAllowed(body.successUrl, ctx.config.corsAllowedOrigins) ||
      !checkoutRedirectAllowed(body.cancelUrl, ctx.config.corsAllowedOrigins)
    ) {
      throw new ValidationError(
        'Checkout success and cancel URLs must use an origin on the CORS allowlist (PUBLIC_BASE_URL plus CORS_ALLOWED_ORIGINS).',
        { successUrl: body.successUrl, cancelUrl: body.cancelUrl },
      );
    }
    const row = await company();
    const companyId = row.id;

    const products = await Promise.all(
      body.items.map(async (item) => {
        const product = await ctx.repos.commerce.products.bySku(companyId, item.sku);
        if (!product) throw new NotFoundError('product', item.sku);
        if (product.status !== 'active') {
          throw new ValidationError(`Product "${item.sku}" is not available for sale`, { sku: item.sku });
        }
        if (product.price_minor <= 0) {
          throw new ValidationError(`Product "${item.sku}" has no catalogue price`, { sku: item.sku });
        }
        if (trackedProductOutOfStock(product, item.quantity)) {
          throw new ValidationError(`Product "${item.sku}" is out of stock`, {
            sku: item.sku,
            quantity: item.quantity,
          });
        }
        assertCheckoutPaymentRoute(product.kind, product.payment_route);
        return { product, quantity: item.quantity };
      }),
    );

    // Every line must share one currency and one payment route — mixing them
    // would need two payment sessions for one order.
    const currencies = new Set(products.map((p) => p.product.currency));
    if (currencies.size > 1) {
      throw new ValidationError('All items in one order must share a currency', { currencies: [...currencies] });
    }
    const routes = new Set(products.map((p) => p.product.payment_route));
    if (routes.size > 1) {
      throw new ValidationError('All items in one order must use the same payment route', { routes: [...routes] });
    }
    const paymentRoute = [...routes][0]!;
    const currency = [...currencies][0]!;

    const customer = await ctx.repos.commerce.customers.upsert({
      companyId,
      email: body.email ?? null,
      phoneE164: null,
    });

    const order = await ctx.repos.commerce.orders.create({
      companyId,
      customerId: customer.id,
      siteId: row.active_site_id,
      currency,
      paymentRoute: paymentRoute as 'stripe_direct' | 'dodo_merchant_of_record' | 'whop_checkout',
      lineItems: products.map(({ product, quantity }) => ({
        productId: product.id,
        sku: product.sku,
        name: product.name,
        quantity,
        unitPriceMinor: product.price_minor,
        landedUnitCostMinor: null,
      })),
      attribution: body.attribution ?? {},
    });

    for (const { product, quantity } of products) {
      const reserved = await ctx.repos.commerce.products.reserveInventory(product.id, quantity);
      if (!reserved) {
        throw new ValidationError(`Product "${product.sku}" is out of stock`, {
          sku: product.sku,
          quantity,
          orderId: order.order.id,
        });
      }
    }

    /* ---------------------------------------------------------------- */
    /* Payment session                                                   */
    /* ---------------------------------------------------------------- */
    if (paymentRoute !== 'stripe_direct') {
      // Honest failure rather than a broken redirect: the adapter for this
      // route is not wired yet, and the order row records the attempt.
      throw new ValidationError(
        `Payment route "${paymentRoute}" has no active adapter in this deployment. ` +
          `Order ${order.order.order_number} was created but no payment session exists.`,
        { orderId: order.order.id, paymentRoute },
      );
    }

    const { status, adapter } = ctx.providers.forCapability('payments.checkout.physical');
    if (!adapter) {
      throw new ValidationError(
        `Checkout is unavailable: ${status.remediation ?? `capability is ${status.state}`}`,
        { orderId: order.order.id, capabilityState: status.state },
      );
    }

    const stripe = adapter as StripeAdapter;
    const session = await stripe.createCheckoutSession({
      orderId: order.order.id,
      currency,
      lineItems: products.map(({ product, quantity }) => ({
        productId: product.id,
        name: product.name,
        description: product.description,
        unitPriceMinor: product.price_minor,
        quantity,
      })),
      successUrl: body.successUrl,
      cancelUrl: body.cancelUrl,
      allowedShippingCountries: companyConfig(row).commerce.sellsTo,
      ...(body.email ? { customerEmail: body.email } : {}),
      attribution: body.attribution ?? {},
      // Deterministic: a retried checkout for the same order reuses the session
      // rather than creating a second one.
      idempotencyKey: idempotencyKey('checkout', order.order.id),
    });

    await ctx.repos.commerce.orders.setExternalRef(order.order.id, 'stripe_checkout_session', session.sessionId);
    if (session.paymentIntentId) {
      await ctx.repos.commerce.orders.setExternalRef(order.order.id, 'stripe_payment_intent', session.paymentIntentId);
    }
    await ctx.repos.commerce.orders.applyEvent({
      orderId: order.order.id,
      kind: 'checkout_started',
      toStatus: 'CHECKOUT_STARTED',
      actor: 'api:checkout',
      payload: { sessionId: session.sessionId },
    });

    log.info({ orderId: order.order.id, sessionId: session.sessionId }, 'checkout session created');

    return reply.send({
      orderId: order.order.id,
      orderNumber: order.order.order_number,
      checkoutUrl: session.url,
      expiresAt: session.expiresAt,
    });
  });

  /**
   * Order status for the confirmation page.
   *
   * Reports only what the database records. It never infers "paid" from the
   * browser having reached the success URL — the webhook is authoritative, and
   * a customer arriving here before it lands correctly sees the pending state.
   */
  app.get<{ Params: { id: string } }>('/api/orders/:id', async (request) => {
    const order = await ctx.repos.commerce.orders.byId(request.params.id);
    const items = await ctx.repos.commerce.orders.lineItems(order.id);
    return {
      orderNumber: order.order_number,
      status: order.status,
      // Explicit so a client cannot mistake "we have your order" for "we have
      // your money".
      paymentConfirmed: order.amount_paid_minor > 0,
      currency: order.currency,
      totalMinor: order.total_minor,
      amountPaidMinor: order.amount_paid_minor,
      amountRefundedMinor: order.amount_refunded_minor,
      placedAt: order.placed_at,
      paidAt: order.paid_at,
      shippedAt: order.shipped_at,
      deliveredAt: order.delivered_at,
      items: items.map((li) => ({ sku: li.sku, name: li.name, quantity: li.quantity, subtotalMinor: li.subtotal_minor })),
    };
  });

  /** Full internal view, including the append-only event history. Operator only. */
  app.get<{ Params: { id: string } }>('/api/orders/:id/events', async (request) => {
    await requireOperator(request, ctx.config.operatorApiToken);
    const events = await ctx.repos.commerce.orders.events(request.params.id);
    return { events };
  });

  app.get<{ Querystring: { status?: string } }>('/api/orders', async (request) => {
    await requireOperator(request, ctx.config.operatorApiToken);
    const row = await company();
    const statuses = request.query.status
      ? (request.query.status.split(',') as never)
      : (['PAID', 'FULFILLMENT_QUEUED', 'FULFILLING', 'MANUAL_REVIEW', 'DISPUTED'] as never);
    const orders = await ctx.repos.commerce.orders.listByStatus(row.id, statuses);
    return {
      orders: orders.map((o) => ({
        id: o.id,
        orderNumber: o.order_number,
        status: o.status,
        totalMinor: o.total_minor,
        amountPaidMinor: o.amount_paid_minor,
        currency: o.currency,
        riskLevel: o.risk_level,
        manualReviewReason: o.manual_review_reason,
        createdAt: o.created_at,
      })),
    };
  });

  /* ---------------------------------------------------------------------- */
  /* Support intake                                                          */
  /* ---------------------------------------------------------------------- */

  const ContactForm = z.object({
    email: z.string().email(),
    orderNumber: z.string().optional(),
    subject: z.string().min(3).max(200),
    message: z.string().min(3).max(5000),
  });

  /** The storefront's contact form. Creates a ticket; a worker triages it. */
  app.post<{ Body: unknown }>('/api/support/contact', async (request, reply) => {
    const body = ContactForm.parse(request.body);
    const row = await company();

    const customer = await ctx.repos.commerce.customers.upsert({ companyId: row.id, email: body.email });
    const { ticket, isNew } = await ctx.repos.growth.support.openOrGet({
      companyId: row.id,
      channel: 'web_form',
      customerId: customer.id,
      subject: body.subject,
      intent: 'unknown',
      intentConfidence: 0,
    });

    const supportMessageId = await ctx.repos.growth.support.recordMessage({
      companyId: row.id,
      ticketId: ticket.id,
      customerId: customer.id,
      channel: 'web_form',
      direction: 'inbound',
      provider: 'web',
      fromHandle: body.email,
      toHandle: companyConfig(row).contact.supportEmail ?? 'support',
      body: body.message,
      status: 'delivered',
    });

    await ctx.queues.enqueue('support.inbound', {
      companyId: row.id,
      traceId: ticket.id,
      originRunId: null,
      idempotencyKey: `support:${ticket.id}:${supportMessageId}`,
      supportMessageId,
    });

    return reply.send({ ticketId: ticket.id, isNew, message: 'Received. We will reply by email.' });
  });
}
