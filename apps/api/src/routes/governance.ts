/**
 * Governance surface — the human operator's controls.
 *
 * This is where the "execution stays inside the permissions a real owner
 * granted" requirement becomes concrete: approvals are decided here, kill
 * switches are thrown here, budgets are set here, and the audit chain can be
 * verified here.
 *
 * Every route requires the operator token — reads included. An unauthenticated
 * caller cannot list pending approvals, inspect budgets, or approve a purchase.
 * Client-supplied actor names (`decidedBy` / `engagedBy` / `releasedBy`) are
 * ignored; the audit actor is the authenticated operator.
 *
 * The `*Label` fields are the one concession to a shared token: several people
 * can hold one `OPERATOR_API_TOKEN`, so the console lets a human type who they
 * are. That string is recorded **inside `detail`, as an annotation** — it never
 * becomes `actor_id`. The authenticated identity stays authoritative, and the
 * label is exactly as trustworthy as whoever holds the token, which is what a
 * reviewer needs to know.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { KillSwitchScope, ValidationError, type BudgetScope } from '@foundry/core';
import { getLogger } from '@foundry/obs';
import type { AppContext } from '@foundry/runtime';
import { requireOperator } from '../auth.js';
import { registerAgentActivityRoute } from './agent-activity.js';

/** An unverified, self-declared name. Bounded so it cannot be used as storage. */
const OperatorLabel = z.string().trim().min(3).max(120).optional();

const DecideApproval = z.object({
  decision: z.enum(['approved', 'rejected']),
  rationale: z.string().min(3),
  decidedByLabel: OperatorLabel,
});

const EngageKillSwitch = z.object({
  scope: KillSwitchScope,
  reason: z.string().min(3),
  engagedByLabel: OperatorLabel,
});

const ReleaseKillSwitch = z.object({
  releasedByLabel: OperatorLabel,
});

const AuditListQuery = z.object({
  kind: z.string().min(1).optional(),
  subjectRefId: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

const SetBudget = z.object({
  scope: z.enum([
    'company_total', 'research', 'expert_review', 'sampling', 'inventory',
    'advertising', 'infrastructure', 'messaging', 'llm_inference',
  ]),
  window: z.enum(['daily', 'weekly', 'monthly', 'lifetime']),
  limitMinor: z.number().int().nonnegative(),
  currency: z.string().length(3),
  hardStop: z.boolean().optional(),
});

export async function registerGovernanceRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const log = getLogger();

  const operator = async (request: { headers: Record<string, unknown> }): Promise<string> =>
    requireOperator(request, ctx.config.operatorApiToken);

  const company = async (): Promise<string> => {
    const row = await ctx.repos.companies.first();
    if (!row) throw new ValidationError('No company is configured yet.');
    return row.id;
  };

  /* ---------------------------------------------------------------------- */
  /* Approvals                                                               */
  /* ---------------------------------------------------------------------- */

  app.get('/api/approvals', async (request) => {
    await operator(request as never);
    const companyId = await company();
    const pending = await ctx.repos.governance.approvals.listPending(companyId);
    return {
      pending: pending.map((a) => ({
        id: a.id,
        request: a.request,
        authority: a.authority,
        subjectRefId: a.subject_ref_id,
        amountMinor: a.amount_minor,
        currency: a.currency,
        evidenceRefs: a.evidence_refs,
        riskNotes: a.risk_notes,
        expiresAt: a.expires_at,
        createdAt: a.created_at,
      })),
    };
  });

  app.post<{ Params: { id: string }; Body: unknown }>('/api/approvals/:id/decide', async (request, reply) => {
    const actorId = await operator(request as never);
    const body = DecideApproval.parse(request.body);
    const approval = await ctx.repos.governance.approvals.decide(
      request.params.id,
      body.decision,
      actorId,
      body.rationale,
    );

    await ctx.repos.audit.append({
      companyId: approval.company_id,
      kind: body.decision === 'approved' ? 'approval_granted' : 'approval_rejected',
      actorId,
      actorKind: 'human_operator',
      action: approval.request,
      subjectType: 'approval',
      subjectRefId: approval.id,
      outcome: 'success',
      detail: {
        authority: approval.authority,
        rationale: body.rationale,
        ...(body.decidedByLabel ? { operatorLabel: body.decidedByLabel } : {}),
      },
      amountMinor: approval.amount_minor,
      currency: approval.currency,
    });

    log.info({ approvalId: approval.id, decision: body.decision, by: actorId }, 'approval decided');
    return reply.send({ id: approval.id, status: approval.status, decidedAt: approval.decided_at });
  });

  /* ---------------------------------------------------------------------- */
  /* Kill switches                                                           */
  /* ---------------------------------------------------------------------- */

  app.get('/api/kill-switches', async (request) => {
    await operator(request as never);
    const companyId = await company();
    const history = await ctx.repos.governance.killSwitches.history(companyId);
    return {
      engaged: await ctx.repos.governance.killSwitches.engagedScopes(companyId),
      history: history.map((k) => ({
        scope: k.scope,
        engaged: k.engaged,
        reason: k.reason,
        engagedBy: k.engaged_by,
        engagedAt: k.engaged_at,
        releasedBy: k.released_by,
        releasedAt: k.released_at,
      })),
    };
  });

  app.post<{ Body: unknown }>('/api/kill-switches/engage', async (request, reply) => {
    const actorId = await operator(request as never);
    const body = EngageKillSwitch.parse(request.body);
    const companyId = await company();

    const engaged = await ctx.repos.governance.killSwitches.engage(companyId, body.scope, body.reason, actorId);
    await ctx.repos.audit.append({
      companyId,
      kind: 'kill_switch_engaged',
      actorId,
      actorKind: 'human_operator',
      action: `engage kill switch: ${body.scope}`,
      subjectType: 'kill_switch',
      subjectRefId: engaged.id,
      outcome: 'success',
      detail: {
        scope: body.scope,
        reason: body.reason,
        ...(body.engagedByLabel ? { operatorLabel: body.engagedByLabel } : {}),
      },
    });

    log.warn({ scope: body.scope, by: actorId }, 'kill switch engaged');
    return reply.send({ scope: engaged.scope, engaged: true, engagedAt: engaged.engaged_at });
  });

  app.post<{ Params: { scope: string }; Body: unknown }>('/api/kill-switches/:scope/release', async (request, reply) => {
    const actorId = await operator(request as never);
    const scope = KillSwitchScope.parse(request.params.scope);
    const body = ReleaseKillSwitch.parse(request.body ?? {});
    const companyId = await company();

    await ctx.repos.governance.killSwitches.release(companyId, scope, actorId);
    await ctx.repos.audit.append({
      companyId,
      kind: 'kill_switch_released',
      actorId,
      actorKind: 'human_operator',
      action: `release kill switch: ${scope}`,
      subjectType: 'kill_switch',
      subjectRefId: scope,
      outcome: 'success',
      detail: { scope, ...(body.releasedByLabel ? { operatorLabel: body.releasedByLabel } : {}) },
    });

    log.info({ scope, by: actorId }, 'kill switch released');
    return reply.send({ scope, engaged: false });
  });

  /* ---------------------------------------------------------------------- */
  /* Budgets                                                                 */
  /* ---------------------------------------------------------------------- */

  app.get('/api/budgets', async (request) => {
    await operator(request as never);
    const companyId = await company();
    const budgets = await ctx.repos.governance.budgets.list(companyId);
    return {
      budgets: budgets.map((b) => ({
        scope: b.scope,
        window: b.window_kind,
        limitMinor: b.limit_minor,
        reservedMinor: b.reserved_minor,
        spentMinor: b.spent_minor,
        remainingMinor: Math.max(0, b.limit_minor - b.reserved_minor - b.spent_minor),
        currency: b.currency,
        hardStop: b.hard_stop,
        windowStartedAt: b.window_started_at,
      })),
    };
  });

  app.put<{ Body: unknown }>('/api/budgets', async (request, reply) => {
    await operator(request as never);
    const body = SetBudget.parse(request.body);
    const companyId = await company();

    const budget = await ctx.repos.governance.budgets.upsert({
      companyId,
      scope: body.scope as BudgetScope,
      window: body.window,
      limitMinor: body.limitMinor,
      currency: body.currency,
      ...(body.hardStop !== undefined ? { hardStop: body.hardStop } : {}),
    });

    await ctx.repos.audit.append({
      companyId,
      kind: 'budget_changed',
      actorId: 'operator',
      actorKind: 'human_operator',
      action: `set ${body.scope}/${body.window} budget`,
      subjectType: 'budget',
      subjectRefId: budget.id,
      outcome: 'success',
      detail: { scope: body.scope, window: body.window, limitMinor: body.limitMinor },
      amountMinor: body.limitMinor,
      currency: body.currency,
    });

    return reply.send({ scope: budget.scope, window: budget.window_kind, limitMinor: budget.limit_minor });
  });

  /* ---------------------------------------------------------------------- */
  /* Audit                                                                   */
  /* ---------------------------------------------------------------------- */

  app.get<{ Querystring: { kind?: string; subjectRefId?: string; limit?: string } }>(
    '/api/audit',
    async (request) => {
      await operator(request as never);
      const query = AuditListQuery.parse(request.query);
      const companyId = await company();
      const events = await ctx.repos.audit.list(companyId, {
        ...(query.kind ? { kind: query.kind as never } : {}),
        ...(query.subjectRefId ? { subjectRefId: query.subjectRefId } : {}),
        limit: query.limit,
      });
      return {
        events: events.map((e) => ({
          id: e.id,
          position: e.chain_position,
          kind: e.kind,
          actorId: e.actor_id,
          actorKind: e.actor_kind,
          action: e.action,
          subjectType: e.subject_type,
          subjectRefId: e.subject_ref_id,
          outcome: e.outcome,
          detail: e.detail,
          amountMinor: e.amount_minor,
          currency: e.currency,
          occurredAt: e.occurred_at,
          hash: e.hash,
        })),
      };
    },
  );

  /**
   * Verifies the audit hash chain.
   *
   * Recomputes every hash rather than trusting the stored value, so a clean
   * result is a real statement about the log's integrity.
   */
  app.get('/api/audit/verify', async (request, reply) => {
    await operator(request as never);
    const companyId = await company();
    const result = await ctx.repos.audit.verifyChain(companyId);
    return reply.code(result.valid ? 200 : 500).send(result);
  });

  /* ---------------------------------------------------------------------- */
  /* Agent runs                                                              */
  /* ---------------------------------------------------------------------- */

  app.get('/api/agent-runs', async (request) => {
    await operator(request as never);
    const companyId = await company();
    const active = await ctx.repos.agents.runs.listActive(companyId);
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const usage = await ctx.repos.agents.runs.usageByRole(companyId, since);
    return {
      active: active.map((r) => ({
        id: r.id,
        roleKey: r.role_key,
        status: r.status,
        objective: r.objective,
        model: r.model,
        parentRunId: r.parent_run_id,
        startedAt: r.started_at,
        deadlineAt: r.deadline_at,
      })),
      usageLast24h: usage,
      totalCostMinorUsd: usage.reduce((acc, u) => acc + u.costMinorUsd, 0),
    };
  });

  app.get<{ Params: { id: string } }>('/api/agent-runs/:id', async (request) => {
    await operator(request as never);
    const run = await ctx.repos.agents.runs.byId(request.params.id);
    const messages = await ctx.repos.agents.messages.forRun(run.id);
    const children = await ctx.repos.agents.runs.children(run.id);
    return {
      run: {
        id: run.id,
        roleKey: run.role_key,
        status: run.status,
        objective: run.objective,
        model: run.model,
        output: run.output,
        error: run.error,
        toolCallCount: run.tool_call_count,
        inputTokens: run.input_tokens,
        outputTokens: run.output_tokens,
        costMinorUsd: run.cost_minor_usd,
        startedAt: run.started_at,
        finishedAt: run.finished_at,
      },
      messages: messages.map((m) => ({
        sequence: m.sequence,
        role: m.role,
        toolName: m.tool_name,
        isError: m.is_error,
        content: m.content,
      })),
      children: children.map((c) => ({ id: c.id, roleKey: c.role_key, status: c.status })),
    };
  });

  /**
   * The message-level interaction feed. Registered here rather than from the
   * app entrypoint so it inherits this file's rule without restating it: the
   * operator token gates the read, and it lives beside the run listing it
   * expands on.
   */
  await registerAgentActivityRoute(app, ctx);
}
