/**
 * Company configuration and the operating-loop cycle record.
 *
 * The loop cycle table is what makes the company a running organisation rather
 * than a pipeline: each cycle records the phase, what it produced, what blocked
 * it, and the CEO's decision with its rationale.
 */

import { z } from 'zod';
import {
  CompanyConfig,
  ValidationError,
  LOOP_PHASE_ORDER,
  newId,
  nextPhase,
  type CompanyStage,
  type LoopPhase,
} from '@foundry/core';
import { exec, q, qMaybe, qOne, withSerializableTransaction, type DbPool, type Queryable } from '../pool.js';

const CompanyRow = z.object({
  id: z.string(),
  name: z.string(),
  mission: z.string(),
  stage: z.string(),
  config: z.unknown(),
  selected_opportunity_id: z.string().nullable(),
  active_brand_id: z.string().nullable(),
  active_site_id: z.string().nullable(),
  kpi_targets: z.record(z.string(), z.number()),
  created_at: z.date(),
  updated_at: z.date(),
});

const CycleRow = z.object({
  id: z.string(),
  company_id: z.string(),
  cycle_number: z.number(),
  phase: z.string(),
  status: z.enum(['running', 'blocked', 'completed', 'aborted']),
  blocked_reason: z.string().nullable(),
  blocked_on_capability: z.string().nullable(),
  phase_outputs: z.record(z.string(), z.unknown()),
  ceo_decision: z.string().nullable(),
  ceo_decision_rationale: z.string().nullable(),
  started_at: z.date(),
  phase_entered_at: z.date(),
  completed_at: z.date().nullable(),
});

export type CompanyRow = z.infer<typeof CompanyRow>;
export type LoopCycleRow = z.infer<typeof CycleRow>;

/**
 * Typed view of the stored config.
 *
 * The column stays `unknown` on the row so that a config written under an older
 * schema does not make every query throw at parse time. Readers call this
 * instead, which fails loudly and locally: a drifted config breaks the one
 * route that needs it, with a message naming the bad field, rather than
 * silently defaulting to a value nobody chose. Legal text, tax behaviour and
 * currency all come from here, so a quiet default would be a false statement
 * about the business.
 */
export function companyConfig(row: CompanyRow): CompanyConfig {
  const parsed = CompanyConfig.safeParse(row.config);
  if (!parsed.success) {
    throw new ValidationError(
      `Company ${row.id} has a stored config that does not match the current schema. ` +
        `Fix it via PUT /api/company/config before using features that depend on it.`,
      { issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) },
    );
  }
  return parsed.data;
}

const COMPANY_COLUMNS = `id, name, mission, stage, config, selected_opportunity_id, active_brand_id,
  active_site_id, kpi_targets, created_at, updated_at`;
const CYCLE_COLUMNS = `id, company_id, cycle_number, phase, status, blocked_reason, blocked_on_capability,
  phase_outputs, ceo_decision, ceo_decision_rationale, started_at, phase_entered_at, completed_at`;

export class CompanyRepository {
  constructor(private readonly db: Queryable) {}

  async create(input: { name: string; mission: string; config: unknown }): Promise<CompanyRow> {
    // Validate the config here rather than at read time: an invalid config
    // silently blocks every legal document downstream.
    const parsed = CompanyConfig.parse(input.config);
    return qOne(
      this.db,
      `INSERT INTO companies (id, name, mission, stage, config)
       VALUES ($1,$2,$3,'initialising',$4::jsonb)
       RETURNING ${COMPANY_COLUMNS}`,
      [newId('company'), input.name, input.mission, JSON.stringify(parsed)],
      CompanyRow,
      'company',
      input.name,
    );
  }

  async byId(id: string): Promise<CompanyRow> {
    return qOne(this.db, `SELECT ${COMPANY_COLUMNS} FROM companies WHERE id=$1`, [id], CompanyRow, 'company', id);
  }

  async first(): Promise<CompanyRow | undefined> {
    return qMaybe(this.db, `SELECT ${COMPANY_COLUMNS} FROM companies ORDER BY created_at LIMIT 1`, [], CompanyRow);
  }

  async list(): Promise<readonly CompanyRow[]> {
    return q(this.db, `SELECT ${COMPANY_COLUMNS} FROM companies ORDER BY created_at`, [], CompanyRow);
  }

  async updateConfig(id: string, config: unknown): Promise<CompanyRow> {
    const parsed = CompanyConfig.parse(config);
    return qOne(
      this.db,
      `UPDATE companies SET config=$2::jsonb WHERE id=$1 RETURNING ${COMPANY_COLUMNS}`,
      [id, JSON.stringify(parsed)],
      CompanyRow,
      'company',
      id,
    );
  }

  async setStage(id: string, stage: CompanyStage): Promise<void> {
    await exec(this.db, `UPDATE companies SET stage=$2 WHERE id=$1`, [id, stage]);
  }

  async setActive(
    id: string,
    refs: { opportunityId?: string | null; brandId?: string | null; siteId?: string | null },
  ): Promise<void> {
    await exec(
      this.db,
      `UPDATE companies
          SET selected_opportunity_id = COALESCE($2, selected_opportunity_id),
              active_brand_id         = COALESCE($3, active_brand_id),
              active_site_id          = COALESCE($4, active_site_id)
        WHERE id = $1`,
      [id, refs.opportunityId ?? null, refs.brandId ?? null, refs.siteId ?? null],
    );
  }

  async setKpiTargets(id: string, targets: Record<string, number>): Promise<void> {
    await exec(this.db, `UPDATE companies SET kpi_targets = kpi_targets || $2::jsonb WHERE id=$1`, [
      id,
      JSON.stringify(targets),
    ]);
  }
}

export class LoopCycleRepository {
  constructor(private readonly pool: DbPool) {}

  /** Returns the running cycle, starting a new one if none is open. */
  async currentOrStart(companyId: string): Promise<LoopCycleRow> {
    return withSerializableTransaction(this.pool, async (client) => {
      const open = await qMaybe(
        client,
        `SELECT ${CYCLE_COLUMNS} FROM loop_cycles
          WHERE company_id=$1 AND status IN ('running','blocked')
          ORDER BY cycle_number DESC LIMIT 1`,
        [companyId],
        CycleRow,
      );
      if (open) return open;

      const last = await qMaybe(
        client,
        `SELECT COALESCE(MAX(cycle_number), 0) AS n FROM loop_cycles WHERE company_id=$1`,
        [companyId],
        z.object({ n: z.number() }),
      );

      return qOne(
        client,
        `INSERT INTO loop_cycles (id, company_id, cycle_number, phase, status)
         VALUES ($1,$2,$3,'observe','running')
         RETURNING ${CYCLE_COLUMNS}`,
        [newId('task'), companyId, (last?.n ?? 0) + 1],
        CycleRow,
        'loop_cycle',
        companyId,
      );
    });
  }

  /** Records what a phase produced and moves to the next one. */
  async advance(
    cycleId: string,
    phaseOutputs: Record<string, unknown>,
  ): Promise<{ cycle: LoopCycleRow; wrapped: boolean }> {
    return withSerializableTransaction(this.pool, async (client) => {
      const current = await qOne(
        client,
        `SELECT ${CYCLE_COLUMNS} FROM loop_cycles WHERE id=$1 FOR UPDATE`,
        [cycleId],
        CycleRow,
        'loop_cycle',
        cycleId,
      );

      const phase = current.phase as LoopPhase;
      const next = nextPhase(phase);
      const wrapped = LOOP_PHASE_ORDER.indexOf(next) === 0;

      const updated = await qOne(
        client,
        `UPDATE loop_cycles
            SET phase = $2,
                status = CASE WHEN $3 THEN 'completed' ELSE 'running' END,
                phase_outputs = phase_outputs || $4::jsonb,
                phase_entered_at = now(),
                blocked_reason = NULL,
                blocked_on_capability = NULL,
                completed_at = CASE WHEN $3 THEN now() ELSE completed_at END
          WHERE id = $1
          RETURNING ${CYCLE_COLUMNS}`,
        [cycleId, next, wrapped, JSON.stringify({ [phase]: phaseOutputs })],
        CycleRow,
        'loop_cycle',
        cycleId,
      );
      return { cycle: updated, wrapped };
    });
  }

  /**
   * Marks the cycle blocked with the exact remediation.
   *
   * A blocked loop is a normal, reportable state — usually a capability whose
   * credentials are missing. It is never silently skipped, because skipping it
   * would let the company appear to progress through work it did not do.
   */
  async block(cycleId: string, reason: string, capability?: string | null): Promise<void> {
    await exec(
      this.pool,
      `UPDATE loop_cycles SET status='blocked', blocked_reason=$2, blocked_on_capability=$3 WHERE id=$1`,
      [cycleId, reason, capability ?? null],
    );
  }

  async unblock(cycleId: string): Promise<void> {
    await exec(
      this.pool,
      `UPDATE loop_cycles SET status='running', blocked_reason=NULL, blocked_on_capability=NULL WHERE id=$1`,
      [cycleId],
    );
  }

  async recordDecision(cycleId: string, decision: string, rationale: string): Promise<void> {
    await exec(
      this.pool,
      `UPDATE loop_cycles SET ceo_decision=$2, ceo_decision_rationale=$3 WHERE id=$1`,
      [cycleId, decision, rationale],
    );
  }

  async setPhase(cycleId: string, phase: LoopPhase): Promise<void> {
    await exec(this.pool, `UPDATE loop_cycles SET phase=$2, phase_entered_at=now() WHERE id=$1`, [cycleId, phase]);
  }

  async history(companyId: string, limit = 20): Promise<readonly LoopCycleRow[]> {
    return q(
      this.pool,
      `SELECT ${CYCLE_COLUMNS} FROM loop_cycles WHERE company_id=$1 ORDER BY cycle_number DESC LIMIT $2`,
      [companyId, limit],
      CycleRow,
    );
  }

  async byId(id: string): Promise<LoopCycleRow> {
    return qOne(this.pool, `SELECT ${CYCLE_COLUMNS} FROM loop_cycles WHERE id=$1`, [id], CycleRow, 'loop_cycle', id);
  }
}
