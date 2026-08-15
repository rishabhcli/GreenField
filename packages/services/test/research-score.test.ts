/**
 * Opportunity scoring must be derived from observable evidence, never from a
 * made-up 80. Ungrounded dimensions fail the selection gates; the composite
 * is whatever `computeComposite` actually returns.
 */

import { describe, expect, it } from 'vitest';
import {
  computeComposite,
  evaluateSelectionGates,
  SCORE_DIMENSIONS,
  type DimensionScore,
  type SelectionGateInputs,
} from '@foundry/core';
import type { ServiceDeps } from '../src/deps.js';
import {
  OpportunityScoringService,
  buildObservableDimensionScores,
} from '../src/research/score.js';

function ungroundedDimensions(): DimensionScore[] {
  return SCORE_DIMENSIONS.map((dimension) => ({
    dimension,
    raw: 50,
    confidence: 0.1,
    rationale: 'No observable measurement; not estimated.',
    evidenceIds: [],
    grounded: false,
  }));
}

function gatesFrom(dimensions: readonly DimensionScore[], extras: Partial<SelectionGateInputs> = {}) {
  const computation = computeComposite(dimensions);
  return evaluateSelectionGates({
    independentSourceCount: 0,
    evidenceCount: 0,
    groundedWeightRatio: computation.groundedWeightRatio,
    hasSupplierQuote: false,
    contributionMarginRatio: null,
    safetyRegulatoryRisk: dimensions.find((d) => d.dimension === 'safety_regulatory_risk')?.raw ?? 50,
    ipRisk: dimensions.find((d) => d.dimension === 'ip_risk')?.raw ?? 50,
    adPolicyRisk: dimensions.find((d) => d.dimension === 'ad_policy_risk')?.raw ?? 50,
    expertReviewCompleted: false,
    ...extras,
  });
}

describe('ungrounded scoring cannot pass selection gates', () => {
  it('fails evaluateSelectionGates when every dimension is ungrounded', () => {
    const dimensions = ungroundedDimensions();
    const computation = computeComposite(dimensions);
    expect(computation.groundedWeightRatio).toBe(0);
    expect(computation.composite).toBe(computeComposite(dimensions).composite);

    const gates = gatesFrom(dimensions);
    expect(gates.passed).toBe(false);
    expect(gates.failures.some((f) => f.gate === 'grounded_scoring')).toBe(true);
    expect(gates.failures.some((f) => f.gate === 'evidence_volume')).toBe(true);
  });

  it('buildObservableDimensionScores never fabricates an 80 when there is no evidence', () => {
    const dimensions = buildObservableDimensionScores({
      evidenceCount: 0,
      independentSourceCount: 0,
      medianSeverity: 0,
      evidenceIds: [],
      willingnessToPayEvidenceIds: [],
    });
    expect(dimensions).toHaveLength(SCORE_DIMENSIONS.length);
    for (const dim of dimensions) {
      expect(dim.grounded).toBe(false);
      expect(dim.confidence).toBeLessThan(0.5);
      expect(dim.raw).not.toBe(80);
      expect(dim.evidenceIds).toEqual([]);
    }
    expect(gatesFrom(dimensions).passed).toBe(false);
    expect(computeComposite(dimensions).composite).toBe(computeComposite(dimensions).composite);
  });
});

describe('OpportunityScoringService', () => {
  it('scores an opportunity with no linked evidence as ungrounded and does not pass gates', async () => {
    let written: { dimensions: readonly DimensionScore[]; weightProfile: string } | undefined;
    let stage: string | undefined;

    const deps = {
      repos: {
        research: {
          opportunities: {
            byId: async () => ({
              id: 'opp_1',
              company_id: 'co_1',
              title: 'Test opportunity',
              concept: 'concept',
              pain_point_ids: ['pp_1'],
              target_segment: 'segment',
              category: 'category',
              value_hypothesis: 'hypothesis',
              assumed_selling_price_cents: null,
              currency: 'USD',
              stage: 'discovered',
              latest_scorecard_id: null,
              kill_reason: null,
              created_at: new Date(),
              updated_at: new Date(),
            }),
            writeScorecard: async (input: {
              opportunityId: string;
              weightProfile: string;
              dimensions: readonly DimensionScore[];
            }) => {
              written = { dimensions: input.dimensions, weightProfile: input.weightProfile };
              const computation = computeComposite(input.dimensions);
              return {
                id: 'sc_1',
                opportunity_id: input.opportunityId,
                weight_profile: input.weightProfile,
                dimensions: [...input.dimensions],
                overrides: [],
                composite: computation.composite,
                grounded_composite: computation.groundedComposite,
                grounded_weight_ratio: computation.groundedWeightRatio,
                computed_at: new Date(),
              };
            },
            setStage: async (_id: string, next: string) => {
              stage = next;
            },
          },
          painPoints: {
            evidenceIds: async () => [],
            byId: async () => ({
              id: 'pp_1',
              evidence_count: 0,
              independent_source_count: 0,
              median_severity: 0,
              purchase_intent_ratio: 0,
            }),
          },
          evidence: {
            byIds: async () => [],
            independentSourceCount: async () => 0,
          },
          expertReviews: {
            completedFor: async () => undefined,
          },
        },
        sourcing: {
          quotes: {
            countGrounded: async () => 0,
          },
        },
      },
    } as unknown as ServiceDeps;

    const result = await new OpportunityScoringService(deps).score({
      companyId: 'co_1',
      opportunityId: 'opp_1',
      weightProfile: 'commercial_impact',
    });

    expect(stage).toBe('scored');
    expect(written?.weightProfile).toBe('commercial_impact');
    expect(result.weight_profile).toBe('commercial_impact');
    expect(result.grounded_weight_ratio).toBe(computeComposite(written!.dimensions).groundedWeightRatio);
    for (const dim of written!.dimensions) {
      expect(dim.grounded).toBe(false);
      expect(dim.raw).not.toBe(80);
      expect(dim.confidence).toBeLessThan(0.5);
    }
  });
});
