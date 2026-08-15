/**
 * Stripe event → order transition mapping.
 *
 * Fixtures are built from the documented Stripe object shapes. They are test
 * inputs for a pure function, not stand-ins for production data: nothing here
 * is ever presented as a real order or a real payment.
 *
 * The double-credit test is the important one. Stripe delivers
 * `checkout.session.completed` and `payment_intent.succeeded` for the same
 * payment, and if both carried the amount the order would be credited twice.
 */

import { describe, expect, it } from 'vitest';
import { canTransition, type OrderStatus } from '@foundry/core';
import { HANDLED_STRIPE_EVENTS, mapStripeEventToOrderTransition } from '@foundry/providers';
import { STRIPE_MANIFEST } from '@foundry/providers';

const NOW = Math.floor(Date.now() / 1000);

function session(overrides: Record<string, unknown> = {}) {
  return {
    id: 'cs_test_a1',
    object: 'checkout.session',
    mode: 'payment',
    status: 'complete',
    payment_status: 'paid',
    url: null,
    client_reference_id: 'ord_01ABC',
    amount_subtotal: 4700,
    amount_total: 5787,
    currency: 'usd',
    total_details: { amount_discount: 0, amount_shipping: 699, amount_tax: 388 },
    payment_intent: 'pi_test_a1',
    metadata: { internal_order_id: 'ord_01ABC' },
    livemode: false,
    ...overrides,
  };
}

function paymentIntent(overrides: Record<string, unknown> = {}) {
  return {
    id: 'pi_test_a1',
    object: 'payment_intent',
    status: 'succeeded',
    amount: 5787,
    amount_received: 5787,
    currency: 'usd',
    latest_charge: 'ch_test_a1',
    metadata: { internal_order_id: 'ord_01ABC' },
    created: NOW,
    ...overrides,
  };
}

function charge(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ch_test_a1',
    object: 'charge',
    status: 'succeeded',
    paid: true,
    amount: 5787,
    amount_refunded: 0,
    currency: 'usd',
    payment_intent: 'pi_test_a1',
    balance_transaction: { id: 'txn_1', fee: 198, net: 5589, currency: 'usd' },
    payment_method_details: { type: 'card', card: { brand: 'visa', last4: '4242' } },
    outcome: { risk_level: 'normal', risk_score: 12, type: 'authorized' },
    created: NOW,
    ...overrides,
  };
}

function refund(overrides: Record<string, unknown> = {}) {
  return {
    id: 're_test_a1',
    object: 'refund',
    status: 'succeeded',
    amount: 2000,
    currency: 'usd',
    charge: 'ch_test_a1',
    payment_intent: 'pi_test_a1',
    reason: 'requested_by_customer',
    created: NOW,
    ...overrides,
  };
}

function dispute(overrides: Record<string, unknown> = {}) {
  return {
    id: 'dp_test_a1',
    object: 'dispute',
    amount: 5787,
    currency: 'usd',
    status: 'needs_response',
    reason: 'product_not_received',
    charge: 'ch_test_a1',
    payment_intent: 'pi_test_a1',
    evidence_details: { due_by: NOW + 604_800, has_evidence: false, past_due: false, submission_count: 0 },
    created: NOW,
    ...overrides,
  };
}

/* -------------------------------------------------------------------------- */

describe('coverage of the declared event list', () => {
  it('handles every event the manifest says we subscribe to', () => {
    const declared = STRIPE_MANIFEST.webhooks?.[0]?.events ?? [];
    expect(declared.length).toBeGreaterThan(0);
    const unhandled = declared.filter((e) => !HANDLED_STRIPE_EVENTS.includes(e));
    expect(unhandled, `manifest declares events with no mapping: ${unhandled.join(', ')}`).toHaveLength(0);
  });

  it('does not claim to handle events the manifest never subscribes to', () => {
    const declared = new Set(STRIPE_MANIFEST.webhooks?.[0]?.events ?? []);
    const extra = HANDLED_STRIPE_EVENTS.filter((e) => !declared.has(e));
    expect(extra, `mapper handles undeclared events: ${extra.join(', ')}`).toHaveLength(0);
  });

  it('reports an unknown event as unhandled rather than guessing', () => {
    const result = mapStripeEventToOrderTransition('invoice.paid', {});
    expect(result.action).toBe('unhandled');
    if (result.action === 'unhandled') expect(result.reason).toContain('no mapping');
  });
});

/* -------------------------------------------------------------------------- */

describe('checkout events', () => {
  it('a paid session moves the order to PAID with the full amount', () => {
    const result = mapStripeEventToOrderTransition('checkout.session.completed', session());
    expect(result.action).toBe('transition');
    if (result.action !== 'transition') return;
    expect(result.intent.orderStatus).toBe('PAID');
    expect(result.intent.amountPaidDeltaMinor).toBe(5787);
    expect(result.intent.externalIds['internal_order_id']).toBe('ord_01ABC');
    expect(result.intent.externalIds['stripe_payment_intent']).toBe('pi_test_a1');
  });

  it('a completed but unpaid session does NOT credit the order', () => {
    // Asynchronous methods complete the session while payment is still pending.
    // Treating that as paid would ship goods before the money arrives.
    const result = mapStripeEventToOrderTransition(
      'checkout.session.completed',
      session({ payment_status: 'unpaid' }),
    );
    expect(result.action).toBe('transition');
    if (result.action !== 'transition') return;
    expect(result.intent.orderStatus).toBe('PAYMENT_PENDING');
    expect(result.intent.amountPaidDeltaMinor).toBeUndefined();
  });

  it('an async payment succeeding credits the order', () => {
    const result = mapStripeEventToOrderTransition('checkout.session.async_payment_succeeded', session());
    expect(result.action).toBe('transition');
    if (result.action !== 'transition') return;
    expect(result.intent.orderStatus).toBe('PAID');
    expect(result.intent.amountPaidDeltaMinor).toBe(5787);
  });

  it('an async payment failing marks the order failed', () => {
    const result = mapStripeEventToOrderTransition(
      'checkout.session.async_payment_failed',
      session({ payment_status: 'unpaid' }),
    );
    if (result.action !== 'transition') throw new Error('expected transition');
    expect(result.intent.orderStatus).toBe('PAYMENT_FAILED');
  });

  it('an expired session cancels the order', () => {
    const result = mapStripeEventToOrderTransition(
      'checkout.session.expired',
      session({ status: 'expired', payment_status: 'unpaid' }),
    );
    if (result.action !== 'transition') throw new Error('expected transition');
    expect(result.intent.orderStatus).toBe('CANCELLED');
  });
});

/* -------------------------------------------------------------------------- */

describe('payment intent events', () => {
  it('succeeded confirms PAID but carries no amount, so the order is not credited twice', () => {
    const checkout = mapStripeEventToOrderTransition('checkout.session.completed', session());
    const intent = mapStripeEventToOrderTransition('payment_intent.succeeded', paymentIntent());

    if (checkout.action !== 'transition' || intent.action !== 'transition') throw new Error('expected transitions');

    const total =
      (checkout.intent.amountPaidDeltaMinor ?? 0) + (intent.intent.amountPaidDeltaMinor ?? 0);
    // Stripe sends both for one payment. Exactly one payment's worth may land.
    expect(total).toBe(5787);
  });

  it('payment_failed records the decline reason', () => {
    const result = mapStripeEventToOrderTransition(
      'payment_intent.payment_failed',
      paymentIntent({
        status: 'requires_payment_method',
        last_payment_error: { code: 'card_declined', message: 'Your card was declined.' },
      }),
    );
    if (result.action !== 'transition') throw new Error('expected transition');
    expect(result.intent.orderStatus).toBe('PAYMENT_FAILED');
    expect(result.intent.detail['code']).toBe('card_declined');
  });

  it('processing and requires_action both mean pending, not paid', () => {
    for (const [type, status] of [
      ['payment_intent.processing', 'processing'],
      ['payment_intent.requires_action', 'requires_action'],
    ] as const) {
      const result = mapStripeEventToOrderTransition(type, paymentIntent({ status }));
      if (result.action !== 'transition') throw new Error('expected transition');
      expect(result.intent.orderStatus).toBe('PAYMENT_PENDING');
      expect(result.intent.amountPaidDeltaMinor).toBeUndefined();
    }
  });

  it('canceled cancels the order', () => {
    const result = mapStripeEventToOrderTransition('payment_intent.canceled', paymentIntent({ status: 'canceled' }));
    if (result.action !== 'transition') throw new Error('expected transition');
    expect(result.intent.orderStatus).toBe('CANCELLED');
  });
});

/* -------------------------------------------------------------------------- */

describe('charge events', () => {
  it('succeeded records the fee and card details without changing status', () => {
    const result = mapStripeEventToOrderTransition('charge.succeeded', charge());
    if (result.action !== 'transition') throw new Error('expected transition');
    expect(result.intent.orderStatus).toBeNull();
    expect(result.intent.detail['feeMinor']).toBe(198);
    expect(result.intent.detail['netMinor']).toBe(5589);
    expect(result.intent.detail['cardLast4']).toBe('4242');
  });

  it('an unsettled balance transaction reports a null fee, never zero', () => {
    // A null fee means "not known yet". Recording it as 0 would overstate
    // contribution margin until the balance transaction settles.
    const result = mapStripeEventToOrderTransition('charge.succeeded', charge({ balance_transaction: 'txn_1' }));
    if (result.action !== 'transition') throw new Error('expected transition');
    expect(result.intent.detail['feeMinor']).toBeNull();
    expect(result.intent.detail['netMinor']).toBeNull();
  });

  it('charge.refunded records the cumulative total but carries no delta', () => {
    // Stripe's docs direct you to refund.created for the amount. If both
    // carried a delta a single refund would be booked twice.
    const result = mapStripeEventToOrderTransition('charge.refunded', charge({ amount_refunded: 2000 }));
    if (result.action !== 'transition') throw new Error('expected transition');
    expect(result.intent.amountRefundedDeltaMinor).toBeUndefined();
    expect(result.intent.detail['cumulativeAmountRefunded']).toBe(2000);
  });

  it('charge.failed marks the payment failed', () => {
    const result = mapStripeEventToOrderTransition('charge.failed', charge({ status: 'failed', paid: false }));
    if (result.action !== 'transition') throw new Error('expected transition');
    expect(result.intent.orderStatus).toBe('PAYMENT_FAILED');
  });
});

/* -------------------------------------------------------------------------- */

describe('refund events', () => {
  it('a succeeded refund carries the amount exactly once', () => {
    const created = mapStripeEventToOrderTransition('refund.created', refund());
    const updated = mapStripeEventToOrderTransition('refund.updated', refund());
    if (created.action !== 'transition' || updated.action !== 'transition') throw new Error('expected transitions');

    expect(created.intent.amountRefundedDeltaMinor).toBe(2000);
    // The update is a status change on an existing refund, not a second refund.
    expect(updated.intent.amountRefundedDeltaMinor).toBeUndefined();
  });

  it('a pending refund does not deduct money yet', () => {
    const result = mapStripeEventToOrderTransition('refund.created', refund({ status: 'pending' }));
    if (result.action !== 'transition') throw new Error('expected transition');
    expect(result.intent.orderStatus).toBe('REFUND_REQUESTED');
    expect(result.intent.amountRefundedDeltaMinor).toBeUndefined();
  });

  it('a failed refund escalates to manual review with a reason a human can act on', () => {
    const result = mapStripeEventToOrderTransition(
      'refund.failed',
      refund({ status: 'failed', failure_reason: 'expired_or_canceled_card' }),
    );
    if (result.action !== 'transition') throw new Error('expected transition');
    expect(result.intent.orderStatus).toBe('MANUAL_REVIEW');
    expect(result.intent.manualReviewReason).toContain('expects money back');
  });
});

/* -------------------------------------------------------------------------- */

describe('dispute events', () => {
  it('a new dispute moves the order to DISPUTED and records the evidence deadline', () => {
    const result = mapStripeEventToOrderTransition('charge.dispute.created', dispute());
    if (result.action !== 'transition') throw new Error('expected transition');
    expect(result.intent.orderStatus).toBe('DISPUTED');
    expect(result.intent.detail['evidenceDueBy']).toBeGreaterThan(NOW);
  });

  it('a lost dispute is treated as money gone', () => {
    const result = mapStripeEventToOrderTransition('charge.dispute.closed', dispute({ status: 'lost' }));
    if (result.action !== 'transition') throw new Error('expected transition');
    expect(result.intent.orderStatus).toBe('REFUNDED');
  });

  it('a won dispute goes to manual review rather than guessing the prior state', () => {
    const result = mapStripeEventToOrderTransition('charge.dispute.closed', dispute({ status: 'won' }));
    if (result.action !== 'transition') throw new Error('expected transition');
    expect(result.intent.orderStatus).toBe('MANUAL_REVIEW');
    expect(result.intent.manualReviewReason).toContain('won');
  });

  it('funds movement events are recorded without a status change', () => {
    for (const type of ['charge.dispute.funds_withdrawn', 'charge.dispute.funds_reinstated'] as const) {
      const result = mapStripeEventToOrderTransition(type, dispute());
      if (result.action !== 'transition') throw new Error('expected transition');
      expect(result.intent.orderStatus).toBeNull();
      expect(result.intent.detail['fundsMovement']).toBe(type);
    }
  });
});

/* -------------------------------------------------------------------------- */

describe('risk events', () => {
  it('an early fraud warning holds fulfilment', () => {
    const result = mapStripeEventToOrderTransition('radar.early_fraud_warning.created', {
      id: 'issfr_1',
      object: 'radar.early_fraud_warning',
      charge: 'ch_test_a1',
      fraud_type: 'made_with_stolen_card',
      actionable: true,
      created: NOW,
    });
    if (result.action !== 'transition') throw new Error('expected transition');
    expect(result.intent.orderStatus).toBe('MANUAL_REVIEW');
    expect(result.intent.manualReviewReason).toContain('Hold fulfilment');
  });

  it('review.opened holds the order and review.closed clears it', () => {
    const opened = mapStripeEventToOrderTransition('review.opened', {
      id: 'prv_1', object: 'review', charge: 'ch_test_a1', open: true, reason: 'rule', created: NOW,
    });
    const closed = mapStripeEventToOrderTransition('review.closed', {
      id: 'prv_1', object: 'review', charge: 'ch_test_a1', open: false, reason: 'approved', created: NOW,
    });
    if (opened.action !== 'transition' || closed.action !== 'transition') throw new Error('expected transitions');
    expect(opened.intent.orderStatus).toBe('MANUAL_REVIEW');
    expect(closed.intent.kind).toBe('manual_review_cleared');
    expect(closed.intent.orderStatus).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */

describe('every mapping targets a reachable state', () => {
  it('produces statuses the order machine can actually reach from a live order', () => {
    // Guards against a mapping that would always throw an illegal-transition
    // error at runtime. MANUAL_REVIEW is reachable from everywhere by design.
    const fixtures: [string, unknown][] = [
      ['checkout.session.completed', session()],
      ['checkout.session.async_payment_succeeded', session()],
      ['payment_intent.succeeded', paymentIntent()],
      ['charge.refunded', charge()],
      ['refund.created', refund()],
      ['charge.dispute.created', dispute()],
    ];
    const from: OrderStatus = 'PAID';
    for (const [type, payload] of fixtures) {
      const result = mapStripeEventToOrderTransition(type, payload);
      if (result.action !== 'transition' || result.intent.orderStatus === null) continue;
      expect(
        canTransition(from, result.intent.orderStatus),
        `${type} targets ${result.intent.orderStatus}, unreachable from ${from}`,
      ).toBe(true);
    }
  });
});
