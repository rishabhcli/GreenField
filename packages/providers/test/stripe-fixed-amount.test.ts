import { describe, expect, it } from 'vitest';
import { ValidationError } from '@foundry/core';
import {
  HACKATHON_OFFER_PRICE_MINOR,
  paymentLinkAllowsCustomAmount,
  paymentLinkFixedAmountMinor,
  stripeCataloguePriceData,
  stripeFixedAmountShippingRate,
} from '../src/stripe/fixed-amount.js';

describe('paymentLinkAllowsCustomAmount', () => {
  it('fails closed when line items are missing', () => {
    expect(paymentLinkAllowsCustomAmount({})).toBe(true);
    expect(paymentLinkAllowsCustomAmount({ line_items: { data: [] } })).toBe(true);
  });

  it('fails closed when the price is an unexpanded id string', () => {
    expect(
      paymentLinkAllowsCustomAmount({
        line_items: { data: [{ price: 'price_unexpanded' }] },
      }),
    ).toBe(true);
  });

  it('detects custom_unit_amount.enabled', () => {
    expect(
      paymentLinkAllowsCustomAmount({
        line_items: {
          data: [{ price: { unit_amount: null, custom_unit_amount: { enabled: true } } }],
        },
      }),
    ).toBe(true);
  });

  it('accepts a single fixed unit amount', () => {
    const link = {
      line_items: {
        data: [{ price: { id: 'price_fixed', unit_amount: HACKATHON_OFFER_PRICE_MINOR } }],
      },
    };
    expect(paymentLinkAllowsCustomAmount(link)).toBe(false);
    expect(paymentLinkFixedAmountMinor(link)).toBe(HACKATHON_OFFER_PRICE_MINOR);
  });
});

describe('stripeFixedAmountShippingRate', () => {
  it('emits type fixed_amount only, never a calculated rate', () => {
    const option = stripeFixedAmountShippingRate({
      displayName: 'Standard',
      amountMinor: 699,
      currency: 'USD',
      minBusinessDays: 5,
      maxBusinessDays: 10,
    });
    expect(option.shipping_rate_data.type).toBe('fixed_amount');
    expect(option.shipping_rate_data.fixed_amount).toEqual({ amount: 699, currency: 'usd' });
    expect(option.shipping_rate_data).not.toHaveProperty('delivery_estimate', undefined);
    expect(JSON.stringify(option)).not.toContain('calculated');
  });

  it('refuses a negative shipping amount rather than inventing a rate', () => {
    expect(() =>
      stripeFixedAmountShippingRate({
        displayName: 'Standard',
        amountMinor: -1,
        currency: 'usd',
        minBusinessDays: 1,
        maxBusinessDays: 2,
      }),
    ).toThrow(ValidationError);
  });
});

describe('stripeCataloguePriceData', () => {
  it('puts the catalogue unit amount on the Price, never a custom_unit_amount', () => {
    const price = stripeCataloguePriceData({
      currency: 'USD',
      unitAmountMinor: 9900,
      name: 'Founding access',
      productId: 'prod_1',
      taxCode: 'txcd_99999999',
    });
    expect(price.unit_amount).toBe(9900);
    expect(price.product_data.tax_code).toBe('txcd_99999999');
    expect(price.tax_behavior).toBe('exclusive');
    expect(price).not.toHaveProperty('custom_unit_amount');
    expect(JSON.stringify(price)).not.toContain('custom_unit_amount');
  });

  it('refuses a zero or negative catalogue amount', () => {
    expect(() =>
      stripeCataloguePriceData({
        currency: 'usd',
        unitAmountMinor: 0,
        name: 'X',
        productId: 'prod_1',
      }),
    ).toThrow(ValidationError);
  });
});
