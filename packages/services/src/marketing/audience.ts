/**
 * Audience segment definition — PLAN.md §10 pre-launch, "Define ICP/user segment".
 *
 * This is the step that was missing. `marketing.create_experiment` produced an
 * empty `audienceSpec`, and the Meta launch path then refused to build an ad set
 * without `audience_spec.targeting`, so no experiment the agents created could
 * ever launch. A segment is what fills that field.
 *
 * The rule this service enforces is that a segment must be derived from evidence
 * the company actually collected. Every cited evidence id is verified to exist
 * and to belong to this company before the row is written. A model asserting
 * "women 25-34 in the US" without a source is exactly the fabrication the rest of
 * the system refuses to make, and here it would spend real ad budget.
 */

import { AudienceSegment, ValidationError, audienceSpecFor, type AdPlatform } from '@foundry/core';
import type { ServiceDeps } from '../deps.js';

export interface DefineSegmentInput {
  readonly companyId: string;
  readonly opportunityId?: string | null;
  readonly name: string;
  readonly description: string;
  readonly countries: readonly string[];
  readonly regions?: readonly string[];
  readonly cities?: readonly string[];
  readonly ageMin: number;
  readonly ageMax: number;
  readonly gender?: 'all' | 'male' | 'female';
  readonly interests?: readonly string[];
  readonly languages?: readonly string[];
  readonly evidenceIds: readonly string[];
}

export interface DefineSegmentResult {
  readonly segmentId: string;
  readonly grounded: boolean;
  readonly evidenceCount: number;
}

export class AudienceSegmentService {
  constructor(private readonly deps: ServiceDeps) {}

  /**
   * Define a segment from cited evidence.
   *
   * `grounded` is derived, never supplied by the caller: it is true only when
   * every cited evidence item carries a provenance method that fetched a real
   * source. That mirrors `DimensionScore.grounded` and keeps "this audience is
   * observed" from being something a caller can simply claim.
   */
  async defineSegment(input: DefineSegmentInput): Promise<DefineSegmentResult> {
    if (input.evidenceIds.length === 0) {
      throw new ValidationError(
        'An audience segment must cite at least one evidence item. Define the audience from collected evidence, not from assumption.',
        { companyId: input.companyId, name: input.name },
      );
    }

    const evidence = await this.#loadOwnedEvidence(input.companyId, input.evidenceIds);
    const grounded = evidence.every((row) => isGroundedMethod(row.method));

    const row = await this.deps.repos.growth.audience.create({
      companyId: input.companyId,
      opportunityId: input.opportunityId ?? null,
      name: input.name,
      description: input.description,
      geo: {
        countries: input.countries.map((c) => c.toUpperCase()),
        regions: input.regions ?? [],
        cities: input.cities ?? [],
      },
      ageMin: input.ageMin,
      ageMax: input.ageMax,
      gender: input.gender ?? 'all',
      interests: input.interests ?? [],
      languages: input.languages ?? [],
      evidenceIds: input.evidenceIds,
      grounded,
    });

    return { segmentId: row.id, grounded, evidenceCount: evidence.length };
  }

  async list(companyId: string, status?: readonly string[]) {
    return this.deps.repos.growth.audience.list(companyId, status);
  }

  async activate(segmentId: string): Promise<void> {
    await this.deps.repos.growth.audience.activate(segmentId);
  }

  /**
   * Build the `audience_spec` an experiment stores for a given platform.
   * Returned rather than written so the experiment service stays the only
   * writer of the experiments table.
   */
  async specForExperiment(segmentId: string, platform: AdPlatform): Promise<Record<string, unknown>> {
    const row = await this.deps.repos.growth.audience.byId(segmentId);
    return audienceSpecFor(toDomain(row), platform);
  }

  /**
   * Every cited id must exist and belong to this company. A segment citing
   * another company's evidence, or an id that does not resolve, is not grounded
   * in anything — it just looks like it is.
   */
  async #loadOwnedEvidence(
    companyId: string,
    evidenceIds: readonly string[],
  ): Promise<readonly { id: string; method: string }[]> {
    const unique = [...new Set(evidenceIds)];
    const rows = await this.deps.repos.research.evidence.byIds(unique);
    // byIds is not company-scoped, so ownership is checked here. Citing another
    // company's evidence would look grounded while being unrelated to this
    // company's research.
    const owned = rows.filter((row) => row.company_id === companyId);
    if (owned.length !== unique.length) {
      const found = new Set(owned.map((r) => r.id));
      const missing = unique.filter((id) => !found.has(id));
      throw new ValidationError(
        `Audience segment cites evidence that does not exist for this company: ${missing.join(', ')}`,
        { companyId, missing },
      );
    }
    return owned.map((row) => {
      const method = row.provenance['method'];
      return { id: row.id, method: typeof method === 'string' ? method : 'unknown' };
    });
  }
}

/**
 * Provenance methods that mean a real source was fetched. `research.Provenance`
 * has no "generated" variant by design, but a segment should still only claim
 * grounding when the evidence came from a retrieval rather than a first-party
 * assertion.
 */
const GROUNDED_METHODS: ReadonlySet<string> = new Set(['public_api', 'browser_session', 'http_fetch', 'human_expert']);

function isGroundedMethod(method: string): boolean {
  return GROUNDED_METHODS.has(method);
}

interface SegmentRowLike {
  readonly id: string;
  readonly company_id: string;
  readonly opportunity_id: string | null;
  readonly name: string;
  readonly description: string;
  readonly geo: Record<string, unknown>;
  readonly age_min: number;
  readonly age_max: number;
  readonly gender: string;
  readonly interests: readonly string[];
  readonly languages: readonly string[];
  readonly evidence_ids: readonly string[];
  readonly grounded: boolean;
  readonly estimated_reach_lower: number | null;
  readonly estimated_reach_upper: number | null;
  readonly status: string;
  readonly created_at: Date;
  readonly updated_at: Date;
}

/** Row → domain. Parsed rather than cast so a schema drift fails loudly here. */
export function toDomain(row: SegmentRowLike): AudienceSegment {
  const geo = row.geo as { countries?: unknown; regions?: unknown; cities?: unknown };
  return AudienceSegment.parse({
    id: row.id,
    companyId: row.company_id,
    opportunityId: row.opportunity_id,
    name: row.name,
    description: row.description,
    geo: {
      countries: Array.isArray(geo.countries) ? geo.countries : [],
      regions: Array.isArray(geo.regions) ? geo.regions : [],
      cities: Array.isArray(geo.cities) ? geo.cities : [],
    },
    ageRange: { min: row.age_min, max: row.age_max },
    gender: row.gender,
    interests: [...row.interests],
    languages: [...row.languages],
    evidenceIds: [...row.evidence_ids],
    grounded: row.grounded,
    estimatedReachLower: row.estimated_reach_lower,
    estimatedReachUpper: row.estimated_reach_upper,
    status: row.status,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  });
}
