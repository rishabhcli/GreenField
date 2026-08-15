/**
 * Growth and support persistence: creative, experiments, metrics, tickets.
 *
 * `approveConcept` is the only path to `human_approved`, and it refuses without
 * a completed expert review on record. The database trigger on `experiment_arms`
 * enforces the same rule from the other side, so ad spend on unreviewed creative
 * is impossible from either direction.
 */

import { z } from 'zod';
import {
  ConflictError,
  decideArm,
  deriveMetrics,
  newId,
  type AdPlatform,
  type ArmDecision,
  type ExperimentObjective,
  type MetricSnapshot,
  type StopCondition,
  type TicketIntent,
} from '@foundry/core';
import { exec, q, qMaybe, qOne, withTransaction, type DbPool, type Queryable } from '../pool.js';

/* -------------------------------------------------------------------------- */
/* Creative                                                                    */
/* -------------------------------------------------------------------------- */

const ConceptRow = z.object({
  id: z.string(),
  company_id: z.string(),
  brand_id: z.string(),
  hypothesis: z.string(),
  angle: z.string(),
  hook: z.string(),
  primary_text: z.string(),
  headline: z.string(),
  description: z.string().nullable(),
  call_to_action: z.string(),
  asset_ids: z.array(z.string()),
  landing_path: z.string(),
  claims_used: z.array(z.string()),
  platform: z.string(),
  status: z.string(),
  review_ids: z.array(z.string()),
  created_at: z.date(),
});

export type ConceptRow = z.infer<typeof ConceptRow>;

const CONCEPT_COLUMNS = `id, company_id, brand_id, hypothesis, angle, hook, primary_text, headline,
  description, call_to_action, asset_ids, landing_path, claims_used, platform, status, review_ids, created_at`;

export class CreativeRepository {
  constructor(private readonly pool: DbPool) {}

  async create(input: {
    companyId: string;
    brandId: string;
    hypothesis: string;
    angle: string;
    hook: string;
    primaryText: string;
    headline: string;
    callToAction: string;
    landingPath: string;
    platform: AdPlatform;
    description?: string | null;
    assetIds?: readonly string[];
    claimsUsed?: readonly string[];
  }): Promise<ConceptRow> {
    return qOne(
      this.pool,
      `INSERT INTO creative_concepts (id, company_id, brand_id, hypothesis, angle, hook, primary_text,
                                      headline, description, call_to_action, asset_ids, landing_path,
                                      claims_used, platform, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'draft')
       RETURNING ${CONCEPT_COLUMNS}`,
      [
        newId('creative'), input.companyId, input.brandId, input.hypothesis, input.angle, input.hook,
        input.primaryText, input.headline, input.description ?? null, input.callToAction,
        input.assetIds ?? [], input.landingPath, input.claimsUsed ?? [], input.platform,
      ],
      ConceptRow,
      'creative_concept',
      input.hook,
    );
  }

  async byId(id: string): Promise<ConceptRow> {
    return qOne(this.pool, `SELECT ${CONCEPT_COLUMNS} FROM creative_concepts WHERE id=$1`, [id], ConceptRow, 'creative_concept', id);
  }

  /**
   * Verifies every objective claim against the brand's substantiation register.
   * An unsupported claim fails the concept rather than being quietly dropped —
   * a claim we cannot back costs the ad account and invites a regulator.
   */
  async checkClaims(conceptId: string): Promise<{ ok: boolean; unsupported: readonly string[] }> {
    const row = await qOne(
      this.pool,
      `SELECT c.claims_used,
              COALESCE(ARRAY(SELECT jsonb_array_elements(b.permitted_claims) ->> 'claim'), '{}') AS permitted,
              b.prohibited_claims
         FROM creative_concepts c
         JOIN brand_identities b ON b.id = c.brand_id
        WHERE c.id = $1`,
      [conceptId],
      z.object({
        claims_used: z.array(z.string()),
        permitted: z.array(z.string()),
        prohibited_claims: z.array(z.string()),
      }),
      'creative_concept',
      conceptId,
    );

    const permitted = new Set(row.permitted);
    const prohibited = new Set(row.prohibited_claims);
    const unsupported = row.claims_used.filter((c) => !permitted.has(c) || prohibited.has(c));

    if (unsupported.length > 0) {
      await exec(this.pool, `UPDATE creative_concepts SET status='claims_check_failed' WHERE id=$1`, [conceptId]);
    }
    return { ok: unsupported.length === 0, unsupported };
  }

  async requestReview(conceptId: string, reviewId: string): Promise<void> {
    await exec(
      this.pool,
      `UPDATE creative_concepts
          SET status='awaiting_human_review',
              review_ids = ARRAY(SELECT DISTINCT unnest(review_ids || ARRAY[$2::text]))
        WHERE id=$1`,
      [conceptId, reviewId],
    );
  }

  /**
   * Approves a concept for spend — the only path to `human_approved`.
   * Refuses without a completed expert review whose verdict permits it.
   */
  async applyReviewVerdict(conceptId: string, reviewId: string): Promise<{ status: string; verdict: string }> {
    return withTransaction(this.pool, async (client) => {
      const review = await qMaybe(
        client,
        `SELECT verdict, status FROM expert_reviews WHERE id=$1`,
        [reviewId],
        z.object({ verdict: z.string(), status: z.string() }),
      );
      if (!review) throw new ConflictError(`Expert review ${reviewId} does not exist`, { conceptId, reviewId });
      if (review.status !== 'completed') {
        throw new ConflictError(
          `Expert review ${reviewId} is "${review.status}", not completed. Creative cannot be approved for spend yet.`,
          { conceptId, reviewId, reviewStatus: review.status },
        );
      }

      const status =
        review.verdict === 'approved' || review.verdict === 'approve_with_changes'
          ? 'human_approved'
          : 'human_rejected';

      await exec(
        client,
        `UPDATE creative_concepts
            SET status=$2, review_ids = ARRAY(SELECT DISTINCT unnest(review_ids || ARRAY[$3::text]))
          WHERE id=$1`,
        [conceptId, status, reviewId],
      );
      return { status, verdict: review.verdict };
    });
  }

  async setStatus(id: string, status: string): Promise<void> {
    await exec(this.pool, `UPDATE creative_concepts SET status=$2 WHERE id=$1`, [id, status]);
  }

  async listAwaitingReview(companyId: string): Promise<readonly ConceptRow[]> {
    return q(
      this.pool,
      `SELECT ${CONCEPT_COLUMNS} FROM creative_concepts WHERE company_id=$1 AND status='awaiting_human_review' ORDER BY created_at`,
      [companyId],
      ConceptRow,
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Experiments                                                                 */
/* -------------------------------------------------------------------------- */

const ExperimentRow = z.object({
  id: z.string(),
  company_id: z.string(),
  brand_id: z.string(),
  name: z.string(),
  hypothesis: z.string(),
  platform: z.string(),
  objective: z.string(),
  audience_spec: z.record(z.string(), z.unknown()),
  total_budget_minor: z.number(),
  currency: z.string(),
  stop_conditions: z.array(z.record(z.string(), z.unknown())),
  attribution_model: z.string(),
  status: z.string(),
  approval_id: z.string().nullable(),
  started_at: z.date().nullable(),
  ended_at: z.date().nullable(),
  conclusion: z.string().nullable(),
});

const ArmRow = z.object({
  id: z.string(),
  experiment_id: z.string(),
  name: z.string(),
  creative_concept_id: z.string(),
  landing_path: z.string(),
  external_refs: z.record(z.string(), z.string()),
  daily_budget_minor: z.number(),
  status: z.string(),
  stop_reason: z.string().nullable(),
});

export type ExperimentRow = z.infer<typeof ExperimentRow>;
export type ArmRow = z.infer<typeof ArmRow>;

const EXP_COLUMNS = `id, company_id, brand_id, name, hypothesis, platform, objective, audience_spec,
  total_budget_minor, currency, stop_conditions, attribution_model, status, approval_id, started_at,
  ended_at, conclusion`;
const ARM_COLUMNS = `id, experiment_id, name, creative_concept_id, landing_path, external_refs,
  daily_budget_minor, status, stop_reason`;

export class ExperimentRepository {
  constructor(private readonly pool: DbPool) {}

  async create(input: {
    companyId: string;
    brandId: string;
    name: string;
    hypothesis: string;
    platform: AdPlatform;
    objective: ExperimentObjective;
    audienceSpec: Record<string, unknown>;
    totalBudgetMinor: number;
    currency: string;
    stopConditions: readonly StopCondition[];
    attributionModel: 'platform_reported' | 'first_party_click_id' | 'blended';
  }): Promise<ExperimentRow> {
    if (input.stopConditions.length === 0) {
      throw new ConflictError('An experiment must declare at least one stop condition before it can be created');
    }
    return qOne(
      this.pool,
      `INSERT INTO experiments (id, company_id, brand_id, name, hypothesis, platform, objective,
                                audience_spec, total_budget_minor, currency, stop_conditions,
                                attribution_model, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11::jsonb,$12,'draft')
       RETURNING ${EXP_COLUMNS}`,
      [
        newId('experiment'), input.companyId, input.brandId, input.name, input.hypothesis, input.platform,
        input.objective, JSON.stringify(input.audienceSpec), input.totalBudgetMinor, input.currency,
        JSON.stringify(input.stopConditions), input.attributionModel,
      ],
      ExperimentRow,
      'experiment',
      input.name,
    );
  }

  async approve(id: string, approvalId: string): Promise<void> {
    await exec(this.pool, `UPDATE experiments SET status='approved', approval_id=$2 WHERE id=$1 AND status IN ('draft','pending_approval')`, [id, approvalId]);
  }

  async start(id: string): Promise<ExperimentRow> {
    return qOne(
      this.pool,
      `UPDATE experiments SET status='running', started_at=COALESCE(started_at, now())
        WHERE id=$1 AND status='approved' AND approval_id IS NOT NULL
        RETURNING ${EXP_COLUMNS}`,
      [id],
      ExperimentRow,
      'experiment',
      id,
    );
  }

  async conclude(id: string, conclusion: string): Promise<void> {
    await exec(this.pool, `UPDATE experiments SET status='concluded', ended_at=now(), conclusion=$2 WHERE id=$1`, [id, conclusion]);
  }

  async pause(id: string, reason: string): Promise<void> {
    await withTransaction(this.pool, async (client) => {
      await exec(client, `UPDATE experiments SET status='paused', conclusion=COALESCE(conclusion, $2) WHERE id=$1`, [id, reason]);
      await exec(client, `UPDATE experiment_arms SET status='paused' WHERE experiment_id=$1 AND status='live'`, [id]);
    });
  }

  async byId(id: string): Promise<ExperimentRow> {
    return qOne(this.pool, `SELECT ${EXP_COLUMNS} FROM experiments WHERE id=$1`, [id], ExperimentRow, 'experiment', id);
  }

  async listRunning(companyId: string): Promise<readonly ExperimentRow[]> {
    return q(this.pool, `SELECT ${EXP_COLUMNS} FROM experiments WHERE company_id=$1 AND status='running' ORDER BY started_at`, [companyId], ExperimentRow);
  }

  async addArm(input: {
    experimentId: string;
    name: string;
    creativeConceptId: string;
    landingPath: string;
    dailyBudgetMinor: number;
  }): Promise<ArmRow> {
    return qOne(
      this.pool,
      `INSERT INTO experiment_arms (id, experiment_id, name, creative_concept_id, landing_path,
                                    daily_budget_minor, status)
       VALUES ($1,$2,$3,$4,$5,$6,'draft')
       RETURNING ${ARM_COLUMNS}`,
      [newId('experimentArm'), input.experimentId, input.name, input.creativeConceptId, input.landingPath, input.dailyBudgetMinor],
      ArmRow,
      'experiment_arm',
      input.name,
    );
  }

  /** The database trigger refuses this unless the creative is human-approved. */
  async setArmStatus(id: string, status: string, stopReason?: string | null): Promise<ArmRow> {
    return qOne(
      this.pool,
      `UPDATE experiment_arms SET status=$2, stop_reason=COALESCE($3, stop_reason) WHERE id=$1 RETURNING ${ARM_COLUMNS}`,
      [id, status, stopReason ?? null],
      ArmRow,
      'experiment_arm',
      id,
    );
  }

  async setArmBudget(id: string, dailyBudgetMinor: number): Promise<void> {
    await exec(this.pool, `UPDATE experiment_arms SET daily_budget_minor=$2 WHERE id=$1`, [id, dailyBudgetMinor]);
  }

  async setArmExternalRef(id: string, key: string, value: string): Promise<void> {
    await exec(
      this.pool,
      `UPDATE experiment_arms SET external_refs = external_refs || jsonb_build_object($2::text,$3::text) WHERE id=$1`,
      [id, key, value],
    );
  }

  async arms(experimentId: string): Promise<readonly ArmRow[]> {
    return q(this.pool, `SELECT ${ARM_COLUMNS} FROM experiment_arms WHERE experiment_id=$1 ORDER BY name`, [experimentId], ArmRow);
  }

  async armById(id: string): Promise<ArmRow> {
    return qOne(this.pool, `SELECT ${ARM_COLUMNS} FROM experiment_arms WHERE id=$1`, [id], ArmRow, 'experiment_arm', id);
  }
}

/* -------------------------------------------------------------------------- */
/* Metrics                                                                     */
/* -------------------------------------------------------------------------- */

const SnapshotRow = z.object({
  id: z.string(),
  company_id: z.string(),
  scope: z.string(),
  scope_ref_id: z.string(),
  source: z.string(),
  window_start: z.date(),
  window_end: z.date(),
  currency: z.string(),
  impressions: z.number(),
  reach: z.number(),
  clicks: z.number(),
  spend_minor: z.number(),
  landing_page_views: z.number(),
  add_to_carts: z.number(),
  checkout_starts: z.number(),
  purchases: z.number(),
  revenue_minor: z.number(),
  refunds_minor: z.number(),
  contribution_margin_minor: z.number(),
  repeat_purchases: z.number(),
  support_contacts: z.number(),
  collected_at: z.date(),
});

export type SnapshotRow = z.infer<typeof SnapshotRow>;

const SNAP_COLUMNS = `id, company_id, scope, scope_ref_id, source, window_start, window_end, currency,
  impressions, reach, clicks, spend_minor, landing_page_views, add_to_carts, checkout_starts, purchases,
  revenue_minor, refunds_minor, contribution_margin_minor, repeat_purchases, support_contacts, collected_at`;

export class MetricRepository {
  constructor(private readonly pool: DbPool) {}

  /** Re-collecting a window replaces it, so spend cannot be double-counted. */
  async upsert(snapshot: Omit<MetricSnapshot, 'id'>): Promise<SnapshotRow> {
    return qOne(
      this.pool,
      `INSERT INTO metric_snapshots (id, company_id, scope, scope_ref_id, source, window_start, window_end,
                                     currency, impressions, reach, clicks, spend_minor, landing_page_views,
                                     add_to_carts, checkout_starts, purchases, revenue_minor, refunds_minor,
                                     contribution_margin_minor, repeat_purchases, support_contacts, collected_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21, now())
       ON CONFLICT (scope, scope_ref_id, source, window_start, window_end) DO UPDATE
         SET impressions = EXCLUDED.impressions,
             reach = EXCLUDED.reach,
             clicks = EXCLUDED.clicks,
             spend_minor = EXCLUDED.spend_minor,
             landing_page_views = EXCLUDED.landing_page_views,
             add_to_carts = EXCLUDED.add_to_carts,
             checkout_starts = EXCLUDED.checkout_starts,
             purchases = EXCLUDED.purchases,
             revenue_minor = EXCLUDED.revenue_minor,
             refunds_minor = EXCLUDED.refunds_minor,
             contribution_margin_minor = EXCLUDED.contribution_margin_minor,
             repeat_purchases = EXCLUDED.repeat_purchases,
             support_contacts = EXCLUDED.support_contacts,
             collected_at = now()
       RETURNING ${SNAP_COLUMNS}`,
      [
        newId('metricSnapshot'), snapshot.companyId, snapshot.scope, snapshot.scopeRefId, snapshot.source,
        snapshot.windowStart, snapshot.windowEnd, snapshot.currency, snapshot.impressions, snapshot.reach,
        snapshot.clicks, snapshot.spendMinor, snapshot.landingPageViews, snapshot.addToCarts,
        snapshot.checkoutStarts, snapshot.purchases, snapshot.revenueMinor, snapshot.refundsMinor,
        snapshot.contributionMarginMinor, snapshot.repeatPurchases, snapshot.supportContacts,
      ],
      SnapshotRow,
      'metric_snapshot',
      snapshot.scopeRefId,
    );
  }

  /** Cumulative counts for a scope, which is what arm decisions are made on. */
  async aggregate(scope: string, scopeRefId: string, source?: string): Promise<MetricSnapshot | undefined> {
    const row = await qMaybe(
      this.pool,
      `SELECT company_id, currency,
              MIN(window_start) AS window_start, MAX(window_end) AS window_end,
              SUM(impressions)::bigint AS impressions, SUM(reach)::bigint AS reach,
              SUM(clicks)::bigint AS clicks, SUM(spend_minor)::bigint AS spend_minor,
              SUM(landing_page_views)::bigint AS landing_page_views,
              SUM(add_to_carts)::bigint AS add_to_carts,
              SUM(checkout_starts)::bigint AS checkout_starts,
              SUM(purchases)::bigint AS purchases,
              SUM(revenue_minor)::bigint AS revenue_minor,
              SUM(refunds_minor)::bigint AS refunds_minor,
              SUM(contribution_margin_minor)::bigint AS contribution_margin_minor,
              SUM(repeat_purchases)::bigint AS repeat_purchases,
              SUM(support_contacts)::bigint AS support_contacts
         FROM metric_snapshots
        WHERE scope=$1 AND scope_ref_id=$2 AND ($3::text IS NULL OR source=$3)
        GROUP BY company_id, currency`,
      [scope, scopeRefId, source ?? null],
      z.object({
        company_id: z.string(), currency: z.string(),
        window_start: z.date(), window_end: z.date(),
        impressions: z.number(), reach: z.number(), clicks: z.number(), spend_minor: z.number(),
        landing_page_views: z.number(), add_to_carts: z.number(), checkout_starts: z.number(),
        purchases: z.number(), revenue_minor: z.number(), refunds_minor: z.number(),
        contribution_margin_minor: z.number(), repeat_purchases: z.number(), support_contacts: z.number(),
      }),
    );
    if (!row) return undefined;

    return {
      id: `agg_${scopeRefId}`,
      companyId: row.company_id,
      scope: scope as MetricSnapshot['scope'],
      scopeRefId,
      source: (source ?? 'blended') as MetricSnapshot['source'],
      windowStart: row.window_start.toISOString(),
      windowEnd: row.window_end.toISOString(),
      currency: row.currency,
      impressions: row.impressions,
      reach: row.reach,
      clicks: row.clicks,
      spendMinor: row.spend_minor,
      landingPageViews: row.landing_page_views,
      addToCarts: row.add_to_carts,
      checkoutStarts: row.checkout_starts,
      purchases: row.purchases,
      revenueMinor: row.revenue_minor,
      refundsMinor: row.refunds_minor,
      contributionMarginMinor: row.contribution_margin_minor,
      repeatPurchases: row.repeat_purchases,
      supportContacts: row.support_contacts,
      collectedAt: new Date().toISOString(),
    };
  }

  /** Per-arm kill/hold/scale decisions, computed from recorded counts only. */
  async decideArms(
    experimentId: string,
    unitContributionMinor: number,
  ): Promise<readonly { arm: ArmRow; decision: ArmDecision; derived: ReturnType<typeof deriveMetrics> | null }[]> {
    const arms = await q(this.pool, `SELECT ${ARM_COLUMNS} FROM experiment_arms WHERE experiment_id=$1`, [experimentId], ArmRow);
    const results: { arm: ArmRow; decision: ArmDecision; derived: ReturnType<typeof deriveMetrics> | null }[] = [];

    for (const arm of arms) {
      const snapshot = await this.aggregate('arm', arm.id);
      if (!snapshot) {
        results.push({
          arm,
          decision: { kind: 'insufficient_data', armId: arm.id, reason: 'no metrics collected yet', needed: 'a metrics collection run' },
          derived: null,
        });
        continue;
      }
      results.push({
        arm,
        decision: decideArm({ armId: arm.id, snapshot, unitContributionMinor }),
        derived: deriveMetrics(snapshot),
      });
    }
    return results;
  }

  async recent(scope: string, scopeRefId: string, limit = 24): Promise<readonly SnapshotRow[]> {
    return q(
      this.pool,
      `SELECT ${SNAP_COLUMNS} FROM metric_snapshots WHERE scope=$1 AND scope_ref_id=$2 ORDER BY window_end DESC LIMIT $3`,
      [scope, scopeRefId, limit],
      SnapshotRow,
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Support                                                                     */
/* -------------------------------------------------------------------------- */

const TicketRow = z.object({
  id: z.string(),
  company_id: z.string(),
  customer_id: z.string().nullable(),
  order_id: z.string().nullable(),
  channel: z.string(),
  external_chat_id: z.string().nullable(),
  subject: z.string(),
  intent: z.string(),
  intent_confidence: z.number(),
  status: z.string(),
  priority: z.string(),
  escalation_reason: z.string().nullable(),
  escalated_at: z.date().nullable(),
  assigned_role_key: z.string().nullable(),
  assigned_human: z.string().nullable(),
  resolution: z.string().nullable(),
  resolution_cost_minor: z.number(),
  first_response_at: z.date().nullable(),
  resolved_at: z.date().nullable(),
  created_at: z.date(),
});

export type TicketRow = z.infer<typeof TicketRow>;

const TICKET_COLUMNS = `id, company_id, customer_id, order_id, channel, external_chat_id, subject, intent,
  intent_confidence, status, priority, escalation_reason, escalated_at, assigned_role_key, assigned_human,
  resolution, resolution_cost_minor, first_response_at, resolved_at, created_at`;

export class SupportRepository {
  constructor(private readonly pool: DbPool) {}

  /** Reuses the open ticket for a conversation so a thread stays one ticket. */
  async openOrGet(input: {
    companyId: string;
    channel: string;
    externalChatId?: string | null;
    customerId?: string | null;
    orderId?: string | null;
    subject: string;
    intent: TicketIntent;
    intentConfidence: number;
    priority?: string;
  }): Promise<{ ticket: TicketRow; isNew: boolean }> {
    if (input.externalChatId) {
      const existing = await qMaybe(
        this.pool,
        `SELECT ${TICKET_COLUMNS} FROM tickets
          WHERE company_id=$1 AND external_chat_id=$2 AND status NOT IN ('resolved','closed')
          ORDER BY created_at DESC LIMIT 1`,
        [input.companyId, input.externalChatId],
        TicketRow,
      );
      if (existing) return { ticket: existing, isNew: false };
    }

    const ticket = await qOne(
      this.pool,
      `INSERT INTO tickets (id, company_id, customer_id, order_id, channel, external_chat_id, subject,
                            intent, intent_confidence, status, priority)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'open',$10)
       RETURNING ${TICKET_COLUMNS}`,
      [
        newId('ticket'), input.companyId, input.customerId ?? null, input.orderId ?? null, input.channel,
        input.externalChatId ?? null, input.subject, input.intent, input.intentConfidence,
        input.priority ?? 'normal',
      ],
      TicketRow,
      'ticket',
      input.subject,
    );
    return { ticket, isNew: true };
  }

  async escalate(id: string, reason: string, priority: string): Promise<void> {
    await exec(
      this.pool,
      `UPDATE tickets SET status='escalated_to_human', escalation_reason=$2, priority=$3, escalated_at=now() WHERE id=$1`,
      [id, reason, priority],
    );
  }

  async resolve(id: string, resolution: string, costMinor = 0, currency?: string | null): Promise<void> {
    await exec(
      this.pool,
      `UPDATE tickets SET status='resolved', resolution=$2, resolution_cost_minor=$3,
                          currency=COALESCE($4, currency), resolved_at=now() WHERE id=$1`,
      [id, resolution, costMinor, currency ?? null],
    );
  }

  async setIntent(id: string, intent: TicketIntent, confidence: number): Promise<void> {
    await exec(this.pool, `UPDATE tickets SET intent=$2, intent_confidence=$3 WHERE id=$1`, [id, intent, confidence]);
  }

  async link(id: string, refs: { customerId?: string | null; orderId?: string | null }): Promise<void> {
    await exec(
      this.pool,
      `UPDATE tickets SET customer_id=COALESCE($2, customer_id), order_id=COALESCE($3, order_id) WHERE id=$1`,
      [id, refs.customerId ?? null, refs.orderId ?? null],
    );
  }

  async byId(id: string): Promise<TicketRow> {
    return qOne(this.pool, `SELECT ${TICKET_COLUMNS} FROM tickets WHERE id=$1`, [id], TicketRow, 'ticket', id);
  }

  async listOpen(companyId: string, limit = 50): Promise<readonly TicketRow[]> {
    return q(
      this.pool,
      `SELECT ${TICKET_COLUMNS} FROM tickets
        WHERE company_id=$1 AND status IN ('open','awaiting_internal','escalated_to_human')
        ORDER BY CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, created_at
        LIMIT $2`,
      [companyId, limit],
      TicketRow,
    );
  }

  async recordMessage(input: {
    companyId: string;
    ticketId?: string | null;
    customerId?: string | null;
    channel: string;
    direction: 'inbound' | 'outbound';
    provider: string;
    fromHandle: string;
    toHandle: string;
    body: string;
    status: string;
    externalChatId?: string | null;
    externalMessageId?: string | null;
    authoredByRunId?: string | null;
    authoredByHuman?: string | null;
    failureCode?: string | null;
    failureReason?: string | null;
  }): Promise<string> {
    const row = await qOne(
      this.pool,
      `INSERT INTO support_messages (id, company_id, ticket_id, customer_id, channel, direction, provider,
                                     external_chat_id, external_message_id, from_handle, to_handle, body,
                                     status, authored_by_run_id, authored_by_human, failure_code, failure_reason,
                                     sent_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,
               CASE WHEN $6='outbound' THEN now() ELSE NULL END)
       ON CONFLICT (provider, external_message_id) WHERE external_message_id IS NOT NULL
         DO UPDATE SET status = EXCLUDED.status
       RETURNING id`,
      [
        newId('message'), input.companyId, input.ticketId ?? null, input.customerId ?? null, input.channel,
        input.direction, input.provider, input.externalChatId ?? null, input.externalMessageId ?? null,
        input.fromHandle, input.toHandle, input.body, input.status, input.authoredByRunId ?? null,
        input.authoredByHuman ?? null, input.failureCode ?? null, input.failureReason ?? null,
      ],
      z.object({ id: z.string() }),
      'support_message',
      input.externalMessageId ?? 'new',
    );

    if (input.ticketId && input.direction === 'outbound') {
      await exec(this.pool, `UPDATE tickets SET first_response_at = COALESCE(first_response_at, now()) WHERE id=$1`, [input.ticketId]);
    }
    return row.id;
  }

  async updateMessageStatus(provider: string, externalMessageId: string, status: string, at?: Date): Promise<void> {
    await exec(
      this.pool,
      `UPDATE support_messages
          SET status=$3,
              delivered_at = CASE WHEN $3='delivered' THEN COALESCE($4, now()) ELSE delivered_at END,
              read_at      = CASE WHEN $3='read'      THEN COALESCE($4, now()) ELSE read_at END
        WHERE provider=$1 AND external_message_id=$2`,
      [provider, externalMessageId, status, at ?? null],
    );
  }

  async messageById(id: string): Promise<
    | {
        id: string;
        company_id: string;
        ticket_id: string | null;
        channel: string;
        body: string;
        from_handle: string;
        external_chat_id: string | null;
      }
    | undefined
  > {
    return qMaybe(
      this.pool,
      `SELECT id, company_id, ticket_id, channel, body, from_handle, external_chat_id
         FROM support_messages WHERE id=$1`,
      [id],
      z.object({
        id: z.string(),
        company_id: z.string(),
        ticket_id: z.string().nullable(),
        channel: z.string(),
        body: z.string(),
        from_handle: z.string(),
        external_chat_id: z.string().nullable(),
      }),
    );
  }

  async conversation(ticketId: string): Promise<readonly Record<string, unknown>[]> {
    return q(
      this.pool,
      `SELECT id, direction, channel, from_handle, to_handle, body, status, authored_by_run_id,
              authored_by_human, created_at
         FROM support_messages WHERE ticket_id=$1 ORDER BY created_at`,
      [ticketId],
      z.record(z.string(), z.unknown()),
    );
  }

  async messageCount(ticketId: string, direction: 'inbound' | 'outbound'): Promise<number> {
    const row = await qMaybe(
      this.pool,
      `SELECT COUNT(*)::int AS n FROM support_messages WHERE ticket_id=$1 AND direction=$2`,
      [ticketId, direction],
      z.object({ n: z.number() }),
    );
    return row?.n ?? 0;
  }
}

export class GrowthRepositories {
  readonly creative: CreativeRepository;
  readonly experiments: ExperimentRepository;
  readonly metrics: MetricRepository;
  readonly support: SupportRepository;

  constructor(pool: DbPool) {
    this.creative = new CreativeRepository(pool);
    this.experiments = new ExperimentRepository(pool);
    this.metrics = new MetricRepository(pool);
    this.support = new SupportRepository(pool);
  }
}

export { type Queryable };
