/**
 * Assemble selection-gate inputs from stored artefacts only.
 *
 * A missing quote stays `hasSupplierQuote: false`. Callers must not invent a
 * supplier price to pass the gate.
 */

import {
  DimensionScore,
  evaluateSelectionGates,
  type SelectionGateInputs,
  type SelectionGateResult,
} from '@foundry/core';
import type { ServiceDeps } from '../deps.js';
import { contributionFromLandedRow } from '../sourcing/economics.js';

export interface SelectionArtefacts {
  readonly scorecard: {
    readonly grounded_weight_ratio: number;
    readonly dimensions: readonly Record<string, unknown>[];
  } | null;
  readonly quotes: readonly unknown[];
  readonly evidenceCount: number;
  readonly independentSourceCount: number;
  readonly contributionMarginRatio: number | null;
  readonly expertReviewCompleted: boolean;
}

export function assembleSelectionGateInputs(artefacts: SelectionArtefacts): SelectionGateInputs {
  const dimensions = artefacts.scorecard?.dimensions
    .map((row) => DimensionScore.safeParse(row))
    .filter((parsed): parsed is { success: true; data: DimensionScore } => parsed.success)
    .map((parsed) => parsed.data) ?? [];

  const raw = (dimension: DimensionScore['dimension'], missing: number): number =>
    dimensions.find((d) => d.dimension === dimension)?.raw ?? missing;

  return {
    independentSourceCount: artefacts.independentSourceCount,
    evidenceCount: artefacts.evidenceCount,
    groundedWeightRatio: artefacts.scorecard?.grounded_weight_ratio ?? 0,
    hasSupplierQuote: artefacts.quotes.length > 0,
    contributionMarginRatio: artefacts.contributionMarginRatio,
    // Missing scorecard fails closed on risk: 100 exceeds every ceiling.
    safetyRegulatoryRisk: raw('safety_regulatory_risk', 100),
    ipRisk: raw('ip_risk', 100),
    adPolicyRisk: raw('ad_policy_risk', 100),
    expertReviewCompleted: artefacts.expertReviewCompleted,
  };
}

export async function loadAndEvaluateSelection(
  deps: ServiceDeps,
  opportunityId: string,
): Promise<{ inputs: SelectionGateInputs; gates: SelectionGateResult }> {
  const opportunity = await deps.repos.research.opportunities.byId(opportunityId);
  const [scorecard, quotes, expert, landed] = await Promise.all([
    deps.repos.research.opportunities.latestScorecard(opportunityId),
    deps.repos.sourcing.quotes.forOpportunity(opportunityId),
    deps.repos.research.expertReviews.completedFor(opportunity.company_id, 'opportunity', opportunityId),
    deps.repos.sourcing.landedCosts.latestForOpportunity(opportunityId),
  ]);

  const evidenceIds = new Set<string>();
  for (const painPointId of opportunity.pain_point_ids) {
    const linked = await deps.repos.research.painPoints.evidenceIds(painPointId);
    for (const id of linked) evidenceIds.add(id);
  }
  const independentSourceCount =
    evidenceIds.size === 0 ? 0 : await deps.repos.research.evidence.independentSourceCount([...evidenceIds]);

  let contributionMarginRatio: number | null = null;
  const selling = opportunity.assumed_selling_price_cents;
  if (landed && selling != null && selling > 0) {
    const contribution = contributionFromLandedRow(landed, selling);
    contributionMarginRatio = contribution?.contributionMarginRatio ?? null;
  }

  const inputs = assembleSelectionGateInputs({
    scorecard: scorecard
      ? { grounded_weight_ratio: scorecard.grounded_weight_ratio, dimensions: scorecard.dimensions }
      : null,
    quotes,
    evidenceCount: evidenceIds.size,
    independentSourceCount,
    contributionMarginRatio,
    expertReviewCompleted: Boolean(expert),
  });
  return { inputs, gates: evaluateSelectionGates(inputs) };
}
