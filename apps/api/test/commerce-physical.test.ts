import { describe, expect, it } from 'vitest';
import { ConflictError, ValidationError } from '@foundry/core';
import {
  assertCheckoutPaymentRoute,
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
