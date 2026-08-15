/**
 * Arm decisions require a real modelled unit contribution. Zero is not a
 * contribution — it would make the kill threshold 1 minor unit via Math.max.
 */

import { describe, expect, it } from 'vitest';
import type { ServiceDeps } from '../src/deps.js';
import { MarketingExperimentService } from '../src/marketing/experiments.js';

describe('MarketingExperimentService.decideArms', () => {
  it('refuses when economics have not modelled a positive unit contribution', async () => {
    const deps = {
      repos: {
        growth: {
          experiments: {
            byId: async () => ({ id: 'exp_1', company_id: 'co_1' }),
          },
          metrics: {
            decideArms: async () => {
              throw new Error('must not decide arms without a real contribution');
            },
          },
        },
        companies: {
          byId: async () => ({ id: 'co_1', selected_opportunity_id: 'opp_1' }),
        },
        research: {
          opportunities: {
            byId: async () => ({ id: 'opp_1', assumed_selling_price_cents: null }),
          },
        },
        sourcing: {
          landedCosts: {
            latestForOpportunity: async () => undefined,
          },
        },
      },
    } as unknown as ServiceDeps;

    const result = await new MarketingExperimentService(deps).decideArms({
      experimentId: 'exp_1',
      unitContributionMinor: 0,
    });
    expect(result.ok).toBe(false);
    expect(result.blockedOn?.reason).toMatch(/contribution/i);
  });
});
