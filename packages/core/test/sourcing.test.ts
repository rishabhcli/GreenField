import { describe, expect, it } from 'vitest';
import {
  GROUNDED_BASES,
  Money,
  computeContribution,
  computeLandedCost,
  priceForTargetMargin,
  unitPriceForQuantity,
  type ContributionInput,
  type LandedCostModel,
  type SupplierQuote,
} from '@foundry/core';

const NOW = '2026-08-15T12:00:00.000Z';

function model(overrides: Partial<LandedCostModel> = {}): LandedCostModel {
  return {
    id: 'cost_1',
    companyId: 'co_1',
    opportunityId: 'opp_1',
    quoteId: 'quote_1',
    orderQuantity: 1_000,
    currency: 'USD',
    destinationCountry: 'US',
    incoterm: 'FOB',
    hsCode: '3924.90',
    computedAt: NOW,
    components: [
      { kind: 'unit_manufacturing', amount: '4.200000', currency: 'USD', basis: 'supplier_quote', sourceRef: 'quote_1', note: null },
      { kind: 'customisation', amount: '0.350000', currency: 'USD', basis: 'supplier_quote', sourceRef: 'quote_1', note: null },
      { kind: 'packaging', amount: '0.480000', currency: 'USD', basis: 'supplier_quote', sourceRef: 'quote_1', note: null },
      { kind: 'tooling_setup_allocated', amount: '0.192000', currency: 'USD', basis: 'supplier_quote', sourceRef: 'quote_1', note: '$4800/25000' },
      { kind: 'international_freight', amount: '1.100000', currency: 'USD', basis: 'provider_api', sourceRef: 'rate_1', note: null },
      { kind: 'duties_tariffs', amount: '0.294000', currency: 'USD', basis: 'assumption', sourceRef: null, note: '7% of FOB, HS not confirmed' },
      { kind: 'damage_loss_allowance', amount: '0.100000', currency: 'USD', basis: 'assumption', sourceRef: null, note: '2% allowance' },
    ],
    ...overrides,
  };
}

describe('landed cost', () => {
  it('sums components exactly at modelling precision', () => {
    const result = computeLandedCost(model());
    expect(result.landedUnitCost.toString()).toBe('6.716000');
  });

  it('scales to the whole production run without drift', () => {
    const result = computeLandedCost(model());
    expect(result.totalOrderCost.toString()).toBe('6716.000000');
  });

  it('reports the grounded ratio so assumptions are visible', () => {
    const result = computeLandedCost(model());
    // Quoted + API components dominate; duty and damage are assumptions.
    expect(result.groundedRatio).toBeGreaterThan(0.9);
    expect(result.groundedRatio).toBeLessThan(1);
    expect(result.assumedComponents).toEqual(['duties_tariffs', 'damage_loss_allowance']);
  });

  it('reports a grounded ratio of 1 when everything is quoted', () => {
    const grounded = model({
      components: model().components.map((c) => ({ ...c, basis: 'supplier_quote' as const, sourceRef: 'quote_1' })),
    });
    expect(computeLandedCost(grounded).groundedRatio).toBe(1);
    expect(computeLandedCost(grounded).assumedComponents).toHaveLength(0);
  });

  it('reports a grounded ratio of 0 when the whole model is guessed', () => {
    const guessed = model({
      components: model().components.map((c) => ({ ...c, basis: 'assumption' as const, sourceRef: null })),
    });
    expect(computeLandedCost(guessed).groundedRatio).toBe(0);
  });

  it('classifies exactly the bases that count as grounded', () => {
    expect([...GROUNDED_BASES].sort()).toEqual(['contract_rate', 'observed_actual', 'provider_api', 'supplier_quote']);
    expect(GROUNDED_BASES.has('assumption')).toBe(false);
  });
});

describe('contribution margin', () => {
  function contribution(overrides: Partial<ContributionInput> = {}): ContributionInput {
    return {
      netSellingPrice: '39.00',
      currency: 'USD',
      components: [
        { kind: 'landed_unit_cost', amount: '6.716000', basis: 'supplier_quote', sourceRef: 'cost_1', note: null },
        { kind: 'outbound_shipping_subsidy', amount: '5.400000', basis: 'provider_api', sourceRef: 'rate_2', note: null },
        { kind: 'payment_processing_fee', amount: '1.431000', basis: 'contract_rate', sourceRef: 'stripe', note: '2.9% + 30c' },
        { kind: 'expected_refunds_returns', amount: '1.170000', basis: 'observed_actual', sourceRef: 'hist', note: '3%' },
        { kind: 'ad_cac', amount: '14.000000', basis: 'observed_actual', sourceRef: 'exp_1', note: null },
        { kind: 'variable_support_cost', amount: '0.850000', basis: 'assumption', sourceRef: null, note: null },
      ],
      ...overrides,
    };
  }

  it('computes contribution and gross margin distinctly', () => {
    const result = computeContribution(contribution());
    // Gross excludes CAC and support; contribution includes them.
    expect(result.grossMargin.toString()).toBe('24.283000');
    expect(result.contributionMargin.toString()).toBe('9.433000');
    expect(result.grossMarginRatio).toBeGreaterThan(result.contributionMarginRatio);
  });

  it('shows a product that looks great on gross margin but is thin after CAC', () => {
    const result = computeContribution(contribution());
    expect(result.grossMarginRatio).toBeGreaterThan(0.6);
    expect(result.contributionMarginRatio).toBeLessThan(0.3);
  });

  it('goes negative when CAC exceeds the margin, and says so', () => {
    const result = computeContribution(
      contribution({
        components: contribution().components.map((c) =>
          c.kind === 'ad_cac' ? { ...c, amount: '30.000000' } : c,
        ),
      }),
    );
    expect(result.contributionMargin.isNegative).toBe(true);
    expect(result.contributionMarginRatio).toBeLessThan(0);
  });

  it('computes the break-even CAC the growth team must stay under', () => {
    const result = computeContribution(contribution());
    // Current contribution 9.433 with a 14.00 CAC means break-even CAC is 23.433.
    expect(result.breakEvenCac.toString()).toBe('23.433000');
  });

  it('tracks which variable costs are assumptions', () => {
    const result = computeContribution(contribution());
    expect(result.assumedComponents).toEqual(['variable_support_cost']);
    expect(result.groundedRatio).toBeGreaterThan(0.9);
  });

  it('handles a zero price without dividing by zero', () => {
    const result = computeContribution(contribution({ netSellingPrice: '0.00' }));
    expect(result.contributionMarginRatio).toBe(0);
    expect(result.grossMarginRatio).toBe(0);
  });
});

describe('priceForTargetMargin', () => {
  it('solves for the price that hits a target contribution ratio', () => {
    const fixed = Money.of('12.00', 'USD', 6);
    const flat = Money.of('0.30', 'USD', 6);
    const price = priceForTargetMargin(fixed, 290, flat, 0.35);
    // Verify by round-tripping through the contribution calculation.
    const fee = price.multiplyByDecimal('0.029').add(flat);
    const contribution = price.subtract(fixed).subtract(fee);
    expect(Money.ratio(contribution, price)).toBeGreaterThanOrEqual(0.35);
  });

  it('refuses an unreachable target', () => {
    expect(() => priceForTargetMargin(Money.of('10', 'USD'), 290, Money.of('0.30', 'USD'), 0.98)).toThrow();
    expect(() => priceForTargetMargin(Money.of('10', 'USD'), 290, Money.of('0.30', 'USD'), 1.2)).toThrow();
  });
});

describe('quote price tiers', () => {
  const quote: SupplierQuote = {
    id: 'quote_1',
    companyId: 'co_1',
    rfqId: 'rfq_1',
    supplierId: 'sup_1',
    receivedVia: 'email_inbound',
    rawResponseRef: 'msg_1',
    receivedAt: NOW,
    currency: 'USD',
    priceTiers: [
      { minQuantity: 500, maxQuantity: 999, unitPriceMinor: 520, currency: 'USD' },
      { minQuantity: 1000, maxQuantity: 4999, unitPriceMinor: 420, currency: 'USD' },
      { minQuantity: 5000, maxQuantity: null, unitPriceMinor: 350, currency: 'USD' },
    ],
    moq: 500,
    sampleCostMinor: 4500,
    sampleLeadTimeDays: 10,
    toolingSetupCostMinor: 480000,
    customisationCostPerUnitMinor: 35,
    packagingCostPerUnitMinor: 48,
    productionLeadTimeDays: 28,
    incoterm: 'FOB',
    originPort: 'Ningbo',
    paymentTerms: '30% deposit, 70% before shipment',
    validUntil: null,
    notes: null,
    verifiedByEngagementId: null,
    createdAt: NOW,
  };

  it('picks the correct tier for a quantity', () => {
    expect(unitPriceForQuantity(quote, 600)?.toString()).toBe('5.200000');
    expect(unitPriceForQuantity(quote, 1_000)?.toString()).toBe('4.200000');
    expect(unitPriceForQuantity(quote, 50_000)?.toString()).toBe('3.500000');
  });

  it('returns null below MOQ rather than inventing a price', () => {
    expect(unitPriceForQuantity(quote, 100)).toBeNull();
  });

  it('handles the open-ended top tier', () => {
    expect(unitPriceForQuantity(quote, 1_000_000)?.toString()).toBe('3.500000');
  });
});
