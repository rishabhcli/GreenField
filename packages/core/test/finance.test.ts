/**
 * Double-entry invariants: books balance, tax is a liability.
 */

import { describe, expect, it } from 'vitest';
import {
  LedgerEntry,
  ValidationError,
  assertBalanced,
  buildSaleTransaction,
  computeProfitAndLoss,
} from '@foundry/core';

describe('assertBalanced', () => {
  it('rejects a transaction whose legs do not net to zero', () => {
    expect(() =>
      assertBalanced({
        transactionId: 'tx_1',
        entries: [
          { account: 'cash_settled', amountMinor: 100, currency: 'USD', description: 'in' },
          { account: 'product_revenue', amountMinor: -90, currency: 'USD', description: 'out' },
        ],
      }),
    ).toThrow(ValidationError);
  });

  it('rejects a single-leg transaction even if the amount is zero', () => {
    expect(() =>
      assertBalanced({
        transactionId: 'tx_2',
        entries: [{ account: 'cash_settled', amountMinor: 0, currency: 'USD', description: 'noop' }],
      }),
    ).toThrow(/at least two legs/);
  });
});

describe('buildSaleTransaction', () => {
  it('books tax collected as a liability, never as revenue', () => {
    const tx = buildSaleTransaction({
      transactionId: 'tx_sale',
      currency: 'USD',
      productRevenueMinor: 1000,
      shippingRevenueMinor: 200,
      discountMinor: 50,
      taxCollectedMinor: 80,
      paymentFeeMinor: 40,
      landedCogsMinor: 300,
    });
    const tax = tx.entries.find((e) => e.account === 'tax_payable');
    expect(tax?.amountMinor).toBe(-80);
    expect(tx.entries.some((e) => e.account === 'product_revenue' && e.amountMinor === -80)).toBe(
      false,
    );
    expect(() => assertBalanced(tx)).not.toThrow();
  });
});

describe('computeProfitAndLoss', () => {
  it('presents credited revenue as a positive number', () => {
    const now = '2026-08-15T00:00:00.000Z';
    const tx = buildSaleTransaction({
      transactionId: 'tx_sale',
      currency: 'USD',
      productRevenueMinor: 1000,
      shippingRevenueMinor: 0,
      discountMinor: 0,
      taxCollectedMinor: 0,
      paymentFeeMinor: 0,
      landedCogsMinor: 400,
    });
    const entries = tx.entries.map((e, i) =>
      LedgerEntry.parse({
        id: `led_${i}`,
        companyId: 'co_1',
        transactionId: tx.transactionId,
        account: e.account,
        amountMinor: e.amountMinor,
        currency: e.currency,
        description: e.description,
        sourceType: 'order',
        sourceRefId: 'ord_1',
        settled: true,
        occurredAt: now,
        createdAt: now,
      }),
    );
    const pnl = computeProfitAndLoss(entries, 'USD');
    expect(pnl.revenueMinor).toBe(1000);
    expect(pnl.cogsMinor).toBe(400);
    expect(pnl.grossProfitMinor).toBe(600);
  });
});
