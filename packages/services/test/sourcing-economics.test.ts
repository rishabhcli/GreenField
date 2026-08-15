import { describe, expect, it } from 'vitest';
import {
  GROUNDED_BASES,
  ValidationError,
  computeContribution,
  computeLandedCost,
  type CostComponent,
  type LandedCostModel,
} from '@foundry/core';
import { asSupplierQuoteComponent, LandedCostService } from '../src/sourcing/economics.js';
import type { ServiceDeps } from '../src/deps.js';

const NOW = '2026-08-15T12:00:00.000Z';

function landedModel(components: CostComponent[]): LandedCostModel {
  return {
    id: 'cost_1',
    companyId: 'co_1',
    opportunityId: 'opp_1',
    quoteId: 'quote_1',
    orderQuantity: 1_000,
    currency: 'USD',
    destinationCountry: 'US',
    incoterm: 'FOB',
    hsCode: null,
    computedAt: NOW,
    components,
  };
}

describe('landed cost honesty', () => {
  it('keeps a grounded manufacturing quote distinct from assumed freight', () => {
    const quoted: CostComponent = {
      kind: 'unit_manufacturing',
      amount: '4.200000',
      currency: 'USD',
      basis: 'supplier_quote',
      sourceRef: 'quote_1',
      note: null,
    };
    const freight: CostComponent = {
      kind: 'international_freight',
      amount: '1.100000',
      currency: 'USD',
      basis: 'assumption',
      sourceRef: null,
      note: 'no Shippo rate; caller supplied assumption',
    };

    const result = computeLandedCost(landedModel([quoted, freight]));

    expect(result.byComponent.find((c) => c.kind === 'unit_manufacturing')?.basis).toBe('supplier_quote');
    expect(result.assumedComponents).toEqual(['international_freight']);
    expect(result.groundedRatio).toBeLessThan(1);
    expect(result.groundedRatio).toBeGreaterThan(0.7);
    expect(GROUNDED_BASES.has('assumption')).toBe(false);
  });

  it('refuses to treat an assumed unit cost as a supplier quote', () => {
    const assumedUnit: CostComponent = {
      kind: 'unit_manufacturing',
      amount: '4.200000',
      currency: 'USD',
      basis: 'assumption',
      sourceRef: null,
      note: 'model guess — supplier has not quoted',
    };

    const result = computeLandedCost(landedModel([assumedUnit]));
    expect(result.groundedRatio).toBe(0);
    expect(result.assumedComponents).toEqual(['unit_manufacturing']);
    expect(GROUNDED_BASES.has(assumedUnit.basis)).toBe(false);

    expect(() => asSupplierQuoteComponent(assumedUnit, 'quote_1')).toThrow(ValidationError);
    expect(() => asSupplierQuoteComponent(assumedUnit, 'quote_1')).toThrow(/supplier did not quote/i);

    const quoted: CostComponent = { ...assumedUnit, basis: 'supplier_quote', sourceRef: 'quote_1' };
    expect(asSupplierQuoteComponent(quoted, 'quote_1').basis).toBe('supplier_quote');
  });

  it('detects negative contribution when variable costs exceed price', () => {
    const result = computeContribution({
      netSellingPrice: '12.00',
      currency: 'USD',
      components: [
        { kind: 'landed_unit_cost', amount: '6.000000', basis: 'supplier_quote', sourceRef: 'quote_1', note: null },
        { kind: 'payment_processing_fee', amount: '0.648000', basis: 'contract_rate', sourceRef: 'stripe_us_card_published_schedule', note: '2.9% + $0.30' },
        { kind: 'ad_cac', amount: '8.000000', basis: 'assumption', sourceRef: null, note: 'unobserved CAC' },
      ],
    });

    expect(result.contributionMargin.isNegative).toBe(true);
    expect(result.contributionMarginRatio).toBeLessThan(0);
    expect(result.assumedComponents).toEqual(['ad_cac']);
  });
});

describe('LandedCostService.build', () => {
  it('refuses when the order quantity is outside quoted tiers', async () => {
    const calls: string[] = [];
    const deps = {
      repos: {
        sourcing: {
          quotes: {
            byId: async () => ({
              id: 'quote_1',
              company_id: 'co_1',
              rfq_id: 'rfq_1',
              supplier_id: 'sup_1',
              received_via: 'email_inbound',
              raw_response_ref: 'msg_1',
              received_at: new Date(NOW),
              currency: 'USD',
              price_tiers: [{ minQuantity: 500, maxQuantity: 999, unitPriceMinor: 520, currency: 'USD' }],
              moq: 500,
              sample_cost_minor: null,
              sample_lead_time_days: null,
              tooling_setup_cost_minor: 0,
              customisation_cost_per_unit_minor: 0,
              packaging_cost_per_unit_minor: 0,
              production_lead_time_days: 28,
              incoterm: 'FOB',
              origin_port: null,
              payment_terms: null,
              valid_until: null,
              notes: null,
              verified_by_engagement_id: null,
            }),
          },
          landedCosts: {
            write: async () => {
              calls.push('write');
              throw new Error('must not persist a model without a quoted unit cost');
            },
          },
        },
      },
      providers: {
        forCapability: () => ({
          adapter: undefined,
          status: { usable: false, state: 'blocked_missing_credentials', missingSecrets: [], provider: 'shippo', remediation: null },
        }),
      },
    } as unknown as ServiceDeps;

    const service = new LandedCostService(deps);
    await expect(
      service.build({
        companyId: 'co_1',
        opportunityId: 'opp_1',
        quoteId: 'quote_1',
        orderQuantity: 50,
        destinationCountry: 'US',
      }),
    ).rejects.toThrow(/outside the quoted price tiers/);
    expect(calls).not.toContain('write');
  });
});
