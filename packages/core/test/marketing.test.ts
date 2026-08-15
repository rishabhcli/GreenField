/**
 * Arm decision rules and age-range bounds.
 *
 * Audience projection (Meta/Google targeting keys) lives in `audience.test.ts`.
 */

import { describe, expect, it } from 'vitest';
import {
  AGE_MAX,
  AGE_MIN,
  AgeRange,
  MetricSnapshot,
  decideArm,
  evaluateStopConditions,
} from '@foundry/core';

function snapshot(overrides: Record<string, unknown> = {}) {
  return MetricSnapshot.parse({
    id: 'msnap_1',
    companyId: 'co_1',
    scope: 'arm',
    scopeRefId: 'arm_1',
    source: 'platform_api',
    windowStart: '2026-08-01T00:00:00.000Z',
    windowEnd: '2026-08-02T00:00:00.000Z',
    currency: 'USD',
    impressions: 5000,
    clicks: 80,
    spendMinor: 0,
    purchases: 0,
    contributionMarginMinor: 0,
    collectedAt: '2026-08-02T00:00:00.000Z',
    ...overrides,
  });
}

describe('AgeRange', () => {
  it('rejects ages Meta would refuse, and inverted ranges', () => {
    expect(() => AgeRange.parse({ min: AGE_MIN - 1, max: 44 })).toThrow();
    expect(() => AgeRange.parse({ min: 25, max: AGE_MAX + 1 })).toThrow();
    expect(() => AgeRange.parse({ min: 44, max: 25 })).toThrow();
    expect(AgeRange.parse({ min: AGE_MIN, max: AGE_MAX })).toEqual({ min: 13, max: 65 });
  });
});

describe('decideArm', () => {
  it('holds until there are enough impressions', () => {
    const decision = decideArm({
      armId: 'arm_1',
      snapshot: snapshot({ impressions: 100 }),
      unitContributionMinor: 1000,
    });
    expect(decision.kind).toBe('insufficient_data');
  });

  it('kills an arm that spent several units of contribution with zero purchases', () => {
    const decision = decideArm({
      armId: 'arm_1',
      snapshot: snapshot({ spendMinor: 3000, purchases: 0, impressions: 5000 }),
      unitContributionMinor: 1000,
    });
    expect(decision.kind).toBe('kill');
    expect(decision.reason).toMatch(/zero purchases/);
  });

  it('never scales on clicks alone', () => {
    const decision = decideArm({
      armId: 'arm_1',
      snapshot: snapshot({ clicks: 500, purchases: 0, spendMinor: 500, impressions: 8000 }),
      unitContributionMinor: 1000,
    });
    expect(decision.kind).not.toBe('scale');
    expect(decision.kind).toBe('hold');
  });

  it('scales only with enough purchases and positive contribution per purchase', () => {
    const decision = decideArm({
      armId: 'arm_1',
      snapshot: snapshot({
        purchases: 10,
        contributionMarginMinor: 5000,
        spendMinor: 2000,
        clicks: 80,
        impressions: 5000,
      }),
      unitContributionMinor: 500,
    });
    expect(decision.kind).toBe('scale');
    if (decision.kind === 'scale') {
      expect(decision.suggestedBudgetMultiplier).toBeGreaterThan(1);
      expect(decision.suggestedBudgetMultiplier).toBeLessThanOrEqual(1.5);
    }
  });
});

describe('evaluateStopConditions', () => {
  it('triggers max_spend against observed spend, not against hoped-for spend', () => {
    const results = evaluateStopConditions(
      [{ kind: 'max_spend', threshold: 1000, action: 'pause_arm' }],
      snapshot({ spendMinor: 1500 }),
      2,
    );
    expect(results[0]).toMatchObject({ triggered: true, observed: 1500 });
  });
});
