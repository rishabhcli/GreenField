/**
 * Stripe event → order transition mapping.
 *
 * Pure and exhaustive over the event list in `STRIPE_MANIFEST`. Two rules
 * shape it:
 *
 *  - An event we do not act on returns `null` with a reason, rather than
 *    guessing at a transition. Guessing here moves money state on incomplete
 *    information.
 *  - Money deltas are only emitted by the event that actually confirms the
 *    movement. `checkout.session.completed` with `payment_status: 'paid'` and
 *    `payment_intent.succeeded` both signal payment, so exactly one of them is
 *    allowed to carry the amount — otherwise a normal Stripe delivery sequence
 *    would credit the order twice.
 */

import { Address, type OrderEventKind, type OrderStatus } from '@foundry/core';
import { StripeCharge, StripeCheckoutSession, StripeDispute, StripePaymentIntent, StripeRefund, refId } from './schemas.js';

export interface OrderTransitionIntent {
  /** Target status, or null to record the event without changing status. */
  readonly orderStatus: OrderStatus | null;
  readonly kind: OrderEventKind;
  /** Provider ids we can use to locate our order row. */
  readonly externalIds: Readonly<Record<string, string>>;
  readonly amountPaidDeltaMinor?: number;
  readonly amountRefundedDeltaMinor?: number;
  readonly currency?: string;
  /** Detail persisted on the order event, useful in support and disputes. */
  readonly detail: Readonly<Record<string, unknown>>;
  readonly manualReviewReason?: string;
}

export type MappingResult =
  | { readonly action: 'transition'; readonly intent: OrderTransitionIntent }
  /** Recognised, but deliberately not acted on. */
  | { readonly action: 'ignore'; readonly reason: string }
  /** Not in our handled set. Recorded and surfaced, never silently dropped. */
  | { readonly action: 'unhandled'; readonly reason: string };

export function mapStripeEventToOrderTransition(eventType: string, dataObject: unknown): MappingResult {
  switch (eventType) {
    /* ---------------------------------------------------------------- */
    /* Checkout                                                          */
    /* ---------------------------------------------------------------- */
    case 'checkout.session.completed': {
      // Fired for Checkout Sessions (physical-goods storefront) and for the
      // submitted hackathon Payment Link. Both are Stripe-hosted checkouts.
      const session = StripeCheckoutSession.parse(dataObject);
      const ids = sessionIds(session);

      // A completed session is not necessarily a paid session — asynchronous
      // methods complete the session while payment is still pending.
      if (session.payment_status === 'paid') {
        if (session.amount_total == null) {
          return {
            action: 'transition',
            intent: {
              orderStatus: 'MANUAL_REVIEW',
              kind: 'manual_review_flagged',
              externalIds: ids,
              currency: session.currency ?? undefined,
              detail: {
                paymentStatus: session.payment_status,
                missingAmountTotal: true,
                shipping: session.collected_information?.shipping_details ?? session.shipping_details ?? null,
                customerEmail: session.customer_details?.email ?? null,
                customerPhone: session.customer_details?.phone ?? null,
                customerName: session.customer_details?.name ?? null,
              },
              manualReviewReason:
                'Paid checkout session is missing amount_total. Refusing to mark PAID with an unknown amount.',
            },
          };
        }
        return {
          action: 'transition',
          intent: {
            orderStatus: 'PAID',
            kind: 'payment_webhook_received',
            externalIds: ids,
            amountPaidDeltaMinor: session.amount_total,
            currency: session.currency ?? undefined,
            detail: {
              paymentStatus: session.payment_status,
              amountSubtotal: session.amount_subtotal,
              amountTax: session.total_details?.amount_tax ?? null,
              amountShipping: session.total_details?.amount_shipping ?? null,
              shipping: session.collected_information?.shipping_details ?? session.shipping_details ?? null,
              customerEmail: session.customer_details?.email ?? null,
              customerPhone: session.customer_details?.phone ?? null,
              customerName: session.customer_details?.name ?? null,
            },
          },
        };
      }
      return {
        action: 'transition',
        intent: {
          orderStatus: 'PAYMENT_PENDING',
          kind: 'payment_webhook_received',
          externalIds: ids,
          detail: { paymentStatus: session.payment_status },
        },
      };
    }

    case 'checkout.session.async_payment_succeeded': {
      const session = StripeCheckoutSession.parse(dataObject);
      if (session.amount_total == null) {
        return {
          action: 'transition',
          intent: {
            orderStatus: 'MANUAL_REVIEW',
            kind: 'manual_review_flagged',
            externalIds: sessionIds(session),
            currency: session.currency ?? undefined,
            detail: { asyncPayment: true, missingAmountTotal: true },
            manualReviewReason:
              'Async payment succeeded but amount_total is missing. Refusing to mark PAID with an unknown amount.',
          },
        };
      }
      return {
        action: 'transition',
        intent: {
          orderStatus: 'PAID',
          kind: 'payment_captured',
          externalIds: sessionIds(session),
          amountPaidDeltaMinor: session.amount_total,
          currency: session.currency ?? undefined,
          detail: { asyncPayment: true },
        },
      };
    }

    case 'checkout.session.async_payment_failed': {
      const session = StripeCheckoutSession.parse(dataObject);
      return {
        action: 'transition',
        intent: {
          orderStatus: 'PAYMENT_FAILED',
          kind: 'payment_failed',
          externalIds: sessionIds(session),
          detail: { asyncPayment: true },
        },
      };
    }

    case 'checkout.session.expired': {
      const session = StripeCheckoutSession.parse(dataObject);
      return {
        action: 'transition',
        intent: {
          orderStatus: 'CANCELLED',
          kind: 'status_changed',
          externalIds: sessionIds(session),
          detail: { reason: 'checkout session expired' },
        },
      };
    }

    /* ---------------------------------------------------------------- */
    /* Payment intents                                                   */
    /* ---------------------------------------------------------------- */
    case 'payment_intent.succeeded': {
      const pi = StripePaymentIntent.parse(dataObject);
      const received = pi.amount_received;
      if (received == null || received <= 0) {
        // Do not mark PAID with a zero capture. checkout.session.completed
        // carries amount_total for Checkout; a PaymentIntent without
        // amount_received is left for that event.
        return {
          action: 'transition',
          intent: {
            orderStatus: null,
            kind: 'payment_captured',
            externalIds: compact({ stripe_payment_intent: pi.id, stripe_charge: refId(pi.latest_charge) }),
            currency: pi.currency,
            detail: { amount: pi.amount, amountReceived: received ?? null, skippedPaid: true },
          },
        };
      }
      return {
        action: 'transition',
        intent: {
          orderStatus: 'PAID',
          kind: 'payment_captured',
          externalIds: compact({ stripe_payment_intent: pi.id, stripe_charge: refId(pi.latest_charge) }),
          amountPaidDeltaMinor: received,
          currency: pi.currency,
          detail: { amount: pi.amount, amountReceived: received },
        },
      };
    }

    case 'payment_intent.payment_failed': {
      const pi = StripePaymentIntent.parse(dataObject);
      return {
        action: 'transition',
        intent: {
          orderStatus: 'PAYMENT_FAILED',
          kind: 'payment_failed',
          externalIds: { stripe_payment_intent: pi.id },
          detail: {
            code: pi.last_payment_error?.code ?? null,
            message: pi.last_payment_error?.message ?? null,
          },
        },
      };
    }

    case 'payment_intent.processing': {
      const pi = StripePaymentIntent.parse(dataObject);
      return {
        action: 'transition',
        intent: {
          orderStatus: 'PAYMENT_PENDING',
          kind: 'payment_webhook_received',
          externalIds: { stripe_payment_intent: pi.id },
          detail: { status: pi.status },
        },
      };
    }

    case 'payment_intent.canceled': {
      const pi = StripePaymentIntent.parse(dataObject);
      return {
        action: 'transition',
        intent: {
          orderStatus: 'CANCELLED',
          kind: 'status_changed',
          externalIds: { stripe_payment_intent: pi.id },
          detail: { status: pi.status },
        },
      };
    }

    case 'payment_intent.requires_action': {
      const pi = StripePaymentIntent.parse(dataObject);
      return {
        action: 'transition',
        intent: {
          orderStatus: 'PAYMENT_PENDING',
          kind: 'payment_webhook_received',
          externalIds: { stripe_payment_intent: pi.id },
          detail: { status: pi.status, requiresAction: true },
        },
      };
    }

    /* ---------------------------------------------------------------- */
    /* Charges                                                           */
    /* ---------------------------------------------------------------- */
    case 'charge.succeeded': {
      const charge = StripeCharge.parse(dataObject);
      // Informational relative to the payment intent, but it carries the fee
      // and the card details we need for reconciliation and support.
      return {
        action: 'transition',
        intent: {
          orderStatus: null,
          kind: 'payment_webhook_received',
          externalIds: compact({ stripe_charge: charge.id, stripe_payment_intent: refId(charge.payment_intent) }),
          currency: charge.currency,
          detail: chargeDetail(charge),
        },
      };
    }

    case 'charge.failed': {
      const charge = StripeCharge.parse(dataObject);
      return {
        action: 'transition',
        intent: {
          orderStatus: 'PAYMENT_FAILED',
          kind: 'payment_failed',
          externalIds: compact({ stripe_charge: charge.id, stripe_payment_intent: refId(charge.payment_intent) }),
          detail: chargeDetail(charge),
        },
      };
    }

    case 'charge.updated': {
      const charge = StripeCharge.parse(dataObject);
      // Usually the balance transaction settling, which is where the fee
      // finally becomes known. Recorded, no status change.
      return {
        action: 'transition',
        intent: {
          orderStatus: null,
          kind: 'payment_webhook_received',
          externalIds: compact({ stripe_charge: charge.id, stripe_payment_intent: refId(charge.payment_intent) }),
          currency: charge.currency,
          detail: chargeDetail(charge),
        },
      };
    }

    case 'charge.refunded': {
      // Stripe's own docs say to listen to `refund.created` for the refund
      // detail; this event fires for full and partial refunds alike and gives
      // the cumulative total. We record it without a delta and let
      // `refund.created` carry the amount, so the two cannot double-count.
      const charge = StripeCharge.parse(dataObject);
      return {
        action: 'transition',
        intent: {
          orderStatus: null,
          kind: 'refund_issued',
          externalIds: compact({ stripe_charge: charge.id, stripe_payment_intent: refId(charge.payment_intent) }),
          currency: charge.currency,
          detail: { cumulativeAmountRefunded: charge.amount_refunded, chargeAmount: charge.amount },
        },
      };
    }

    /* ---------------------------------------------------------------- */
    /* Refunds                                                           */
    /* ---------------------------------------------------------------- */
    case 'refund.created': {
      const refund = StripeRefund.parse(dataObject);
      if (refund.status !== 'succeeded') {
        return {
          action: 'transition',
          intent: {
            orderStatus: 'REFUND_REQUESTED',
            kind: 'refund_issued',
            externalIds: compact({ stripe_refund: refund.id, stripe_charge: refId(refund.charge), stripe_payment_intent: refId(refund.payment_intent) }),
            currency: refund.currency,
            detail: { status: refund.status, amount: refund.amount, reason: refund.reason ?? null },
          },
        };
      }
      return {
        action: 'transition',
        intent: {
          // The order repository decides REFUNDED vs PARTIALLY_REFUNDED from
          // the resulting balance; the caller passes the delta and reads back
          // the settled status.
          orderStatus: 'PARTIALLY_REFUNDED',
          kind: 'refund_issued',
          externalIds: compact({ stripe_refund: refund.id, stripe_charge: refId(refund.charge), stripe_payment_intent: refId(refund.payment_intent) }),
          amountRefundedDeltaMinor: refund.amount,
          currency: refund.currency,
          detail: { status: refund.status, reason: refund.reason ?? null },
        },
      };
    }

    case 'refund.updated': {
      const refund = StripeRefund.parse(dataObject);
      if (refund.status === 'succeeded') {
        return {
          action: 'transition',
          intent: {
            orderStatus: 'PARTIALLY_REFUNDED',
            kind: 'refund_issued',
            externalIds: compact({ stripe_refund: refund.id, stripe_charge: refId(refund.charge) }),
            // The delta was already applied by refund.created; this is a status
            // change on an existing refund, not a second refund.
            currency: refund.currency,
            detail: { status: refund.status, transitionedToSucceeded: true },
          },
        };
      }
      return {
        action: 'transition',
        intent: {
          orderStatus: null,
          kind: 'refund_issued',
          externalIds: compact({ stripe_refund: refund.id, stripe_charge: refId(refund.charge) }),
          detail: { status: refund.status },
        },
      };
    }

    case 'refund.failed': {
      const refund = StripeRefund.parse(dataObject);
      return {
        action: 'transition',
        intent: {
          orderStatus: 'MANUAL_REVIEW',
          kind: 'manual_review_flagged',
          externalIds: compact({ stripe_refund: refund.id, stripe_charge: refId(refund.charge) }),
          detail: { failureReason: refund.failure_reason ?? null, amount: refund.amount },
          manualReviewReason: `Refund ${refund.id} failed: ${refund.failure_reason ?? 'unknown reason'}. The customer expects money back that has not moved.`,
        },
      };
    }

    /* ---------------------------------------------------------------- */
    /* Disputes                                                          */
    /* ---------------------------------------------------------------- */
    case 'charge.dispute.created': {
      const dispute = StripeDispute.parse(dataObject);
      return {
        action: 'transition',
        intent: {
          orderStatus: 'DISPUTED',
          kind: 'dispute_opened',
          externalIds: compact({ stripe_dispute: dispute.id, stripe_charge: refId(dispute.charge) }),
          currency: dispute.currency,
          detail: {
            reason: dispute.reason,
            amount: dispute.amount,
            evidenceDueBy: dispute.evidence_details?.due_by ?? null,
          },
        },
      };
    }

    case 'charge.dispute.updated': {
      const dispute = StripeDispute.parse(dataObject);
      return {
        action: 'transition',
        intent: {
          orderStatus: null,
          kind: 'dispute_opened',
          externalIds: compact({ stripe_dispute: dispute.id, stripe_charge: refId(dispute.charge) }),
          detail: { status: dispute.status, submissionCount: dispute.evidence_details?.submission_count ?? null },
        },
      };
    }

    case 'charge.dispute.closed': {
      const dispute = StripeDispute.parse(dataObject);
      const lost = dispute.status === 'lost';
      return {
        action: 'transition',
        intent: {
          // A lost dispute is money gone; the order is effectively refunded.
          // A won dispute restores it to a normal delivered state.
          orderStatus: lost ? 'REFUNDED' : 'MANUAL_REVIEW',
          kind: 'dispute_closed',
          externalIds: compact({ stripe_dispute: dispute.id, stripe_charge: refId(dispute.charge) }),
          currency: dispute.currency,
          detail: { status: dispute.status, amount: dispute.amount },
          ...(lost
            ? { amountRefundedDeltaMinor: dispute.amount }
            : { manualReviewReason: `Dispute ${dispute.id} closed as "${dispute.status}"; confirm the order's correct final state.` }),
        },
      };
    }

    case 'charge.dispute.funds_withdrawn':
    case 'charge.dispute.funds_reinstated': {
      const dispute = StripeDispute.parse(dataObject);
      return {
        action: 'transition',
        intent: {
          orderStatus: null,
          kind: 'dispute_opened',
          externalIds: compact({ stripe_dispute: dispute.id, stripe_charge: refId(dispute.charge) }),
          currency: dispute.currency,
          detail: { fundsMovement: eventType, amount: dispute.amount },
        },
      };
    }

    /* ---------------------------------------------------------------- */
    /* Risk                                                              */
    /* ---------------------------------------------------------------- */
    case 'radar.early_fraud_warning.created': {
      const record = dataObject as { id?: string; charge?: unknown; fraud_type?: string };
      return {
        action: 'transition',
        intent: {
          orderStatus: 'MANUAL_REVIEW',
          kind: 'manual_review_flagged',
          externalIds: compact({ stripe_charge: refId(record.charge) }),
          detail: { fraudType: record.fraud_type ?? null, warningId: record.id ?? null },
          manualReviewReason:
            `Stripe raised an early fraud warning (${record.fraud_type ?? 'unknown type'}). ` +
            `Hold fulfilment until this is reviewed — shipping now risks losing both the goods and the money.`,
        },
      };
    }

    case 'review.opened': {
      const record = dataObject as { id?: string; charge?: unknown; payment_intent?: unknown; reason?: string };
      return {
        action: 'transition',
        intent: {
          orderStatus: 'MANUAL_REVIEW',
          kind: 'manual_review_flagged',
          externalIds: compact({ stripe_charge: refId(record.charge), stripe_payment_intent: refId(record.payment_intent) }),
          detail: { reviewId: record.id ?? null, reason: record.reason ?? null },
          manualReviewReason: `Stripe Radar opened a manual review (${record.reason ?? 'unspecified'}).`,
        },
      };
    }

    case 'review.closed': {
      const record = dataObject as { id?: string; charge?: unknown; reason?: string };
      return {
        action: 'transition',
        intent: {
          orderStatus: null,
          kind: 'manual_review_cleared',
          externalIds: compact({ stripe_charge: refId(record.charge) }),
          detail: { reviewId: record.id ?? null, closedReason: record.reason ?? null },
        },
      };
    }

    default:
      return {
        action: 'unhandled',
        reason: `Stripe event "${eventType}" has no mapping. It is stored and surfaced rather than acted on.`,
      };
  }
}

/** Event names this mapper claims to handle. Used to assert exhaustiveness. */
export const HANDLED_STRIPE_EVENTS: readonly string[] = [
  'checkout.session.completed',
  'checkout.session.async_payment_succeeded',
  'checkout.session.async_payment_failed',
  'checkout.session.expired',
  'payment_intent.succeeded',
  'payment_intent.payment_failed',
  'payment_intent.processing',
  'payment_intent.canceled',
  'payment_intent.requires_action',
  'charge.succeeded',
  'charge.failed',
  'charge.updated',
  'charge.refunded',
  'refund.created',
  'refund.updated',
  'refund.failed',
  'charge.dispute.created',
  'charge.dispute.updated',
  'charge.dispute.closed',
  'charge.dispute.funds_withdrawn',
  'charge.dispute.funds_reinstated',
  'radar.early_fraud_warning.created',
  'review.opened',
  'review.closed',
];

function sessionIds(session: StripeCheckoutSession): Record<string, string> {
  return compact({
    stripe_checkout_session: session.id,
    stripe_payment_intent: refId(session.payment_intent),
    stripe_payment_link: refId(session.payment_link),
    internal_order_id: session.client_reference_id ?? session.metadata?.['internal_order_id'] ?? null,
  });
}

function chargeDetail(charge: StripeCharge): Record<string, unknown> {
  const bt = charge.balance_transaction;
  const settled = bt && typeof bt === 'object' ? bt : null;
  return {
    amount: charge.amount,
    amountRefunded: charge.amount_refunded,
    // Null means the balance transaction has not settled yet. It is not zero.
    feeMinor: settled?.fee ?? null,
    netMinor: settled?.net ?? null,
    cardBrand: charge.payment_method_details?.card?.brand ?? null,
    cardLast4: charge.payment_method_details?.card?.last4 ?? null,
    riskLevel: charge.outcome?.risk_level ?? null,
    riskScore: charge.outcome?.risk_score ?? null,
  };
}

function compact(record: Record<string, string | null | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === 'string' && value.length > 0) out[key] = value;
  }
  return out;
}

/** Maps Stripe Checkout shipping onto our Address, or null when required fields are missing. */
export function shippingAddressFromStripe(shipping: unknown): Address | null {
  if (!shipping || typeof shipping !== 'object') return null;
  const rec = shipping as Record<string, unknown>;
  const addr = rec['address'];
  if (!addr || typeof addr !== 'object') return null;
  const a = addr as Record<string, unknown>;
  const parsed = Address.safeParse({
    name: typeof rec['name'] === 'string' ? rec['name'] : '',
    line1: typeof a['line1'] === 'string' ? a['line1'] : '',
    line2: typeof a['line2'] === 'string' && a['line2'].length > 0 ? a['line2'] : null,
    city: typeof a['city'] === 'string' ? a['city'] : '',
    state: typeof a['state'] === 'string' && a['state'].length > 0 ? a['state'] : null,
    postalCode: typeof a['postal_code'] === 'string' ? a['postal_code'] : '',
    country: typeof a['country'] === 'string' ? a['country'] : '',
    phone: typeof rec['phone'] === 'string' && rec['phone'].length > 0 ? rec['phone'] : null,
  });
  return parsed.success ? parsed.data : null;
}
