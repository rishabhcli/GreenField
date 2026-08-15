/**
 * Opportunity selection must load real artefacts and call evaluateSelectionGates.
 * A missing quote is a failed gate, not an invented supplier price.
 */

import { describe, expect, it } from 'vitest';
import { evaluateSelectionGates } from '@foundry/core';
import { assembleSelectionGateInputs } from '../src/research/selection.js';

describe('assembleSelectionGateInputs', () => {
  it('does not invent a supplier quote when none is on record', () => {
    const inputs = assembleSelectionGateInputs({
      scorecard: null,
      quotes: [],
      evidenceCount: 80,
      independentSourceCount: 12,
      contributionMarginRatio: 0.4,
      expertReviewCompleted: true,
    });
    expect(inputs.hasSupplierQuote).toBe(false);
    const gates = evaluateSelectionGates(inputs);
    expect(gates.passed).toBe(false);
    expect(gates.failures.map((f) => f.gate)).toContain('supplier_quote');
  });

  it('passes only when scorecard, quote evidence, and modelled contribution are all present', () => {
    const inputs = assembleSelectionGateInputs({
      scorecard: {
        grounded_weight_ratio: 0.6,
        dimensions: [
          { dimension: 'safety_regulatory_risk', raw: 20, confidence: 0.8, rationale: 'quoted', evidenceIds: ['e1'], grounded: true },
          { dimension: 'ip_risk', raw: 15, confidence: 0.8, rationale: 'quoted', evidenceIds: ['e1'], grounded: true },
          { dimension: 'ad_policy_risk', raw: 25, confidence: 0.8, rationale: 'quoted', evidenceIds: ['e1'], grounded: true },
        ],
      },
      quotes: [{ id: 'quote_1' }],
      evidenceCount: 60,
      independentSourceCount: 8,
      contributionMarginRatio: 0.4,
      expertReviewCompleted: true,
    });
    expect(evaluateSelectionGates(inputs).passed).toBe(true);
  });
});
