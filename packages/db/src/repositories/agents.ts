/**
 * Agent run persistence.
 *
 * An agent run is a durable record, not an in-memory conversation. Every
 * message is stored so a run is fully replayable, every tool call is counted,
 * and token spend is attributed per role — which is what makes "the research
 * organisation cost $14 this cycle" a fact rather than a guess.
 */

import { z } from 'zod';
import { MODEL_BY_TIER, newId, roleByKey, type AgentRunStatus } from '@foundry/core';
import { metrics } from '@foundry/obs';
import { exec, q, qMaybe, qOne, type DbPool, type Queryable } from '../pool.js';

const RunRow = z.object({
  id: z.string(),
  company_id: z.string(),
  role_key: z.string(),
  parent_run_id: z.string().nullable(),
  objective: z.string(),
  input_refs: z.record(z.string(), z.unknown()),
  status: z.string(),
  model: z.string(),
  output: z.unknown().nullable(),
  error: z.string().nullable(),
  tool_call_count: z.number(),
  input_tokens: z.number(),
  output_tokens: z.number(),
  cost_minor_usd: z.number(),
  coordination_room_id: z.string().nullable(),
  sandbox_id: z.string().nullable(),
  started_at: z.date().nullable(),
  finished_at: z.date().nullable(),
  deadline_at: z.date(),
  created_at: z.date(),
});

const MessageRow = z.object({
  id: z.string(),
  run_id: z.string(),
  sequence: z.number(),
  role: z.enum(['system', 'user', 'assistant', 'tool_result']),
  content: z.unknown(),
  tool_name: z.string().nullable(),
  tool_use_id: z.string().nullable(),
  is_error: z.boolean(),
  created_at: z.date(),
});

export type AgentRunRow = z.infer<typeof RunRow>;
export type AgentMessageRow = z.infer<typeof MessageRow>;

const RUN_COLUMNS = `id, company_id, role_key, parent_run_id, objective, input_refs, status, model, output,
  error, tool_call_count, input_tokens, output_tokens, cost_minor_usd, coordination_room_id, sandbox_id,
  started_at, finished_at, deadline_at, created_at`;

const MESSAGE_COLUMNS = `id, run_id, sequence, role, content, tool_name, tool_use_id, is_error, created_at`;

export class AgentRunRepository {
  constructor(private readonly db: Queryable) {}

  async create(input: {
    companyId: string;
    roleKey: string;
    objective: string;
    inputRefs?: Record<string, unknown>;
    parentRunId?: string | null;
    /** Overrides the role's tier default; used when a run needs more headroom. */
    model?: string;
    deadlineMs?: number;
  }): Promise<AgentRunRow> {
    const role = roleByKey(input.roleKey);
    if (!role) {
      throw new Error(`Unknown role "${input.roleKey}" — it is not in the org chart`);
    }
    const model = input.model ?? MODEL_BY_TIER[role.tier];
    const deadlineAt = new Date(Date.now() + (input.deadlineMs ?? role.runBudgetSeconds * 1000));

    return qOne(
      this.db,
      `INSERT INTO agent_runs (id, company_id, role_key, parent_run_id, objective, input_refs, status,
                               model, deadline_at)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,'queued',$7,$8)
       RETURNING ${RUN_COLUMNS}`,
      [
        newId('agentRun'),
        input.companyId,
        input.roleKey,
        input.parentRunId ?? null,
        input.objective,
        JSON.stringify(input.inputRefs ?? {}),
        model,
        deadlineAt,
      ],
      RunRow,
      'agent_run',
      input.roleKey,
    );
  }

  async markStarted(id: string): Promise<void> {
    await exec(
      this.db,
      `UPDATE agent_runs SET status='running', started_at=COALESCE(started_at, now()) WHERE id=$1`,
      [id],
    );
  }

  async setStatus(id: string, status: AgentRunStatus, detail?: string | null): Promise<void> {
    await exec(this.db, `UPDATE agent_runs SET status=$2, error=COALESCE($3, error) WHERE id=$1`, [id, status, detail ?? null]);
  }

  async finish(input: {
    id: string;
    status: Extract<AgentRunStatus, 'succeeded' | 'failed' | 'cancelled' | 'timed_out'>;
    roleKey: string;
    output?: unknown;
    error?: string | null;
  }): Promise<AgentRunRow> {
    const row = await qOne(
      this.db,
      `UPDATE agent_runs
          SET status=$2, output=$3::jsonb, error=$4, finished_at=now()
        WHERE id=$1
        RETURNING ${RUN_COLUMNS}`,
      [input.id, input.status, JSON.stringify(input.output ?? null), input.error ?? null],
      RunRow,
      'agent_run',
      input.id,
    );
    metrics.agentRuns.inc({ role: input.roleKey, outcome: input.status });
    return row;
  }

  /** Accumulates usage as the run proceeds, so a killed run still reports cost. */
  async addUsage(id: string, usage: { inputTokens: number; outputTokens: number; costMinorUsd: number; toolCalls?: number }): Promise<void> {
    await exec(
      this.db,
      `UPDATE agent_runs
          SET input_tokens = input_tokens + $2,
              output_tokens = output_tokens + $3,
              cost_minor_usd = cost_minor_usd + $4,
              tool_call_count = tool_call_count + $5
        WHERE id = $1`,
      [id, usage.inputTokens, usage.outputTokens, usage.costMinorUsd, usage.toolCalls ?? 0],
    );
  }

  async attachSandbox(id: string, sandboxId: string): Promise<void> {
    await exec(this.db, `UPDATE agent_runs SET sandbox_id=$2 WHERE id=$1`, [id, sandboxId]);
  }

  async attachRoom(id: string, roomId: string): Promise<void> {
    await exec(this.db, `UPDATE agent_runs SET coordination_room_id=$2 WHERE id=$1`, [id, roomId]);
  }

  async byId(id: string): Promise<AgentRunRow> {
    return qOne(this.db, `SELECT ${RUN_COLUMNS} FROM agent_runs WHERE id=$1`, [id], RunRow, 'agent_run', id);
  }

  async children(parentRunId: string): Promise<readonly AgentRunRow[]> {
    return q(this.db, `SELECT ${RUN_COLUMNS} FROM agent_runs WHERE parent_run_id=$1 ORDER BY created_at`, [parentRunId], RunRow);
  }

  async listActive(companyId: string): Promise<readonly AgentRunRow[]> {
    return q(
      this.db,
      `SELECT ${RUN_COLUMNS} FROM agent_runs
        WHERE company_id=$1 AND status IN ('queued','running','awaiting_tool','awaiting_approval','awaiting_human')
        ORDER BY created_at`,
      [companyId],
      RunRow,
    );
  }

  /** Runs past their deadline; the worker fails these so a slot is not held forever. */
  async findOverdue(limit = 50): Promise<readonly AgentRunRow[]> {
    return q(
      this.db,
      `SELECT ${RUN_COLUMNS} FROM agent_runs
        WHERE status IN ('queued','running','awaiting_tool') AND deadline_at < now()
        ORDER BY deadline_at LIMIT $1`,
      [limit],
      RunRow,
    );
  }

  /** Cost and volume per role over a window, for the finance report. */
  async usageByRole(
    companyId: string,
    since: Date,
  ): Promise<readonly { roleKey: string; runs: number; inputTokens: number; outputTokens: number; costMinorUsd: number }[]> {
    const rows = await q(
      this.db,
      `SELECT role_key,
              COUNT(*)::int              AS runs,
              SUM(input_tokens)::bigint  AS input_tokens,
              SUM(output_tokens)::bigint AS output_tokens,
              SUM(cost_minor_usd)::bigint AS cost_minor_usd
         FROM agent_runs
        WHERE company_id = $1 AND created_at >= $2
        GROUP BY role_key
        ORDER BY cost_minor_usd DESC`,
      [companyId, since],
      z.object({
        role_key: z.string(),
        runs: z.number(),
        input_tokens: z.number(),
        output_tokens: z.number(),
        cost_minor_usd: z.number(),
      }),
    );
    return rows.map((r) => ({
      roleKey: r.role_key,
      runs: r.runs,
      inputTokens: r.input_tokens,
      outputTokens: r.output_tokens,
      costMinorUsd: r.cost_minor_usd,
    }));
  }
}

export class AgentMessageRepository {
  constructor(private readonly db: Queryable) {}

  async append(input: {
    runId: string;
    sequence: number;
    role: AgentMessageRow['role'];
    content: unknown;
    toolName?: string | null;
    toolUseId?: string | null;
    isError?: boolean;
  }): Promise<AgentMessageRow> {
    return qOne(
      this.db,
      `INSERT INTO agent_messages (id, run_id, sequence, role, content, tool_name, tool_use_id, is_error)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8)
       RETURNING ${MESSAGE_COLUMNS}`,
      [
        newId('agentMessage'),
        input.runId,
        input.sequence,
        input.role,
        JSON.stringify(input.content),
        input.toolName ?? null,
        input.toolUseId ?? null,
        input.isError ?? false,
      ],
      MessageRow,
      'agent_message',
      `${input.runId}:${input.sequence}`,
    );
  }

  async forRun(runId: string): Promise<readonly AgentMessageRow[]> {
    return q(this.db, `SELECT ${MESSAGE_COLUMNS} FROM agent_messages WHERE run_id=$1 ORDER BY sequence`, [runId], MessageRow);
  }

  async nextSequence(runId: string): Promise<number> {
    const row = await qMaybe(
      this.db,
      `SELECT COALESCE(MAX(sequence), -1) + 1 AS next FROM agent_messages WHERE run_id=$1`,
      [runId],
      z.object({ next: z.number() }),
    );
    return row?.next ?? 0;
  }
}

export class SandboxRepository {
  constructor(private readonly db: Queryable) {}

  async record(input: {
    companyId: string;
    provider: 'superserve' | 'sandbox0' | 'solari';
    externalId: string;
    purpose: string;
    runId?: string | null;
    status: string;
    egressPolicy?: Record<string, unknown> | null;
    previewUrl?: string | null;
    metadata?: Record<string, unknown>;
  }): Promise<string> {
    const row = await qOne(
      this.db,
      `INSERT INTO sandboxes (id, company_id, provider, external_id, purpose, run_id, status,
                              egress_policy, preview_url, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10::jsonb)
       ON CONFLICT (provider, external_id) DO UPDATE
         SET status = EXCLUDED.status,
             egress_policy = COALESCE(EXCLUDED.egress_policy, sandboxes.egress_policy),
             preview_url = COALESCE(EXCLUDED.preview_url, sandboxes.preview_url)
       RETURNING id`,
      [
        newId('sandbox'),
        input.companyId,
        input.provider,
        input.externalId,
        input.purpose,
        input.runId ?? null,
        input.status,
        input.egressPolicy ? JSON.stringify(input.egressPolicy) : null,
        input.previewUrl ?? null,
        JSON.stringify(input.metadata ?? {}),
      ],
      z.object({ id: z.string() }),
      'sandbox',
      input.externalId,
    );
    return row.id;
  }

  async setStatus(provider: string, externalId: string, status: string): Promise<void> {
    await exec(
      this.db,
      `UPDATE sandboxes
          SET status=$3, terminated_at = CASE WHEN $3 IN ('terminated','failed') THEN now() ELSE terminated_at END
        WHERE provider=$1 AND external_id=$2`,
      [provider, externalId, status],
    );
  }

  async listActive(companyId: string): Promise<readonly Record<string, unknown>[]> {
    return q(
      this.db,
      `SELECT id, provider, external_id, purpose, run_id, status, preview_url, created_at
         FROM sandboxes WHERE company_id=$1 AND status='active' ORDER BY created_at DESC`,
      [companyId],
      z.record(z.string(), z.unknown()),
    );
  }

  /** Sandboxes left running with no live run — real money leaking per hour. */
  async findOrphaned(olderThanHours = 6): Promise<readonly Record<string, unknown>[]> {
    return q(
      this.db,
      `SELECT s.id, s.provider, s.external_id, s.purpose, s.created_at
         FROM sandboxes s
         LEFT JOIN agent_runs r ON r.id = s.run_id
        WHERE s.status = 'active'
          AND s.created_at < now() - ($1 || ' hours')::interval
          AND (r.id IS NULL OR r.status IN ('succeeded','failed','cancelled','timed_out'))
        ORDER BY s.created_at`,
      [String(olderThanHours)],
      z.record(z.string(), z.unknown()),
    );
  }
}

export class AgentRepositories {
  readonly runs: AgentRunRepository;
  readonly messages: AgentMessageRepository;
  readonly sandboxes: SandboxRepository;

  constructor(pool: DbPool) {
    this.runs = new AgentRunRepository(pool);
    this.messages = new AgentMessageRepository(pool);
    this.sandboxes = new SandboxRepository(pool);
  }
}
