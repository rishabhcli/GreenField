/**
 * Dodo Payments event → order transition mapping.
 *
 * Fixtures are built from the documented Dodo webhook object shapes (OpenAPI
 * examples verified 2026-08-15). They are test inputs for a pure function, not
 * stand-ins for production data: nothing here is ever presented as a real
 * order or a real payment.
 *
 * The double-credit test is the important one. Dodo delivers
 * `payment.succeeded` together with `subscription.renewed` (and recovery
 * events) for the same funds. If more than one of those carried the amount,
 * the order would be credited twice.
 */

import { describe, expect, it } from 'vitest';
import { canTransition, type OrderStatus } from '@foundry/core';
import { DODO_MANIFEST } from '@foundry/providers';
import { HANDLED_DODO_EVENTS, mapDodoEventToOrderTransition } from '../src/dodo/events.js';

function payment(overrides: Record<string, unknown> = {}) {
  return {
    payment_id: 'pay_test_a1',
    total_amount: 4000,
    currency: 'USD',
    status: 'succeeded',
    metadata: { internal_order_id: 'ord_01ABC' },
    checkout_session_id: 'cks_test_a1',
    tax: 0,
    settlement_amount: 4000,
    settlement_currency: 'USD',
    payload_type: 'Payment',
    ...overrides,
  };
}

function refund(overrides: Record<string, unknown> = {}) {
  return {
    refund_id: 're_dodo_test_a1',
    payment_id: 'pay_test_a1',
    amount: 1500,
    currency: 'USD',
    status: 'succeeded',
    is_partial: true,
    reason: 'requested_by_customer',
    metadata: { internal_order_id: 'ord_01ABC' },
    payload_type: 'Refund',
    ...overrides,
  };
}

function dispute(overrides: Record<string, unknown> = {}) {
  return {
    dispute_id: 'dsp_test_a1',
    payment_id: 'pay_test_a1',
    amount: '4000',
    currency: 'USD',
    dispute_status: 'dispute_opened',
    dispute_stage: 'dispute',
    payload_type: 'Dispute',
    ...overrides,
  };
}

function subscription(overrides: Record<string, unknown> = {}) {
  return {
    subscription_id: 'sub_test_a1',
    status: 'active',
    currency: 'USD',
    metadata: { internal_order_id: 'ord_01ABC' },
    payload_type: 'Subscription',
    ...overrides,
  };
}

/* -------------------------------------------------------------------------- */

describe('coverage of the declared event list', () => {
  it('handles every event the manifest says we subscribe to', () => {
    const declared = DODO_MANIFEST.webhooks?.[0]?.events ?? [];
    expect(declared.length).toBeGreaterThan(0);
    const unhandled = declared.filter((e) => !HANDLED_DODO_EVENTS.includes(e));
    expect(unhandled, `manifest declares events with no mapping: ${unhandled.join(', ')}`).toHaveLength(0);
  });

  it('does not claim to handle events the manifest never subscribes to', () => {
    const declared = new Set(DODO_MANIFEST.webhooks?.[0]?.events ?? []);
    const extra = HANDLED_DODO_EVENTS.filter((e) => !declared.has(e));
    expect(extra, `mapper handles undeclared events: ${extra.join(', ')}`).toHaveLength(0);
  });

  it('reports an unknown event as unhandled rather than guessing', () => {
    const result = mapDodoEventToOrderTransition('payout.success', {});
    expect(result.action).toBe('unhandled');
    if (result.action === 'unhandled') expect(result.reason).toContain('no mapping');
  });
});

/* -------------------------------------------------------------------------- */

describe('payment events', () => {
  it('succeeded moves the order to PAID with the full amount', () => {
    const result = mapDodoEventToOrderTransition('payment.succeeded', payment());
    expect(result.action).toBe('transition');
    if (result.action !== 'transition') return;
    expect(result.intent.orderStatus).toBe('PAID');
    expect(result.intent.amountPaidDeltaMinor).toBe(4000);
    expect(result.intent.externalIds['internal_order_id']).toBe('ord_01ABC');
    expect(result.intent.externalIds['checkout_session_id']).toBe('cks_test_a1');
    expect(result.intent.externalIds['payment_id']).toBe('pay_test_a1');
  });

  it('failed marks the order PAYMENT_FAILED without crediting', () => {
    const result = mapDodoEventToOrderTransition(
      'payment.failed',
      payment({ status: 'failed', error_code: 'card_declined', error_message: 'Card declined' }),
    );
    if (result.action !== 'transition') throw new Error('expected transition');
    expect(result.intent.orderStatus).toBe('PAYMENT_FAILED');
    expect(result.intent.amountPaidDeltaMinor).toBeUndefined();
    expect(result.intent.detail['errorCode']).toBe('card_declined');
  });

  it('processing means pending, not paid', () => {
    const result = mapDodoEventToOrderTransition('payment.processing', payment({ status: 'processing' }));
    if (result.action !== 'transition') throw new Error('expected transition');
    expect(result.intent.orderStatus).toBe('PAYMENT_PENDING');
    expect(result.intent.amountPaidDeltaMinor).toBeUndefined();
  });

  it('cancelled cancels the order without a money delta', () => {
    const result = mapDodoEventToOrderTransition('payment.cancelled', payment({ status: 'cancelled' }));
    if (result.action !== 'transition') throw new Error('expected transition');
    expect(result.intent.orderStatus).toBe('CANCELLED');
    expect(result.intent.amountPaidDeltaMinor).toBeUndefined();
  });

  it('locates the order via metadata.order_id when internal_order_id is absent', () => {
    const result = mapDodoEventToOrderTransition(
      'payment.succeeded',
      payment({ metadata: { order_id: 'ord_via_alias' } }),
    );
    if (result.action !== 'transition') throw new Error('expected transition');
    expect(result.intent.externalIds['order_id']).toBe('ord_via_alias');
    expect(result.intent.externalIds['internal_order_id']).toBe('ord_via_alias');
  });
});

/* -------------------------------------------------------------------------- */

describe('no double credit', () => {
  it('payment.succeeded is the only event that carries the paid amount', () => {
    const succeeded = mapDodoEventToOrderTransition('payment.succeeded', payment());
    const processing = mapDodoEventToOrderTransition('payment.processing', payment({ status: 'processing' }));
    const renewed = mapDodoEventToOrderTransition('subscription.renewed', subscription({ status: 'active' }));
    const recovered = mapDodoEventToOrderTransition('abandoned_checkout.recovered', {
      payment_id: 'pay_test_a1',
      payload_type: 'AbandonedCheckout',
    });
    const dunning = mapDodoEventToOrderTransition('dunning.recovered', { payment_id: 'pay_test_a1' });

    if (succeeded.action !== 'transition' || processing.action !== 'transition' || renewed.action !== 'transition') {
      throw new Error('expected transitions for payment/subscription events');
    }
    expect(recovered.action).toBe('ignore');
    expect(dunning.action).toBe('ignore');

    const total =
      (succeeded.intent.amountPaidDeltaMinor ?? 0) +
      (processing.intent.amountPaidDeltaMinor ?? 0) +
      (renewed.intent.amountPaidDeltaMinor ?? 0);
    expect(total).toBe(4000);
  });
});

/* -------------------------------------------------------------------------- */

describe('refund events', () => {
  it('a succeeded refund carries the amount exactly once', () => {
    const succeeded = mapDodoEventToOrderTransition('refund.succeeded', refund());
    const failed = mapDodoEventToOrderTransition('refund.failed', refund({ status: 'failed' }));
    if (succeeded.action !== 'transition' || failed.action !== 'transition') throw new Error('expected transitions');

    expect(succeeded.intent.amountRefundedDeltaMinor).toBe(1500);
    expect(succeeded.intent.orderStatus).toBe('PARTIALLY_REFUNDED');
    // Failure is an escalation, not a second refund of the same amount.
    expect(failed.intent.amountRefundedDeltaMinor).toBeUndefined();
    expect(failed.intent.orderStatus).toBe('MANUAL_REVIEW');
  });

  it('ledger lookup keys are the re_* refund id, not the payment id', () => {
    const result = mapDodoEventToOrderTransition('refund.succeeded', refund());
    if (result.action !== 'transition') throw new Error('expected transition');
    expect(result.intent.externalIds['refund_id']).toBe('re_dodo_test_a1');
    expect(result.intent.externalIds['refund']).toBe('re_dodo_test_a1');
    expect(result.intent.externalIds['refund']).not.toBe(result.intent.externalIds['payment_id']);
    expect(result.intent.detail['refundId']).toBe('re_dodo_test_a1');
  });

  it('does not invent a zero refund when the amount field is absent', () => {
    const result = mapDodoEventToOrderTransition('refund.succeeded', refund({ amount: null }));
    if (result.action !== 'transition') throw new Error('expected transition');
    expect(result.intent.amountRefundedDeltaMinor).toBeUndefined();
  });
});

/* -------------------------------------------------------------------------- */

describe('dispute events', () => {
  it('opened moves the order to DISPUTED without a money delta', () => {
    const result = mapDodoEventToOrderTransition('dispute.opened', dispute());
    if (result.action !== 'transition') throw new Error('expected transition');
    expect(result.intent.orderStatus).toBe('DISPUTED');
    expect(result.intent.amountPaidDeltaMinor).toBeUndefined();
    expect(result.intent.amountRefundedDeltaMinor).toBeUndefined();
    expect(result.intent.detail['amount']).toBe('4000');
  });

  it('lost is treated as money gone, still without a refund delta', () => {
    const result = mapDodoEventToOrderTransition('dispute.lost', dispute({ dispute_status: 'dispute_lost' }));
    if (result.action !== 'transition') throw new Error('expected transition');
    expect(result.intent.orderStatus).toBe('REFUNDED');
    expect(result.intent.amountRefundedDeltaMinor).toBeUndefined();
  });
});

/* -------------------------------------------------------------------------- */

describe('digital happy-path state machine', () => {
  it('processing → succeeded → refund.succeeded is a legal money path', () => {
    const processing = mapDodoEventToOrderTransition('payment.processing', payment({ status: 'processing' }));
    const succeeded = mapDodoEventToOrderTransition('payment.succeeded', payment());
    const refunded = mapDodoEventToOrderTransition('refund.succeeded', refund());
    if (
      processing.action !== 'transition' ||
      succeeded.action !== 'transition' ||
      refunded.action !== 'transition'
    ) {
      throw new Error('expected transitions');
    }

    let status: OrderStatus = 'CHECKOUT_STARTED';
    expect(processing.intent.orderStatus).toBe('PAYMENT_PENDING');
    expect(canTransition(status, 'PAYMENT_PENDING')).toBe(true);
    status = 'PAYMENT_PENDING';

    expect(succeeded.intent.orderStatus).toBe('PAID');
    expect(succeeded.intent.amountPaidDeltaMinor).toBe(4000);
    expect(canTransition(status, 'PAID')).toBe(true);
    status = 'PAID';

    expect(refunded.intent.orderStatus).toBe('PARTIALLY_REFUNDED');
    expect(refunded.intent.amountRefundedDeltaMinor).toBe(1500);
    expect(canTransition(status, 'PARTIALLY_REFUNDED')).toBe(true);
    expect(refunded.intent.externalIds['refund_id']).toMatch(/^re_/);
  });
});

describe('every mapping targets a reachable state', () => {
  it('produces statuses the order machine can actually reach from a live order', () => {
    const fixtures: [string, unknown][] = [
      ['payment.succeeded', payment()],
      ['refund.succeeded', refund()],
      ['dispute.opened', dispute()],
    ];
    const from: OrderStatus = 'PAID';
    for (const [type, payload] of fixtures) {
      const result = mapDodoEventToOrderTransition(type, payload);
      if (result.action !== 'transition' || result.intent.orderStatus === null) continue;
      expect(
        canTransition(from, result.intent.orderStatus),
        `${type} targets ${result.intent.orderStatus}, unreachable from ${from}`,
      ).toBe(true);
    }
  });
});
