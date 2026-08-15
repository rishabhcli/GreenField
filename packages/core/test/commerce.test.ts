import { describe, expect, it } from 'vitest';
import {
  ConflictError,
  ORDER_STATUSES,
  ORDER_TRANSITIONS,
  assertPaymentRoute,
  assertTransition,
  canTransition,
  computeOrderTotals,
  isStaleTransition,
  maxRefundableMinor,
  statusAfterRefund,
  type OrderStatus,
} from '@foundry/core';

describe('order state machine', () => {
  it('allows the happy path end to end', () => {
    const path: OrderStatus[] = [
      'CREATED',
      'CHECKOUT_STARTED',
      'PAYMENT_PENDING',
      'PAID',
      'FULFILLMENT_QUEUED',
      'FULFILLING',
      'SHIPPED',
      'DELIVERED',
    ];
    for (let i = 0; i < path.length - 1; i += 1) {
      expect(canTransition(path[i]!, path[i + 1]!)).toBe(true);
    }
  });

  it('treats a repeated identical transition as legal, so duplicate webhooks are idempotent', () => {
    for (const status of ORDER_STATUSES) {
      expect(canTransition(status, status)).toBe(true);
    }
  });

  it('accepts payment arriving before we recorded checkout start', () => {
    // A provider webhook can beat our own write. Rejecting it would strand a
    // real captured payment with no order record.
    expect(canTransition('CREATED', 'PAID')).toBe(true);
    expect(canTransition('CREATED', 'PAYMENT_PENDING')).toBe(true);
    expect(canTransition('CREATED', 'PAYMENT_FAILED')).toBe(true);
  });

  it('refuses transitions that make no business sense', () => {
    expect(canTransition('REFUNDED', 'SHIPPED')).toBe(false);
    expect(canTransition('CREATED', 'DELIVERED')).toBe(false);
    expect(canTransition('RETURNED', 'FULFILLING')).toBe(false);
    expect(canTransition('DELIVERED', 'PAYMENT_PENDING')).toBe(false);
  });

  it('throws a ConflictError naming the allowed transitions', () => {
    expect(() => assertTransition('REFUNDED', 'SHIPPED', 'ord_1')).toThrow(ConflictError);
    try {
      assertTransition('REFUNDED', 'SHIPPED', 'ord_1');
    } catch (error) {
      expect((error as Error).message).toContain('Illegal order transition REFUNDED -> SHIPPED');
      expect((error as Error).message).toContain('Allowed:');
    }
  });

  it('always offers MANUAL_REVIEW as an escape hatch', () => {
    for (const status of ORDER_STATUSES) {
      if (status === 'MANUAL_REVIEW') continue;
      expect(ORDER_TRANSITIONS[status]).toContain('MANUAL_REVIEW');
    }
  });

  it('lets MANUAL_REVIEW return to any state, since a human decided', () => {
    for (const status of ORDER_STATUSES) {
      expect(canTransition('MANUAL_REVIEW', status)).toBe(true);
    }
  });

  it('every declared target status is itself a known status', () => {
    for (const targets of Object.values(ORDER_TRANSITIONS)) {
      for (const target of targets) {
        expect(ORDER_STATUSES).toContain(target);
      }
    }
  });

  it('lists no redundant self-transitions, since identity is always permitted', () => {
    for (const [from, targets] of Object.entries(ORDER_TRANSITIONS)) {
      // MANUAL_REVIEW is the deliberate exception: it spreads every status so a
      // human can route an order anywhere, including back to manual review.
      if (from === 'MANUAL_REVIEW') continue;
      expect(targets).not.toContain(from);
    }
  });
});

describe('out-of-order webhook protection', () => {
  it('detects a late payment_intent.processing arriving after PAID', () => {
    expect(isStaleTransition('PAID', 'PAYMENT_PENDING')).toBe(true);
  });

  it('detects a late checkout event arriving after shipment', () => {
    expect(isStaleTransition('SHIPPED', 'CHECKOUT_STARTED')).toBe(true);
  });

  it('does not flag genuine forward progress', () => {
    expect(isStaleTransition('PAID', 'FULFILLMENT_QUEUED')).toBe(false);
    expect(isStaleTransition('SHIPPED', 'DELIVERED')).toBe(false);
  });

  it('does not flag an exceptional branch that is genuinely later', () => {
    expect(isStaleTransition('DELIVERED', 'REFUND_REQUESTED')).toBe(false);
    expect(isStaleTransition('PAID', 'DISPUTED')).toBe(false);
  });
});

describe('order totals', () => {
  it('sums line items and applies shipping and discount correctly', () => {
    const totals = computeOrderTotals(
      [
        { subtotalMinor: 4700, taxMinor: 388, discountMinor: 0 },
        { subtotalMinor: 2350, taxMinor: 194, discountMinor: 500 },
      ],
      699,
    );
    expect(totals.subtotalMinor).toBe(7050);
    expect(totals.taxMinor).toBe(582);
    expect(totals.discountMinor).toBe(500);
    expect(totals.shippingMinor).toBe(699);
    expect(totals.totalMinor).toBe(7050 + 582 + 699 - 500);
  });
});

describe('refund ceilings', () => {
  it('never permits refunding more than was captured', () => {
    expect(maxRefundableMinor({ amountPaidMinor: 4700, amountRefundedMinor: 0 })).toBe(4700);
    expect(maxRefundableMinor({ amountPaidMinor: 4700, amountRefundedMinor: 2000 })).toBe(2700);
    expect(maxRefundableMinor({ amountPaidMinor: 4700, amountRefundedMinor: 4700 })).toBe(0);
  });

  it('clamps at zero rather than returning a negative ceiling', () => {
    expect(maxRefundableMinor({ amountPaidMinor: 1000, amountRefundedMinor: 1500 })).toBe(0);
  });

  it('reaches REFUNDED only when the full captured amount is returned', () => {
    expect(statusAfterRefund({ amountPaidMinor: 4700, amountRefundedMinor: 0 }, 2000)).toBe('PARTIALLY_REFUNDED');
    expect(statusAfterRefund({ amountPaidMinor: 4700, amountRefundedMinor: 2000 }, 2700)).toBe('REFUNDED');
  });
});

describe('payment routing compliance', () => {
  it('refuses to route a physical good through a digital-goods merchant of record', () => {
    expect(() => assertPaymentRoute('physical_good', 'dodo_merchant_of_record')).toThrow(ConflictError);
    expect(() => assertPaymentRoute('physical_good', 'whop_checkout')).toThrow(ConflictError);
  });

  it('allows the routes each provider actually supports', () => {
    expect(() => assertPaymentRoute('physical_good', 'stripe_direct')).not.toThrow();
    expect(() => assertPaymentRoute('digital_good', 'dodo_merchant_of_record')).not.toThrow();
    expect(() => assertPaymentRoute('subscription', 'dodo_merchant_of_record')).not.toThrow();
    expect(() => assertPaymentRoute('membership', 'whop_checkout')).not.toThrow();
  });

  it('explains why, so the refusal is actionable rather than mysterious', () => {
    try {
      assertPaymentRoute('physical_good', 'dodo_merchant_of_record');
    } catch (error) {
      expect((error as Error).message).toContain('Merchant of Record');
      expect((error as Error).message).toContain('stripe_direct');
    }
  });
});
