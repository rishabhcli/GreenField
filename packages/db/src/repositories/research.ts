/**
 * Research persistence: evidence, pain-point clusters, the opportunity graph,
 * scorecards and expert reviews.
 *
 * `insertEvidence` de-duplicates on a content hash so the same post collected
 * twice does not inflate a pain point's apparent support, and
 * `recomputePainPointStats` derives `independent_source_count` from distinct
 * source domains — the measure the selection gate actually reads.
 */

import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  computeComposite,
  newId,
  type DimensionScore,
  type EvidenceDraft,
  type GraphEdgeKind,
  type GraphNodeKind,
  type HumanOverride,
  type OpportunityStage,
  type WeightProfile,
} from '@foundry/core';
import { exec, q, qMaybe, qOne, withTransaction, type DbPool, type Queryable } from '../pool.js';

/* -------------------------------------------------------------------------- */
/* Evidence                                                                    */
/* -------------------------------------------------------------------------- */

const EvidenceRow = z.object({
  id: z.string(),
  company_id: z.string(),
  source_kind: z.string(),
  source_url: z.string().nullable(),
  external_id: z.string().nullable(),
  source_domain: z.string(),
  retrieved_at: z.date(),
  authored_at: z.date().nullable(),
  provenance: z.record(z.string(), z.unknown()),
  compliance: z.record(z.string(), z.unknown()),
  excerpt: z.string().nullable(),
  summary: z.string(),
  pain_point_labels: z.array(z.string()),
  category_labels: z.array(z.string()),
  competitors_mentioned: z.array(z.string()),
  sentiment: z.number(),
  severity: z.number(),
  purchase_intent: z.string(),
  workaround_described: z.boolean(),
  willingness_to_pay_cents: z.number().nullable(),
  geography: z.string().nullable(),
  engagement_score: z.number().nullable(),
  confidence: z.number(),
  dedupe_hash: z.string(),
  created_at: z.date(),
});

export type EvidenceRow = z.infer<typeof EvidenceRow>;

const EVIDENCE_COLUMNS = `id, company_id, source_kind, source_url, external_id, source_domain, retrieved_at,
  authored_at, provenance, compliance, excerpt, summary, pain_point_labels, category_labels,
  competitors_mentioned, sentiment, severity, purchase_intent, workaround_described,
  willingness_to_pay_cents, geography, engagement_score, confidence, dedupe_hash, created_at`;

/**
 * SimHash-style content fingerprint. Normalises whitespace and case so the same
 * comment fetched from two URLs collapses, without collapsing genuinely
 * distinct complaints that merely share vocabulary.
 */
export function evidenceDedupeHash(input: { sourceUrl: string | null; externalId: string | null; summary: string }): string {
  const identity = input.externalId ?? input.sourceUrl ?? '';
  const normalised = input.summary.toLowerCase().replace(/\s+/g, ' ').trim();
  return createHash('sha256').update(`${identity}|${normalised}`).digest('hex').slice(0, 32);
}

export class EvidenceRepository {
  constructor(private readonly db: Queryable) {}

  /** Inserts, or returns the existing row when this content was already collected. */
  async insert(companyId: string, draft: EvidenceDraft): Promise<{ row: EvidenceRow; isNew: boolean }> {
    const dedupeHash = evidenceDedupeHash({
      sourceUrl: draft.sourceUrl,
      externalId: draft.externalId,
      summary: draft.summary,
    });

    const inserted = await this.db.query(
      `INSERT INTO evidence_items
         (id, company_id, source_kind, source_url, external_id, source_domain, retrieved_at, authored_at,
          provenance, compliance, excerpt, summary, language, pain_point_labels, category_labels,
          competitors_mentioned, sentiment, severity, purchase_intent, workaround_described,
          willingness_to_pay_cents, geography, engagement_score, confidence, dedupe_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)
       ON CONFLICT (company_id, dedupe_hash) DO NOTHING
       RETURNING ${EVIDENCE_COLUMNS}`,
      [
        newId('evidence'), companyId, draft.sourceKind, draft.sourceUrl, draft.externalId, draft.sourceDomain,
        draft.retrievedAt, draft.authoredAt, JSON.stringify(draft.provenance), JSON.stringify(draft.compliance),
        // Honour the compliance decision at write time, not just at read time.
        draft.compliance.excerptStoragePermitted ? draft.excerpt : null,
        draft.summary, draft.language, draft.painPointLabels, draft.categoryLabels, draft.competitorsMentioned,
        draft.sentiment, draft.severity, draft.purchaseIntent, draft.workaroundDescribed,
        draft.willingnessToPayCents, draft.geography, draft.engagementScore, draft.confidence, dedupeHash,
      ],
    );

    if (inserted.rows[0]) return { row: EvidenceRow.parse(inserted.rows[0]), isNew: true };

    const existing = await qOne(
      this.db,
      `SELECT ${EVIDENCE_COLUMNS} FROM evidence_items WHERE company_id=$1 AND dedupe_hash=$2`,
      [companyId, dedupeHash],
      EvidenceRow,
      'evidence',
      dedupeHash,
    );
    return { row: existing, isNew: false };
  }

  async byId(id: string): Promise<EvidenceRow> {
    return qOne(this.db, `SELECT ${EVIDENCE_COLUMNS} FROM evidence_items WHERE id=$1`, [id], EvidenceRow, 'evidence', id);
  }

  async byIds(ids: readonly string[]): Promise<readonly EvidenceRow[]> {
    if (ids.length === 0) return [];
    return q(this.db, `SELECT ${EVIDENCE_COLUMNS} FROM evidence_items WHERE id = ANY($1)`, [ids], EvidenceRow);
  }

  async search(
    companyId: string,
    options: { labels?: readonly string[]; minConfidence?: number; since?: Date; limit?: number } = {},
  ): Promise<readonly EvidenceRow[]> {
    return q(
      this.db,
      `SELECT ${EVIDENCE_COLUMNS} FROM evidence_items
        WHERE company_id = $1
          AND superseded_by_evidence_id IS NULL
          AND confidence >= $2
          AND ($3::text[] IS NULL OR pain_point_labels && $3)
          AND ($4::timestamptz IS NULL OR retrieved_at >= $4)
        ORDER BY retrieved_at DESC
        LIMIT $5`,
      [
        companyId,
        options.minConfidence ?? 0.5,
        options.labels && options.labels.length > 0 ? options.labels : null,
        options.since ?? null,
        Math.min(options.limit ?? 200, 1000),
      ],
      EvidenceRow,
    );
  }

  async updateConfidence(id: string, confidence: number, reason: string): Promise<void> {
    await exec(
      this.db,
      `UPDATE evidence_items
          SET confidence = $2,
              compliance = compliance || jsonb_build_object('verificationNote', $3::text)
        WHERE id = $1`,
      [id, confidence, reason],
    );
  }

  async supersede(id: string, replacementId: string): Promise<void> {
    await exec(this.db, `UPDATE evidence_items SET superseded_by_evidence_id=$2 WHERE id=$1`, [id, replacementId]);
  }

  /** Distinct source domains behind a set of evidence — the diversity measure. */
  async independentSourceCount(evidenceIds: readonly string[]): Promise<number> {
    if (evidenceIds.length === 0) return 0;
    const row = await qMaybe(
      this.db,
      `SELECT COUNT(DISTINCT source_domain)::int AS n FROM evidence_items WHERE id = ANY($1)`,
      [evidenceIds],
      z.object({ n: z.number() }),
    );
    return row?.n ?? 0;
  }
}

/* -------------------------------------------------------------------------- */
/* Pain points                                                                 */
/* -------------------------------------------------------------------------- */

const PainPointRow = z.object({
  id: z.string(),
  company_id: z.string(),
  label: z.string(),
  statement: z.string(),
  segment: z.string(),
  category_labels: z.array(z.string()),
  evidence_count: z.number(),
  independent_source_count: z.number(),
  median_severity: z.number(),
  purchase_intent_ratio: z.number(),
  workaround_ratio: z.number(),
  competitors_mentioned: z.array(z.string()),
  first_observed_at: z.date(),
  last_observed_at: z.date(),
  status: z.string(),
  rejection_reason: z.string().nullable(),
});

export type PainPointRow = z.infer<typeof PainPointRow>;

const PAIN_COLUMNS = `id, company_id, label, statement, segment, category_labels, evidence_count,
  independent_source_count, median_severity, purchase_intent_ratio, workaround_ratio,
  competitors_mentioned, first_observed_at, last_observed_at, status, rejection_reason`;

export class PainPointRepository {
  constructor(private readonly pool: DbPool) {}

  async upsert(input: {
    companyId: string;
    label: string;
    statement: string;
    segment: string;
    categoryLabels?: readonly string[];
  }): Promise<PainPointRow> {
    return qOne(
      this.pool,
      `INSERT INTO pain_points (id, company_id, label, statement, segment, category_labels,
                                first_observed_at, last_observed_at)
       VALUES ($1,$2,$3,$4,$5,$6, now(), now())
       ON CONFLICT (company_id, label) DO UPDATE
         SET statement = EXCLUDED.statement,
             segment = EXCLUDED.segment,
             category_labels = EXCLUDED.category_labels,
             last_observed_at = now()
       RETURNING ${PAIN_COLUMNS}`,
      [newId('painPoint'), input.companyId, input.label, input.statement, input.segment, input.categoryLabels ?? []],
      PainPointRow,
      'pain_point',
      input.label,
    );
  }

  async linkEvidence(painPointId: string, evidenceIds: readonly string[], similarity?: number): Promise<number> {
    if (evidenceIds.length === 0) return 0;
    return withTransaction(this.pool, async (client) => {
      let linked = 0;
      for (const evidenceId of evidenceIds) {
        linked += await exec(
          client,
          `INSERT INTO pain_point_evidence (pain_point_id, evidence_id, similarity)
           VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
          [painPointId, evidenceId, similarity ?? null],
        );
      }
      return linked;
    });
  }

  /**
   * Recomputes the cluster's statistics from its linked evidence.
   *
   * Everything here is derived, never asserted — including
   * `independent_source_count`, which counts distinct domains rather than rows
   * so forty posts from one subreddit cannot masquerade as broad demand.
   */
  async recomputeStats(painPointId: string): Promise<PainPointRow> {
    return qOne(
      this.pool,
      `WITH stats AS (
         SELECT
           COUNT(*)::int                                        AS evidence_count,
           COUNT(DISTINCT e.source_domain)::int                 AS independent_source_count,
           COALESCE(percentile_cont(0.5) WITHIN GROUP (ORDER BY e.severity), 0) AS median_severity,
           COALESCE(AVG(CASE WHEN e.purchase_intent IN ('moderate','strong') THEN 1.0 ELSE 0.0 END), 0) AS purchase_intent_ratio,
           COALESCE(AVG(CASE WHEN e.workaround_described THEN 1.0 ELSE 0.0 END), 0) AS workaround_ratio,
           COALESCE(MIN(e.retrieved_at), now())                 AS first_observed_at,
           COALESCE(MAX(e.retrieved_at), now())                 AS last_observed_at,
           COALESCE(array_agg(DISTINCT c) FILTER (WHERE c IS NOT NULL), '{}') AS competitors
         FROM pain_point_evidence ppe
         JOIN evidence_items e ON e.id = ppe.evidence_id AND e.superseded_by_evidence_id IS NULL
         LEFT JOIN LATERAL unnest(e.competitors_mentioned) AS c ON TRUE
         WHERE ppe.pain_point_id = $1
       )
       UPDATE pain_points p
          SET evidence_count           = stats.evidence_count,
              independent_source_count = stats.independent_source_count,
              median_severity          = stats.median_severity,
              purchase_intent_ratio    = stats.purchase_intent_ratio,
              workaround_ratio         = stats.workaround_ratio,
              competitors_mentioned    = stats.competitors,
              first_observed_at        = stats.first_observed_at,
              last_observed_at         = stats.last_observed_at
         FROM stats
        WHERE p.id = $1
        RETURNING ${PAIN_COLUMNS.split(', ').map((c) => `p.${c.trim()}`).join(', ')}`,
      [painPointId],
      PainPointRow,
      'pain_point',
      painPointId,
    );
  }

  async listRanked(companyId: string, limit = 25): Promise<readonly PainPointRow[]> {
    return q(
      this.pool,
      `SELECT ${PAIN_COLUMNS} FROM pain_points
        WHERE company_id=$1 AND status IN ('candidate','validated')
        ORDER BY independent_source_count DESC, median_severity DESC, evidence_count DESC
        LIMIT $2`,
      [companyId, limit],
      PainPointRow,
    );
  }

  async byId(id: string): Promise<PainPointRow> {
    return qOne(this.pool, `SELECT ${PAIN_COLUMNS} FROM pain_points WHERE id=$1`, [id], PainPointRow, 'pain_point', id);
  }

  async setStatus(id: string, status: string, rejectionReason?: string | null): Promise<void> {
    await exec(this.pool, `UPDATE pain_points SET status=$2, rejection_reason=$3 WHERE id=$1`, [id, status, rejectionReason ?? null]);
  }

  async evidenceIds(painPointId: string): Promise<readonly string[]> {
    const rows = await q(
      this.pool,
      `SELECT evidence_id FROM pain_point_evidence WHERE pain_point_id=$1`,
      [painPointId],
      z.object({ evidence_id: z.string() }),
    );
    return rows.map((r) => r.evidence_id);
  }
}

/* -------------------------------------------------------------------------- */
/* Opportunity graph                                                           */
/* -------------------------------------------------------------------------- */

export class GraphRepository {
  constructor(private readonly db: Queryable) {}

  async upsertNode(input: {
    companyId: string;
    kind: GraphNodeKind;
    label: string;
    refId?: string | null;
    attributes?: Record<string, unknown>;
  }): Promise<string> {
    const row = await qOne(
      this.db,
      `INSERT INTO graph_nodes (id, company_id, kind, label, ref_id, attributes)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb)
       ON CONFLICT (company_id, kind, label) DO UPDATE
         SET ref_id = COALESCE(EXCLUDED.ref_id, graph_nodes.ref_id),
             attributes = graph_nodes.attributes || EXCLUDED.attributes
       RETURNING id`,
      [newId('task'), input.companyId, input.kind, input.label, input.refId ?? null, JSON.stringify(input.attributes ?? {})],
      z.object({ id: z.string() }),
      'graph_node',
      input.label,
    );
    return row.id;
  }

  async upsertEdge(input: {
    companyId: string;
    kind: GraphEdgeKind;
    fromNodeId: string;
    toNodeId: string;
    weight?: number;
    evidenceIds?: readonly string[];
  }): Promise<string> {
    const row = await qOne(
      this.db,
      `INSERT INTO graph_edges (id, company_id, kind, from_node_id, to_node_id, weight, evidence_ids)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (company_id, kind, from_node_id, to_node_id) DO UPDATE
         SET weight = EXCLUDED.weight,
             -- Union the evidence rather than replacing it: each new supporting
             -- source strengthens the edge and must stay inspectable.
             evidence_ids = ARRAY(SELECT DISTINCT unnest(graph_edges.evidence_ids || EXCLUDED.evidence_ids))
       RETURNING id`,
      [newId('task'), input.companyId, input.kind, input.fromNodeId, input.toNodeId, input.weight ?? 1, input.evidenceIds ?? []],
      z.object({ id: z.string() }),
      'graph_edge',
      input.kind,
    );
    return row.id;
  }

  /** Neighbourhood around a node, so the CEO can ask "why do we believe this?". */
  async neighbourhood(nodeId: string, depth = 1): Promise<{ nodes: unknown[]; edges: unknown[] }> {
    const edges = await q(
      this.db,
      `WITH RECURSIVE walk(node_id, level) AS (
         SELECT $1::text, 0
         UNION
         SELECT CASE WHEN e.from_node_id = w.node_id THEN e.to_node_id ELSE e.from_node_id END, w.level + 1
           FROM walk w
           JOIN graph_edges e ON e.from_node_id = w.node_id OR e.to_node_id = w.node_id
          WHERE w.level < $2
       )
       SELECT DISTINCT e.id, e.kind, e.from_node_id, e.to_node_id, e.weight, e.evidence_ids
         FROM graph_edges e
        WHERE e.from_node_id IN (SELECT node_id FROM walk)
           OR e.to_node_id   IN (SELECT node_id FROM walk)`,
      [nodeId, depth],
      z.record(z.string(), z.unknown()),
    );
    const nodeIds = new Set<string>([nodeId]);
    for (const e of edges) {
      nodeIds.add(e['from_node_id'] as string);
      nodeIds.add(e['to_node_id'] as string);
    }
    const nodes = await q(
      this.db,
      `SELECT id, kind, label, ref_id, attributes FROM graph_nodes WHERE id = ANY($1)`,
      [[...nodeIds]],
      z.record(z.string(), z.unknown()),
    );
    return { nodes: [...nodes], edges: [...edges] };
  }
}

/* -------------------------------------------------------------------------- */
/* Opportunities and scorecards                                                */
/* -------------------------------------------------------------------------- */

const OpportunityRow = z.object({
  id: z.string(),
  company_id: z.string(),
  title: z.string(),
  concept: z.string(),
  pain_point_ids: z.array(z.string()),
  target_segment: z.string(),
  category: z.string(),
  value_hypothesis: z.string(),
  assumed_selling_price_cents: z.number().nullable(),
  currency: z.string(),
  stage: z.string(),
  latest_scorecard_id: z.string().nullable(),
  kill_reason: z.string().nullable(),
  created_at: z.date(),
  updated_at: z.date(),
});

const ScorecardRow = z.object({
  id: z.string(),
  opportunity_id: z.string(),
  weight_profile: z.string(),
  dimensions: z.array(z.record(z.string(), z.unknown())),
  overrides: z.array(z.record(z.string(), z.unknown())),
  composite: z.number(),
  grounded_composite: z.number(),
  grounded_weight_ratio: z.number(),
  computed_at: z.date(),
});

export type OpportunityRow = z.infer<typeof OpportunityRow>;
export type ScorecardRow = z.infer<typeof ScorecardRow>;

const OPP_COLUMNS = `id, company_id, title, concept, pain_point_ids, target_segment, category,
  value_hypothesis, assumed_selling_price_cents, currency, stage, latest_scorecard_id, kill_reason,
  created_at, updated_at`;
const SCORE_COLUMNS = `id, opportunity_id, weight_profile, dimensions, overrides, composite,
  grounded_composite, grounded_weight_ratio, computed_at`;

export class OpportunityRepository {
  constructor(private readonly pool: DbPool) {}

  async create(input: {
    companyId: string;
    title: string;
    concept: string;
    painPointIds: readonly string[];
    targetSegment: string;
    category: string;
    valueHypothesis: string;
    assumedSellingPriceCents?: number | null;
    currency?: string;
  }): Promise<OpportunityRow> {
    return qOne(
      this.pool,
      `INSERT INTO opportunities (id, company_id, title, concept, pain_point_ids, target_segment, category,
                                  value_hypothesis, assumed_selling_price_cents, currency, stage)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'discovered')
       RETURNING ${OPP_COLUMNS}`,
      [
        newId('opportunity'), input.companyId, input.title, input.concept, input.painPointIds,
        input.targetSegment, input.category, input.valueHypothesis,
        input.assumedSellingPriceCents ?? null, input.currency ?? 'USD',
      ],
      OpportunityRow,
      'opportunity',
      input.title,
    );
  }

  async byId(id: string): Promise<OpportunityRow> {
    return qOne(this.pool, `SELECT ${OPP_COLUMNS} FROM opportunities WHERE id=$1`, [id], OpportunityRow, 'opportunity', id);
  }

  async list(companyId: string, stages?: readonly OpportunityStage[]): Promise<readonly OpportunityRow[]> {
    return q(
      this.pool,
      `SELECT ${OPP_COLUMNS} FROM opportunities
        WHERE company_id=$1 AND ($2::text[] IS NULL OR stage = ANY($2))
        ORDER BY updated_at DESC`,
      [companyId, stages && stages.length > 0 ? stages : null],
      OpportunityRow,
    );
  }

  /** Ranked by grounded composite — the score backed by real data, not estimates. */
  async ranked(companyId: string, limit = 10): Promise<readonly (OpportunityRow & { composite: number | null; grounded_weight_ratio: number | null })[]> {
    return q(
      this.pool,
      `SELECT o.id, o.company_id, o.title, o.concept, o.pain_point_ids, o.target_segment, o.category,
              o.value_hypothesis, o.assumed_selling_price_cents, o.currency, o.stage, o.latest_scorecard_id,
              o.kill_reason, o.created_at, o.updated_at,
              s.composite, s.grounded_weight_ratio
         FROM opportunities o
         LEFT JOIN opportunity_scorecards s ON s.id = o.latest_scorecard_id
        WHERE o.company_id = $1 AND o.stage NOT IN ('killed','parked')
        ORDER BY s.grounded_composite DESC NULLS LAST, s.composite DESC NULLS LAST
        LIMIT $2`,
      [companyId, limit],
      OpportunityRow.extend({ composite: z.number().nullable(), grounded_weight_ratio: z.number().nullable() }),
    );
  }

  async setStage(id: string, stage: OpportunityStage, killReason?: string | null): Promise<void> {
    await exec(this.pool, `UPDATE opportunities SET stage=$2, kill_reason=$3 WHERE id=$1`, [id, stage, killReason ?? null]);
  }

  async setAssumedPrice(id: string, cents: number): Promise<void> {
    await exec(this.pool, `UPDATE opportunities SET assumed_selling_price_cents=$2 WHERE id=$1`, [id, cents]);
  }

  /** Writes a scorecard and makes it the opportunity's current score. */
  async writeScorecard(input: {
    opportunityId: string;
    weightProfile: string;
    dimensions: readonly DimensionScore[];
    overrides?: readonly HumanOverride[];
    weights?: WeightProfile;
  }): Promise<ScorecardRow> {
    const computation = computeComposite(input.dimensions, input.overrides ?? [], input.weights);

    return withTransaction(this.pool, async (client) => {
      const row = await qOne(
        client,
        `INSERT INTO opportunity_scorecards (id, opportunity_id, weight_profile, dimensions, overrides,
                                             composite, grounded_composite, grounded_weight_ratio)
         VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7,$8)
         RETURNING ${SCORE_COLUMNS}`,
        [
          newId('scorecard'), input.opportunityId, input.weightProfile,
          JSON.stringify(input.dimensions), JSON.stringify(input.overrides ?? []),
          computation.composite, computation.groundedComposite, computation.groundedWeightRatio,
        ],
        ScorecardRow,
        'scorecard',
        input.opportunityId,
      );
      await exec(client, `UPDATE opportunities SET latest_scorecard_id=$2 WHERE id=$1`, [input.opportunityId, row.id]);
      return row;
    });
  }

  async latestScorecard(opportunityId: string): Promise<ScorecardRow | undefined> {
    return qMaybe(
      this.pool,
      `SELECT ${SCORE_COLUMNS} FROM opportunity_scorecards WHERE opportunity_id=$1 ORDER BY computed_at DESC LIMIT 1`,
      [opportunityId],
      ScorecardRow,
    );
  }

  async scorecardHistory(opportunityId: string, limit = 10): Promise<readonly ScorecardRow[]> {
    return q(
      this.pool,
      `SELECT ${SCORE_COLUMNS} FROM opportunity_scorecards WHERE opportunity_id=$1 ORDER BY computed_at DESC LIMIT $2`,
      [opportunityId, limit],
      ScorecardRow,
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Expert reviews                                                              */
/* -------------------------------------------------------------------------- */

const ReviewRow = z.object({
  id: z.string(),
  company_id: z.string(),
  subject: z.string(),
  subject_ref_id: z.string(),
  provider: z.string(),
  external_engagement_id: z.string().nullable(),
  external_request_id: z.string().nullable(),
  status: z.string(),
  question: z.string(),
  rubric: z.array(z.record(z.string(), z.unknown())),
  participants_requested: z.number(),
  cost_per_participant_minor: z.number().nullable(),
  currency: z.string().nullable(),
  verdict: z.string(),
  mean_scores: z.record(z.string(), z.number()),
  requested_at: z.date(),
  completed_at: z.date().nullable(),
});

export type ExpertReviewRow = z.infer<typeof ReviewRow>;

const REVIEW_COLUMNS = `id, company_id, subject, subject_ref_id, provider, external_engagement_id,
  external_request_id, status, question, rubric, participants_requested, cost_per_participant_minor,
  currency, verdict, mean_scores, requested_at, completed_at`;

export class ExpertReviewRepository {
  constructor(private readonly db: Queryable) {}

  async create(input: {
    companyId: string;
    subject: string;
    subjectRefId: string;
    provider: string;
    question: string;
    rubric: readonly Record<string, unknown>[];
    participantsRequested: number;
  }): Promise<ExpertReviewRow> {
    return qOne(
      this.db,
      `INSERT INTO expert_reviews (id, company_id, subject, subject_ref_id, provider, status, question,
                                   rubric, participants_requested)
       VALUES ($1,$2,$3,$4,$5,'requested',$6,$7::jsonb,$8)
       RETURNING ${REVIEW_COLUMNS}`,
      [
        newId('expertReview'), input.companyId, input.subject, input.subjectRefId, input.provider,
        input.question, JSON.stringify(input.rubric), input.participantsRequested,
      ],
      ReviewRow,
      'expert_review',
      input.subjectRefId,
    );
  }

  async setExternalIds(id: string, refs: { engagementId?: string | null; requestId?: string | null }): Promise<void> {
    await exec(
      this.db,
      `UPDATE expert_reviews
          SET external_engagement_id = COALESCE($2, external_engagement_id),
              external_request_id    = COALESCE($3, external_request_id)
        WHERE id=$1`,
      [id, refs.engagementId ?? null, refs.requestId ?? null],
    );
  }

  async setStatus(id: string, status: string, costPerParticipantMinor?: number | null, currency?: string | null): Promise<void> {
    await exec(
      this.db,
      `UPDATE expert_reviews
          SET status=$2,
              cost_per_participant_minor = COALESCE($3, cost_per_participant_minor),
              currency = COALESCE($4, currency)
        WHERE id=$1`,
      [id, status, costPerParticipantMinor ?? null, currency ?? null],
    );
  }

  async recordSubmission(input: {
    expertReviewId: string;
    externalSubmissionId: string;
    expertRef: string;
    attestations?: readonly string[];
    scores: Record<string, number>;
    critique: string;
    recommendation: 'approve' | 'approve_with_changes' | 'reject';
    suggestedChanges?: readonly string[];
    approved: boolean;
    submittedAt: Date;
  }): Promise<boolean> {
    const inserted = await exec(
      this.db,
      `INSERT INTO expert_review_submissions (id, expert_review_id, external_submission_id, expert_ref,
                                              attestations, scores, critique, recommendation,
                                              suggested_changes, approved, submitted_at)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11)
       ON CONFLICT (expert_review_id, external_submission_id) DO NOTHING`,
      [
        newId('task'), input.expertReviewId, input.externalSubmissionId, input.expertRef,
        input.attestations ?? [], JSON.stringify(input.scores), input.critique, input.recommendation,
        input.suggestedChanges ?? [], input.approved, input.submittedAt,
      ],
    );
    return inserted > 0;
  }

  async submissions(expertReviewId: string): Promise<readonly Record<string, unknown>[]> {
    return q(
      this.db,
      `SELECT external_submission_id, expert_ref, attestations, scores, critique, recommendation,
              suggested_changes, approved, submitted_at
         FROM expert_review_submissions WHERE expert_review_id=$1 ORDER BY submitted_at`,
      [expertReviewId],
      z.record(z.string(), z.unknown()),
    );
  }

  async setVerdict(id: string, verdict: string, meanScores: Record<string, number>): Promise<void> {
    await exec(
      this.db,
      `UPDATE expert_reviews SET verdict=$2, mean_scores=$3::jsonb, status='completed', completed_at=now() WHERE id=$1`,
      [id, verdict, JSON.stringify(meanScores)],
    );
  }

  async byId(id: string): Promise<ExpertReviewRow> {
    return qOne(this.db, `SELECT ${REVIEW_COLUMNS} FROM expert_reviews WHERE id=$1`, [id], ReviewRow, 'expert_review', id);
  }

  async listOpen(companyId: string): Promise<readonly ExpertReviewRow[]> {
    return q(
      this.db,
      `SELECT ${REVIEW_COLUMNS} FROM expert_reviews
        WHERE company_id=$1 AND status NOT IN ('completed','cancelled','failed')
        ORDER BY requested_at`,
      [companyId],
      ReviewRow,
    );
  }

  async completedFor(companyId: string, subject: string, subjectRefId: string): Promise<ExpertReviewRow | undefined> {
    return qMaybe(
      this.db,
      `SELECT ${REVIEW_COLUMNS} FROM expert_reviews
        WHERE company_id=$1 AND subject=$2 AND subject_ref_id=$3 AND status='completed'
        ORDER BY completed_at DESC LIMIT 1`,
      [companyId, subject, subjectRefId],
      ReviewRow,
    );
  }
}

export class ResearchRepositories {
  readonly evidence: EvidenceRepository;
  readonly painPoints: PainPointRepository;
  readonly graph: GraphRepository;
  readonly opportunities: OpportunityRepository;
  readonly expertReviews: ExpertReviewRepository;

  constructor(pool: DbPool) {
    this.evidence = new EvidenceRepository(pool);
    this.painPoints = new PainPointRepository(pool);
    this.graph = new GraphRepository(pool);
    this.opportunities = new OpportunityRepository(pool);
    this.expertReviews = new ExpertReviewRepository(pool);
  }
}
