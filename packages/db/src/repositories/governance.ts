/**
 * Governance persistence: actors, budgets, approvals, kill switches and the
 * record of every policy decision.
 *
 * The budget methods are the important ones. Reserving spend is a single
 * conditional UPDATE, so two workers racing for the last dollar cannot both
 * win — the second one's `WHERE` clause simply matches no rows. Doing this as
 * read-then-write in application code is the classic way an autonomous system
 * blows through a spend cap.
 */

import { z } from 'zod';
import {
  ConflictError,
  NotFoundError,
  PolicyDeniedError,
  newId,
  type Actor,
  type ApprovalStatus,
  type Authority,
  type BudgetScope,
  type BudgetWindow,
  type KillSwitchScope,
  type PolicyEvaluation,
} from '@foundry/core';
import { metrics } from '@foundry/obs';
import { exec, q, qMaybe, qOne, withTransaction, type DbPool, type Queryable } from '../pool.js';

/* -------------------------------------------------------------------------- */
/* Rows                                                                        */
/* -------------------------------------------------------------------------- */

const ActorRow = z.object({
  id: z.string(),
  company_id: z.string(),
  kind: z.enum(['ceo_agent', 'manager_agent', 'specialist_agent', 'human_operator', 'system_job']),
  handle: z.string(),
  role_key: z.string().nullable(),
  authorities: z.array(z.string()),
  spend_ceiling_minor: z.number().nullable(),
  currency: z.string(),
  active: z.boolean(),
});

const BudgetRow = z.object({
  id: z.string(),
  company_id: z.string(),
  scope: z.string(),
  window_kind: z.string(),
  limit_minor: z.number(),
  currency: z.string(),
  reserved_minor: z.number(),
  spent_minor: z.number(),
  window_started_at: z.date(),
  warn_at_ratio: z.number(),
  hard_stop: z.boolean(),
  updated_at: z.date(),
});

const ApprovalRow = z.object({
  id: z.string(),
  company_id: z.string(),
  request: z.string(),
  authority: z.string(),
  requested_by_actor_id: z.string(),
  subject_ref_id: z.string().nullable(),
  amount_minor: z.number().nullable(),
  currency: z.string().nullable(),
  evidence_refs: z.array(z.string()),
  risk_notes: z.array(z.string()),
  status: z.enum(['pending', 'approved', 'rejected', 'expired', 'auto_approved']),
  decided_by: z.string().nullable(),
  decided_at: z.date().nullable(),
  decision_rationale: z.string().nullable(),
  expires_at: z.date(),
  created_at: z.date(),
});

const KillSwitchRow = z.object({
  id: z.string(),
  company_id: z.string(),
  scope: z.string(),
  engaged: z.boolean(),
  reason: z.string(),
  engaged_by: z.string(),
  engaged_at: z.date(),
  released_by: z.string().nullable(),
  released_at: z.date().nullable(),
});

export type ActorRow = z.infer<typeof ActorRow>;
export type BudgetRow = z.infer<typeof BudgetRow>;
export type ApprovalRow = z.infer<typeof ApprovalRow>;
export type KillSwitchRow = z.infer<typeof KillSwitchRow>;

export function toActor(row: ActorRow): Actor {
  return {
    id: row.id,
    kind: row.kind,
    handle: row.handle,
    authorities: row.authorities as Authority[],
    spendCeilingMinor: row.spend_ceiling_minor,
    currency: row.currency,
  };
}

const ACTOR_COLUMNS = `id, company_id, kind, handle, role_key, authorities, spend_ceiling_minor, currency, active`;
const BUDGET_COLUMNS = `id, company_id, scope, window_kind, limit_minor, currency, reserved_minor,
                        spent_minor, window_started_at, warn_at_ratio, hard_stop, updated_at`;
const APPROVAL_COLUMNS = `id, company_id, request, authority, requested_by_actor_id, subject_ref_id,
                          amount_minor, currency, evidence_refs, risk_notes, status, decided_by,
                          decided_at, decision_rationale, expires_at, created_at`;
const KILL_COLUMNS = `id, company_id, scope, engaged, reason, engaged_by, engaged_at, released_by, released_at`;

/* -------------------------------------------------------------------------- */
/* Actors                                                                      */
/* -------------------------------------------------------------------------- */

export class ActorRepository {
  constructor(private readonly db: Queryable) {}

  async upsert(input: {
    companyId: string;
    kind: ActorRow['kind'];
    handle: string;
    roleKey?: string | null;
    authorities: readonly string[];
    spendCeilingMinor: number | null;
    currency?: string;
  }): Promise<ActorRow> {
    return qOne(
      this.db,
      `INSERT INTO actors (id, company_id, kind, handle, role_key, authorities, spend_ceiling_minor, currency)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (company_id, handle) DO UPDATE
         SET kind = EXCLUDED.kind,
             role_key = EXCLUDED.role_key,
             authorities = EXCLUDED.authorities,
             spend_ceiling_minor = EXCLUDED.spend_ceiling_minor,
             currency = EXCLUDED.currency,
             active = TRUE
       RETURNING ${ACTOR_COLUMNS}`,
      [
        newId('agent'),
        input.companyId,
        input.kind,
        input.handle,
        input.roleKey ?? null,
        input.authorities,
        input.spendCeilingMinor,
        input.currency ?? 'USD',
      ],
      ActorRow,
      'actor',
      input.handle,
    );
  }

  async byHandle(companyId: string, handle: string): Promise<ActorRow | undefined> {
    return qMaybe(
      this.db,
      `SELECT ${ACTOR_COLUMNS} FROM actors WHERE company_id = $1 AND handle = $2`,
      [companyId, handle],
      ActorRow,
    );
  }

  async requireByHandle(companyId: string, handle: string): Promise<ActorRow> {
    const actor = await this.byHandle(companyId, handle);
    if (!actor) throw new NotFoundError('actor', handle);
    if (!actor.active) throw new PolicyDeniedError(`Actor "${handle}" is deactivated`, { handle });
    return actor;
  }

  async list(companyId: string): Promise<readonly ActorRow[]> {
    return q(this.db, `SELECT ${ACTOR_COLUMNS} FROM actors WHERE company_id = $1 ORDER BY handle`, [companyId], ActorRow);
  }
}

/* -------------------------------------------------------------------------- */
/* Budgets                                                                     */
/* -------------------------------------------------------------------------- */

export interface ReservationResult {
  readonly reserved: boolean;
  readonly budget: BudgetRow | undefined;
  readonly remainingMinor: number;
  readonly reason?: string;
}

export class BudgetRepository {
  constructor(private readonly db: Queryable) {}

  async upsert(input: {
    companyId: string;
    scope: BudgetScope;
    window: BudgetWindow;
    limitMinor: number;
    currency: string;
    warnAtRatio?: number;
    hardStop?: boolean;
  }): Promise<BudgetRow> {
    return qOne(
      this.db,
      `INSERT INTO budgets (id, company_id, scope, window_kind, limit_minor, currency, warn_at_ratio, hard_stop)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (company_id, scope, window_kind) DO UPDATE
         SET limit_minor = EXCLUDED.limit_minor,
             currency = EXCLUDED.currency,
             warn_at_ratio = EXCLUDED.warn_at_ratio,
             hard_stop = EXCLUDED.hard_stop
       RETURNING ${BUDGET_COLUMNS}`,
      [
        newId('budget'),
        input.companyId,
        input.scope,
        input.window,
        input.limitMinor,
        input.currency,
        input.warnAtRatio ?? 0.8,
        input.hardStop ?? true,
      ],
      BudgetRow,
      'budget',
      input.scope,
    );
  }

  async list(companyId: string): Promise<readonly BudgetRow[]> {
    return q(
      this.db,
      `SELECT ${BUDGET_COLUMNS} FROM budgets WHERE company_id = $1 ORDER BY scope, window_kind`,
      [companyId],
      BudgetRow,
    );
  }

  async forScope(companyId: string, scope: BudgetScope): Promise<readonly BudgetRow[]> {
    // company_total always applies in addition to the specific scope.
    return q(
      this.db,
      `SELECT ${BUDGET_COLUMNS} FROM budgets
        WHERE company_id = $1 AND scope IN ($2, 'company_total')`,
      [companyId, scope],
      BudgetRow,
    );
  }

  /**
   * Atomically reserves `amountMinor`.
   *
   * The `WHERE limit_minor - reserved_minor - spent_minor >= $amount` clause is
   * what makes the cap real: under concurrency exactly one caller's UPDATE
   * matches, and the loser gets zero rows back rather than an over-committed
   * budget. The CHECK constraint on the table is the second line of defence.
   */
  async reserve(
    companyId: string,
    scope: BudgetScope,
    amountMinor: number,
    currency: string,
  ): Promise<ReservationResult> {
    if (amountMinor < 0) throw new ConflictError('Cannot reserve a negative amount', { amountMinor });
    if (amountMinor === 0) {
      const existing = await qMaybe(
        this.db,
        `SELECT ${BUDGET_COLUMNS} FROM budgets WHERE company_id = $1 AND scope = $2 LIMIT 1`,
        [companyId, scope],
        BudgetRow,
      );
      return {
        reserved: true,
        budget: existing,
        remainingMinor: existing ? existing.limit_minor - existing.reserved_minor - existing.spent_minor : 0,
      };
    }

    const rows = await q(
      this.db,
      `UPDATE budgets
          SET reserved_minor = reserved_minor + $3
        WHERE company_id = $1
          AND scope = $2
          AND currency = $4
          AND limit_minor - reserved_minor - spent_minor >= $3
        RETURNING ${BUDGET_COLUMNS}`,
      [companyId, scope, amountMinor, currency],
      BudgetRow,
    );

    const budget = rows[0];
    if (budget) {
      metrics.spendMinor.inc({ scope, state: 'reserved' }, amountMinor);
      return {
        reserved: true,
        budget,
        remainingMinor: budget.limit_minor - budget.reserved_minor - budget.spent_minor,
      };
    }

    // Report precisely why: no such budget, wrong currency, or genuinely short.
    const current = await qMaybe(
      this.db,
      `SELECT ${BUDGET_COLUMNS} FROM budgets WHERE company_id = $1 AND scope = $2 LIMIT 1`,
      [companyId, scope],
      BudgetRow,
    );
    if (!current) {
      return { reserved: false, budget: undefined, remainingMinor: 0, reason: `no ${scope} budget is configured` };
    }
    if (current.currency !== currency) {
      return {
        reserved: false,
        budget: current,
        remainingMinor: 0,
        reason: `budget is denominated in ${current.currency} but the request is in ${currency}`,
      };
    }
    const remaining = current.limit_minor - current.reserved_minor - current.spent_minor;
    return {
      reserved: false,
      budget: current,
      remainingMinor: remaining,
      reason: `only ${remaining} of ${current.limit_minor} ${current.currency} minor units remain; ${amountMinor} requested`,
    };
  }

  /** Converts a reservation into settled spend once the money actually moved. */
  async settle(companyId: string, scope: BudgetScope, reservedMinor: number, actualMinor: number): Promise<BudgetRow> {
    return qOne(
      this.db,
      `UPDATE budgets
          SET reserved_minor = GREATEST(0, reserved_minor - $3),
              spent_minor    = spent_minor + $4
        WHERE company_id = $1 AND scope = $2
        RETURNING ${BUDGET_COLUMNS}`,
      [companyId, scope, reservedMinor, actualMinor],
      BudgetRow,
      'budget',
      scope,
    );
  }

  /** Releases a reservation whose operation did not happen. */
  async release(companyId: string, scope: BudgetScope, amountMinor: number): Promise<void> {
    await exec(
      this.db,
      `UPDATE budgets SET reserved_minor = GREATEST(0, reserved_minor - $3)
        WHERE company_id = $1 AND scope = $2`,
      [companyId, scope, amountMinor],
    );
  }

  /**
   * Rolls a spend window over. Reservations are deliberately NOT cleared —
   * an ad set that is live right now still has money committed against it, and
   * zeroing that at midnight would let the next day double-spend.
   */
  async rolloverWindows(now = new Date()): Promise<number> {
    return exec(
      this.db,
      `UPDATE budgets
          SET spent_minor = 0, window_started_at = $1
        WHERE (window_kind = 'daily'   AND window_started_at < date_trunc('day',   $1::timestamptz))
           OR (window_kind = 'weekly'  AND window_started_at < date_trunc('week',  $1::timestamptz))
           OR (window_kind = 'monthly' AND window_started_at < date_trunc('month', $1::timestamptz))`,
      [now],
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Approvals                                                                   */
/* -------------------------------------------------------------------------- */

export class ApprovalRepository {
  constructor(private readonly db: Queryable) {}

  async create(input: {
    companyId: string;
    request: string;
    authority: Authority;
    requestedByActorId: string;
    subjectRefId?: string | null;
    amountMinor?: number | null;
    currency?: string | null;
    evidenceRefs?: readonly string[];
    riskNotes?: readonly string[];
    expiresInMs?: number;
  }): Promise<ApprovalRow> {
    const expiresAt = new Date(Date.now() + (input.expiresInMs ?? 72 * 60 * 60 * 1000));
    return qOne(
      this.db,
      `INSERT INTO approvals (id, company_id, request, authority, requested_by_actor_id, subject_ref_id,
                              amount_minor, currency, evidence_refs, risk_notes, status, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending',$11)
       RETURNING ${APPROVAL_COLUMNS}`,
      [
        newId('approval'),
        input.companyId,
        input.request,
        input.authority,
        input.requestedByActorId,
        input.subjectRefId ?? null,
        input.amountMinor ?? null,
        input.currency ?? null,
        input.evidenceRefs ?? [],
        input.riskNotes ?? [],
        expiresAt,
      ],
      ApprovalRow,
      'approval',
      input.authority,
    );
  }

  async decide(
    id: string,
    decision: 'approved' | 'rejected',
    decidedBy: string,
    rationale: string,
  ): Promise<ApprovalRow> {
    const rows = await q(
      this.db,
      `UPDATE approvals
          SET status = $2, decided_by = $3, decided_at = now(), decision_rationale = $4
        WHERE id = $1 AND status = 'pending' AND expires_at > now()
        RETURNING ${APPROVAL_COLUMNS}`,
      [id, decision, decidedBy, rationale],
      ApprovalRow,
    );
    const row = rows[0];
    if (!row) {
      const existing = await qMaybe(this.db, `SELECT ${APPROVAL_COLUMNS} FROM approvals WHERE id = $1`, [id], ApprovalRow);
      if (!existing) throw new NotFoundError('approval', id);
      throw new ConflictError(
        existing.expires_at <= new Date()
          ? `Approval ${id} expired at ${existing.expires_at.toISOString()}`
          : `Approval ${id} is already ${existing.status}`,
        { id, status: existing.status },
      );
    }
    return row;
  }

  /** The specific approval a policy check can honour, if one exists. */
  async findValidFor(
    companyId: string,
    authority: Authority,
    subjectRefId: string | null,
    amountMinor: number | null,
  ): Promise<ApprovalRow | undefined> {
    return qMaybe(
      this.db,
      `SELECT ${APPROVAL_COLUMNS} FROM approvals
        WHERE company_id = $1
          AND authority = $2
          AND status IN ('approved','auto_approved')
          AND expires_at > now()
          AND ($3::text IS NULL OR subject_ref_id = $3)
          AND ($4::bigint IS NULL OR amount_minor IS NULL OR amount_minor >= $4)
        ORDER BY decided_at DESC NULLS LAST
        LIMIT 1`,
      [companyId, authority, subjectRefId, amountMinor],
      ApprovalRow,
    );
  }

  async listPending(companyId: string, limit = 50): Promise<readonly ApprovalRow[]> {
    return q(
      this.db,
      `SELECT ${APPROVAL_COLUMNS} FROM approvals
        WHERE company_id = $1 AND status = 'pending' AND expires_at > now()
        ORDER BY created_at
        LIMIT $2`,
      [companyId, limit],
      ApprovalRow,
    );
  }

  async expireStale(): Promise<number> {
    return exec(
      this.db,
      `UPDATE approvals SET status = 'expired' WHERE status = 'pending' AND expires_at <= now()`,
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Kill switches                                                               */
/* -------------------------------------------------------------------------- */

export class KillSwitchRepository {
  constructor(private readonly db: Queryable) {}

  async engage(companyId: string, scope: KillSwitchScope, reason: string, engagedBy: string): Promise<KillSwitchRow> {
    // The partial unique index means engaging an already-engaged scope is a
    // conflict; treat it as idempotent and return the existing switch.
    const existing = await qMaybe(
      this.db,
      `SELECT ${KILL_COLUMNS} FROM kill_switches WHERE company_id = $1 AND scope = $2 AND engaged`,
      [companyId, scope],
      KillSwitchRow,
    );
    if (existing) return existing;

    return qOne(
      this.db,
      `INSERT INTO kill_switches (id, company_id, scope, engaged, reason, engaged_by)
       VALUES ($1,$2,$3,TRUE,$4,$5)
       RETURNING ${KILL_COLUMNS}`,
      [newId('killSwitch'), companyId, scope, reason, engagedBy],
      KillSwitchRow,
      'kill_switch',
      scope,
    );
  }

  async release(companyId: string, scope: KillSwitchScope, releasedBy: string): Promise<void> {
    await exec(
      this.db,
      `UPDATE kill_switches
          SET engaged = FALSE, released_by = $3, released_at = now()
        WHERE company_id = $1 AND scope = $2 AND engaged`,
      [companyId, scope, releasedBy],
    );
  }

  async engagedScopes(companyId: string): Promise<readonly KillSwitchScope[]> {
    const rows = await q(
      this.db,
      `SELECT ${KILL_COLUMNS} FROM kill_switches WHERE company_id = $1 AND engaged`,
      [companyId],
      KillSwitchRow,
    );
    return rows.map((r) => r.scope as KillSwitchScope);
  }

  async history(companyId: string, limit = 50): Promise<readonly KillSwitchRow[]> {
    return q(
      this.db,
      `SELECT ${KILL_COLUMNS} FROM kill_switches WHERE company_id = $1 ORDER BY engaged_at DESC LIMIT $2`,
      [companyId, limit],
      KillSwitchRow,
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Policy decisions                                                            */
/* -------------------------------------------------------------------------- */

export class PolicyDecisionRepository {
  constructor(private readonly db: Queryable) {}

  async record(input: {
    companyId: string;
    actorId: string;
    authority: Authority;
    action: string;
    subjectRefId?: string | null;
    amountMinor?: number | null;
    currency?: string | null;
    evaluation: PolicyEvaluation;
    approvalId?: string | null;
  }): Promise<string> {
    const id = newId('policyDecision');
    await exec(
      this.db,
      `INSERT INTO policy_decisions (id, company_id, actor_id, authority, action, subject_ref_id,
                                     amount_minor, currency, outcome, reasons, approval_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11)`,
      [
        id,
        input.companyId,
        input.actorId,
        input.authority,
        input.action,
        input.subjectRefId ?? null,
        input.amountMinor ?? null,
        input.currency ?? null,
        input.evaluation.outcome,
        JSON.stringify(input.evaluation.reasons),
        input.approvalId ?? null,
      ],
    );
    metrics.policyDecisions.inc({ authority: input.authority, outcome: input.evaluation.outcome });
    return id;
  }

  async recentDenials(companyId: string, limit = 20): Promise<readonly Record<string, unknown>[]> {
    return q(
      this.db,
      `SELECT id, authority, action, subject_ref_id, amount_minor, currency, reasons, decided_at
         FROM policy_decisions
        WHERE company_id = $1 AND outcome = 'deny'
        ORDER BY decided_at DESC
        LIMIT $2`,
      [companyId, limit],
      z.record(z.string(), z.unknown()),
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Facade                                                                      */
/* -------------------------------------------------------------------------- */

export class GovernanceRepositories {
  readonly actors: ActorRepository;
  readonly budgets: BudgetRepository;
  readonly approvals: ApprovalRepository;
  readonly killSwitches: KillSwitchRepository;
  readonly decisions: PolicyDecisionRepository;

  constructor(private readonly pool: DbPool) {
    this.actors = new ActorRepository(pool);
    this.budgets = new BudgetRepository(pool);
    this.approvals = new ApprovalRepository(pool);
    this.killSwitches = new KillSwitchRepository(pool);
    this.decisions = new PolicyDecisionRepository(pool);
  }

  /** Same repositories bound to a transaction client. */
  inTransaction<T>(fn: (repos: {
    actors: ActorRepository;
    budgets: BudgetRepository;
    approvals: ApprovalRepository;
    killSwitches: KillSwitchRepository;
    decisions: PolicyDecisionRepository;
  }) => Promise<T>): Promise<T> {
    return withTransaction(this.pool, async (client) =>
      fn({
        actors: new ActorRepository(client),
        budgets: new BudgetRepository(client),
        approvals: new ApprovalRepository(client),
        killSwitches: new KillSwitchRepository(client),
        decisions: new PolicyDecisionRepository(client),
      }),
    );
  }
}

export type ApprovalStatusValue = ApprovalStatus;
