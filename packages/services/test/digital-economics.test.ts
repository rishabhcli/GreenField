/**
 * Unit economics for a digital product line.
 *
 * The point of these tests is the basis labelling, not the arithmetic. A
 * digital model has no supplier quote, so the only way it can clear the
 * grounded-ratio gate honestly is with a cost that was actually measured —
 * inference this company was really charged. Everything that was not measured
 * (per-unit hosting) must stay `assumption`, and nothing may be promoted to
 * `supplier_quote`, because no supplier ever quoted anything.
 */

import { describe, expect, it } from 'vitest';
import { GROUNDED_BASES, ValidationError, type CostComponent } from '@foundry/core';
import {
  DIGITAL_HOSTING_UNMEASURED_NOTE,
  LandedCostService,
  STRIPE_US_CARD_FEE_SCHEDULE,
} from '../src/sourcing/economics.js';
import type { ServiceDeps } from '../src/deps.js';

interface Recorded {
  readonly written: Array<Record<string, unknown>>;
  readonly windows: Date[];
}

function digitalDeps(options: {
  readonly pricedRuns?: number;
  readonly costMinorUsd?: number;
}): { deps: ServiceDeps; recorded: Recorded } {
  const written: Array<Record<string, unknown>> = [];
  const windows: Date[] = [];
  const deps = {
    repos: {
      agents: {
        runs: {
          observedInferenceCost: async (_companyId: string, since: Date) => {
            windows.push(since);
            return {
              pricedRuns: options.pricedRuns ?? 6,
              costMinorUsd: options.costMinorUsd ?? 219,
            };
          },
        },
      },
      sourcing: {
        quotes: {
          byId: async () => {
            throw new Error('a digital model must never look for a supplier quote');
          },
        },
        landedCosts: {
          write: async (input: Record<string, unknown>) => {
            written.push(input);
            return { id: 'cost_digital_1', ...input };
          },
        },
      },
    },
  } as unknown as ServiceDeps;
  return { deps, recorded: { written, windows } };
}

const BASE = {
  companyId: 'co_01M03F7RQW2M6540BY2GZHCFBW',
  opportunityId: 'opp_1',
  currency: 'USD',
  destinationCountry: 'US',
};

describe('LandedCostService.buildDigital', () => {
  it('grounds the compute line in inference actually charged and leaves hosting assumed', async () => {
    const { deps, recorded } = digitalDeps({ pricedRuns: 6, costMinorUsd: 219 });
    const result = await new LandedCostService(deps).buildDigital({ ...BASE, sellingPriceMinor: 4900 });

    const components = (recorded.written[0] as { components: CostComponent[] }).components;
    const inference = components.find((c) => c.kind === 'inference_compute');
    const hosting = components.find((c) => c.kind === 'hosting_delivery');

    expect(inference?.basis).toBe('observed_actual');
    expect(GROUNDED_BASES.has(inference!.basis)).toBe(true);
    expect(inference?.sourceRef).toBe('agent_runs.cost_minor_usd');
    // 219 minor USD over 6 priced runs = $0.365 per unit. Measured, not chosen.
    expect(inference?.amount).toBe('0.365000');
    expect(String(inference?.note)).toMatch(/219 minor USD actually charged across 6 priced agent runs/);

    expect(hosting?.basis).toBe('assumption');
    expect(GROUNDED_BASES.has(hosting!.basis)).toBe(false);
    expect(hosting?.note).toBe(DIGITAL_HOSTING_UNMEASURED_NOTE);
    expect(result.assumedComponents).toEqual(['hosting_delivery']);
  });

  it('never labels a digital cost as a supplier quote, and stores no quote id', async () => {
    const { deps, recorded } = digitalDeps({});
    await new LandedCostService(deps).buildDigital({ ...BASE, sellingPriceMinor: 4900 });

    const model = recorded.written[0] as { quoteId: unknown; incoterm: unknown; components: CostComponent[] };
    expect(model.quoteId).toBeNull();
    expect(model.incoterm).toBe('not_applicable');
    expect(model.components.some((c) => c.basis === 'supplier_quote')).toBe(false);
    expect(model.components.some((c) => c.kind === 'unit_manufacturing')).toBe(false);
  });

  it('charges the published Stripe schedule as a contract rate, not an assumption', async () => {
    const { deps } = digitalDeps({});
    const result = await new LandedCostService(deps).buildDigital({ ...BASE, sellingPriceMinor: 4900 });

    const fee = result.contribution?.byComponent.find((c) => c.kind === 'payment_processing_fee');
    expect(fee?.basis).toBe(STRIPE_US_CARD_FEE_SCHEDULE.basis);
    expect(fee?.basis).toBe('contract_rate');
    // 2.9% of $49.00 + $0.30 = $1.721
    expect(fee?.amount.toString()).toBe('1.721000');

    // The landed line is demoted to `assumption` at the contribution layer
    // because one of its components (hosting) was never measured — the same
    // demotion the physical path applies when freight is unquoted. A digital
    // model must not read as fully grounded on the strength of the one number
    // that was measured.
    const landedLine = result.contribution?.byComponent.find((c) => c.kind === 'landed_unit_cost');
    expect(landedLine?.basis).toBe('assumption');
    expect(result.contribution?.assumedComponents).toEqual(['landed_unit_cost']);
  });

  it('clears the gate on measured compute and reports the margin it actually computed', async () => {
    const { deps } = digitalDeps({});
    const result = await new LandedCostService(deps).buildDigital({ ...BASE, sellingPriceMinor: 4900 });

    // Hosting is carried at zero, so the grounded ratio is not diluted by a cost
    // nobody measured — but the component is still listed as assumed.
    expect(result.groundedRatio).toBe(1);
    expect(result.passesMarginGate).toBe(true);
    expect(result.complete).toBe(true);
    expect(result.contributionMarginRatio).toBeGreaterThan(0.25);
    expect(result.notes.join(' ')).toMatch(/no supplier quote exists or is required/i);
  });

  it('refuses to build when no inference has been charged, rather than estimating compute', async () => {
    const { deps, recorded } = digitalDeps({ pricedRuns: 0, costMinorUsd: 0 });
    await expect(
      new LandedCostService(deps).buildDigital({ ...BASE, sellingPriceMinor: 4900 }),
    ).rejects.toThrow(/cannot be measured|Refusing to estimate/i);
    expect(recorded.written).toEqual([]);
  });

  it('refuses when no selling price is stated, so contribution is not silently skipped', async () => {
    const { deps, recorded } = digitalDeps({});
    await expect(
      new LandedCostService(deps).buildDigital({ ...BASE, sellingPriceMinor: null }),
    ).rejects.toThrow(/incomplete|selling price/i);
    expect(recorded.written).toEqual([]);
  });

  it('refuses when the price cannot cover measured compute plus the payment fee', async () => {
    const { deps, recorded } = digitalDeps({ pricedRuns: 1, costMinorUsd: 5_000 });
    await expect(
      new LandedCostService(deps).buildDigital({ ...BASE, sellingPriceMinor: 500 }),
    ).rejects.toThrow(ValidationError);
    expect(recorded.written).toEqual([]);
  });

  it('refuses to restate a USD-measured inference cost in another currency', async () => {
    const { deps, recorded } = digitalDeps({});
    await expect(
      new LandedCostService(deps).buildDigital({ ...BASE, currency: 'EUR', sellingPriceMinor: 4900 }),
    ).rejects.toThrow(/FX rate/i);
    expect(recorded.written).toEqual([]);
  });

  it('rejects a caller-supplied component that claims to be quoted', async () => {
    const { deps, recorded } = digitalDeps({});
    const fake: CostComponent = {
      kind: 'packaging',
      amount: '1.000000',
      currency: 'USD',
      basis: 'supplier_quote',
      sourceRef: 'quote_that_does_not_exist',
      note: null,
    };
    await expect(
      new LandedCostService(deps).buildDigital({ ...BASE, sellingPriceMinor: 4900, assumedComponents: [fake] }),
    ).rejects.toThrow(/cannot carry basis "supplier_quote"/i);
    expect(recorded.written).toEqual([]);
  });

  it('measures inference over the requested window', async () => {
    const { deps, recorded } = digitalDeps({});
    const before = Date.now();
    await new LandedCostService(deps).buildDigital({
      ...BASE,
      sellingPriceMinor: 4900,
      inferenceWindowDays: 7,
    });
    const since = recorded.windows[0]!;
    const days = (before - since.getTime()) / (24 * 60 * 60 * 1000);
    expect(days).toBeGreaterThan(6.9);
    expect(days).toBeLessThan(7.1);
  });
});
