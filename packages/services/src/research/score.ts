/**
 * Opportunity scoring from observable evidence quantities only.
 *
 * Grounded dimensions require evidence ids (or a supplier quote, which this
 * path does not invent). Everything else is recorded as ungrounded with low
 * confidence and a rationale that says the value is assumed.
 */

import {
  COMMERCIAL_IMPACT_WEIGHTS,
  DEFAULT_SELECTION_GATES,
  SCORE_DIMENSIONS,
  type DimensionScore,
  type ScoreDimension,
} from '@foundry/core';
import type { ScorecardRow } from '@foundry/db';
import type { ServiceDeps } from '../deps.js';

export interface ObservableEvidenceStats {
  readonly evidenceCount: number;
  readonly independentSourceCount: number;
  readonly medianSeverity: number;
  readonly evidenceIds: readonly string[];
  readonly willingnessToPayEvidenceIds: readonly string[];
}

export interface ScoreInput {
  readonly companyId: string;
  readonly opportunityId: string;
  readonly weightProfile?: string;
}

const UNGROUNDED_CONFIDENCE = 0.1;
const GROUNDED_CONFIDENCE = 0.8;
const NEUTRAL_RAW = 50;

/**
 * One score per `SCORE_DIMENSIONS` entry. Including the ungrounded majority is
 * load-bearing: omitting them would make `groundedWeightRatio` look like 1.0
 * on a handful of thin measurements.
 */
export function buildObservableDimensionScores(stats: ObservableEvidenceStats): DimensionScore[] {
  const hasEvidence = stats.evidenceCount > 0 && stats.evidenceIds.length > 0;
  const ids = hasEvidence ? [...stats.evidenceIds] : [];

  return SCORE_DIMENSIONS.map((dimension) => {
    if (!hasEvidence) return ungrounded(dimension);
    switch (dimension) {
      case 'pain_severity':
        return grounded(
          dimension,
          clamp100(stats.medianSeverity * 10),
          ids,
          `Median severity ${stats.medianSeverity}/10 across ${stats.evidenceCount} linked evidence items.`,
        );
      case 'frequency':
        return grounded(
          dimension,
          clamp100((stats.evidenceCount / DEFAULT_SELECTION_GATES.minEvidenceItems) * 100),
          ids,
          `Evidence count ${stats.evidenceCount}, capped against the selection gate of ${DEFAULT_SELECTION_GATES.minEvidenceItems}.`,
        );
      case 'source_diversity':
        return grounded(
          dimension,
          clamp100((stats.independentSourceCount / DEFAULT_SELECTION_GATES.minIndependentSources) * 100),
          ids,
          `Independent source domains: ${stats.independentSourceCount}.`,
        );
      case 'willingness_to_pay':
        if (stats.willingnessToPayEvidenceIds.length === 0) return ungrounded(dimension);
        return grounded(
          dimension,
          clamp100((stats.willingnessToPayEvidenceIds.length / stats.evidenceCount) * 100),
          [...stats.willingnessToPayEvidenceIds],
          `${stats.willingnessToPayEvidenceIds.length} of ${stats.evidenceCount} evidence items stated willingness_to_pay_cents.`,
        );
      default:
        return ungrounded(dimension);
    }
  });
}

function grounded(dimension: ScoreDimension, raw: number, evidenceIds: string[], rationale: string): DimensionScore {
  return {
    dimension,
    raw,
    confidence: GROUNDED_CONFIDENCE,
    rationale,
    evidenceIds,
    grounded: true,
  };
}

function ungrounded(dimension: ScoreDimension): DimensionScore {
  return {
    dimension,
    raw: NEUTRAL_RAW,
    confidence: UNGROUNDED_CONFIDENCE,
    rationale: `Assumed: no observable measurement for ${dimension} in the linked evidence or supplier quotes; value not estimated.`,
    evidenceIds: [],
    grounded: false,
  };
}

function clamp100(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(100, Math.max(0, Math.round(n * 100) / 100));
}

export class OpportunityScoreService {
  constructor(private readonly deps: ServiceDeps) {}

  async score(input: ScoreInput): Promise<ScorecardRow> {
    const opportunity = await this.deps.repos.research.opportunities.byId(input.opportunityId);
    const evidenceIds = await this.#linkedEvidenceIds(opportunity.pain_point_ids);
    const rows = await this.deps.repos.research.evidence.byIds(evidenceIds);
    const independentSourceCount =
      evidenceIds.length === 0 ? 0 : await this.deps.repos.research.evidence.independentSourceCount(evidenceIds);

    const stats: ObservableEvidenceStats = {
      evidenceCount: rows.length,
      independentSourceCount,
      medianSeverity: median(rows.map((r) => r.severity)),
      evidenceIds,
      willingnessToPayEvidenceIds: rows
        .filter((r) => r.willingness_to_pay_cents != null)
        .map((r) => r.id),
    };

    const dimensions = buildObservableDimensionScores(stats);
    const weightProfile = input.weightProfile ?? 'commercial_impact';

    const scorecard = await this.deps.repos.research.opportunities.writeScorecard({
      opportunityId: input.opportunityId,
      weightProfile,
      dimensions,
      weights: COMMERCIAL_IMPACT_WEIGHTS,
    });

    await this.deps.repos.research.opportunities.setStage(input.opportunityId, 'scored');
    return scorecard;
  }

  async #linkedEvidenceIds(painPointIds: readonly string[]): Promise<string[]> {
    const ids = new Set<string>();
    for (const painPointId of painPointIds) {
      const linked = await this.deps.repos.research.painPoints.evidenceIds(painPointId);
      for (const id of linked) ids.add(id);
    }
    return [...ids];
  }
}

/** @deprecated Use OpportunityScoreService. */
export { OpportunityScoreService as OpportunityScoringService };

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) return (sorted[mid - 1]! + sorted[mid]!) / 2;
  return sorted[mid]!;
}
