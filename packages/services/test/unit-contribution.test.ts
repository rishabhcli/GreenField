/**
 * Arm decisions must use modelled unit contribution. A hardcoded 0 makes the
 * 3× kill threshold 3¢ and will kill every arm.
 */

import { describe, expect, it } from 'vitest';
import type { ServiceDeps } from '../src/deps.js';
import { resolveUnitContributionMinor } from '../src/sourcing/economics.js';

const COMPANY = 'co_01M03F7RQW2M6540BY2GZHCFBW';
const OPP = 'opp_01CONTRIB0000000000000000';

function deps(options: {
  readonly selectedOpportunityId?: string | null;
  readonly products?: readonly { price_minor: number; currency: string; opportunity_id: string | null; landed_cost_model_id: string | null }[];
  readonly landed?: { landed_unit_cost: string; currency: string; quote_id: string | null } | null;
}): ServiceDeps {
  return {
    repos: {
      companies: {
        byId: async () => ({
          id: COMPANY,
          selected_opportunity_id: options.selectedOpportunityId ?? OPP,
        }),
      },
      commerce: {
        products: {
          listActive: async () => options.products ?? [],
        },
      },
      research: {
        opportunities: {
          byId: async () => ({
            id: OPP,
            assumed_selling_price_cents: 9900,
            currency: 'USD',
          }),
        },
      },
      sourcing: {
        landedCosts: {
          latestForOpportunity: async () => options.landed ?? undefined,
          byId: async () => options.landed,
          listForCompany: async () => (options.landed ? [options.landed] : []),
        },
      },
    },
  } as unknown as ServiceDeps;
}

describe('resolveUnitContributionMinor', () => {
  it('returns null when no landed-cost model exists rather than 0', async () => {
    const minor = await resolveUnitContributionMinor(deps({ landed: null, products: [{ price_minor: 9900, currency: 'USD', opportunity_id: OPP, landed_cost_model_id: null }] }), COMPANY);
    expect(minor).toBeNull();
  });

  it('subtracts landed unit cost from the active SKU price', async () => {
    const minor = await resolveUnitContributionMinor(
      deps({
        products: [
          {
            price_minor: 9900,
            currency: 'USD',
            opportunity_id: OPP,
            landed_cost_model_id: 'cost_1',
          },
        ],
        landed: { landed_unit_cost: '12.000000', currency: 'USD', quote_id: 'quote_1', assumed_components: [] },
      }),
      COMPANY,
    );
    expect(minor).toBeGreaterThan(0);
    expect(minor).toBeLessThan(9900);
  });
});
