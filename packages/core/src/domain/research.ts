/**
 * Research & opportunity-discovery domain.
 *
 * The load-bearing rule here is provenance: an opportunity may only be scored
 * on evidence that carries a real source, a real URL/external id and a real
 * retrieval timestamp. `EvidenceItem.provenance` has no "model asserted this"
 * variant, so a language model cannot manufacture evidence — it can only
 * summarise and label material that was actually fetched.
 */

import { z } from 'zod';

/* -------------------------------------------------------------------------- */
/* Sources                                                                     */
/* -------------------------------------------------------------------------- */

export const EvidenceSourceKind = z.enum([
  'reddit_post',
  'reddit_comment',
  'product_review',
  'forum_thread',
  'q_and_a',
  'video_comment',
  'social_post',
  'news_article',
  'blog_post',
  'marketplace_listing',
  'support_thread',
  'search_trend',
  'expert_statement',
  'customer_message',
]);
export type EvidenceSourceKind = z.infer<typeof EvidenceSourceKind>;

/**
 * How the bytes were obtained. Every variant names a mechanism that leaves an
 * auditable trace; there is deliberately no "generated" option.
 */
export const Provenance = z.discriminatedUnion('method', [
  z.object({
    method: z.literal('public_api'),
    provider: z.string().min(1),
    endpoint: z.string().min(1),
    requestId: z.string().optional(),
  }),
  z.object({
    method: z.literal('browser_session'),
    provider: z.string().min(1),
    sessionId: z.string().min(1),
    recordingUrl: z.string().url().optional(),
  }),
  z.object({
    method: z.literal('http_fetch'),
    statusCode: z.number().int(),
    contentType: z.string().optional(),
  }),
  z.object({
    method: z.literal('human_expert'),
    provider: z.string().min(1),
    engagementId: z.string().min(1),
    expertRef: z.string().min(1),
  }),
  z.object({
    method: z.literal('first_party'),
    system: z.string().min(1),
    recordId: z.string().min(1),
  }),
]);
export type Provenance = z.infer<typeof Provenance>;

/** Robots/ToS decision recorded at fetch time, not asserted later. */
export const ComplianceMetadata = z.object({
  robotsAllowed: z.boolean(),
  robotsCheckedAt: z.string().datetime().nullable(),
  termsReviewed: z.boolean().default(false),
  /** True when the excerpt may be stored; false means store only the summary. */
  excerptStoragePermitted: z.boolean(),
  /** Author handles are only retained when there is a lawful basis. */
  authorIdentifierRetained: z.boolean().default(false),
  retentionPolicy: z.enum(['standard_365d', 'short_30d', 'summary_only']).default('standard_365d'),
  notes: z.string().optional(),
});
export type ComplianceMetadata = z.infer<typeof ComplianceMetadata>;

/* -------------------------------------------------------------------------- */
/* Evidence                                                                    */
/* -------------------------------------------------------------------------- */

export const SignalStrength = z.enum(['none', 'weak', 'moderate', 'strong']);
export type SignalStrength = z.infer<typeof SignalStrength>;

export const EvidenceItem = z.object({
  id: z.string().min(1),
  companyId: z.string().min(1),
  sourceKind: EvidenceSourceKind,
  /** Canonical URL when public; otherwise a stable external id. */
  sourceUrl: z.string().url().nullable(),
  externalId: z.string().nullable(),
  /** e.g. "reddit.com/r/homeimprovement". */
  sourceDomain: z.string().min(1),
  retrievedAt: z.string().datetime(),
  /** When the underlying content was authored, when the source exposes it. */
  authoredAt: z.string().datetime().nullable(),
  provenance: Provenance,
  compliance: ComplianceMetadata,

  /** Verbatim excerpt, stored only when `compliance.excerptStoragePermitted`. */
  excerpt: z.string().nullable(),
  /** Model-written normalisation of the excerpt. Always attributable to the excerpt. */
  summary: z.string().min(1),
  language: z.string().length(2).default('en'),

  painPointLabels: z.array(z.string().min(1)).default([]),
  categoryLabels: z.array(z.string().min(1)).default([]),
  competitorsMentioned: z.array(z.string().min(1)).default([]),

  sentiment: z.number().min(-1).max(1),
  severity: z.number().int().min(0).max(10),
  purchaseIntent: SignalStrength,
  workaroundDescribed: z.boolean(),
  willingnessToPayCents: z.number().int().nonnegative().nullable(),
  geography: z.string().nullable(),

  /** Engagement metrics from the source, when available (upvotes, helpful votes). */
  engagementScore: z.number().int().nullable(),

  /** Extraction confidence, 0..1. Low-confidence items are excluded from scoring. */
  confidence: z.number().min(0).max(1),
  /** SimHash of the normalised text, for near-duplicate suppression. */
  dedupeHash: z.string().min(1),
  supersededByEvidenceId: z.string().nullable().default(null),
  createdAt: z.string().datetime(),
});
export type EvidenceItem = z.infer<typeof EvidenceItem>;

/** What a collector returns before ids/hashes are assigned by the service. */
export const EvidenceDraft = EvidenceItem.omit({
  id: true,
  companyId: true,
  dedupeHash: true,
  createdAt: true,
  supersededByEvidenceId: true,
});
export type EvidenceDraft = z.infer<typeof EvidenceDraft>;

/* -------------------------------------------------------------------------- */
/* Pain points                                                                 */
/* -------------------------------------------------------------------------- */

export const PainPoint = z.object({
  id: z.string().min(1),
  companyId: z.string().min(1),
  label: z.string().min(1),
  statement: z.string().min(1),
  /** Who has the problem. */
  segment: z.string().min(1),
  categoryLabels: z.array(z.string()).default([]),

  /** Distinct evidence items supporting this cluster. */
  evidenceCount: z.number().int().nonnegative(),
  /** Distinct source domains — the anti-echo-chamber measure. */
  independentSourceCount: z.number().int().nonnegative(),
  medianSeverity: z.number().min(0).max(10),
  purchaseIntentRatio: z.number().min(0).max(1),
  workaroundRatio: z.number().min(0).max(1),
  competitorsMentioned: z.array(z.string()).default([]),
  firstObservedAt: z.string().datetime(),
  lastObservedAt: z.string().datetime(),
  /** Centroid of the embedding cluster, used to attach new evidence. */
  embedding: z.array(z.number()).nullable().default(null),
  status: z.enum(['candidate', 'validated', 'rejected', 'archived']).default('candidate'),
  rejectionReason: z.string().nullable().default(null),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type PainPoint = z.infer<typeof PainPoint>;

/* -------------------------------------------------------------------------- */
/* Opportunity graph                                                           */
/* -------------------------------------------------------------------------- */

export const GraphNodeKind = z.enum([
  'pain_point',
  'user_segment',
  'product_concept',
  'competitor',
  'desired_outcome',
  'failure_mode',
  'workaround',
  'price_point',
  'supplier',
  'ad_hypothesis',
]);
export type GraphNodeKind = z.infer<typeof GraphNodeKind>;

export const GraphEdgeKind = z.enum([
  'experiences',
  'caused_by',
  'currently_solved_by',
  'worked_around_by',
  'could_be_solved_by',
  'sourceable_from',
  'targeted_by',
  'priced_at',
  'desires',
]);
export type GraphEdgeKind = z.infer<typeof GraphEdgeKind>;

export const GraphNode = z.object({
  id: z.string().min(1),
  companyId: z.string().min(1),
  kind: GraphNodeKind,
  label: z.string().min(1),
  /** Reference into the owning table (pain_points.id, suppliers.id, …). */
  refId: z.string().nullable(),
  attributes: z.record(z.string(), z.unknown()).default({}),
  createdAt: z.string().datetime(),
});
export type GraphNode = z.infer<typeof GraphNode>;

export const GraphEdge = z.object({
  id: z.string().min(1),
  companyId: z.string().min(1),
  kind: GraphEdgeKind,
  fromNodeId: z.string().min(1),
  toNodeId: z.string().min(1),
  weight: z.number().min(0).max(1).default(1),
  /** Evidence ids that justify this edge — the CEO can always drill down. */
  evidenceIds: z.array(z.string()).default([]),
  createdAt: z.string().datetime(),
});
export type GraphEdge = z.infer<typeof GraphEdge>;

/* -------------------------------------------------------------------------- */
/* Opportunity & scoring                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Scoring dimensions. Each carries its own confidence and the ids of the
 * evidence that produced it, so a high score built on one thin source is
 * visibly different from a high score built on forty independent ones.
 */
export const SCORE_DIMENSIONS = [
  'pain_severity',
  'frequency',
  'source_diversity',
  'buyer_clarity',
  /**
   * How many people plausibly have this pain. Distinct from `buyer_clarity`,
   * which is about how sharply we can describe the buyer, not how many exist.
   * A pain that is severe, frequent and clearly attributable to a buyer nobody
   * can find at scale is not a business.
   */
  'audience_size',
  'willingness_to_pay',
  'category_spend',
  'competitor_dissatisfaction',
  'differentiation_potential',
  'private_label_feasibility',
  'moq_friendliness',
  'sample_speed',
  'lead_time',
  'landed_cost_efficiency',
  'expected_price_realisation',
  'gross_margin',
  'contribution_margin',
  'shipping_simplicity',
  'return_risk',
  'safety_regulatory_risk',
  'ip_risk',
  'ad_policy_risk',
  'seasonality',
  'market_saturation',
  'creative_tractability',
] as const;

export const ScoreDimension = z.enum(SCORE_DIMENSIONS);
export type ScoreDimension = z.infer<typeof ScoreDimension>;

/** Dimensions where a high raw value is bad and must be inverted before weighting. */
export const INVERTED_DIMENSIONS: ReadonlySet<ScoreDimension> = new Set<ScoreDimension>([
  'lead_time',
  'return_risk',
  'safety_regulatory_risk',
  'ip_risk',
  'ad_policy_risk',
  'market_saturation',
]);

export const DimensionScore = z.object({
  dimension: ScoreDimension,
  /** Raw 0..100 assessment before inversion and weighting. */
  raw: z.number().min(0).max(100),
  confidence: z.number().min(0).max(1),
  rationale: z.string().min(1),
  evidenceIds: z.array(z.string()).default([]),
  /** True when the value came from a supplier quote or platform data, not a model estimate. */
  grounded: z.boolean(),
});
export type DimensionScore = z.infer<typeof DimensionScore>;

export const HumanOverride = z.object({
  dimension: ScoreDimension,
  previousRaw: z.number().min(0).max(100),
  newRaw: z.number().min(0).max(100),
  rationale: z.string().min(1),
  /** Terac engagement that produced the override. */
  engagementId: z.string().min(1),
  expertRef: z.string().min(1),
  recordedAt: z.string().datetime(),
});
export type HumanOverride = z.infer<typeof HumanOverride>;

export const OpportunityScorecard = z.object({
  id: z.string().min(1),
  opportunityId: z.string().min(1),
  /** Weight profile used, so historical scores stay interpretable after a re-weight. */
  weightProfile: z.string().min(1),
  dimensions: z.array(DimensionScore),
  overrides: z.array(HumanOverride).default([]),
  /** 0..100 weighted composite after inversion, confidence discount and overrides. */
  composite: z.number().min(0).max(100),
  /** Composite computed using only `grounded` dimensions. */
  groundedComposite: z.number().min(0).max(100),
  /** Fraction of total weight backed by grounded values. */
  groundedWeightRatio: z.number().min(0).max(1),
  computedAt: z.string().datetime(),
});
export type OpportunityScorecard = z.infer<typeof OpportunityScorecard>;

export const OpportunityStage = z.enum([
  'discovered',
  'evidence_gathering',
  'scored',
  'expert_review_requested',
  'expert_reviewed',
  'sourcing',
  'quoted',
  'economics_modelled',
  'ceo_review',
  'selected',
  'building',
  'launched',
  'scaling',
  'killed',
  'parked',
]);
export type OpportunityStage = z.infer<typeof OpportunityStage>;

export const Opportunity = z.object({
  id: z.string().min(1),
  companyId: z.string().min(1),
  title: z.string().min(1),
  /** One-sentence description of the product concept. */
  concept: z.string().min(1),
  painPointIds: z.array(z.string()).min(1),
  targetSegment: z.string().min(1),
  category: z.string().min(1),
  /** The differentiated promise, in the customer's words. */
  valueHypothesis: z.string().min(1),
  assumedSellingPriceCents: z.number().int().positive().nullable(),
  currency: z.string().length(3).default('USD'),
  stage: OpportunityStage,
  latestScorecardId: z.string().nullable().default(null),
  killReason: z.string().nullable().default(null),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Opportunity = z.infer<typeof Opportunity>;

/* -------------------------------------------------------------------------- */
/* Scoring engine (pure)                                                       */
/* -------------------------------------------------------------------------- */

export type WeightProfile = Readonly<Record<ScoreDimension, number>>;

/**
 * Default weights. Tuned for commercial impact rather than novelty: margin,
 * willingness to pay, creative tractability and acquisition economics dominate,
 * and the risk dimensions act as strong negatives because a blocked ad account
 * or a recalled product ends the company.
 */
export const COMMERCIAL_IMPACT_WEIGHTS: WeightProfile = {
  pain_severity: 7,
  frequency: 6,
  source_diversity: 5,
  buyer_clarity: 7,
  // Weighted alongside buyer_clarity rather than above it: a smaller audience we
  // can describe and reach precisely beats a large one we cannot target.
  audience_size: 7,
  willingness_to_pay: 9,
  category_spend: 6,
  competitor_dissatisfaction: 6,
  differentiation_potential: 7,
  private_label_feasibility: 6,
  moq_friendliness: 4,
  sample_speed: 2,
  lead_time: 3,
  landed_cost_efficiency: 7,
  expected_price_realisation: 6,
  gross_margin: 9,
  contribution_margin: 10,
  shipping_simplicity: 5,
  return_risk: 5,
  safety_regulatory_risk: 8,
  ip_risk: 7,
  ad_policy_risk: 7,
  seasonality: 2,
  market_saturation: 5,
  creative_tractability: 8,
};

export interface ScoreComputation {
  readonly composite: number;
  readonly groundedComposite: number;
  readonly groundedWeightRatio: number;
  readonly perDimension: ReadonlyArray<{
    dimension: ScoreDimension;
    effective: number;
    weight: number;
    weighted: number;
    overridden: boolean;
  }>;
}

/**
 * Weighted composite.
 *
 * - Inverted dimensions are flipped so 100 always means "good for the business".
 * - Confidence discounts a score toward the neutral midpoint rather than toward
 *   zero: an unknown is not evidence of badness.
 * - A human override replaces the raw value and is treated as fully confident
 *   and grounded, because a paid domain expert looked at it.
 */
export function computeComposite(
  dimensions: readonly DimensionScore[],
  overrides: readonly HumanOverride[] = [],
  weights: WeightProfile = COMMERCIAL_IMPACT_WEIGHTS,
): ScoreComputation {
  const overrideByDim = new Map(overrides.map((o) => [o.dimension, o]));
  const perDimension: Array<{
    dimension: ScoreDimension;
    effective: number;
    weight: number;
    weighted: number;
    overridden: boolean;
  }> = [];

  let totalWeight = 0;
  let weightedSum = 0;
  let groundedWeight = 0;
  let groundedWeightedSum = 0;

  for (const dim of dimensions) {
    const override = overrideByDim.get(dim.dimension);
    const raw = override ? override.newRaw : dim.raw;
    const confidence = override ? 1 : dim.confidence;
    const grounded = override ? true : dim.grounded;

    const oriented = INVERTED_DIMENSIONS.has(dim.dimension) ? 100 - raw : raw;
    // Shrink toward the neutral 50 in proportion to missing confidence.
    const effective = 50 + (oriented - 50) * confidence;
    const weight = weights[dim.dimension] ?? 0;

    totalWeight += weight;
    weightedSum += effective * weight;
    if (grounded) {
      groundedWeight += weight;
      groundedWeightedSum += effective * weight;
    }
    perDimension.push({
      dimension: dim.dimension,
      effective: round2(effective),
      weight,
      weighted: round2(effective * weight),
      overridden: override !== undefined,
    });
  }

  return {
    composite: totalWeight === 0 ? 0 : round2(weightedSum / totalWeight),
    groundedComposite: groundedWeight === 0 ? 0 : round2(groundedWeightedSum / groundedWeight),
    groundedWeightRatio: totalWeight === 0 ? 0 : round2(groundedWeight / totalWeight) / 1,
    perDimension,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Hard gates applied before an opportunity may reach `selected`, regardless of
 * composite score. A 92 that fails a safety gate is still a no.
 */
export interface SelectionGateResult {
  readonly passed: boolean;
  readonly failures: readonly { gate: string; detail: string }[];
}

export interface SelectionGateInputs {
  readonly independentSourceCount: number;
  readonly evidenceCount: number;
  readonly groundedWeightRatio: number;
  readonly hasSupplierQuote: boolean;
  readonly contributionMarginRatio: number | null;
  readonly safetyRegulatoryRisk: number;
  readonly ipRisk: number;
  readonly adPolicyRisk: number;
  readonly expertReviewCompleted: boolean;
}

export const DEFAULT_SELECTION_GATES = {
  minIndependentSources: 5,
  minEvidenceItems: 25,
  minGroundedWeightRatio: 0.4,
  minContributionMarginRatio: 0.25,
  maxSafetyRegulatoryRisk: 60,
  maxIpRisk: 60,
  maxAdPolicyRisk: 65,
} as const;

export function evaluateSelectionGates(
  input: SelectionGateInputs,
  gates: typeof DEFAULT_SELECTION_GATES = DEFAULT_SELECTION_GATES,
): SelectionGateResult {
  const failures: { gate: string; detail: string }[] = [];

  if (input.independentSourceCount < gates.minIndependentSources) {
    failures.push({
      gate: 'independent_sources',
      detail: `${input.independentSourceCount} independent source domains < required ${gates.minIndependentSources}`,
    });
  }
  if (input.evidenceCount < gates.minEvidenceItems) {
    failures.push({
      gate: 'evidence_volume',
      detail: `${input.evidenceCount} evidence items < required ${gates.minEvidenceItems}`,
    });
  }
  if (input.groundedWeightRatio < gates.minGroundedWeightRatio) {
    failures.push({
      gate: 'grounded_scoring',
      detail:
        `only ${(input.groundedWeightRatio * 100).toFixed(0)}% of scoring weight is grounded in real quotes/platform ` +
        `data (need ${(gates.minGroundedWeightRatio * 100).toFixed(0)}%) — the score is mostly model estimate`,
    });
  }
  if (!input.hasSupplierQuote) {
    failures.push({
      gate: 'supplier_quote',
      detail: 'no supplier quote on record; landed cost would be an assumption, not a price',
    });
  }
  if (input.contributionMarginRatio === null) {
    failures.push({ gate: 'contribution_margin', detail: 'contribution margin has not been modelled' });
  } else if (input.contributionMarginRatio < gates.minContributionMarginRatio) {
    failures.push({
      gate: 'contribution_margin',
      detail: `modelled contribution margin ${(input.contributionMarginRatio * 100).toFixed(1)}% < required ${(
        gates.minContributionMarginRatio * 100
      ).toFixed(0)}%`,
    });
  }
  if (input.safetyRegulatoryRisk > gates.maxSafetyRegulatoryRisk) {
    failures.push({
      gate: 'safety_regulatory_risk',
      detail: `risk ${input.safetyRegulatoryRisk} > ceiling ${gates.maxSafetyRegulatoryRisk}; requires legal escalation`,
    });
  }
  if (input.ipRisk > gates.maxIpRisk) {
    failures.push({ gate: 'ip_risk', detail: `IP risk ${input.ipRisk} > ceiling ${gates.maxIpRisk}` });
  }
  if (input.adPolicyRisk > gates.maxAdPolicyRisk) {
    failures.push({
      gate: 'ad_policy_risk',
      detail: `ad-policy risk ${input.adPolicyRisk} > ceiling ${gates.maxAdPolicyRisk}; acquisition channel may be unusable`,
    });
  }
  if (!input.expertReviewCompleted) {
    failures.push({ gate: 'human_expert_review', detail: 'no completed human expert review on record' });
  }

  return { passed: failures.length === 0, failures };
}
