/**
 * Marketing domain: creative, experiments, metrics and the decision rules that
 * kill or scale a variant.
 *
 * Every decision the growth organisation makes is computed here from observed
 * counts, so "we scaled the winner" is always reproducible from the data. There
 * is no path that reports performance without a metric snapshot behind it.
 */

import { z } from 'zod';
import { ValidationError } from '../errors.js';

/* -------------------------------------------------------------------------- */
/* Creative                                                                    */
/* -------------------------------------------------------------------------- */

export const AdPlatform = z.enum(['meta', 'google', 'organic', 'email', 'sms']);
export type AdPlatform = z.infer<typeof AdPlatform>;

export const CreativeConcept = z.object({
  id: z.string().min(1),
  companyId: z.string().min(1),
  brandId: z.string().min(1),
  /** The specific belief this creative is testing. */
  hypothesis: z.string().min(1),
  angle: z.string().min(1),
  hook: z.string().min(1),
  primaryText: z.string().min(1),
  headline: z.string().min(1),
  description: z.string().nullable(),
  callToAction: z.string().min(1),
  assetIds: z.array(z.string()).default([]),
  landingPath: z.string().min(1),
  /** Claims used, cross-checked against BrandIdentity.permittedClaims. */
  claimsUsed: z.array(z.string()).default([]),
  platform: AdPlatform,
  status: z.enum([
    'draft',
    'claims_check_failed',
    'awaiting_human_review',
    'human_rejected',
    'human_approved',
    'live',
    'paused',
    'retired',
  ]),
  /** Human expert reviews. Required before spend on any new concept. */
  reviewIds: z.array(z.string()).default([]),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type CreativeConcept = z.infer<typeof CreativeConcept>;

/* -------------------------------------------------------------------------- */
/* Human expert review                                                         */
/* -------------------------------------------------------------------------- */

export const ExpertReviewSubject = z.enum([
  'opportunity_validity',
  'evidence_quality',
  'ad_creative',
  'landing_page',
  'brand_identity',
  'packaging',
  'pricing',
  'category_compliance',
  'supplier_quote',
  'legal_escalation',
]);
export type ExpertReviewSubject = z.infer<typeof ExpertReviewSubject>;

export const ExpertReviewStatus = z.enum([
  'requested',
  'pricing_pending',
  'priced',
  'launched',
  'in_progress',
  'submissions_received',
  'completed',
  'cancelled',
  'failed',
]);
export type ExpertReviewStatus = z.infer<typeof ExpertReviewStatus>;

/**
 * A structured review from a real human expert sourced through the expert
 * marketplace. The structure is the point: ratings and typed critiques feed
 * back into the agent loop rather than sitting in a chat transcript.
 */
export const ExpertReview = z.object({
  id: z.string().min(1),
  companyId: z.string().min(1),
  subject: ExpertReviewSubject,
  /** Row the review is about (creative id, opportunity id, …). */
  subjectRefId: z.string().min(1),
  provider: z.string().min(1),
  /** Provider-side opportunity/engagement id. */
  externalEngagementId: z.string().nullable(),
  externalRequestId: z.string().nullable(),
  status: ExpertReviewStatus,
  question: z.string().min(1),
  /** Rubric the expert is asked to score against. */
  rubric: z.array(z.object({ key: z.string(), prompt: z.string(), scale: z.enum(['1_5', '1_10', 'boolean']) })),
  participantsRequested: z.number().int().positive(),
  costPerParticipantMinor: z.number().int().nonnegative().nullable(),
  currency: z.string().length(3).nullable(),
  /** Individual expert submissions. */
  submissions: z.array(
    z.object({
      externalSubmissionId: z.string().min(1),
      expertRef: z.string().min(1),
      attestations: z.array(z.string()).default([]),
      scores: z.record(z.string(), z.number()),
      critique: z.string().min(1),
      recommendation: z.enum(['approve', 'approve_with_changes', 'reject']),
      suggestedChanges: z.array(z.string()).default([]),
      submittedAt: z.string().datetime(),
      approved: z.boolean(),
    }),
  ).default([]),
  /** Aggregate, computed from submissions. */
  verdict: z.enum(['pending', 'approved', 'approve_with_changes', 'rejected', 'inconclusive']).default('pending'),
  meanScores: z.record(z.string(), z.number()).default({}),
  requestedAt: z.string().datetime(),
  completedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type ExpertReview = z.infer<typeof ExpertReview>;

export function summariseReview(
  submissions: ExpertReview['submissions'],
): { verdict: ExpertReview['verdict']; meanScores: Record<string, number> } {
  const approved = submissions.filter((s) => s.approved);
  if (approved.length === 0) return { verdict: 'pending', meanScores: {} };

  const sums = new Map<string, { total: number; count: number }>();
  for (const s of approved) {
    for (const [key, value] of Object.entries(s.scores)) {
      const entry = sums.get(key) ?? { total: 0, count: 0 };
      entry.total += value;
      entry.count += 1;
      sums.set(key, entry);
    }
  }
  const meanScores = Object.fromEntries(
    [...sums.entries()].map(([k, v]) => [k, Math.round((v.total / v.count) * 100) / 100]),
  );

  const counts = { approve: 0, approve_with_changes: 0, reject: 0 };
  for (const s of approved) counts[s.recommendation] += 1;

  // A single reject from a paid domain expert is enough to block spend; the
  // system is optimising for money, and a policy-violating ad costs the account.
  if (counts.reject > 0) {
    return { verdict: 'rejected', meanScores };
  }
  if (counts.approve > counts.approve_with_changes && counts.reject === 0) {
    return { verdict: 'approved', meanScores };
  }
  if (counts.approve + counts.approve_with_changes > counts.reject) {
    return { verdict: 'approve_with_changes', meanScores };
  }
  return { verdict: 'inconclusive', meanScores };
}

/* -------------------------------------------------------------------------- */
/* Experiments                                                                 */
/* -------------------------------------------------------------------------- */

export const ExperimentObjective = z.enum([
  'purchases',
  'contribution_margin',
  'add_to_cart',
  'checkout_start',
  'lead',
  'click_through_rate',
]);
export type ExperimentObjective = z.infer<typeof ExperimentObjective>;

export const StopCondition = z.object({
  kind: z.enum([
    'max_spend',
    'max_duration_hours',
    'min_impressions',
    'min_conversions',
    'cac_ceiling',
    'negative_contribution',
    'policy_violation',
  ]),
  /** Threshold in minor units for money, raw count otherwise. */
  threshold: z.number(),
  action: z.enum(['pause_arm', 'pause_experiment', 'alert_only', 'escalate_to_ceo']),
});
export type StopCondition = z.infer<typeof StopCondition>;

export const ExperimentArm = z.object({
  id: z.string().min(1),
  experimentId: z.string().min(1),
  name: z.string().min(1),
  creativeConceptId: z.string().min(1),
  landingPath: z.string().min(1),
  /** Platform object ids once launched. */
  externalRefs: z.record(z.string(), z.string()).default({}),
  dailyBudgetMinor: z.number().int().nonnegative(),
  status: z.enum(['draft', 'pending_review', 'ready', 'live', 'paused', 'stopped', 'winner', 'loser']),
  stopReason: z.string().nullable().default(null),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type ExperimentArm = z.infer<typeof ExperimentArm>;

/* -------------------------------------------------------------------------- */
/* Audience segments                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Who we are selling to, stated precisely enough to hand to an ad platform.
 *
 * This exists because `Experiment.audienceSpec` used to be an untyped bag that
 * nothing populated, while the Meta ad-set builder correctly refused to invent
 * geo/age targeting. The result was an experiment that could be created and
 * could never launch. A segment is the thing that fills that gap.
 *
 * The load-bearing rule is `evidenceIds`: a segment must cite the evidence it
 * was derived from. A demographic guessed by a model is exactly the kind of
 * fabricated claim the rest of this system refuses to make, and targeting spend
 * at an invented audience costs real money.
 */

/** ISO 3166-1 alpha-2. Meta and Google both key geo targeting on these. */
export const CountryCode = z.string().length(2).regex(/^[A-Z]{2}$/, 'ISO 3166-1 alpha-2, uppercase');

export const GeoTarget = z.object({
  countries: z.array(CountryCode).min(1),
  regions: z.array(z.string().min(1)).default([]),
  cities: z.array(z.string().min(1)).default([]),
});
export type GeoTarget = z.infer<typeof GeoTarget>;

/** Meta rejects ad sets outside 13..65; 65 is treated as "65 or older". */
export const AGE_MIN = 13;
export const AGE_MAX = 65;

export const AgeRange = z
  .object({
    min: z.number().int().min(AGE_MIN).max(AGE_MAX),
    max: z.number().int().min(AGE_MIN).max(AGE_MAX),
  })
  .refine((r) => r.max >= r.min, { message: 'ageRange.max must be >= ageRange.min' });
export type AgeRange = z.infer<typeof AgeRange>;

export const AudienceGender = z.enum(['all', 'male', 'female']);
export type AudienceGender = z.infer<typeof AudienceGender>;

export const AudienceSegment = z.object({
  id: z.string().min(1),
  companyId: z.string().min(1),
  /** The opportunity this audience was derived for, when one is selected. */
  opportunityId: z.string().nullable().default(null),
  name: z.string().min(1),
  /** Plain-language ICP statement: who they are and what they are trying to do. */
  description: z.string().min(1),
  geo: GeoTarget,
  ageRange: AgeRange,
  gender: AudienceGender.default('all'),
  /** Free-text interest labels. Resolved to platform interest ids at launch. */
  interests: z.array(z.string().min(1)).default([]),
  /** BCP-47 language tags. */
  languages: z.array(z.string().min(1)).default([]),
  /**
   * Evidence rows this segment was inferred from. At least one is required:
   * an audience nobody observed is an invention, and this system does not
   * spend money against inventions.
   */
  evidenceIds: z.array(z.string().min(1)).min(1),
  /**
   * True only when every contributing evidence item was itself grounded in a
   * fetched source rather than asserted. Mirrors `DimensionScore.grounded`.
   */
  grounded: z.boolean(),
  /** Platform-reported reach, when a platform has been asked. Never estimated. */
  estimatedReachLower: z.number().int().nonnegative().nullable().default(null),
  estimatedReachUpper: z.number().int().nonnegative().nullable().default(null),
  status: z.enum(['draft', 'active', 'retired']).default('draft'),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type AudienceSegment = z.infer<typeof AudienceSegment>;

/** Meta encodes gender as 1=male, 2=female, and omission as "all". */
const META_GENDER: Readonly<Record<AudienceGender, readonly number[] | undefined>> = {
  all: undefined,
  male: [1],
  female: [2],
};

/**
 * Project a segment into Meta's Targeting spec.
 *
 * Interests are emitted as `interests_by_name` rather than `interests`, because
 * Meta's `interests` field takes numeric interest ids from its own taxonomy.
 * Passing a name where an id belongs would be silently dropped by the API and
 * we would be paying for broader targeting than we asked for.
 */
export function toMetaTargeting(segment: AudienceSegment): Record<string, unknown> {
  const genders = META_GENDER[segment.gender];
  return {
    geo_locations: {
      countries: [...segment.geo.countries],
      ...(segment.geo.regions.length > 0 ? { regions: segment.geo.regions.map((key) => ({ key })) } : {}),
      ...(segment.geo.cities.length > 0 ? { cities: segment.geo.cities.map((key) => ({ key })) } : {}),
    },
    age_min: segment.ageRange.min,
    age_max: segment.ageRange.max,
    ...(genders ? { genders: [...genders] } : {}),
    ...(segment.languages.length > 0 ? { locales: [...segment.languages] } : {}),
    ...(segment.interests.length > 0 ? { interests_by_name: [...segment.interests] } : {}),
  };
}

/**
 * Project a segment into the criteria Google Ads applies at the ad-group level.
 * Google has no single targeting blob, so this returns the pieces the caller
 * attaches individually.
 */
export function toGoogleTargeting(segment: AudienceSegment): Record<string, unknown> {
  return {
    locations: [...segment.geo.countries],
    ...(segment.geo.regions.length > 0 ? { regions: [...segment.geo.regions] } : {}),
    ageRanges: [segment.ageRange.min, segment.ageRange.max],
    ...(segment.gender !== 'all' ? { gender: segment.gender } : {}),
    ...(segment.languages.length > 0 ? { languages: [...segment.languages] } : {}),
    ...(segment.interests.length > 0 ? { affinityTerms: [...segment.interests] } : {}),
  };
}

/**
 * The `audience_spec` JSONB an experiment stores. `targeting` is the key the
 * Meta launch path reads; `segmentId` keeps the row traceable to the segment
 * and the evidence behind it.
 *
 * The platform comes from the experiment, not the segment — the same audience
 * can be tested on more than one platform, and each needs its own projection.
 */
export function audienceSpecFor(segment: AudienceSegment, platform: AdPlatform): Record<string, unknown> {
  const spec: Record<string, unknown> = { segmentId: segment.id, evidenceIds: [...segment.evidenceIds] };
  if (platform === 'google') {
    spec['targeting'] = toGoogleTargeting(segment);
  } else {
    // Meta is the default projection: organic, email and sms carry the same
    // audience definition for reporting even though they do not call an ads API.
    spec['targeting'] = toMetaTargeting(segment);
  }
  return spec;
}

export const Experiment = z.object({
  id: z.string().min(1),
  companyId: z.string().min(1),
  brandId: z.string().min(1),
  name: z.string().min(1),
  hypothesis: z.string().min(1),
  platform: AdPlatform,
  objective: ExperimentObjective,
  audienceSpec: z.record(z.string(), z.unknown()),
  totalBudgetMinor: z.number().int().nonnegative(),
  currency: z.string().length(3),
  stopConditions: z.array(StopCondition).min(1),
  attributionModel: z.enum(['platform_reported', 'first_party_click_id', 'blended']),
  status: z.enum(['draft', 'pending_approval', 'approved', 'running', 'paused', 'concluded', 'aborted']),
  /** Set when the CEO agent or a human authorised the spend. */
  approvalId: z.string().nullable().default(null),
  startedAt: z.string().datetime().nullable(),
  endedAt: z.string().datetime().nullable(),
  conclusion: z.string().nullable().default(null),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Experiment = z.infer<typeof Experiment>;

/* -------------------------------------------------------------------------- */
/* Metrics                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * A point-in-time snapshot of platform-reported and first-party counts.
 * `source` records who produced each number so a platform-reported conversion
 * is never silently mixed with a webhook-confirmed order.
 */
export const MetricSnapshot = z.object({
  id: z.string().min(1),
  companyId: z.string().min(1),
  scope: z.enum(['experiment', 'arm', 'campaign', 'site', 'company']),
  scopeRefId: z.string().min(1),
  source: z.enum(['platform_api', 'first_party', 'payment_provider', 'blended']),
  /** Inclusive window the counts cover. */
  windowStart: z.string().datetime(),
  windowEnd: z.string().datetime(),
  currency: z.string().length(3),

  impressions: z.number().int().nonnegative().default(0),
  reach: z.number().int().nonnegative().default(0),
  clicks: z.number().int().nonnegative().default(0),
  spendMinor: z.number().int().nonnegative().default(0),
  landingPageViews: z.number().int().nonnegative().default(0),
  addToCarts: z.number().int().nonnegative().default(0),
  checkoutStarts: z.number().int().nonnegative().default(0),
  purchases: z.number().int().nonnegative().default(0),
  revenueMinor: z.number().int().nonnegative().default(0),
  refundsMinor: z.number().int().nonnegative().default(0),
  contributionMarginMinor: z.number().int().default(0),
  repeatPurchases: z.number().int().nonnegative().default(0),
  supportContacts: z.number().int().nonnegative().default(0),

  collectedAt: z.string().datetime(),
});
export type MetricSnapshot = z.infer<typeof MetricSnapshot>;

export interface DerivedMetrics {
  readonly ctr: number | null;
  readonly cpcMinor: number | null;
  readonly cpmMinor: number | null;
  readonly landingConversionRate: number | null;
  readonly checkoutConversionRate: number | null;
  readonly purchaseConversionRate: number | null;
  readonly cacMinor: number | null;
  readonly aovMinor: number | null;
  readonly roas: number | null;
  /** The number the CEO actually optimises. */
  readonly contributionPerPurchaseMinor: number | null;
  readonly refundRate: number | null;
}

export function deriveMetrics(m: MetricSnapshot): DerivedMetrics {
  const safeDiv = (a: number, b: number): number | null => (b === 0 ? null : a / b);
  return {
    ctr: safeDiv(m.clicks, m.impressions),
    cpcMinor: m.clicks === 0 ? null : Math.round(m.spendMinor / m.clicks),
    cpmMinor: m.impressions === 0 ? null : Math.round((m.spendMinor / m.impressions) * 1000),
    landingConversionRate: safeDiv(m.addToCarts, m.landingPageViews),
    checkoutConversionRate: safeDiv(m.purchases, m.checkoutStarts),
    purchaseConversionRate: safeDiv(m.purchases, m.clicks),
    cacMinor: m.purchases === 0 ? null : Math.round(m.spendMinor / m.purchases),
    aovMinor: m.purchases === 0 ? null : Math.round(m.revenueMinor / m.purchases),
    roas: safeDiv(m.revenueMinor, m.spendMinor),
    contributionPerPurchaseMinor: m.purchases === 0 ? null : Math.round(m.contributionMarginMinor / m.purchases),
    refundRate: safeDiv(m.refundsMinor, m.revenueMinor),
  };
}

/* -------------------------------------------------------------------------- */
/* Statistical decision rules                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Two-proportion z-test. Used to decide whether one arm's conversion rate is
 * meaningfully better, rather than declaring a winner off 3 conversions.
 */
export function twoProportionZTest(
  successesA: number,
  trialsA: number,
  successesB: number,
  trialsB: number,
): { z: number; pValue: number; pooledRate: number } | null {
  if (trialsA <= 0 || trialsB <= 0) return null;
  const pA = successesA / trialsA;
  const pB = successesB / trialsB;
  const pooled = (successesA + successesB) / (trialsA + trialsB);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / trialsA + 1 / trialsB));
  if (se === 0) return null;
  const z = (pA - pB) / se;
  return { z, pValue: 2 * (1 - standardNormalCdf(Math.abs(z))), pooledRate: pooled };
}

/** Abramowitz–Stegun 26.2.17 approximation; max error ~7.5e-8. */
export function standardNormalCdf(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp((-x * x) / 2);
  const p = d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x > 0 ? 1 - p : p;
}

export interface ArmDecisionInput {
  readonly armId: string;
  readonly snapshot: MetricSnapshot;
  /** Contribution margin per unit at the current price, in minor units. */
  readonly unitContributionMinor: number;
}

export type ArmDecision =
  | { kind: 'insufficient_data'; armId: string; reason: string; needed: string }
  | { kind: 'kill'; armId: string; reason: string }
  | { kind: 'hold'; armId: string; reason: string }
  | { kind: 'scale'; armId: string; reason: string; suggestedBudgetMultiplier: number };

export interface ArmDecisionPolicy {
  /** Impressions before any judgement is allowed. */
  readonly minImpressions: number;
  /** Clicks before CTR judgements are allowed. */
  readonly minClicks: number;
  /** Spend before a no-conversion kill is allowed, as a multiple of unit contribution. */
  readonly killSpendMultipleOfContribution: number;
  /** Required conversions before declaring a winner. */
  readonly minPurchasesToScale: number;
  /** Contribution per purchase must exceed this to scale. */
  readonly minContributionPerPurchaseMinor: number;
  readonly maxBudgetMultiplier: number;
}

export const DEFAULT_ARM_POLICY: ArmDecisionPolicy = {
  minImpressions: 2_000,
  minClicks: 40,
  killSpendMultipleOfContribution: 3,
  minPurchasesToScale: 8,
  minContributionPerPurchaseMinor: 1,
  maxBudgetMultiplier: 1.5,
};

/**
 * The core "don't just increase spend" rule.
 *
 * An arm is killed when it has spent several units' worth of contribution with
 * nothing to show, held while the data is thin, and scaled only when it has
 * both enough conversions and positive contribution per purchase. Clicks alone
 * never justify scaling.
 */
export function decideArm(input: ArmDecisionInput, policy: ArmDecisionPolicy = DEFAULT_ARM_POLICY): ArmDecision {
  if (!Number.isFinite(input.unitContributionMinor) || input.unitContributionMinor <= 0) {
    throw new ValidationError(
      'unitContributionMinor must be a positive modelled contribution from economics; refusing to decide spend on a zero or invented contribution.',
      { unitContributionMinor: input.unitContributionMinor },
    );
  }
  const { snapshot: m, armId } = input;
  const d = deriveMetrics(m);

  if (m.impressions < policy.minImpressions) {
    return {
      kind: 'insufficient_data',
      armId,
      reason: `${m.impressions} impressions`,
      needed: `${policy.minImpressions} impressions`,
    };
  }

  const killThresholdMinor = Math.max(1, input.unitContributionMinor) * policy.killSpendMultipleOfContribution;
  if (m.purchases === 0 && m.spendMinor >= killThresholdMinor) {
    return {
      kind: 'kill',
      armId,
      reason:
        `spent ${m.spendMinor} minor units (>= ${killThresholdMinor}, i.e. ${policy.killSpendMultipleOfContribution}x ` +
        `unit contribution) with zero purchases`,
    };
  }

  if (m.purchases > 0 && d.contributionPerPurchaseMinor !== null && d.contributionPerPurchaseMinor < 0) {
    const totalLoss = -m.contributionMarginMinor;
    if (totalLoss >= killThresholdMinor) {
      return {
        kind: 'kill',
        armId,
        reason: `negative contribution of ${totalLoss} minor units across ${m.purchases} purchases — selling at a loss`,
      };
    }
  }

  if (m.clicks < policy.minClicks) {
    return { kind: 'hold', armId, reason: `only ${m.clicks} clicks; need ${policy.minClicks} before judging` };
  }

  if (
    m.purchases >= policy.minPurchasesToScale &&
    d.contributionPerPurchaseMinor !== null &&
    d.contributionPerPurchaseMinor >= policy.minContributionPerPurchaseMinor
  ) {
    // Scale proportionally to how profitable it is, capped so a lucky day
    // cannot 10x the budget overnight.
    const headroom = d.contributionPerPurchaseMinor / Math.max(1, policy.minContributionPerPurchaseMinor);
    const multiplier = Math.min(policy.maxBudgetMultiplier, 1 + Math.log10(1 + headroom) / 2);
    return {
      kind: 'scale',
      armId,
      reason: `${m.purchases} purchases at ${d.contributionPerPurchaseMinor} minor units contribution each`,
      suggestedBudgetMultiplier: Math.round(multiplier * 100) / 100,
    };
  }

  return {
    kind: 'hold',
    armId,
    reason: `${m.purchases} purchases (need ${policy.minPurchasesToScale} to scale), contribution ${
      d.contributionPerPurchaseMinor ?? 'unknown'
    }`,
  };
}

/** Evaluates configured stop conditions against a snapshot. */
export function evaluateStopConditions(
  conditions: readonly StopCondition[],
  m: MetricSnapshot,
  elapsedHours: number,
): readonly { condition: StopCondition; triggered: boolean; observed: number }[] {
  const d = deriveMetrics(m);
  return conditions.map((condition) => {
    let observed: number;
    switch (condition.kind) {
      case 'max_spend':
        observed = m.spendMinor;
        break;
      case 'max_duration_hours':
        observed = elapsedHours;
        break;
      case 'min_impressions':
        observed = m.impressions;
        break;
      case 'min_conversions':
        observed = m.purchases;
        break;
      case 'cac_ceiling':
        observed = d.cacMinor ?? Number.POSITIVE_INFINITY;
        break;
      case 'negative_contribution':
        observed = -m.contributionMarginMinor;
        break;
      case 'policy_violation':
        observed = 0;
        break;
    }
    const isMinimum = condition.kind === 'min_impressions' || condition.kind === 'min_conversions';
    const triggered = isMinimum ? observed < condition.threshold : observed >= condition.threshold;
    return { condition, triggered, observed };
  });
}
