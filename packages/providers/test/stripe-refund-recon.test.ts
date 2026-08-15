/**
 * Stripe refund and reconciliation facades.
 *
 * These are pure mappings over documented Stripe object shapes. They do not
 * call the network and they do not invent amounts.
 */

import { describe, expect, it } from 'vitest';
import {
  listedPaymentFromStripeCharge,
  mapStripeRefundToFacade,
  shippingAddressFromStripe,
  StripeAdapter,
} from '../src/stripe/index.js';
import type { StripeCharge, StripeRefund } from '../src/stripe/schemas.js';

describe('StripeAdapter.refund facade', () => {
  it('exposes refund() for RefundService', () => {
    expect(typeof StripeAdapter.prototype.refund).toBe('function');
  });

  it('maps a Stripe refund onto { refundId, status, amountMinor }', () => {
    const refund = {
      id: 're_test_a1',
      object: 'refund',
      status: 'succeeded',
      amount: 2000,
      currency: 'usd',
      charge: 'ch_test_a1',
      payment_intent: 'pi_test_a1',
      created: 1,
    } satisfies StripeRefund;
    expect(mapStripeRefundToFacade(refund)).toEqual({
      refundId: 're_test_a1',
      status: 'succeeded',
      amountMinor: 2000,
    });
  });

  it('does not invent a succeeded status when Stripe omitted one', () => {
    const refund = {
      id: 're_test_a1',
      object: 'refund',
      amount: 2000,
      currency: 'usd',
      created: 1,
    } satisfies StripeRefund;
    expect(mapStripeRefundToFacade(refund).status).toBe('pending');
    expect(mapStripeRefundToFacade(refund).amountMinor).toBe(2000);
  });
});

describe('listedPaymentFromStripeCharge', () => {
  it('prefers the payment intent id so RefundService can look the row up', () => {
    const charge = {
      id: 'ch_test_a1',
      object: 'charge',
      status: 'succeeded',
      paid: true,
      amount: 5787,
      amount_refunded: 0,
      currency: 'usd',
      payment_intent: 'pi_test_a1',
      balance_transaction: { id: 'txn_1', fee: 198, net: 5589, currency: 'usd' },
      created: 1,
    } satisfies StripeCharge;
    expect(listedPaymentFromStripeCharge(charge)).toEqual({
      externalId: 'pi_test_a1',
      amountMinor: 5787,
      currency: 'usd',
      status: 'succeeded',
      feeMinor: 198,
      netMinor: 5589,
    });
  });

  it('falls back to the charge id and reports a null fee when unsettled', () => {
    const charge = {
      id: 'ch_test_a1',
      object: 'charge',
      status: 'succeeded',
      paid: true,
      amount: 5787,
      amount_refunded: 0,
      currency: 'usd',
      balance_transaction: 'txn_1',
      created: 1,
    } satisfies StripeCharge;
    const listed = listedPaymentFromStripeCharge(charge);
    expect(listed.externalId).toBe('ch_test_a1');
    expect(listed.feeMinor).toBeNull();
    expect(listed.netMinor).toBeNull();
  });
});

describe('shippingAddressFromStripe', () => {
  it('maps a complete Stripe shipping object onto Address', () => {
    expect(
      shippingAddressFromStripe({
        name: 'A Buyer',
        address: {
          line1: '1 Main St',
          line2: 'Ste 2',
          city: 'Austin',
          state: 'TX',
          postal_code: '78701',
          country: 'US',
        },
      }),
    ).toEqual({
      name: 'A Buyer',
      line1: '1 Main St',
      line2: 'Ste 2',
      city: 'Austin',
      state: 'TX',
      postalCode: '78701',
      country: 'US',
      phone: null,
    });
  });

  it('returns null rather than inventing missing fields', () => {
    expect(shippingAddressFromStripe({ name: 'A', address: { city: 'Austin' } })).toBeNull();
    expect(shippingAddressFromStripe(null)).toBeNull();
  });
});
