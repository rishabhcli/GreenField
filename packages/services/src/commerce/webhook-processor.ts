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
} from '@foundry/core';
import type { OrderStatus } from '@foundry/core';
import { getLogger, metrics } from '@foundry/obs';
import {
  mapDodoEventToOrderTransition,
  mapLinqEventToSupportUpdate,
  mapStripeEventToOrderTransition,
  mapWhopEventToOrderTransition,
  type MappingResult,
  type OrderTransitionIntent,
} from '@foundry/providers';
import type { ServiceDeps } from '../deps.js';
import { SupportInboxService } from '../support/inbox.js';

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

    try {
      const result = await this.deps.repos.commerce.orders.applyEvent({
        orderId: order.id,
        kind: intent.kind,
        toStatus: intent.orderStatus,
        actor: `webhook:${provider}`,
        externalEventId: `${provider}:${webhookEventId}`,
        payload: { eventType, ...intent.detail },
        ...(intent.amountPaidDeltaMinor !== undefined
          ? { amountPaidDeltaMinor: intent.amountPaidDeltaMinor }
          : {}),
        ...(intent.amountRefundedDeltaMinor !== undefined
          ? { amountRefundedDeltaMinor: intent.amountRefundedDeltaMinor }
          : {}),
        ...(intent.manualReviewReason ? { manualReviewReason: intent.manualReviewReason } : {}),
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

      await this.#onApplied(order.id, intent);

      log.info(
        { orderId: order.id, provider, eventType, toStatus: intent.orderStatus },
        'order transition applied from webhook',
      );
      return {
        outcome: 'applied',
        orderId: order.id,
        fromStatus: order.status as OrderStatus,
        ...(intent.orderStatus ? { toStatus: intent.orderStatus } : {}),
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
      const found = await this.deps.repos.commerce.orders.byExternalRef(companyRow.id, `${provider}_${key}`, value);
      if (found) return found;
    }

    // Our own order id, when the provider echoed it back in metadata. This is
    // the most reliable path and the reason checkout sets it.
    const ownId = intent.externalIds['orderId'] ?? intent.externalIds['order_id'];
    if (ownId) {
      try {
        return await this.deps.repos.commerce.orders.byId(ownId);
      } catch (error) {
        if (!(error instanceof NotFoundError)) throw error;
      }
    }
    return undefined;
  }

  /**
   * Side effects that must follow a successful money transition.
   *
   * Kept as enqueues rather than inline work: the webhook path must stay fast
   * and must not fail because a downstream system is slow.
   */
  async #onApplied(orderId: string, intent: OrderTransitionIntent): Promise<void> {
    const order = await this.deps.repos.commerce.orders.byId(orderId);

    if (intent.orderStatus === 'PAID') {
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

    if (intent.orderStatus === 'DISPUTED') {
      // A dispute is a governance event, not just a status: it can trigger the
      // payments kill switch if the rate crosses the configured threshold.
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

function readPath(value: unknown, path: readonly string[]): unknown {
  let current: unknown = value;
  for (const segment of path) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}
