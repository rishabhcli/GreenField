/**
 * The `source` and `model_economics` phases on a digital product line.
 *
 * The physical branch waits for `supplier_quotes.countGrounded > 0`. For a
 * digital product that artefact can never exist — there is no supplier — so the
 * phase completes with the reason recorded rather than parking forever. What
 * these tests pin is that completing is not the same as pretending: no supplier,
 * RFQ or quote is created, `performed` is false, and the physical branch is
 * unchanged.
 */

import { describe, expect, it } from 'vitest';
import type { Capability } from '@foundry/core';
import type { ServiceDeps } from '../src/deps.js';
import { LoopOrchestrator } from '../src/loop/orchestrator.js';

const COMPANY = 'co_01M03F7RQW2M6540BY2GZHCFBW';
const CYCLE = 'cyc_01DIGITALLINE00000000000';
const OPPORTUNITY = 'opp_01DIGITALLINE0000000000';

function cap(capability: Capability, usable: boolean) {
  return {
    capability,
    provider: 'test',
    state: usable ? 'live_verified' : 'unverifiable_no_public_api',
    usable,
    evidence: null,
    remediation: `${capability} has no live provider`,
    missingSecrets: [],
    lastVerifiedAt: null,
    alternatives: [],
  };
}

interface Harness {
  readonly loop: LoopOrchestrator;
  readonly dispatched: Array<{ toRoleKey: string }>;
  readonly written: Array<Record<string, unknown>>;
  readonly quoteLookups: string[];
}

function harness(options: {
  readonly productLine?: 'physical' | 'digital' | undefined;
  readonly groundedQuotes?: number;
  /** Mirrors the live matrix: no sourcing provider is usable. */
  readonly sourcingUsable?: boolean;
  readonly landedModels?: Array<{ grounded_ratio: number }>;
  readonly sellingPriceMinor?: number | null;
  readonly pricedRuns?: number;
  readonly inferenceCostMinorUsd?: number;
}): Harness {
  const dispatched: Array<{ toRoleKey: string }> = [];
  const written: Array<Record<string, unknown>> = [];
  const quoteLookups: string[] = [];

  const commerce: Record<string, unknown> = {
    baseCurrency: 'USD',
    sellsTo: ['US'],
    shipsFrom: ['US'],
    returnWindowDays: 30,
    whoPaysReturnShipping: 'depends_on_reason',
    warrantyOffered: false,
    warrantyTermMonths: null,
    taxCollectionEnabled: false,
    taxProvider: null,
  };
  if (options.productLine !== undefined) commerce.productLine = options.productLine;

  const deps = {
    repos: {
      companies: {
        byId: async () => ({
          id: COMPANY,
          selected_opportunity_id: OPPORTUNITY,
          active_site_id: null,
          config: { commerce },
        }),
      },
      sourcing: {
        quotes: {
          countGrounded: async () => options.groundedQuotes ?? 0,
          forOpportunity: async (id: string) => {
            quoteLookups.push(id);
            return [];
          },
        },
        landedCosts: {
          listForCompany: async () => options.landedModels ?? [],
          write: async (input: Record<string, unknown>) => {
            written.push(input);
            return { id: 'cost_1', ...input };
          },
        },
      },
      research: {
        opportunities: {
          byId: async () => ({
            id: OPPORTUNITY,
            assumed_selling_price_cents: options.sellingPriceMinor ?? 4900,
            currency: 'USD',
          }),
        },
      },
      agents: {
        runs: {
          observedInferenceCost: async () => ({
            pricedRuns: options.pricedRuns ?? 6,
            costMinorUsd: options.inferenceCostMinorUsd ?? 219,
          }),
        },
      },
    },
    capabilities: {
      summary: () => ({ usable: [], blocked: [] }),
      resolveCapability: (capability: Capability) => cap(capability, options.sourcingUsable ?? false),
    },
    dispatcher: {
      dispatch: async (input: { toRoleKey: string }) => {
        dispatched.push(input);
      },
      enqueueSystem: async (input: { toRoleKey: string }) => {
        dispatched.push(input);
      },
    },
    queues: { enqueue: async () => 'job' },
  } as unknown as ServiceDeps;

  return { loop: new LoopOrchestrator(deps), dispatched, written, quoteLookups };
}

describe('assess source — digital product line', () => {
  it('completes without a supplier quote and records why', async () => {
    const { loop } = harness({ productLine: 'digital' });
    const assessment = await loop.assess(COMPANY, 'source');

    expect(assessment.complete).toBe(true);
    expect(assessment.blockedOn).toBeUndefined();
    const source = (assessment.outputs as { source: Record<string, unknown> }).source;
    expect(source.performed).toBe(false);
    expect(source.productLine).toBe('digital');
    expect(String(source.reason)).toMatch(/no supplier/i);
    // The count is reported as it is, not asserted to be something it is not.
    expect(source.groundedQuoteCount).toBe(0);
  });

  it('does not fabricate a supplier, RFQ or quote to complete the phase', async () => {
    const { loop, written, dispatched } = harness({ productLine: 'digital' });
    await loop.assess(COMPANY, 'source');
    expect(written).toEqual([]);
    expect(dispatched).toEqual([]);
  });

  it('completes even though sourcing.supplier_search is unusable, because it is not waiting on it', async () => {
    const { loop } = harness({ productLine: 'digital', sourcingUsable: false });
    const assessment = await loop.assess(COMPANY, 'source');
    expect(assessment.complete).toBe(true);
    expect(assessment.blockedOn).toBeUndefined();
  });

  it('does not spend a sourcing manager run when the phase is forced', async () => {
    const { loop, dispatched } = harness({ productLine: 'digital' });
    expect(await loop.drive(COMPANY, CYCLE, 'source')).toBe(false);
    expect(dispatched).toEqual([]);
  });
});

describe('assess source — physical product line is unchanged', () => {
  it('still waits for the first supplier quote when sourcing is usable', async () => {
    const { loop } = harness({ productLine: 'physical', groundedQuotes: 0, sourcingUsable: true });
    const assessment = await loop.assess(COMPANY, 'source');
    expect(assessment.complete).toBe(false);
    expect(assessment.detail).toMatch(/awaiting the first supplier quote/i);
  });

  it('still blocks on the sourcing capability when no provider can find suppliers', async () => {
    const { loop } = harness({ productLine: 'physical', groundedQuotes: 0, sourcingUsable: false });
    const assessment = await loop.assess(COMPANY, 'source');
    expect(assessment.complete).toBe(false);
    expect(assessment.blockedOn?.capability).toBe('sourcing.supplier_search');
  });

  it('completes on real grounded quotes, as before', async () => {
    const { loop } = harness({ productLine: 'physical', groundedQuotes: 3, sourcingUsable: true });
    const assessment = await loop.assess(COMPANY, 'source');
    expect(assessment.complete).toBe(true);
    expect(assessment.outputs).toMatchObject({ source: { groundedQuoteCount: 3 } });
  });

  it('treats a config with no productLine field as physical', async () => {
    const { loop } = harness({ productLine: undefined, groundedQuotes: 0, sourcingUsable: true });
    const assessment = await loop.assess(COMPANY, 'source');
    expect(assessment.complete).toBe(false);
    expect(assessment.detail).toMatch(/awaiting the first supplier quote/i);
  });

  it('dispatches the sourcing manager on a physical line', async () => {
    const { loop, dispatched } = harness({ productLine: 'physical' });
    expect(await loop.drive(COMPANY, CYCLE, 'source')).toBe(true);
    expect(dispatched.map((d) => d.toRoleKey)).toEqual(['sourcing_manager']);
  });
});

describe('model_economics on a digital line', () => {
  it('reports what is missing in digital terms and does not claim completion', async () => {
    const { loop } = harness({ productLine: 'digital', landedModels: [] });
    const assessment = await loop.assess(COMPANY, 'model_economics');
    expect(assessment.complete).toBe(false);
    expect(assessment.detail).toMatch(/marginal cost of delivering a digital unit/i);
  });

  it('builds the model from measured inference rather than looking for quotes', async () => {
    const h = harness({ productLine: 'digital' });
    expect(await h.loop.drive(COMPANY, CYCLE, 'model_economics')).toBe(true);
    expect(h.quoteLookups).toEqual([]);
    expect(h.written).toHaveLength(1);
    const model = h.written[0] as { quoteId: unknown; incoterm: unknown; components: Array<{ kind: string }> };
    expect(model.quoteId).toBeNull();
    expect(model.incoterm).toBe('not_applicable');
    expect(model.components.map((c) => c.kind)).toEqual(['inference_compute', 'hosting_delivery']);
  });

  it('refuses to persist a model when no inference cost has ever been recorded', async () => {
    const h = harness({ productLine: 'digital', pricedRuns: 0, inferenceCostMinorUsd: 0 });
    expect(await h.loop.drive(COMPANY, CYCLE, 'model_economics')).toBe(false);
    expect(h.written).toEqual([]);
  });

  it('still reads quotes on a physical line', async () => {
    const h = harness({ productLine: 'physical' });
    await h.loop.drive(COMPANY, CYCLE, 'model_economics');
    expect(h.quoteLookups).toEqual([OPPORTUNITY]);
    expect(h.written).toEqual([]);
  });
});
