import { describe, expect, it } from 'vitest';
import { ConflictError, ValidationError } from '@foundry/core';
import {
  assertCheckoutPaymentRoute,
  buildPublicLinqStore,
  rejectCustomerTypedCheckoutAmount,
  trackedProductOutOfStock,
} from '../src/routes/commerce.js';

describe('physical checkout payment route', () => {
  it('throws when a physical good is routed through Dodo', () => {
    expect(() => assertCheckoutPaymentRoute('physical_good', 'dodo_merchant_of_record')).toThrow(
      ConflictError,
    );
  });

  it('allows Stripe for a physical good', () => {
    expect(() => assertCheckoutPaymentRoute('physical_good', 'stripe_direct')).not.toThrow();
  });
});

describe('customer-typed checkout amounts', () => {
  it('rejects a request that tries to set the price', () => {
    expect(() =>
      rejectCustomerTypedCheckoutAmount({
        items: [{ sku: 'zhc-founding', quantity: 1, priceMinor: 1 }],
        successUrl: 'https://shop.example.test/ok',
        cancelUrl: 'https://shop.example.test/no',
      }),
    ).toThrow(ValidationError);
  });

  it('rejects a top-level amountMinor', () => {
    expect(() =>
      rejectCustomerTypedCheckoutAmount({
        items: [{ sku: 'zhc-founding', quantity: 1 }],
        amountMinor: 9900,
        successUrl: 'https://shop.example.test/ok',
        cancelUrl: 'https://shop.example.test/no',
      }),
    ).toThrow(ValidationError);
  });

  it('allows catalogue checkout that only names sku and quantity', () => {
    expect(() =>
      rejectCustomerTypedCheckoutAmount({
        items: [{ sku: 'zhc-founding', quantity: 1 }],
        successUrl: 'https://shop.example.test/ok',
        cancelUrl: 'https://shop.example.test/no',
      }),
    ).not.toThrow();
  });
});

describe('public Linq store', () => {
  it('does not invent a number when LINQ_FROM_NUMBER is unset', () => {
    const store = buildPublicLinqStore({ linqNumber: null, messagingUsable: true });
    expect(store.linqNumber).toBeNull();
    expect(store.smsLink).toBeNull();
    expect(store.ready).toBe(false);
    expect(store.role).toBe('primary_consumer_store');
    expect(store.note).toMatch(/unpublished/i);
  });

  it('publishes an sms: link when the assigned line is present', () => {
    const store = buildPublicLinqStore({ linqNumber: '+14155550100', messagingUsable: true });
    expect(store.linqNumber).toBe('+14155550100');
    expect(store.smsLink).toBe('sms:+14155550100');
    expect(store.ready).toBe(true);
  });
});

describe('public dropship idea response', () => {
  it('refuses to carry an invented price or storefront', async () => {
    const { buildDropshipIdeaResponse } = await import('@foundry/services');
    const body = buildDropshipIdeaResponse({
      ticketId: 'tkt_1',
      intent: 'dropship_request',
      matches: [],
      sourcingQueued: true,
      note: 'We started sourcing.',
    });
    expect(body.invoiceUrl).toBeNull();
    expect(body.storefrontUrl).toBeNull();
    expect(body.priceMinor).toBeNull();
    expect(body.sourcingQueued).toBe(true);
  });
});

describe('tracked OOS reject', () => {
  it('rejects a tracked product with no remaining units', () => {
    expect(
      trackedProductOutOfStock(
        { sku: 'zhc-founding', inventory_policy: 'track', inventory_on_hand: 0, inventory_reserved: 0 },
        1,
      ),
    ).toBe(true);
  });
});
