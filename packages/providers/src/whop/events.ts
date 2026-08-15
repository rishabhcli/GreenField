/**
 * Whop webhook → order transition mapping.
 *
 * Event names are the current catalogue (payment.succeeded, membership.activated,
 * …). Older third-party names `membership.went_valid` / `went_invalid` are
 * treated as unhandled — they are not in the 2026 docs.
 *
 * Whop is digital/membership only. Physical-good checkouts are refused in the
 * adapter before a session is created; this mapper still has to be correct for
 * the digital products that do belong here.
 */

import { WHOP_MANIFEST } from '../manifests.js';
import type { MappingResult } from '../stripe/events.js';
import { WhopWebhookEnvelope, asMinorUnits } from './schemas.js';

export const HANDLED_WHOP_EVENTS: readonly string[] = WHOP_MANIFEST.webhooks?.[0]?.events ?? [];

export function mapWhopEventToOrderTransition(eventType: string, payload: unknown): MappingResult {
  const parsed = WhopWebhookEnvelope.safeParse(payload);
  const type = eventType || (parsed.success ? parsed.data.type ?? parsed.data.action ?? '' : '');
  const nested = parsed.success ? parsed.data.data : {};
  const data = Object.keys(nested).length > 0 ? nested : asRecord(payload);
  const ids = externalIds(data);

  switch (type) {
    case 'payment.succeeded':
      return {
        action: 'transition',
        intent: {
          orderStatus: 'PAID',
          kind: 'payment_captured',
          externalIds: ids,
          amountPaidDeltaMinor: asMinorUnits(data['total'] ?? data['amount'] ?? data['subtotal'] ?? data['usd_total']),
          currency: typeof data['currency'] === 'string' ? data['currency'] : undefined,
          detail: { paymentId: ids.whop_payment ?? ids.payment_id, status: data['status'] ?? 'succeeded' },
        },
      };

    case 'payment.created':
    case 'payment.pending':
      return {
        action: 'transition',
        intent: {
          orderStatus: 'PAYMENT_PENDING',
          kind: 'payment_webhook_received',
          externalIds: ids,
          detail: { paymentId: ids.whop_payment ?? ids.payment_id, eventType: type },
        },
      };

    case 'payment.failed':
      return {
        action: 'transition',
        intent: {
          orderStatus: 'PAYMENT_FAILED',
          kind: 'payment_failed',
          externalIds: ids,
          detail: { paymentId: ids.whop_payment ?? ids.payment_id, failure: data['failure_message'] ?? null },
        },
      };

    case 'refund.created':
    case 'refund.updated': {
      const status = String(data['status'] ?? '');
      if (status === 'failed' || status === 'canceled') {
        return { action: 'ignore', reason: `refund ${status} does not reduce captured amount` };
      }
      if (type === 'refund.created' && status === 'pending') {
        return {
          action: 'transition',
          intent: {
            orderStatus: 'REFUND_REQUESTED',
            kind: 'status_changed',
            externalIds: ids,
            detail: { refundId: ids.refund_id, eventType: type, status },
          },
        };
      }
      return {
        action: 'transition',
        intent: {
          orderStatus: 'PARTIALLY_REFUNDED',
          kind: 'refund_issued',
          externalIds: ids,
          amountRefundedDeltaMinor: type === 'refund.created' ? asMinorUnits(data['amount']) : undefined,
          currency: typeof data['currency'] === 'string' ? data['currency'] : undefined,
          detail: { refundId: ids.refund_id, eventType: type, status },
        },
      };
    }

    case 'dispute.created':
    case 'dispute.updated':
      return {
        action: 'transition',
        intent: {
          orderStatus: null,
          kind: type === 'dispute.created' ? 'dispute_opened' : 'dispute_closed',
          externalIds: ids,
          detail: { disputeId: ids.dispute_id, eventType: type },
          manualReviewReason: type === 'dispute.created' ? 'Whop dispute opened' : undefined,
        },
      };

    case 'membership.activated':
    case 'membership.deactivated':
    case 'membership.trial_ending_soon':
    case 'membership.cancel_at_period_end_changed':
    case 'product.created':
    case 'product.updated':
    case 'product.published':
    case 'plan.created':
    case 'plan.updated':
    case 'member.created':
    case 'shipment.created':
    case 'shipment.updated':
      return { action: 'ignore', reason: `${type} is catalogue/membership state, not an order money movement` };

    default:
      return { action: 'unhandled', reason: `Whop event type "${type}" has no mapping` };
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
  const pick = (source: Record<string, unknown>, key: string, dest: string) => {
    const v = source[key];
    if (typeof v === 'string' && v.length > 0) ids[dest] = v;
  };
  pick(data, 'id', 'payment_id');
  pick(data, 'id', 'whop_payment');
  pick(data, 'payment_id', 'payment_id');
  pick(data, 'refund_id', 'refund_id');
  pick(data, 'dispute_id', 'dispute_id');
  pick(data, 'membership_id', 'membership_id');
  if (typeof data['id'] === 'string' && String(data['status'] ?? '').includes('refund')) {
    ids['refund_id'] = data['id'];
  }
  if (typeof data['id'] === 'string' && data['amount'] !== undefined) {
    ids['refund_id'] = ids['refund_id'] ?? data['id'];
  }
  mergeMetadata(ids, data['metadata']);
  const nestedPayment = data['payment'];
  if (nestedPayment && typeof nestedPayment === 'object') {
    const payment = nestedPayment as Record<string, unknown>;
    pick(payment, 'id', 'payment_id');
    pick(payment, 'id', 'whop_payment');
    mergeMetadata(ids, payment['metadata']);
  }
  const membership = data['membership'];
  if (membership && typeof membership === 'object') {
    pick(membership as Record<string, unknown>, 'id', 'membership_id');
  }
  return ids;
}

function mergeMetadata(ids: Record<string, string>, metadata: unknown): void {
  if (!metadata || typeof metadata !== 'object') return;
  const meta = metadata as Record<string, unknown>;
  const orderId = meta['order_id'];
  const internal = meta['internal_order_id'];
  if (typeof orderId === 'string') ids['order_id'] = orderId;
  if (typeof internal === 'string') ids['internal_order_id'] = internal;
  else if (typeof orderId === 'string') ids['internal_order_id'] = orderId;
}
