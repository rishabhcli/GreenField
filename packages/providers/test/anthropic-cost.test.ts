/**
 * Inference cost attribution.
 *
 * An autonomous company that cannot say what its own reasoning cost is not
 * running on real unit economics — agent spend is a variable cost like any
 * other, and it lands in the same ledger as ad spend.
 */

import { describe, expect, it } from 'vitest';
import { MODEL_BY_TIER, MODEL_PRICING_CENTS_PER_MTOK, ORG_CHART } from '@foundry/core';
import { addUsage, effortForTier, estimateCostMinorUsd } from '@foundry/providers';

describe('model pricing table', () => {
  it('prices every model the org chart can actually run', () => {
    for (const tier of Object.keys(MODEL_BY_TIER) as (keyof typeof MODEL_BY_TIER)[]) {
      const model = MODEL_BY_TIER[tier];
      expect(MODEL_PRICING_CENTS_PER_MTOK[model], `no pricing for ${model} (tier ${tier})`).toBeDefined();
    }
  });

  it('uses bare model aliases with no date suffix', () => {
    for (const model of Object.values(MODEL_BY_TIER)) {
      expect(model, `${model} carries a date suffix`).not.toMatch(/-\d{8}$/);
    }
  });

  it('prices output above input on every model, as the API does', () => {
    for (const [model, pricing] of Object.entries(MODEL_PRICING_CENTS_PER_MTOK)) {
      expect(pricing.output, `${model}`).toBeGreaterThan(pricing.input);
    }
  });
});

describe('estimateCostMinorUsd', () => {
  it('prices a plain Opus 5 call at the published rate', () => {
    // 1M input at $5 + 1M output at $25 = $30.00 = 3000 cents.
    expect(
      estimateCostMinorUsd('claude-opus-5', { inputTokens: 1_000_000, outputTokens: 1_000_000 }),
    ).toBe(3000);
  });

  it('prices Sonnet 5 and Haiku below Opus for identical usage', () => {
    const usage = { inputTokens: 100_000, outputTokens: 20_000 };
    const opus = estimateCostMinorUsd('claude-opus-5', usage);
    const sonnet = estimateCostMinorUsd('claude-sonnet-5', usage);
    const haiku = estimateCostMinorUsd('claude-haiku-4-5', usage);
    expect(sonnet).toBeLessThan(opus);
    expect(haiku).toBeLessThan(sonnet);
  });

  it('charges a premium for cache writes and a discount for cache reads', () => {
    const base = estimateCostMinorUsd('claude-opus-5', { inputTokens: 1_000_000, outputTokens: 0 });
    const written = estimateCostMinorUsd('claude-opus-5', {
      inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 1_000_000,
    });
    const read = estimateCostMinorUsd('claude-opus-5', {
      inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 1_000_000,
    });
    expect(written).toBe(Math.ceil(base * 1.25));
    expect(read).toBe(Math.ceil(base * 0.1));
    // The whole point of caching a role prompt: reuse is an order of magnitude cheaper.
    expect(read * 10).toBeLessThanOrEqual(base);
  });

  it('shows why caching the role prompt pays for itself', () => {
    // A 20k-token system prompt reused across 50 specialist runs.
    const uncached = 50 * estimateCostMinorUsd('claude-sonnet-5', { inputTokens: 20_000, outputTokens: 500 });
    const cached =
      estimateCostMinorUsd('claude-sonnet-5', { inputTokens: 0, outputTokens: 500, cacheCreationInputTokens: 20_000 }) +
      49 * estimateCostMinorUsd('claude-sonnet-5', { inputTokens: 0, outputTokens: 500, cacheReadInputTokens: 20_000 });
    expect(cached).toBeLessThan(uncached);
  });

  it('rounds up, so cost is never understated', () => {
    // A tiny call still costs at least one cent in the ledger.
    expect(estimateCostMinorUsd('claude-opus-5', { inputTokens: 10, outputTokens: 10 })).toBe(1);
  });

  it('reports zero rather than guessing for an unpriced model', () => {
    // Silence is wrong, but inventing a price is worse — the finance report
    // would then show a confident number with no basis.
    expect(estimateCostMinorUsd('some-future-model', { inputTokens: 1_000_000, outputTokens: 1_000_000 })).toBe(0);
  });

  it('tolerates a caller passing a date-suffixed id', () => {
    expect(estimateCostMinorUsd('claude-haiku-4-5-20251001', { inputTokens: 1_000_000, outputTokens: 0 })).toBe(
      estimateCostMinorUsd('claude-haiku-4-5', { inputTokens: 1_000_000, outputTokens: 0 }),
    );
  });
});

describe('usage accumulation', () => {
  it('sums every dimension across loop iterations', () => {
    const a = { inputTokens: 10, outputTokens: 5, cacheCreationInputTokens: 2, cacheReadInputTokens: 1, costMinorUsd: 3 };
    const b = { inputTokens: 20, outputTokens: 7, cacheCreationInputTokens: 0, cacheReadInputTokens: 4, costMinorUsd: 2 };
    expect(addUsage(a, b)).toEqual({
      inputTokens: 30, outputTokens: 12, cacheCreationInputTokens: 2, cacheReadInputTokens: 5, costMinorUsd: 5,
    });
  });
});

describe('effort per org tier', () => {
  it('spends the most reasoning on the roles that allocate capital', () => {
    const order = ['low', 'medium', 'high', 'xhigh', 'max'];
    expect(order.indexOf(effortForTier('executive'))).toBeGreaterThan(order.indexOf(effortForTier('manager')));
    expect(order.indexOf(effortForTier('manager'))).toBeGreaterThan(order.indexOf(effortForTier('specialist')));
    expect(order.indexOf(effortForTier('specialist'))).toBeGreaterThan(order.indexOf(effortForTier('fast')));
  });

  it('assigns a valid effort to every tier used by the org chart', () => {
    const valid = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
    for (const role of ORG_CHART) {
      expect(valid.has(effortForTier(role.tier)), `${role.key} tier ${role.tier}`).toBe(true);
    }
  });
});
