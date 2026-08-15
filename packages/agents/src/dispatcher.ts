/**
 * Org dispatch — how the CEO delegates to managers and managers to specialists.
 *
 * Delegation is asynchronous: a dispatch enqueues a durable run and returns
 * immediately with its id. The caller can then continue working and collect
 * reports later. A synchronous spawn-and-block model would serialise the whole
 * organisation behind its slowest specialist, and would lose all in-flight work
 * whenever a worker restarted.
 *
 * The chain of command is enforced here rather than trusted to the prompt: a
 * specialist cannot dispatch anything, and a manager can only dispatch its own
 * direct reports.
 */

import {
  MODEL_BY_TIER,
  PolicyDeniedError,
  ValidationError,
  newId,
  roleByKey,
  specialistsOf,
  type RoleDefinition,
} from './deps.js';
import type { Repositories } from '@foundry/db';
import { companyConfig } from '@foundry/db';
import type { QueueSet } from '@foundry/queue';
import type { BandAdapter } from '@foundry/providers';
import { getLogger } from '@foundry/obs';

export interface DispatchRequest {
  readonly companyId: string;
  /** Role doing the dispatching. */
  readonly fromRoleKey: string;
  /** Role being dispatched. Must be a direct report of `fromRoleKey`. */
  readonly toRoleKey: string;
  readonly objective: string;
  readonly inputRefs?: Record<string, unknown>;
  readonly parentRunId?: string | null;
  readonly traceId: string;
  /** Delay before the run starts, for polling-style follow-ups. */
  readonly delayMs?: number;
}

export interface DispatchResult {
  readonly runId: string;
  readonly roleKey: string;
  readonly model: string;
  readonly queuedAt: string;
}

export class OrgDispatcher {
  constructor(
    private readonly repos: Repositories,
    private readonly queues: QueueSet,
    private readonly coordination?: { readonly band: BandAdapter },
  ) {}

  /**
   * Enqueues a run for a direct report.
   *
   * Refuses a dispatch that violates the chain of command. This matters because
   * the org chart is also the authority model: letting a specialist dispatch a
   * manager would let it borrow authority it does not hold.
   */
  async dispatch(request: DispatchRequest): Promise<DispatchResult> {
    const from = roleByKey(request.fromRoleKey);
    const to = roleByKey(request.toRoleKey);

    if (!from) throw new ValidationError(`Unknown dispatching role "${request.fromRoleKey}"`);
    if (!to) throw new ValidationError(`Unknown target role "${request.toRoleKey}"`);

    // Checked before the chain-of-command rule so a specialist attempting to
    // delegate gets the reason that actually applies, rather than a confusing
    // "not a direct report" message about a role it was never allowed to
    // dispatch in the first place.
    if (from.tier === 'specialist') {
      throw new PolicyDeniedError(
        `Specialists do not delegate. "${from.key}" must do the work itself or report back to ${from.reportsTo}.`,
        { from: from.key },
      );
    }
    if (to.reportsTo !== from.key) {
      throw new PolicyDeniedError(
        `"${from.key}" may not dispatch "${to.key}" — it is not a direct report. ` +
          `Direct reports of ${from.key}: ${directReportKeys(from).join(', ') || 'none'}.`,
        { from: from.key, to: to.key },
      );
    }

    return this.#enqueueRun(request, to.key);
  }

  /**
   * System-origin enqueue for the CEO (and any role the loop must start
   * without a chain-of-command parent). The CEO cannot dispatch itself
   * through `dispatch()` because `ceo.reportsTo` is null.
   */
  async enqueueSystem(
    request: Omit<DispatchRequest, 'fromRoleKey'> & { readonly fromRoleKey?: string },
  ): Promise<DispatchResult> {
    const to = roleByKey(request.toRoleKey);
    if (!to) throw new ValidationError(`Unknown target role "${request.toRoleKey}"`);
    return this.#enqueueRun(
      {
        ...request,
        fromRoleKey: request.fromRoleKey ?? 'system',
      },
      to.key,
    );
  }

  async #enqueueRun(request: DispatchRequest, toRoleKey: string): Promise<DispatchResult> {
    if (!this.coordination?.band) {
      throw new ValidationError(
        'Dispatch requires BAND coordination. The room is the handoff; enqueue without posting to a BAND room is refused.',
      );
    }

    const run = await this.repos.agents.runs.create({
      companyId: request.companyId,
      roleKey: toRoleKey,
      objective: request.objective,
      inputRefs: request.inputRefs ?? {},
      parentRunId: request.parentRunId ?? null,
    });

    try {
      await this.#postBandAssignment(request, run.id, toRoleKey);
    } catch (error) {
      try {
        await this.repos.agents.runs.finish({
          id: run.id,
          status: 'failed',
          roleKey: toRoleKey,
          error: 'BAND handoff failed; the specialist was not enqueued.',
        });
      } catch {
        /* keep the handoff error */
      }
      throw error;
    }

    await this.queues.enqueue(
      'agent.run',
      {
        companyId: request.companyId,
        traceId: request.traceId,
        originRunId: request.parentRunId ?? null,
        idempotencyKey: run.id,
        runId: run.id,
        roleKey: toRoleKey,
        objective: request.objective,
        inputRefs: request.inputRefs ?? {},
        parentRunId: request.parentRunId ?? null,
        deadlineAt: run.deadline_at.toISOString(),
      },
      request.delayMs ? { delay: request.delayMs } : {},
    );

    getLogger().info(
      { from: request.fromRoleKey, to: toRoleKey, runId: run.id },
      'dispatched agent run',
    );

    const role = roleByKey(toRoleKey);
    return {
      runId: run.id,
      roleKey: toRoleKey,
      model: MODEL_BY_TIER[role?.tier ?? 'specialist'],
      queuedAt: run.created_at.toISOString(),
    };
  }

  /**
   * Dispatches several reports at once.
   *
   * Fanning out in one call is the point: parallel specialists each get a fresh
   * context window, so the manager's own context stays small while the reading
   * happens elsewhere.
   */
  async dispatchMany(requests: readonly DispatchRequest[]): Promise<readonly DispatchResult[]> {
    return Promise.all(requests.map((r) => this.dispatch(r)));
  }

  /** Reports from completed child runs, for a manager collecting results. */
  async collectReports(parentRunId: string): Promise<
    readonly {
      runId: string;
      roleKey: string;
      status: string;
      output: unknown;
      error: string | null;
      costMinorUsd: number;
    }[]
  > {
    const children = await this.repos.agents.runs.children(parentRunId);
    return children.map((c) => ({
      runId: c.id,
      roleKey: c.role_key,
      status: c.status,
      output: c.output,
      error: c.error,
      costMinorUsd: c.cost_minor_usd,
    }));
  }

  /** True when every dispatched child has reached a terminal state. */
  async allChildrenFinished(parentRunId: string): Promise<boolean> {
    const children = await this.repos.agents.runs.children(parentRunId);
    if (children.length === 0) return true;
    const terminal = new Set(['succeeded', 'failed', 'cancelled', 'timed_out']);
    return children.every((c) => terminal.has(c.status));
  }

  /**
   * Fails runs that blew past their deadline.
   *
   * Without this a wedged run holds its queue slot and its parent waits
   * forever. Timing out loudly is better than a manager blocked on a
   * specialist that will never report.
   */
  async reapOverdueRuns(): Promise<number> {
    const overdue = await this.repos.agents.runs.findOverdue();
    for (const run of overdue) {
      await this.repos.agents.runs.finish({
        id: run.id,
        status: 'timed_out',
        roleKey: run.role_key,
        error: `Run exceeded its deadline of ${run.deadline_at.toISOString()} without finishing.`,
      });
      getLogger().warn({ runId: run.id, roleKey: run.role_key }, 'reaped overdue agent run');
    }
    return overdue.length;
  }

  /**
   * Posts the assignment into BAND before the queue job is visible. Taking
   * BAND out of this path means the dispatch throws and the specialist never
   * runs — the room is the handoff, not a display.
   */
  async #postBandAssignment(request: DispatchRequest, runId: string, toRoleKey: string): Promise<void> {
    const band = this.coordination!.band;
    const me = await band.getMe();
    const selfHandle = (me.handle ?? me.id)?.replace(/^@/, '') ?? '';
    const chatId = await this.#ensureCompanyChat(request.companyId, band);
    // Band 422s cannot_mention_self. The routing primitive is @mention of
    // another room participant; enqueue happens only after this send returns.
    const mentionHandle = mentionableParticipantHandle(selfHandle, me.id, await band.listParticipants(chatId));
    if (!mentionHandle) {
      throw new ValidationError(
        'BAND requires @mention of another participant; agents cannot mention themselves. ' +
          'The coordination room has no one else to mention, so dispatch cannot post a handoff.',
        { runId, chatId, selfHandle: selfHandle || null },
      );
    }
    const message = await band.sendMessage(chatId, {
      recipients: [mentionHandle],
      body:
        `DISPATCH role=${toRoleKey} run=${runId}\n` +
        `${request.objective}\n` +
        `A specialist must not start this work except by claiming this message.`,
    });
    await this.repos.agents.runs.attachRoom(runId, chatId);
    await this.repos.agents.runs.mergeInputRefs(runId, {
      bandChatId: chatId,
      bandMessageId: message.id,
      bandHandle: mentionHandle,
    });
  }

  async #ensureCompanyChat(companyId: string, band: BandAdapter): Promise<string> {
    const company = await this.repos.companies.byId(companyId);
    const config = companyConfig(company);
    const existing = config.integrations?.bandChatId;
    if (existing) return existing;
    const chat = await band.createChat({
      name: `${company.name} coordination`,
      taskId: companyId,
    });
    await this.repos.companies.updateConfig(companyId, {
      ...config,
      integrations: { ...config.integrations, bandChatId: chat.id },
    });
    return chat.id;
  }
}

/** Band 422s cannot_mention_self; dispatch must @mention someone else in the room. */
function mentionableParticipantHandle(
  selfHandle: string,
  selfId: string | undefined,
  participants: readonly { readonly id?: string | null; readonly handle?: string | null }[],
): string | undefined {
  for (const participant of participants) {
    const handle = participant.handle?.replace(/^@/, '').trim() ?? '';
    if (!handle) continue;
    if (selfHandle && handle === selfHandle) continue;
    if (selfId && (participant.id === selfId || handle === selfId)) continue;
    return handle;
  }
  return undefined;
}

function directReportKeys(role: RoleDefinition): readonly string[] {
  if (role.tier === 'executive') {
    // Managers report to the CEO.
    return ['research_manager', 'sourcing_manager', 'brand_manager', 'commerce_manager', 'growth_manager',
      'customer_ops_manager', 'finance_manager', 'engineering_manager', 'qa_manager', 'legal_manager'];
  }
  return specialistsOf(role.key).map((r) => r.key);
}

/** Stable id for a dispatch, so a retried planner produces the same run. */
export function dispatchKey(parentRunId: string, toRoleKey: string, objective: string): string {
  return newId('task') + `:${parentRunId}:${toRoleKey}:${objective.length}`;
}
