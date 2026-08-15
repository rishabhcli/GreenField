/**
 * Refunds and disputes.
 *
 * Refunds are the one place an autonomous agent can move money *out* of the
 * business without a customer initiating a purchase, so the constraints here
 * are tighter than anywhere else:
 *
 *  - The refundable ceiling is computed from what was actually captured, never
 *    from what the order says it was worth.
 *  - Any amount over the owner's configured agent limit requires a human
 *    approval that exists as a row before the provider call is made.
 *  - The refund is only recorded as issued after the provider confirms it. A
 *    failed provider call leaves the order untouched, not "refunded pending".
 */

import { PolicyDeniedError, ValidationError, maxRefundableMinor } from '@foundry/core';
import { getLogger } from '@foundry/obs';
import { requireCapability, type ServiceDeps } from '../deps.js';

/** The subset of a payment provider a refund needs. */
export interface RefundCapableProvider {
  refund(input: {
    paymentExternalId: string;
    amountMinor: number;
    reason: string;
    idempotencyKey: string;
  }): Promise<{ refundId: string; status: string; amountMinor: number }>;
}

export interface RefundRequest {
  readonly orderId: string;
  readonly amountMinor: number;
  readonly reason: string;
  /** Agent role key or `human:<id>`; recorded on the audit trail. */
  readonly actorId: string;
  readonly actorKind: 'agent' | 'human_operator';
}

export type RefundOutcome =
  | { readonly outcome: 'refunded'; readonly refundId: string; readonly amountMinor: number }
  | { readonly outcome: 'awaiting_approval'; readonly approvalId: string }
  | { readonly outcome: 'refused'; readonly reason: string };

export class RefundService {
  constructor(private readonly deps: ServiceDeps) {}

  async issue(request: RefundRequest): Promise<RefundOutcome> {
    const log = getLogger();
    const order = await this.deps.repos.commerce.orders.byId(request.orderId);

    if (request.amountMinor <= 0) {
      throw new ValidationError('Refund amount must be positive', { amountMinor: request.amountMinor });
    }

    // Ceiling from captured money, not from the order total. An order can be
    // partially captured, already partly refunded, or disputed — all three
    // change what is legitimately refundable.
    const ceiling = maxRefundableMinor({
      amountPaidMinor: order.amount_paid_minor,
      amountRefundedMinor: order.amount_refunded_minor,
    });
    if (request.amountMinor > ceiling) {
      return {
        outcome: 'refused',
        reason:
          `Refund of ${request.amountMinor} exceeds the refundable balance of ${ceiling} ` +
          `(captured ${order.amount_paid_minor}, already refunded ${order.amount_refunded_minor}).`,
      };
    }

    const killed = await this.deps.repos.governance.killSwitches.engagedScopes(order.company_id);
    if (killed.includes('payments_capture') || killed.includes('all')) {
      return { outcome: 'refused', reason: 'the payments kill switch is engaged' };
    }

    /* ------------------------------------------------------------------ */
    /* Authorisation                                                       */
    /* ------------------------------------------------------------------ */
    const decision = await this.deps.gate.evaluate({
      companyId: order.company_id,
      authority: 'payments.refund',
      actorHandle: request.actorId,
      amountMinor: request.amountMinor,
      currency: order.currency,
      subjectRefId: order.id,
      action: `refund on order ${order.order_number}: ${request.reason}`,
    });

    if (decision.outcome === 'deny') {
      throw new PolicyDeniedError(`Refund denied: ${decision.explanation}`, { orderId: order.id });
    }
    if (decision.outcome === 'require_approval') {
      log.info(
        { orderId: order.id, amountMinor: request.amountMinor, approvalId: decision.approvalId },
        'refund held for human approval',
      );
      return { outcome: 'awaiting_approval', approvalId: decision.approvalId };
    }

    /* ------------------------------------------------------------------ */
    /* Execute                                                             */
    /* ------------------------------------------------------------------ */
    const paymentExternalId = order.external_refs['stripe_payment_intent'] ?? order.external_refs['stripe_charge'];
    if (!paymentExternalId) {
      await decision.release();
      return {
        outcome: 'refused',
        reason: `Order ${order.order_number} has no recorded payment reference to refund against.`,
      };
    }

    // The refund row is a child of the payment row, so the payment must
    // already be reconciled. Refunding against a charge we never recorded
    // would leave the books unable to explain where the money went.
    const payment = await this.deps.repos.commerce.payments.byExternalId('stripe', paymentExternalId);
    if (!payment) {
      await decision.release();
      return {
        outcome: 'refused',
        reason:
          `No payment record exists for ${paymentExternalId}. The charge webhook has not been reconciled yet; ` +
          `refunding now would produce a refund with no matching capture in the ledger.`,
      };
    }

    const { adapter } = requireCapability<RefundCapableProvider>(this.deps, 'payments.refund');

    try {
      const refund = await adapter.refund({
        paymentExternalId,
        amountMinor: request.amountMinor,
        reason: request.reason,
        // Keyed on order + amount + a caller-stable reason so a retried job
        // reuses the provider's existing refund rather than issuing a second.
        idempotencyKey: `refund:${order.id}:${request.amountMinor}`,
      });

      // Money state changes only now, after the provider confirmed it.
      await this.deps.repos.commerce.orders.applyEvent({
        orderId: order.id,
        kind: 'refund_issued',
        toStatus: request.amountMinor >= ceiling ? 'REFUNDED' : 'PARTIALLY_REFUNDED',
        actor: request.actorId,
        externalEventId: `refund:${refund.refundId}`,
        amountRefundedDeltaMinor: refund.amountMinor,
        payload: { refundId: refund.refundId, reason: request.reason, providerStatus: refund.status },
      });

      await this.deps.repos.commerce.payments.recordRefund({
        companyId: order.company_id,
        orderId: order.id,
        paymentId: payment.id,
        provider: 'stripe',
        externalId: refund.refundId,
        amountMinor: refund.amountMinor,
        currency: order.currency,
        reason: request.reason,
        status: refund.status,
        authorisedBy: request.actorId,
      });

      await this.deps.repos.audit.append({
        companyId: order.company_id,
        kind: 'refund_issued',
        actorId: request.actorId,
        actorKind: request.actorKind === 'agent' ? 'specialist_agent' : 'human_operator',
        action: `refund ${refund.amountMinor} on order ${order.order_number}`,
        subjectType: 'order',
        subjectRefId: order.id,
        outcome: 'success',
        detail: { refundId: refund.refundId, reason: request.reason },
        amountMinor: refund.amountMinor,
        currency: order.currency,
      });

      await decision.settle(refund.amountMinor);

      // Re-post the books: a refund reverses recognised revenue.
      await this.deps.queues.enqueue('finance.reconcile', {
        companyId: order.company_id,
        traceId: order.id,
        originRunId: null,
        idempotencyKey: `ledger:refund:${refund.refundId}`,
        sinceIso: null,
        scope: 'refund',
        orderId: order.id,
        refundExternalId: refund.refundId,
      });

      log.info({ orderId: order.id, refundId: refund.refundId, amountMinor: refund.amountMinor }, 'refund issued');
      return { outcome: 'refunded', refundId: refund.refundId, amountMinor: refund.amountMinor };
    } catch (error) {
      await decision.release();
      throw error;
    }
  }

  /**
   * Handles an opened dispute.
   *
   * Disputes are not refunds: the money is already gone and the provider
   * decides the outcome. This records the dispute, halts fulfilment on the
   * order, and — if the dispute rate crosses the owner's threshold — engages
   * the payments kill switch, because a rising dispute rate is how a merchant
   * account gets terminated.
   */
  async onDisputeOpened(input: {
    orderId: string;
    provider: string;
    externalId: string;
    amountMinor: number;
    reason: string;
    evidenceDueBy: Date | null;
  }): Promise<{ killSwitchEngaged: boolean; disputeRateBps: number }> {
    const order = await this.deps.repos.commerce.orders.byId(input.orderId);

    const payment = await this.deps.repos.commerce.payments.byExternalId(input.provider, input.externalId);
    await this.deps.repos.commerce.payments.upsertDispute({
      companyId: order.company_id,
      orderId: order.id,
      paymentId: payment?.id ?? null,
      provider: input.provider,
      externalId: input.externalId,
      amountMinor: input.amountMinor,
      currency: order.currency,
      reason: input.reason,
      status: 'needs_response',
      evidenceDueBy: input.evidenceDueBy,
    });

    const rate = await this.deps.repos.commerce.orders.disputeRateBps(order.company_id, 90);
    const config = await this.deps.repos.companies.byId(order.company_id);
    const threshold = disputeThresholdBps(config.config);

    if (rate >= threshold) {
      await this.deps.repos.governance.killSwitches.engage(
        order.company_id,
        'payments_capture',
        `dispute rate ${(rate / 100).toFixed(2)}% reached the ${(threshold / 100).toFixed(2)}% threshold`,
        'system:dispute-monitor',
      );
      getLogger().error({ disputeRateBps: rate, thresholdBps: threshold }, 'payments kill switch engaged on dispute rate');
      return { killSwitchEngaged: true, disputeRateBps: rate };
    }

    return { killSwitchEngaged: false, disputeRateBps: rate };
  }
}

/**
 * Dispute-rate threshold in basis points.
 *
 * 100 bps (1%) is the level at which the card networks place a merchant in a
 * monitoring programme, so it is the default ceiling rather than an arbitrary
 * number. An owner can set a stricter one in the company config.
 */
function disputeThresholdBps(config: unknown): number {
  const risk = (config as { risk?: { disputeRateThresholdBps?: number } }).risk;
  return risk?.disputeRateThresholdBps ?? 100;
}
