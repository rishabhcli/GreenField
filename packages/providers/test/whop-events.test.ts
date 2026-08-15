/**
 * Whop event → order transition mapping.
 *
 * Fixtures are built from the documented Whop webhook envelope (`type` plus a
 * `data` object) and the REST resource fields quoted in
 * `docs/research/SPONSOR_API_RESEARCH.md` section 4. They are test inputs for
 * a pure function, not stand-ins for production data.
 *
 * The double-credit test is the important one. Whop delivers `payment.created`
 * and then `payment.succeeded` for the same charge. Only `payment.succeeded`
 * may carry a money delta; otherwise a normal delivery sequence would credit
 * the order twice.
 */

import { describe, expect, it } from 'vitest';
import { WHOP_MANIFEST } from '../src/manifests.js';
import { HANDLED_WHOP_EVENTS, mapWhopEventToOrderTransition } from '../src/whop/events.js';

function payment(overrides: Record<string, unknown> = {}) {
  return {
    id: 'pay_test_a1',
    status: 'paid',
    substatus: 'succeeded',
    currency: 'usd',
    // Whop documents amounts as decimals in major units (10.43 for $10.43).
    total: 57.87,
    settlement_amount: 57.87,
    amount_after_fees: 55.89,
    metadata: { order_id: 'ord_01ABC', internal_order_id: 'ord_01ABC' },
    membership: { id: 'mem_test_a1' },
    checkout_configuration_id: 'ch_test_a1',
    company: { id: 'biz_test_a1' },
    created_at: '2026-08-10T17:03:24.291Z',
    ...overrides,
  };
}

function refund(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ref_test_a1',
    status: 'succeeded',
    amount: 20.0,
    currency: 'usd',
    payment: {
      id: 'pay_test_a1',
      metadata: { order_id: 'ord_01ABC', internal_order_id: 'ord_01ABC' },
    },
    created_at: '2026-08-10T18:00:00.000Z',
    ...overrides,
  };
}

/* -------------------------------------------------------------------------- */

describe('coverage of the declared event list', () => {
  it('handles every event the manifest says we subscribe to', () => {
    const declared = WHOP_MANIFEST.webhooks?.[0]?.events ?? [];
    expect(declared.length).toBeGreaterThan(0);
    const unhandled = declared.filter((e) => !HANDLED_WHOP_EVENTS.includes(e));
    expect(unhandled, `manifest declares events with no mapping: ${unhandled.join(', ')}`).toHaveLength(0);
  });

  it('reports an unknown event as unhandled rather than guessing', () => {
    const result = mapWhopEventToOrderTransition('invoice.paid', {});
    expect(result.action).toBe('unhandled');
    if (result.action === 'unhandled') expect(result.reason).toContain('no mapping');
  });

  it('does not map the retired membership.went_valid / went_invalid names', () => {
    expect(mapWhopEventToOrderTransition('membership.went_valid', {}).action).toBe('unhandled');
    expect(mapWhopEventToOrderTransition('membership.went_invalid', {}).action).toBe('unhandled');
  });
});

/* -------------------------------------------------------------------------- */

describe('payment events', () => {
  it('payment.succeeded moves the order to PAID with the full amount', () => {
    const result = mapWhopEventToOrderTransition('payment.succeeded', payment());
    expect(result.action).toBe('transition');
    if (result.action !== 'transition') return;
    expect(result.intent.orderStatus).toBe('PAID');
    expect(result.intent.kind).toBe('payment_captured');
    expect(result.intent.amountPaidDeltaMinor).toBe(5787);
    expect(result.intent.currency).toBe('usd');
    expect(result.intent.externalIds['order_id']).toBe('ord_01ABC');
    expect(result.intent.externalIds['internal_order_id']).toBe('ord_01ABC');
    expect(result.intent.externalIds['whop_payment']).toBe('pay_test_a1');
  });

  it('payment.failed marks the order failed without crediting money', () => {
    const result = mapWhopEventToOrderTransition(
      'payment.failed',
      payment({ status: 'open', substatus: 'failed', failure_message: 'card_declined', total: 57.87 }),
    );
    expect(result.action).toBe('transition');
    if (result.action !== 'transition') return;
    expect(result.intent.orderStatus).toBe('PAYMENT_FAILED');
    expect(result.intent.kind).toBe('payment_failed');
    expect(result.intent.amountPaidDeltaMinor).toBeUndefined();
  });

  it('payment.created without success does not credit the order', () => {
    const result = mapWhopEventToOrderTransition(
      'payment.created',
      payment({ status: 'pending', substatus: 'pending', paid_at: null }),
    );
    expect(result.action).toBe('transition');
    if (result.action !== 'transition') return;
    expect(result.intent.orderStatus).toBe('PAYMENT_PENDING');
    expect(result.intent.amountPaidDeltaMinor).toBeUndefined();
  });

  it('payment.created plus payment.succeeded credits the order exactly once', () => {
    const created = mapWhopEventToOrderTransition(
      'payment.created',
      payment({ status: 'pending', substatus: 'pending' }),
    );
    const succeeded = mapWhopEventToOrderTransition('payment.succeeded', payment());
    if (created.action !== 'transition' || succeeded.action !== 'transition') {
      throw new Error('expected transitions');
    }
    const total = (created.intent.amountPaidDeltaMinor ?? 0) + (succeeded.intent.amountPaidDeltaMinor ?? 0);
    expect(total).toBe(5787);
  });

  it('a payment.created that already looks paid still carries no amount', () => {
    // Only payment.succeeded is allowed to move money. Crediting here would
    // double-count when the succeeded event arrives next.
    const result = mapWhopEventToOrderTransition('payment.created', payment());
    expect(result.action).toBe('transition');
    if (result.action !== 'transition') return;
    expect(result.intent.amountPaidDeltaMinor).toBeUndefined();
  });
});

/* -------------------------------------------------------------------------- */

describe('refund events', () => {
  it('a succeeded refund.created carries the amount exactly once across created+updated', () => {
    const created = mapWhopEventToOrderTransition('refund.created', refund());
    const updated = mapWhopEventToOrderTransition('refund.updated', refund());
    if (created.action !== 'transition' || updated.action !== 'transition') {
      throw new Error('expected transitions');
    }
    expect(created.intent.amountRefundedDeltaMinor).toBe(2000);
    expect(created.intent.externalIds['order_id']).toBe('ord_01ABC');
    expect(updated.intent.amountRefundedDeltaMinor).toBeUndefined();
  });

  it('a pending refund.created does not deduct money yet', () => {
    const result = mapWhopEventToOrderTransition('refund.created', refund({ status: 'pending' }));
    expect(result.action).toBe('transition');
    if (result.action !== 'transition') return;
    expect(result.intent.orderStatus).toBe('REFUND_REQUESTED');
    expect(result.intent.amountRefundedDeltaMinor).toBeUndefined();
  });
});

/* -------------------------------------------------------------------------- */

describe('unhandled catalogue events', () => {
  it('product.created is recognised and ignored rather than guessed into an order transition', () => {
    const result = mapWhopEventToOrderTransition('product.created', { id: 'prod_test_a1', title: 'Membership' });
    expect(result.action).toBe('ignore');
  });
});
