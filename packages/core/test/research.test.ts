import { describe, expect, it } from 'vitest';
import {
  COMMERCIAL_IMPACT_WEIGHTS,
  DEFAULT_SELECTION_GATES,
  INVERTED_DIMENSIONS,
  SCORE_DIMENSIONS,
  computeComposite,
  evaluateSelectionGates,
  type DimensionScore,
  type HumanOverride,
  type ScoreDimension,
  type SelectionGateInputs,
} from '@foundry/core';

function dim(dimension: ScoreDimension, raw: number, confidence = 1, grounded = true): DimensionScore {
  return { dimension, raw, confidence, grounded, rationale: 'test', evidenceIds: [] };
}

describe('weight profile', () => {
  it('assigns a weight to every scoring dimension', () => {
    for (const dimension of SCORE_DIMENSIONS) {
      expect(COMMERCIAL_IMPACT_WEIGHTS[dimension]).toBeGreaterThan(0);
    }
  });

  it('weights contribution margin and gross margin above cosmetic dimensions', () => {
    expect(COMMERCIAL_IMPACT_WEIGHTS.contribution_margin).toBeGreaterThan(COMMERCIAL_IMPACT_WEIGHTS.seasonality);
    expect(COMMERCIAL_IMPACT_WEIGHTS.gross_margin).toBeGreaterThan(COMMERCIAL_IMPACT_WEIGHTS.sample_speed);
    expect(COMMERCIAL_IMPACT_WEIGHTS.willingness_to_pay).toBeGreaterThan(COMMERCIAL_IMPACT_WEIGHTS.moq_friendliness);
  });
});

describe('computeComposite', () => {
  it('inverts risk dimensions so 100 always means good for the business', () => {
    const lowRisk = computeComposite([dim('safety_regulatory_risk', 0)]);
    const highRisk = computeComposite([dim('safety_regulatory_risk', 100)]);
    expect(lowRisk.composite).toBe(100);
    expect(highRisk.composite).toBe(0);
  });

  it('inverts exactly the dimensions marked inverted and no others', () => {
    for (const dimension of SCORE_DIMENSIONS) {
      const result = computeComposite([dim(dimension, 80)]);
      const expected = INVERTED_DIMENSIONS.has(dimension) ? 20 : 80;
      expect(result.composite).toBe(expected);
    }
  });

  it('shrinks a low-confidence score toward neutral, not toward zero', () => {
    // An unknown is not evidence of badness.
    const confident = computeComposite([dim('willingness_to_pay', 90, 1)]);
    const unsure = computeComposite([dim('willingness_to_pay', 90, 0.5)]);
    const clueless = computeComposite([dim('willingness_to_pay', 90, 0)]);
    expect(confident.composite).toBe(90);
    expect(unsure.composite).toBe(70);
    expect(clueless.composite).toBe(50);
  });

  it('shrinks a low-confidence bad score upward toward neutral too', () => {
    expect(computeComposite([dim('willingness_to_pay', 10, 0.5)]).composite).toBe(30);
  });

  it('separates the grounded composite from the overall composite', () => {
    const result = computeComposite([
      dim('contribution_margin', 90, 1, true),
      // A non-inverted dimension, so a low raw value genuinely drags the
      // composite down rather than being flipped upward.
      dim('buyer_clarity', 10, 1, false),
    ]);
    // Overall blends both; grounded uses only the quoted/observed dimension.
    expect(result.groundedComposite).toBe(90);
    expect(result.composite).toBeLessThan(90);
    expect(result.groundedWeightRatio).toBeGreaterThan(0);
    expect(result.groundedWeightRatio).toBeLessThan(1);
  });

  it('reports a grounded weight ratio of 0 when nothing is grounded', () => {
    const result = computeComposite([dim('gross_margin', 80, 1, false)]);
    expect(result.groundedWeightRatio).toBe(0);
    expect(result.groundedComposite).toBe(0);
  });

  it('treats a paid human override as fully confident and grounded', () => {
    const override: HumanOverride = {
      dimension: 'willingness_to_pay',
      previousRaw: 90,
      newRaw: 30,
      rationale: 'expert says this audience does not pay for this',
      engagementId: 'eng_1',
      expertRef: 'expert_7',
      recordedAt: new Date().toISOString(),
    };
    const result = computeComposite([dim('willingness_to_pay', 90, 0.4, false)], [override]);
    expect(result.composite).toBe(30);
    expect(result.groundedWeightRatio).toBe(1);
    expect(result.perDimension[0]?.overridden).toBe(true);
  });

  it('returns zero for an empty scorecard rather than throwing', () => {
    const result = computeComposite([]);
    expect(result.composite).toBe(0);
    expect(result.groundedComposite).toBe(0);
  });
});

describe('selection gates', () => {
  function gateInput(overrides: Partial<SelectionGateInputs> = {}): SelectionGateInputs {
    return {
      independentSourceCount: 8,
      evidenceCount: 60,
      groundedWeightRatio: 0.6,
      hasSupplierQuote: true,
      contributionMarginRatio: 0.4,
      safetyRegulatoryRisk: 20,
      ipRisk: 15,
      adPolicyRisk: 25,
      expertReviewCompleted: true,
      ...overrides,
    };
  }

  it('passes a well-evidenced, profitable, low-risk opportunity', () => {
    const result = evaluateSelectionGates(gateInput());
    expect(result.passed).toBe(true);
    expect(result.failures).toHaveLength(0);
  });

  it('blocks on too few independent sources even with lots of evidence', () => {
    const result = evaluateSelectionGates(gateInput({ independentSourceCount: 2, evidenceCount: 500 }));
    expect(result.passed).toBe(false);
    expect(result.failures.map((f) => f.gate)).toContain('independent_sources');
  });

  it('blocks when the score is mostly model estimate rather than real data', () => {
    const result = evaluateSelectionGates(gateInput({ groundedWeightRatio: 0.1 }));
    expect(result.passed).toBe(false);
    const failure = result.failures.find((f) => f.gate === 'grounded_scoring');
    expect(failure?.detail).toContain('mostly model estimate');
  });

  it('blocks without a supplier quote, because landed cost would be a guess', () => {
    const result = evaluateSelectionGates(gateInput({ hasSupplierQuote: false }));
    expect(result.passed).toBe(false);
    expect(result.failures.map((f) => f.gate)).toContain('supplier_quote');
  });

  it('blocks when contribution margin has not been modelled at all', () => {
    const result = evaluateSelectionGates(gateInput({ contributionMarginRatio: null }));
    expect(result.failures.find((f) => f.gate === 'contribution_margin')?.detail).toContain('not been modelled');
  });

  it('blocks a thin-margin product', () => {
    const result = evaluateSelectionGates(gateInput({ contributionMarginRatio: 0.05 }));
    expect(result.passed).toBe(false);
    expect(result.failures.map((f) => f.gate)).toContain('contribution_margin');
  });

  it('blocks on each risk ceiling independently', () => {
    expect(
      evaluateSelectionGates(gateInput({ safetyRegulatoryRisk: 95 })).failures.map((f) => f.gate),
    ).toContain('safety_regulatory_risk');
    expect(evaluateSelectionGates(gateInput({ ipRisk: 95 })).failures.map((f) => f.gate)).toContain('ip_risk');
    expect(evaluateSelectionGates(gateInput({ adPolicyRisk: 95 })).failures.map((f) => f.gate)).toContain(
      'ad_policy_risk',
    );
  });

  it('blocks without a completed human expert review', () => {
    const result = evaluateSelectionGates(gateInput({ expertReviewCompleted: false }));
    expect(result.passed).toBe(false);
    expect(result.failures.map((f) => f.gate)).toContain('human_expert_review');
  });

  it('a high composite score cannot bypass a hard gate', () => {
    // This is the point: score 92 with an unacceptable safety risk is still no.
    const scorecard = computeComposite(SCORE_DIMENSIONS.map((d) => dim(d, INVERTED_DIMENSIONS.has(d) ? 5 : 95)));
    expect(scorecard.composite).toBeGreaterThan(90);
    const gates = evaluateSelectionGates(gateInput({ safetyRegulatoryRisk: 90 }));
    expect(gates.passed).toBe(false);
  });

  it('reports every failing gate at once, not just the first', () => {
    const result = evaluateSelectionGates(
      gateInput({
        independentSourceCount: 1,
        evidenceCount: 2,
        hasSupplierQuote: false,
        expertReviewCompleted: false,
      }),
    );
    expect(result.failures.length).toBeGreaterThanOrEqual(4);
  });

  it('uses thresholds that are actually demanding', () => {
    expect(DEFAULT_SELECTION_GATES.minIndependentSources).toBeGreaterThanOrEqual(3);
    expect(DEFAULT_SELECTION_GATES.minContributionMarginRatio).toBeGreaterThan(0.1);
  });
});
