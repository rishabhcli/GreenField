/**
 * Dodo webhook → order transition mapping.
 *
 * Physical goods never flow through Dodo (merchant-acceptance prohibition).
 * This mapper still exists because digital add-ons and memberships do, and
 * those payments must land on an order row the same way Stripe's do.
 *
 * Amounts are applied only on the terminal success/refund events so a
 * `payment.processing` followed by `payment.succeeded` cannot credit twice.
 */

import { DODO_MANIFEST } from '../manifests.js';
import type { MappingResult } from '../stripe/events.js';
import { DodoWebhookEnvelope, asMinorUnits, refId } from './schemas.js';

export const HANDLED_DODO_EVENTS: readonly string[] = DODO_MANIFEST.webhooks?.[0]?.events ?? [];

export function mapDodoEventToOrderTransition(eventType: string, payload: unknown): MappingResult {
  const envelope = DodoWebhookEnvelope.safeParse(payload);
  const data = envelope.success ? envelope.data.data : asRecord(payload);
  const ids = externalIds(data);

  switch (eventType) {
    case 'payment.succeeded':
      return {
        action: 'transition',
        intent: {
          orderStatus: 'PAID',
          kind: 'payment_captured',
          externalIds: ids,
          amountPaidDeltaMinor: asMinorUnits(data['total_amount'] ?? data['amount'] ?? data['settlement_amount']),
          currency: currencyOf(data),
          detail: { paymentId: ids.payment_id, status: data['status'] ?? 'succeeded' },
        },
      };

    case 'payment.processing':
    case 'payment.pending':
      return {
        action: 'transition',
        intent: {
          orderStatus: 'PAYMENT_PENDING',
          kind: 'payment_webhook_received',
          externalIds: ids,
          detail: { paymentId: ids.payment_id, eventType },
        },
      };

    case 'payment.failed':
      return {
        action: 'transition',
        intent: {
          orderStatus: 'PAYMENT_FAILED',
          kind: 'payment_failed',
          externalIds: ids,
          detail: {
            paymentId: ids.payment_id,
            error: data['error'] ?? data['failure_reason'] ?? data['error_message'] ?? null,
            errorCode: data['error_code'] ?? null,
          },
        },
      };

    case 'payment.cancelled':
      return {
        action: 'transition',
        intent: {
          orderStatus: 'CANCELLED',
          kind: 'status_changed',
          externalIds: ids,
          detail: { paymentId: ids.payment_id },
        },
      };

    case 'refund.succeeded':
      return {
        action: 'transition',
        intent: {
          orderStatus: 'PARTIALLY_REFUNDED',
          kind: 'refund_issued',
          externalIds: ids,
          amountRefundedDeltaMinor: asMinorUnits(data['amount'] ?? data['refund_amount']),
          currency: currencyOf(data),
          detail: { refundId: ids.refund_id, paymentId: ids.payment_id },
        },
      };

    case 'refund.failed':
      return {
        action: 'transition',
        intent: {
          orderStatus: 'MANUAL_REVIEW',
          kind: 'manual_review_flagged',
          externalIds: ids,
          detail: { refundId: ids.refund_id, paymentId: ids.payment_id, status: 'failed' },
          manualReviewReason: 'Dodo refund.failed; captured amount still stands',
        },
      };

    case 'dispute.opened':
    case 'dispute.challenged':
      return {
        action: 'transition',
        intent: {
          orderStatus: 'DISPUTED',
          kind: 'dispute_opened',
          externalIds: ids,
          detail: { disputeId: ids.dispute_id, eventType, amount: data['amount'] ?? null },
          manualReviewReason: `Dodo dispute ${eventType}`,
        },
      };

    case 'dispute.lost':
      return {
        action: 'transition',
        intent: {
          orderStatus: 'REFUNDED',
          kind: 'dispute_closed',
          externalIds: ids,
          detail: { disputeId: ids.dispute_id, eventType },
        },
      };

    case 'dispute.won':
    case 'dispute.accepted':
    case 'dispute.expired':
    case 'dispute.cancelled':
      return {
        action: 'transition',
        intent: {
          orderStatus: null,
          kind: 'dispute_closed',
          externalIds: ids,
          detail: { disputeId: ids.dispute_id, eventType },
        },
      };

    case 'subscription.active':
    case 'subscription.renewed':
    case 'subscription.on_hold':
    case 'subscription.paused':
    case 'subscription.cancelled':
    case 'subscription.failed':
    case 'subscription.expired':
    case 'subscription.plan_changed':
    case 'subscription.updated':
    case 'license_key.created':
    case 'abandoned_checkout.detected':
    case 'abandoned_checkout.recovered':
    case 'dunning.started':
    case 'dunning.recovered':
    case 'entitlement_grant.created':
    case 'entitlement_grant.delivered':
    case 'entitlement_grant.failed':
    case 'entitlement_grant.revoked':
      return { action: 'ignore', reason: `${eventType} is recorded but does not change physical-order status` };

    default:
      return { action: 'unhandled', reason: `Dodo event type "${eventType}" has no mapping` };
  }
}

function asRecord(payload: unknown): Record<string, unknown> {
  if (payload && typeof payload === 'object' && 'data' in payload) {
    const data = (payload as { data: unknown }).data;
    if (data && typeof data === 'object') return data as Record<string, unknown>;
  }
  if (payload && typeof payload === 'object') return payload as Record<string, unknown>;
  return {};
}

function externalIds(data: Record<string, unknown>): Record<string, string> {
  const ids: Record<string, string> = {};
  const payment = refId(data, 'payment_id', 'id');
  const refund = refId(data, 'refund_id');
  const dispute = refId(data, 'dispute_id');
  const checkout = refId(data, 'checkout_session_id', 'session_id');
  if (payment) ids['payment_id'] = payment;
  if (refund) ids['refund_id'] = refund;
  if (dispute) ids['dispute_id'] = dispute;
  if (checkout) ids['checkout_session_id'] = checkout;
  const metadata = data['metadata'];
  if (metadata && typeof metadata === 'object') {
    const meta = metadata as Record<string, unknown>;
    const orderId = refId(meta, 'internal_order_id', 'order_id');
    if (orderId) {
      ids['internal_order_id'] = orderId;
      ids['order_id'] = refId(meta, 'order_id') ?? orderId;
    }
  }
  const client = refId(data, 'client_reference_id');
  if (client) ids['client_reference_id'] = client;
  return ids;
}

function currencyOf(data: Record<string, unknown>): string | undefined {
  const c = data['currency'] ?? data['settlement_currency'];
  return typeof c === 'string' ? c.toUpperCase() : undefined;
}
