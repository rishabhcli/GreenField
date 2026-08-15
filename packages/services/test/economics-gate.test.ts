/**
 * Landed-cost gate: grounded ratio and contribution margin, with incomplete
 * economics distinct from a failed model.
 *
 * A production change that would make these fail: treating a missing selling
 * price as a margin-gate failure, or passing the gate below 0.4 grounded /
 * 0.25 contribution.
 */

import { describe, expect, it } from 'vitest';
import { evaluateEconomicsGate } from '../src/sourcing/economics.js';

describe('evaluateEconomicsGate', () => {
  it('passes when grounded ratio is at least 0.4 and contribution margin is at least 0.25', () => {
    const result = evaluateEconomicsGate({
      groundedRatio: 0.4,
      contributionMarginRatio: 0.25,
      sellingPricePresent: true,
    });
    expect(result.complete).toBe(true);
    expect(result.passesMarginGate).toBe(true);
  });

  it('fails a completed model when contribution margin is below 0.25', () => {
    const result = evaluateEconomicsGate({
      groundedRatio: 0.9,
      contributionMarginRatio: 0.24,
      sellingPricePresent: true,
    });
    expect(result.complete).toBe(true);
    expect(result.passesMarginGate).toBe(false);
    expect(result.reason).not.toMatch(/incomplete/i);
  });

  it('fails a completed model when grounded ratio is below 0.4', () => {
    const result = evaluateEconomicsGate({
      groundedRatio: 0.39,
      contributionMarginRatio: 0.4,
      sellingPricePresent: true,
    });
    expect(result.complete).toBe(true);
    expect(result.passesMarginGate).toBe(false);
  });

  it('is incomplete — not a failed economics model — when selling price is missing', () => {
    const result = evaluateEconomicsGate({
      groundedRatio: 1,
      contributionMarginRatio: null,
      sellingPricePresent: false,
    });
    expect(result.complete).toBe(false);
    expect(result.passesMarginGate).toBe(false);
    expect(result.reason).toMatch(/incomplete/i);
    expect(result.reason).not.toMatch(/failed/i);
  });
});
