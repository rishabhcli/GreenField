/**
 * Webhook → order state machine.
 *
 * This is where a provider's statement about money becomes this system's
 * statement about money, so it is deliberately the most conservative code in
 * the repository. Four rules govern it:
 *
 *  1. **The webhook is authoritative, the browser is not.** A customer landing
 *     on the success URL proves nothing; this processor is the only thing that
 *     may mark an order paid.
 *  2. **An unmapped event is never guessed at.** The mappers return `unhandled`
 *     rather than inventing a transition, and an unhandled event is surfaced as
 *     an operational signal instead of being silently dropped.
 *  3. **An order we cannot locate is an incident, not a no-op.** A payment with
 *     no matching order means real money arrived with nowhere to book it. That
 *     is escalated and left in the queue's failed set, never acknowledged as
 *     handled.
 *  4. **Everything is idempotent on the provider's event id.** Providers retry
 *     aggressively and deliver out of order; the repository's duplicate and
 *     stale-transition handling is relied on rather than re-implemented here.
 */

import {
  ConflictError,
  FoundryError,
  NotFoundError,
  ValidationError,
  isStaleTransition,
  statusAfterRefund,
} from '@foundry/core';
import type { OrderStatus } from '@foundry/core';
import { getLogger, metrics } from '@foundry/obs';
import {
  mapDodoEventToOrderTransition,
  mapLinqEventToSupportUpdate,
  mapStripeEventToOrderTransition,
  mapWhopEventToOrderTransition,
  shippingAddressFromStripe,
  type MappingResult,
  type OrderTransitionIntent,
} from '@foundry/providers';
import type { ServiceDeps } from '../deps.js';
import { SupportInboxService } from '../support/inbox.js';
import { lostDisputeRefundDelta, RefundService } from './refunds.js';

/** Providers whose events this processor knows how to interpret. */
export type WebhookProvider = 'stripe' | 'whop' | 'dodo' | 'linq' | 'terac' | 'lovable' | 'sandbox0' | 'replay' | 'solari';

export interface ProcessResult {
  readonly outcome: 'applied' | 'duplicate' | 'stale' | 'ignored' | 'unhandled' | 'escalated' | 'ingested';
  readonly orderId?: string;
  readonly fromStatus?: OrderStatus;
  readonly toStatus?: OrderStatus;
  readonly reason?: string;
}

export class WebhookProcessorService {
  constructor(private readonly deps: ServiceDeps) {}

  /**
   * Processes one recorded webhook event.
   *
   * The event row already exists and its signature was already verified by the
   * API before it was enqueued — this never re-accepts an unverified body.
   */
  async process(webhookEventId: string): Promise<ProcessResult> {
    const log = getLogger();
    const event = await this.deps.repos.webhooks.byId(webhookEventId);
    if (!event) {
      throw new NotFoundError('webhook_event', webhookEventId);
    }

    if (!event.signature_verified) {
      // Should be unreachable: the API refuses to record an unverified event.
      // If it ever happens, refusing loudly is the only safe response.
      throw new ValidationError(
        `Webhook ${webhookEventId} is recorded as signature-unverified. Refusing to act on it.`,
        { webhookEventId, provider: event.provider },
      );
    }

    if (event.processed_at) {
      return { outcome: 'duplicate', reason: 'already processed' };
    }

    if (event.provider === 'linq') {
      const linq = await this.#processLinq(webhookEventId, event.event_type, event.payload, event.company_id);
      if (linq) return linq;
    }

    const mapping = this.#map(event.provider, event.event_type, event.payload);

    if (mapping.action === 'ignore') {
      await this.deps.repos.webhooks.markIgnored(webhookEventId, mapping.reason);
      return { outcome: 'ignored', reason: mapping.reason };
    }

    if (mapping.action === 'unhandled') {
      // Not an error, but not invisible either. An event type we do not handle
      // may be the provider telling us something important, so it stays
      // visible in the stuck-webhook view until an operator looks at it.
      metrics.webhooksReceived.inc({ provider: event.provider, result: 'unhandled' });
      log.warn(
        { provider: event.provider, eventType: event.event_type, webhookEventId },
        'webhook event type is not handled by any mapper; left for operator review',
      );
      await this.deps.repos.webhooks.markFailed(webhookEventId, `unhandled event type: ${mapping.reason}`);
      return { outcome: 'unhandled', reason: mapping.reason };
    }

    return this.#applyTransition(webhookEventId, event.provider, event.event_type, mapping.intent);
  }

  /**
   * Linq events are support and Agent Pay, not Stripe-shaped money objects.
   * Inbound messages become tickets. Payment events try to locate an order
   * via metadata; if none exists they stay unhandled rather than inventing one.
   */
  async #processLinq(
    webhookEventId: string,
    eventType: string,
    payload: unknown,
    companyId: string | null,
  ): Promise<ProcessResult | undefined> {
    const data = readPath(payload, ['data']) ?? payload;
    if (eventType.startsWith('payment.')) {
      const ids: Record<string, string> = {};
      const rec = data && typeof data === 'object' ? (data as Record<string, unknown>) : {};
      for (const key of ['id', 'payment_request_id', 'order_id', 'orderId']) {
        const value = rec[key];
        if (typeof value === 'string' && value.length > 0) ids[key] = value;
      }
      const metadata = rec['metadata'];
      if (metadata && typeof metadata === 'object') {
        const orderId = (metadata as Record<string, unknown>)['order_id'] ?? (metadata as Record<string, unknown>)['orderId'];
        if (typeof orderId === 'string') ids['order_id'] = orderId;
      }
      if (eventType === 'payment.succeeded') {
        return this.#applyTransition(webhookEventId, 'linq', eventType, {
          orderStatus: 'PAID',
          kind: 'payment_webhook_received',
          externalIds: ids,
          detail: { provider: 'linq', eventType },
        });
      }
      if (eventType === 'payment.canceled' || eventType === 'payment.expired') {
        return this.#applyTransition(webhookEventId, 'linq', eventType, {
          orderStatus: 'PAYMENT_FAILED',
          kind: 'payment_failed',
          externalIds: ids,
          detail: { provider: 'linq', eventType },
        });
      }
    }

    const update = mapLinqEventToSupportUpdate(eventType, data);
    if (update.kind === 'unhandled') return undefined;
    if (update.kind !== 'inbound_message') {
      await this.deps.repos.webhooks.markIgnored(webhookEventId, `linq ${update.kind} recorded without a support ticket`);
      return { outcome: 'ignored', reason: `linq ${update.kind}` };
    }

    const company = companyId
      ? await this.deps.repos.companies.byId(companyId)
      : await this.deps.repos.companies.first();
    if (!company) {
      await this.deps.repos.webhooks.markFailed(webhookEventId, 'no company row to attach inbound Linq message');
      return { outcome: 'escalated', reason: 'no company configured for inbound Linq message' };
    }
    if (!update.externalChatId || !update.fromHandle) {
      await this.deps.repos.webhooks.markFailed(webhookEventId, 'Linq inbound message missing chat id or handle');
      return { outcome: 'unhandled', reason: 'Linq inbound message missing chat id or handle' };
    }

    const support = new SupportInboxService(this.deps);
    const ingested = await support.ingestInbound({
      companyId: company.id,
      channel: update.channel,
      externalChatId: update.externalChatId,
      body: update.body,
      customerHandle: update.fromHandle,
    });
    if (ingested.ok && ingested.data?.messageId) {
      await this.deps.queues.enqueue('support.inbound', {
        companyId: company.id,
        traceId: ingested.data.ticketId,
        originRunId: null,
        idempotencyKey: `support:${ingested.data.ticketId}:${ingested.data.messageId}`,
        supportMessageId: ingested.data.messageId,
      });
    }
    await this.deps.repos.webhooks.markProcessed(webhookEventId, company.id);
    return {
      outcome: 'ingested',
      reason: ingested.data
        ? `ticket ${ingested.data.ticketId} intent ${ingested.data.intent}`
        : ingested.blockedOn?.reason ?? 'inbound ingested',
    };
  }

  /* ------------------------------------------------------------------ */
  /* Mapping                                                             */
  /* ------------------------------------------------------------------ */

  #map(provider: string, eventType: string, payload: unknown): MappingResult {
    // The payload envelope differs per provider: Stripe nests the object under
    // `data.object`, others deliver it at the top level. Getting this wrong
    // would mean parsing the envelope as the object and silently mapping
    // nothing, so each provider's shape is explicit.
    switch (provider) {
      case 'stripe': {
        const dataObject = readPath(payload, ['data', 'object']);
        if (dataObject === undefined) {
          return { action: 'unhandled', reason: 'stripe event has no data.object' };
        }
        return mapStripeEventToOrderTransition(eventType, dataObject);
      }
      case 'dodo':
        // Refund ledger aliases (`refund` = `refund_id` / `re_*`) are applied
        // in mapDodoEventToOrderTransition. Do not copy payment_id onto the
        // refund key. Persist/reconcile splices: PATCH.md (DodoCommerceService).
        return mapDodoEventToOrderTransition(eventType, payload);
      case 'whop':
        return mapWhopEventToOrderTransition(eventType, payload);
      default:
        return {
          action: 'unhandled',
          reason: `no event mapper is registered for provider "${provider}" in this deployment`,
        };
    }
  }

  /* ------------------------------------------------------------------ */
  /* Application                                                         */
  /* ------------------------------------------------------------------ */

  async #applyTransition(
    webhookEventId: string,
    provider: string,
    eventType: string,
    intent: OrderTransitionIntent,
  ): Promise<ProcessResult> {
    const log = getLogger();
    const order = await this.#locateOrder(provider, intent);

    if (!order) {
      // Real money with no order row. This is the failure mode that must never
      // be swallowed: acknowledge nothing, escalate, and leave the webhook in
      // the failed set so the stuck-webhook view surfaces it.
      const detail =
        `Received ${provider}/${eventType} carrying ` +
        `${intent.amountPaidDeltaMinor ?? 0} minor units but no order matches ${JSON.stringify(intent.externalIds)}.`;
      log.error({ provider, eventType, externalIds: intent.externalIds }, 'orphan payment event: no matching order');

      await this.deps.repos.webhooks.markFailed(webhookEventId, detail);
      await this.#escalate(provider, eventType, detail, intent);
      return { outcome: 'escalated', reason: detail };
    }

    // A provider redelivering an old event after a newer one already landed
    // must not walk the order backwards. The repository detects this, but
    // checking here lets the outcome be reported precisely.
    if (intent.orderStatus && isStaleTransition(order.status as OrderStatus, intent.orderStatus)) {
      await this.deps.repos.webhooks.markIgnored(
        webhookEventId,
        `stale: order is already at ${order.status}, at or beyond ${intent.orderStatus}`,
      );
      return {
        outcome: 'stale',
        orderId: order.id,
        fromStatus: order.status as OrderStatus,
        toStatus: intent.orderStatus,
      };
    }

    // Currency mismatch means we are about to add a number denominated in one
    // currency to a total denominated in another. That is silent corruption of
    // the books, so it is refused rather than coerced.
    if (intent.currency && intent.currency.toUpperCase() !== order.currency.toUpperCase()) {
      const detail =
        `Currency mismatch on ${provider}/${eventType}: order ${order.order_number} is ${order.currency}, ` +
        `event reports ${intent.currency}.`;
      await this.deps.repos.webhooks.markFailed(webhookEventId, detail);
      await this.#escalate(provider, eventType, detail, intent);
      return { outcome: 'escalated', orderId: order.id, reason: detail };
    }

    let toStatus = intent.orderStatus;
    let amountPaidDeltaMinor = intent.amountPaidDeltaMinor;
    let amountRefundedDeltaMinor = intent.amountRefundedDeltaMinor;
    let kind = intent.kind;
    let manualReviewReason = intent.manualReviewReason;

    const capture = evaluatePaidCapture({
      intendedStatus: intent.orderStatus,
      amountPaidDeltaMinor: intent.amountPaidDeltaMinor,
      eventCurrency: intent.currency,
      orderTotalMinor: order.total_minor,
      orderCurrency: order.currency,
      orderAmountPaidMinor: order.amount_paid_minor,
    });
    if (capture.action === 'reject') {
      toStatus = 'MANUAL_REVIEW';
      kind = 'manual_review_flagged';
      amountPaidDeltaMinor = undefined;
      amountRefundedDeltaMinor = undefined;
      manualReviewReason = capture.reason;
    } else if (capture.action === 'already_credited') {
      amountPaidDeltaMinor = undefined;
    } else if (capture.action === 'credit') {
      amountPaidDeltaMinor = capture.amountPaidDeltaMinor;
    }

    if (intent.kind === 'dispute_closed' && intent.orderStatus === 'REFUNDED') {
      amountRefundedDeltaMinor = lostDisputeRefundDelta({
        amountPaidMinor: order.amount_paid_minor,
        amountRefundedMinor: order.amount_refunded_minor,
      });
    }

    if (
      capture.action !== 'reject' &&
      amountRefundedDeltaMinor !== undefined &&
      amountRefundedDeltaMinor > 0
    ) {
      toStatus = statusAfterRefund(
        {
          amountPaidMinor: order.amount_paid_minor,
          amountRefundedMinor: order.amount_refunded_minor,
        },
        amountRefundedDeltaMinor,
      );
    }

    try {
      const result = await this.deps.repos.commerce.orders.applyEvent({
        orderId: order.id,
        kind,
        toStatus,
        actor: `webhook:${provider}`,
        externalEventId: `${provider}:${webhookEventId}`,
        payload: { eventType, ...intent.detail },
        ...(amountPaidDeltaMinor !== undefined ? { amountPaidDeltaMinor } : {}),
        ...(amountRefundedDeltaMinor !== undefined ? { amountRefundedDeltaMinor } : {}),
        ...(manualReviewReason ? { manualReviewReason } : {}),
      });

      await this.deps.repos.webhooks.markProcessed(webhookEventId, order.company_id);

      if (result.outcome === 'duplicate') {
        return { outcome: 'duplicate', orderId: order.id };
      }
      if (result.outcome === 'stale') {
        return { outcome: 'stale', orderId: order.id, fromStatus: order.status as OrderStatus };
      }

      // Persist the provider's external ids so a later event for the same
      // payment can find this order even if it arrives on a different id.
      for (const [key, value] of Object.entries(intent.externalIds)) {
        await this.deps.repos.commerce.orders.setExternalRef(order.id, `${provider}_${key}`, value);
      }

      const shipping = shippingAddressFromStripe(intent.detail['shipping']);
      if (shipping) {
        await this.deps.repos.commerce.orders.setShippingAddress(order.id, shipping);
      }

      if (capture.action === 'reject') {
        await this.#escalate(provider, eventType, capture.reason, intent);
        return {
          outcome: 'escalated',
          orderId: order.id,
          fromStatus: order.status as OrderStatus,
          toStatus: 'MANUAL_REVIEW',
          reason: capture.reason,
        };
      }

      await this.#onApplied(order.id, provider, {
        ...intent,
        orderStatus: toStatus,
        amountPaidDeltaMinor,
        amountRefundedDeltaMinor,
      });

      log.info(
        { orderId: order.id, provider, eventType, toStatus },
        'order transition applied from webhook',
      );
      return {
        outcome: 'applied',
        orderId: order.id,
        fromStatus: order.status as OrderStatus,
        ...(toStatus ? { toStatus } : {}),
      };
    } catch (error) {
      if (error instanceof ConflictError) {
        // Concurrent delivery of the same event; one writer won.
        await this.deps.repos.webhooks.markProcessed(webhookEventId, order.company_id);
        return { outcome: 'duplicate', orderId: order.id };
      }
      const message = error instanceof FoundryError ? error.message : String(error);
      await this.deps.repos.webhooks.markFailed(webhookEventId, message);
      throw error;
    }
  }

  /**
   * Finds the order this event belongs to.
   *
   * Tries every external id the provider gave us, because the id that appears
   * on a refund is not always the id that appeared on the checkout session.
   */
  async #locateOrder(provider: string, intent: OrderTransitionIntent) {
    const companyRow = await this.deps.repos.companies.first();
    if (!companyRow) return undefined;

    for (const [key, value] of Object.entries(intent.externalIds)) {
      const prefixed = await this.deps.repos.commerce.orders.byExternalRef(
        companyRow.id,
        `${provider}_${key}`,
        value,
      );
      if (prefixed) return prefixed;
      // Checkout writes `stripe_checkout_session` without a second prefix;
      // mapper keys already include the provider in some cases.
      const direct = await this.deps.repos.commerce.orders.byExternalRef(companyRow.id, key, value);
      if (direct) return direct;
    }

    // Our own order id, when the provider echoed it back in metadata. This is
    // the most reliable path and the reason checkout sets it.
    const ownId = intent.externalIds['orderId'] ?? intent.externalIds['order_id'] ?? intent.externalIds['internal_order_id'];
    if (ownId) {
      try {
        return await this.deps.repos.commerce.orders.byId(ownId);
      } catch (error) {
        if (!(error instanceof NotFoundError)) throw error;
      }
    }

    if (
      provider === 'stripe' &&
      intent.orderStatus === 'PAID' &&
      (intent.amountPaidDeltaMinor ?? 0) >= 50
    ) {
      return this.#materializePaidSessionOrder(companyRow.id, intent);
    }
    return undefined;
  }

  /**
   * A paid Stripe Checkout / Payment Link session with no pre-created order.
   * Records the money against a catalogue SKU rather than leaving an orphan
   * webhook. Does not invent a customer: email or phone must be on the event.
   */
  async #materializePaidSessionOrder(
    companyId: string,
    intent: OrderTransitionIntent,
  ) {
    const email = stringDetail(intent.detail, 'customerEmail');
    const phone = stringDetail(intent.detail, 'customerPhone');
    if (!email && !phone) return undefined;

    const products = await this.deps.repos.commerce.products.listActive(companyId);
    const amount = intent.amountPaidDeltaMinor ?? 0;
    const tax = numberDetail(intent.detail, 'amountTax') ?? 0;
    const shipping = numberDetail(intent.detail, 'amountShipping') ?? 0;
    const productAmount = Math.max(amount - tax - shipping, 0);
    const product =
      products.find((p) => p.price_minor === productAmount) ??
      products.find((p) => p.sku === 'zhc-founding') ??
      products[0];
    if (!product) return undefined;

    const customer = await this.deps.repos.commerce.customers.upsert({
      companyId,
      email: email ?? null,
      phoneE164: phone ?? null,
      name: stringDetail(intent.detail, 'customerName'),
    });

    const created = await this.deps.repos.commerce.orders.create({
      companyId,
      customerId: customer.id,
      currency: (intent.currency ?? product.currency).toUpperCase(),
      paymentRoute: product.payment_route as 'stripe_direct' | 'dodo_merchant_of_record' | 'whop_checkout',
      shippingMinor: shipping,
      lineItems: [
        {
          productId: product.id,
          sku: product.sku,
          name: product.name,
          quantity: 1,
          unitPriceMinor: product.price_minor,
          taxMinor: tax,
        },
      ],
      externalRefs: Object.fromEntries(
        Object.entries(intent.externalIds).map(([key, value]) => [`${key.startsWith('stripe') ? key : `stripe_${key}`}`, value]),
      ),
      attribution: { source: 'stripe_payment_link' },
    });
    return created.order;
  }

  /**
   * Side effects that must follow a successful money transition.
   *
   * Kept as enqueues rather than inline work: the webhook path must stay fast
   * and must not fail because a downstream system is slow.
   */
  async #onApplied(orderId: string, provider: string, intent: OrderTransitionIntent): Promise<void> {
    const order = await this.deps.repos.commerce.orders.byId(orderId);

    if (intent.orderStatus === 'PAID') {
      await this.#upsertCapturedPayment(order, provider, intent);
      await this.deps.queues.enqueue('fulfilment.sync', {
        companyId: order.company_id,
        traceId: orderId,
        originRunId: null,
        idempotencyKey: `fulfil:${orderId}`,
        orderId,
      });
      // Post the sale to the ledger. Revenue recognition happens once, keyed on
      // the order, so a redelivered webhook cannot double-book it.
      await this.deps.queues.enqueue('finance.reconcile', {
        companyId: order.company_id,
        traceId: orderId,
        originRunId: null,
        idempotencyKey: `ledger:sale:${orderId}`,
        sinceIso: null,
        scope: 'order',
        orderId,
        refundExternalId: null,
      });
    }

    if (intent.kind === 'refund_issued' && (intent.amountRefundedDeltaMinor ?? 0) > 0) {
      await this.#recordWebhookRefund(order, provider, intent);
    }

    if (intent.kind === 'dispute_opened' && intent.orderStatus === 'DISPUTED') {
      const amountMinor = numberDetail(intent.detail, 'amount');
      const dueSeconds = numberDetail(intent.detail, 'evidenceDueBy');
      await new RefundService(this.deps).onDisputeOpened({
        orderId: order.id,
        provider,
        externalId:
          intent.externalIds['stripe_dispute'] ??
          intent.externalIds['stripe_charge'] ??
          intent.externalIds['dispute'] ??
          order.id,
        amountMinor: amountMinor ?? order.amount_paid_minor,
        reason: stringDetail(intent.detail, 'reason') ?? 'dispute',
        evidenceDueBy: dueSeconds !== null ? new Date(dueSeconds * 1000) : null,
      });
      await this.deps.repos.audit.append({
        companyId: order.company_id,
        kind: 'order_state_changed',
        actorId: 'webhook',
        actorKind: 'system_job',
        action: `dispute opened on order ${order.order_number}`,
        subjectType: 'order',
        subjectRefId: order.id,
        outcome: 'success',
        detail: intent.detail,
        amountMinor: order.amount_paid_minor,
        currency: order.currency,
      });
    }
  }

  async #upsertCapturedPayment(
    order: {
      id: string;
      company_id: string;
      amount_paid_minor: number;
      currency: string;
      paid_at: Date | null;
      external_refs: Record<string, string>;
    },
    provider: string,
    intent: OrderTransitionIntent,
  ): Promise<void> {
    if (provider !== 'stripe' && provider !== 'dodo' && provider !== 'whop') return;
    if (order.amount_paid_minor <= 0) return;
    const externalId =
      intent.externalIds['stripe_payment_intent'] ??
      intent.externalIds['stripe_charge'] ??
      intent.externalIds['payment_intent'] ??
      intent.externalIds['charge'] ??
      order.external_refs['stripe_payment_intent'] ??
      order.external_refs['stripe_charge'];
    if (!externalId) return;
    await this.deps.repos.commerce.payments.upsert({
      companyId: order.company_id,
      orderId: order.id,
      provider,
      externalId,
      status: 'succeeded',
      amountMinor: order.amount_paid_minor,
      currency: order.currency,
      capturedAt: order.paid_at ?? new Date(),
    });
  }

  /**
   * Dashboard / provider-initiated refunds update order totals in applyEvent.
   * The refunds table + ledger job still have to be written, or
   * finance.reconcile cannot find a `re_*` row.
   */
  async #recordWebhookRefund(
    order: {
      id: string;
      company_id: string;
      currency: string;
      external_refs: Record<string, string>;
    },
    provider: string,
    intent: OrderTransitionIntent,
  ): Promise<void> {
    const refundExternalId = intent.externalIds['stripe_refund'] ?? intent.externalIds['refund'];
    const amountMinor = intent.amountRefundedDeltaMinor;
    if (!refundExternalId || !amountMinor || amountMinor <= 0) return;

    const paymentExternalId =
      intent.externalIds['stripe_payment_intent'] ??
      intent.externalIds['stripe_charge'] ??
      intent.externalIds['payment_intent'] ??
      intent.externalIds['charge'] ??
      order.external_refs['stripe_payment_intent'] ??
      order.external_refs['stripe_charge'];
    if (!paymentExternalId) return;

    const payment = await this.deps.repos.commerce.payments.byExternalId(provider, paymentExternalId);
    if (!payment) return;

    await this.deps.repos.commerce.payments.recordRefund({
      companyId: order.company_id,
      orderId: order.id,
      paymentId: payment.id,
      provider,
      externalId: refundExternalId,
      amountMinor,
      currency: order.currency,
      reason: stringDetail(intent.detail, 'reason'),
      status: stringDetail(intent.detail, 'status') ?? 'succeeded',
      authorisedBy: 'webhook',
    });

    await this.deps.queues.enqueue('finance.reconcile', {
      companyId: order.company_id,
      traceId: order.id,
      originRunId: null,
      idempotencyKey: `ledger:refund:${refundExternalId}`,
      sinceIso: null,
      scope: 'refund',
      orderId: order.id,
      refundExternalId,
    });
  }

  /** Records an incident that needs a human, and audits it. */
  async #escalate(
    provider: string,
    eventType: string,
    detail: string,
    intent: OrderTransitionIntent,
  ): Promise<void> {
    const companyRow = await this.deps.repos.companies.first();
    if (!companyRow) return;
    await this.deps.repos.audit.append({
      companyId: companyRow.id,
      kind: 'webhook_received',
      actorId: `webhook:${provider}`,
      actorKind: 'system_job',
      action: `unmatched ${eventType}`,
      subjectType: 'webhook_event',
      subjectRefId: null,
      outcome: 'failure',
      detail: { detail, externalIds: intent.externalIds },
      ...(intent.amountPaidDeltaMinor ? { amountMinor: intent.amountPaidDeltaMinor } : {}),
      ...(intent.currency ? { currency: intent.currency } : {}),
    });
  }
}

export type PaidCaptureDecision =
  | { readonly action: 'credit'; readonly amountPaidDeltaMinor: number }
  | { readonly action: 'already_credited' }
  | { readonly action: 'pass' }
  | { readonly action: 'reject'; readonly reason: string };

/**
 * Whether a webhook's captured amount may be booked against this order.
 *
 * A mismatch or an explicit zero capture is held for manual review. A PAID
 * event with no amount (Linq, or a later status-only webhook) is passed
 * through without crediting money.
 */
export function evaluatePaidCapture(input: {
  readonly intendedStatus: OrderStatus | null;
  readonly amountPaidDeltaMinor: number | undefined;
  readonly eventCurrency: string | undefined;
  readonly orderTotalMinor: number;
  readonly orderCurrency: string;
  readonly orderAmountPaidMinor: number;
}): PaidCaptureDecision {
  if (
    input.eventCurrency &&
    input.eventCurrency.toUpperCase() !== input.orderCurrency.toUpperCase()
  ) {
    return {
      action: 'reject',
      reason: `Currency mismatch: order is ${input.orderCurrency}, event reports ${input.eventCurrency}.`,
    };
  }
  const delta = input.amountPaidDeltaMinor;
  if (delta === undefined) return { action: 'pass' };
  if (delta <= 0) {
    return {
      action: 'reject',
      reason: `Refusing to mark PAID with captured amount ${delta}.`,
    };
  }
  if (input.orderAmountPaidMinor > 0) {
    if (input.orderAmountPaidMinor === delta) return { action: 'already_credited' };
    return {
      action: 'reject',
      reason:
        `Captured ${delta} minor units disagrees with the already booked ` +
        `${input.orderAmountPaidMinor} on this order.`,
    };
  }
  if (input.orderTotalMinor > 0 && delta !== input.orderTotalMinor) {
    return {
      action: 'reject',
      reason:
        `Captured ${delta} minor units does not equal order total ${input.orderTotalMinor}.`,
    };
  }
  return { action: 'credit', amountPaidDeltaMinor: delta };
}

function readPath(value: unknown, path: readonly string[]): unknown {
  let current: unknown = value;
  for (const segment of path) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function stringDetail(detail: Readonly<Record<string, unknown>>, key: string): string | null {
  const value = detail[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function numberDetail(detail: Readonly<Record<string, unknown>>, key: string): number | null {
  const value = detail[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
