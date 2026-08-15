/**
 * Agent executor — runs one agent role to completion, durably.
 *
 * Every message is persisted before the next request goes out, so a worker that
 * dies mid-run leaves a complete, inspectable trace rather than a black hole.
 * Token spend is accumulated as it happens, so even a killed run reports what
 * it cost.
 *
 * The system prompt is assembled from the org chart — mandate, deliverables,
 * authorities, and the honesty rules that apply to every role. Those rules are
 * not decoration: they are the difference between an agent that reports a
 * blocked dependency and one that invents a plausible result.
 */

import {
  MODEL_BY_TIER,
  ValidationError,
  describeError,
  roleByKey,
  type AgentRunStatus,
  type RoleDefinition,
} from './deps.js';
import type { Repositories } from '@foundry/db';
import type { AnthropicAdapter, BandAdapter, MessageParam, ToolDefinition } from '@foundry/providers';
import { effortForTier } from '@foundry/providers';
import { getLogger, withContext } from '@foundry/obs';
import { executeToolCall, type ToolContext, type ToolRegistry } from './tool-registry.js';
import type { PolicyGate } from './policy-gate.js';

/**
 * Cap, in characters, on a single tool result handed back to the model.
 *
 * Without a cap one oversized provider response — a full search result set, a
 * supplier catalog, a raw analytics export — is appended verbatim to the
 * conversation and the next request blows the context window. The run then dies
 * as a generic failure that says nothing about what actually happened, which is
 * the worst possible diagnosis for an operator.
 *
 * 16,000 characters is roughly 4,000 tokens at the usual ~4 chars/token, i.e. a
 * quarter of the 16,000-token `maxTokens` this executor allows the model for a
 * single turn: a tool result larger than a quarter of the model's own maximum
 * answer is a bulk dump, not an answer. Against the executor's other limit —
 * the 20-iteration cap — the worst case is 20 x ~4,000 = ~80,000 tokens of tool
 * output, which still leaves the system prompt, the objective and twenty
 * assistant turns comfortable room inside a 200k-token context. It is also
 * large enough to carry a realistic page of structured results (tens of search
 * hits with title, url and snippet), so truncation stays the exception.
 *
 * The cap applies to the copy the model sees only. `agent_messages` always
 * stores the full result — see `#execute`.
 */
export const MAX_TOOL_RESULT_CHARS = 16_000;

export interface CappedToolResult {
  readonly content: string;
  readonly omittedChars: number;
}

/**
 * The copy of a tool result the model will see: verbatim when it fits within
 * `MAX_TOOL_RESULT_CHARS`, otherwise truncated to that cap with the number of
 * withheld characters reported so the audit trail can record them. The caller
 * persists the full result regardless — see `#execute`.
 */
export function capToolResultForModel(full: string): CappedToolResult {
  if (full.length <= MAX_TOOL_RESULT_CHARS) {
    return { content: full, omittedChars: 0 };
  }
  // The notice is part of the cap, not an extra. A silently sliced payload
  // would let the model reason over a fragment believing it is complete —
  // which is the honesty failure this function exists to prevent.
  const omitted = full.length - MAX_TOOL_RESULT_CHARS;
  const notice =
    `\n\n[truncated: ${omitted} characters omitted of ${full.length}; ` +
    `the audit trail holds the full result]`;
  const budget = Math.max(0, MAX_TOOL_RESULT_CHARS - notice.length);
  return {
    content: full.slice(0, budget) + notice,
    omittedChars: full.length - budget,
  };
}

export interface ExecutorDeps {
  readonly repos: Repositories;
  readonly llm: AnthropicAdapter;
  readonly tools: ToolRegistry;
  readonly gate: PolicyGate;
  /** When set, a run with a BAND assignment cannot start until the room message is marked processing. */
  readonly band?: BandAdapter;
}

export interface RunRequest {
  readonly runId: string;
  readonly companyId: string;
  readonly roleKey: string;
  readonly objective: string;
  readonly inputRefs?: Record<string, unknown>;
  readonly maxIterations?: number;
  readonly signal: AbortSignal;
}

export interface RunOutcome {
  readonly status: AgentRunStatus;
  readonly finalText: string;
  readonly iterations: number;
  readonly toolCalls: number;
  readonly costMinorUsd: number;
  /** Set when the run could not proceed: blocked capability, denial, refusal. */
  readonly blockedReason: string | null;
}

export class AgentExecutor {
  constructor(private readonly deps: ExecutorDeps) {}

  async run(request: RunRequest): Promise<RunOutcome> {
    const role = roleByKey(request.roleKey);
    if (!role) {
      throw new ValidationError(`Unknown role "${request.roleKey}" — it is not in the org chart`);
    }

    return withContext(
      { traceId: request.runId, companyId: request.companyId, runId: request.runId, route: `agent:${role.key}` },
      async () => this.#execute(request, role),
    );
  }

  async #execute(request: RunRequest, role: RoleDefinition): Promise<RunOutcome> {
    const log = getLogger();
    const { repos, llm, tools, gate } = this.deps;

    const missing = tools.missingForRole(role.tools);
    if (missing.length > 0) {
      // A role wired to tools that do not exist is a configuration bug, and
      // running it anyway would silently reduce what the role can do.
      throw new ValidationError(
        `Role "${role.key}" references unregistered tools: ${missing.join(', ')}`,
        { roleKey: role.key, missing },
      );
    }

    const roleTools = tools.forRole(role.tools);
    const toolDefinitions: ToolDefinition[] = roleTools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.jsonSchema,
      strict: true,
    }));

    const systemPrompt = buildSystemPrompt(role, request);
    const model = MODEL_BY_TIER[role.tier];

    let toolCallCount = 0;
    let blockedReason: string | null = null;

    /**
     * Marks the boundary between "refused to start" and "started and then
     * failed". Everything before the tool loop is a precondition — the DB write
     * that claims the run, the BAND claim, the first two persisted messages. A
     * failure there must be re-thrown so the queue and the dispatcher see that
     * dispatch itself is broken; a failure inside the loop is the run's own
     * outcome and is returned as a `RunOutcome` instead. Both paths must leave
     * the row terminal, which is the entire point of the restructure below.
     */
    let startupComplete = false;

    const toolCtx: ToolContext = {
      companyId: request.companyId,
      runId: request.runId,
      roleKey: role.key,
      actorHandle: role.key,
      traceId: request.runId,
      signal: request.signal,
    };

    /**
     * Untruncated tool output, keyed by tool_use id, for the results that were
     * shortened before the model saw them.
     *
     * `onStep` is handed exactly what `executeTool` returned, so truncating in
     * place would silently truncate the audit trail too. Instead the full
     * string is parked here and `onStep` persists that, while the model gets
     * the capped copy. Only truncated results are stored, and each entry is
     * deleted as soon as it is written, so the map holds at most one
     * iteration's oversized results rather than growing across the run.
     */
    const untruncatedToolResults = new Map<string, { full: string; omittedChars: number }>();

    try {
      /* ---------------------------------------------------------------- */
      /* Startup: claim the run, claim the room, persist the opening turns  */
      /* ---------------------------------------------------------------- */

      // `markStarted` used to sit outside this try alongside the BAND claim.
      // When the claim threw — which it does by design when dispatch never
      // posted an @mention — the row was already `running`, `finish()` was
      // never called and the `finally` never ran, so the run stayed `running`
      // forever and its parent waited on a specialist that no longer existed.
      // Everything that can fail after the row is claimed now lives under the
      // catch that closes it out.
      await repos.agents.runs.markStarted(request.runId);
      await this.#claimBandAssignment(request);

      let sequence = await repos.agents.messages.nextSequence(request.runId);
      await repos.agents.messages.append({
        runId: request.runId,
        sequence: sequence++,
        role: 'system',
        content: { text: systemPrompt },
      });

      const initialMessages: MessageParam[] = [
        {
          role: 'user',
          content: renderObjective(request),
        },
      ];
      await repos.agents.messages.append({
        runId: request.runId,
        sequence: sequence++,
        role: 'user',
        content: initialMessages[0]!.content,
      });

      startupComplete = true;

      const result = await llm.runToolLoop({
        model,
        system: systemPrompt,
        messages: initialMessages,
        tools: toolDefinitions,
        effort: effortForTier(role.tier),
        maxIterations: request.maxIterations ?? 20,
        maxTokens: 16_000,
        signal: request.signal,
        executeTool: async (call) => {
          toolCallCount += 1;
          const outcome = await executeToolCall(tools, gate, { name: call.name, input: call.input }, toolCtx);

          if (!outcome.ok) {
            // A denial or blocked capability is recorded so the loop's reason
            // for stopping short is visible afterwards, not just in the text.
            if (outcome.kind === 'denied' || outcome.kind === 'needs_approval') {
              blockedReason = outcome.reason;
            }
          }
          // Failure reasons are capped too: a provider error can carry a body
          // just as large as a success, and it reaches the model the same way.
          const full = outcome.ok ? JSON.stringify(outcome.output ?? null) : outcome.reason;
          const capped = capToolResultForModel(full);
          if (capped.omittedChars > 0) {
            untruncatedToolResults.set(call.id, { full, omittedChars: capped.omittedChars });
            log.warn(
              {
                role: role.key,
                tool: call.name,
                totalChars: full.length,
                shownChars: MAX_TOOL_RESULT_CHARS,
                omittedChars: capped.omittedChars,
              },
              'tool result truncated before it reached the model',
            );
          }
          return { content: capped.content, isError: !outcome.ok };
        },
        onStep: async (step) => {
          await repos.agents.messages.append({
            runId: request.runId,
            sequence: sequence++,
            role: 'assistant',
            content: step.assistant,
          });
          for (const toolResult of step.toolResults) {
            // `step.toolResults[].content` is verbatim what `executeTool`
            // returned, so for a truncated result it is the shortened copy.
            // The audit trail must hold what the tool actually produced, and
            // separately record that the model was shown less than that.
            const untruncated = untruncatedToolResults.get(toolResult.toolUseId);
            untruncatedToolResults.delete(toolResult.toolUseId);
            await repos.agents.messages.append({
              runId: request.runId,
              sequence: sequence++,
              role: 'tool_result',
              content: {
                toolUseId: toolResult.toolUseId,
                content: untruncated?.full ?? toolResult.content,
                ...(untruncated
                  ? {
                      truncatedForModel: {
                        shownChars: MAX_TOOL_RESULT_CHARS,
                        omittedChars: untruncated.omittedChars,
                      },
                    }
                  : {}),
              },
              toolUseId: toolResult.toolUseId,
              isError: toolResult.isError,
            });
          }
          // Usage is written per step, so a run killed mid-flight still
          // reports what it consumed.
          await repos.agents.runs.addUsage(request.runId, {
            inputTokens: step.usage.inputTokens,
            outputTokens: step.usage.outputTokens,
            costMinorUsd: step.usage.costMinorUsd,
            toolCalls: step.toolResults.length,
          });
        },
      });

      /* ---------------------------------------------------------------- */
      /* Terminal outcomes                                                 */
      /* ---------------------------------------------------------------- */

      if (result.refusal) {
        const reason =
          `The model declined this request (${result.refusal.category ?? 'unspecified category'}): ` +
          `${result.refusal.explanation ?? 'no explanation given'}`;
        await repos.agents.runs.finish({
          id: request.runId,
          status: 'failed',
          roleKey: role.key,
          error: reason,
          output: { refusal: result.refusal },
        });
        await this.#audit(request, role, 'failure', { reason, kind: 'model_refusal' });
        return {
          status: 'failed',
          finalText: '',
          iterations: result.iterations,
          toolCalls: toolCallCount,
          costMinorUsd: result.usage.costMinorUsd,
          blockedReason: reason,
        };
      }

      if (result.stopReason === 'max_iterations') {
        const reason = `Run hit the ${request.maxIterations ?? 20}-iteration cap without finishing.`;
        await repos.agents.runs.finish({
          id: request.runId,
          status: 'failed',
          roleKey: role.key,
          error: reason,
          output: { iterations: result.iterations },
        });
        await this.#audit(request, role, 'failure', { reason, kind: 'iteration_cap' });
        return {
          status: 'failed',
          finalText: '',
          iterations: result.iterations,
          toolCalls: toolCallCount,
          costMinorUsd: result.usage.costMinorUsd,
          blockedReason: reason,
        };
      }

      await repos.agents.runs.finish({
        id: request.runId,
        status: 'succeeded',
        roleKey: role.key,
        output: { text: result.finalText, blockedReason },
      });
      await this.#audit(request, role, 'success', {
        iterations: result.iterations,
        toolCalls: toolCallCount,
        costMinorUsd: result.usage.costMinorUsd,
        blocked: blockedReason !== null,
      });

      log.info(
        { role: role.key, iterations: result.iterations, toolCalls: toolCallCount, costMinorUsd: result.usage.costMinorUsd },
        'agent run finished',
      );

      return {
        status: 'succeeded',
        finalText: result.finalText,
        iterations: result.iterations,
        toolCalls: toolCallCount,
        costMinorUsd: result.usage.costMinorUsd,
        blockedReason,
      };
    } catch (error) {
      const detail = describeError(error);
      const timedOut = request.signal.aborted;
      const status: AgentRunStatus = timedOut ? 'timed_out' : 'failed';

      await repos.agents.runs.finish({
        id: request.runId,
        status,
        roleKey: role.key,
        error: String(detail['message'] ?? 'run failed'),
        output: { error: detail },
      });
      await this.#audit(request, role, 'failure', detail);

      log.error({ role: role.key, err: error }, 'agent run failed');

      if (!startupComplete) {
        // A failure before the tool loop is dispatch itself breaking — the BAND
        // claim that never happened, a run the worker cannot even claim — not a
        // run outcome. The queue must see it as a rejection so it does not wait
        // on a specialist that does not exist. The row was already closed out
        // above; re-throw for the caller.
        throw error;
      }

      return {
        status,
        finalText: '',
        iterations: 0,
        toolCalls: toolCallCount,
        costMinorUsd: 0,
        blockedReason: String(detail['message'] ?? 'run failed'),
      };
    } finally {
      await this.#releaseBandAssignment(request);
    }
  }

  async #claimBandAssignment(request: RunRequest): Promise<void> {
    const band = this.deps.band;
    if (!band) return;
    const run = await this.deps.repos.agents.runs.byId(request.runId);
    const chatId =
      stringRef(run.input_refs['bandChatId']) ?? run.coordination_room_id ?? undefined;
    const messageId = stringRef(run.input_refs['bandMessageId']);
    if (!chatId || !messageId) {
      throw new ValidationError(
        `BAND is configured, so run ${request.runId} cannot start without a BAND assignment. Dispatch must post an @mention first.`,
        { runId: request.runId },
      );
    }
    await band.markMessageProcessing(chatId, messageId);
  }

  async #releaseBandAssignment(request: RunRequest): Promise<void> {
    const band = this.deps.band;
    if (!band) return;
    try {
      const run = await this.deps.repos.agents.runs.byId(request.runId);
      const chatId =
        stringRef(run.input_refs['bandChatId']) ?? run.coordination_room_id ?? undefined;
      const messageId = stringRef(run.input_refs['bandMessageId']);
      if (!chatId || !messageId) return;
      if (run.status === 'succeeded') {
        await band.markMessageProcessed(chatId, messageId);
      } else if (run.status === 'failed' || run.status === 'timed_out' || run.status === 'cancelled') {
        await band.markMessageFailed(chatId, messageId, run.error ?? run.status);
      }
    } catch (error) {
      getLogger().warn({ err: error, runId: request.runId }, 'BAND assignment release failed');
    }
  }

  async #audit(
    request: RunRequest,
    role: RoleDefinition,
    outcome: 'success' | 'failure',
    detail: Record<string, unknown>,
  ): Promise<void> {
    await this.deps.repos.audit.append({
      companyId: request.companyId,
      kind: 'agent_run_finished',
      actorId: request.runId,
      actorKind: role.tier === 'executive' ? 'ceo_agent' : role.tier === 'manager' ? 'manager_agent' : 'specialist_agent',
      action: `${role.key}: ${request.objective.slice(0, 120)}`,
      subjectType: 'agent_run',
      subjectRefId: request.runId,
      outcome,
      detail,
    });
  }
}

/* -------------------------------------------------------------------------- */
/* Prompt assembly                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Honesty rules applied to every role.
 *
 * These exist because the failure mode that would make this whole system
 * worthless is an agent that reports success it did not achieve. Each line
 * targets a specific way that happens.
 */
const OPERATING_RULES = `
# How you operate

Report outcomes faithfully. If a tool failed, say so with the error. If a step
was skipped or blocked, say that plainly. Only claim something is done when a
tool result in this session shows it is done — before reporting progress, audit
each claim against a tool result you actually received.

Never invent data. You may not fabricate a supplier quote, a customer, an order,
a metric, a review, or a source. If you do not have a real value, say the value
is unknown and explain what would produce it. An honest "blocked, here is what
is needed" is a successful outcome; a plausible invention is a failure even if
nobody catches it.

When a tool is denied by policy or a capability is unavailable, that is
information, not an obstacle to route around. Report it, then continue with the
work that does not depend on it. Do not retry a denial, and do not attempt an
equivalent action through a different tool.

Distinguish what you observed from what you assumed. When you estimate, label it
an estimate and state what it rests on.

Deliver what was asked at the scope intended. Make routine judgment calls
yourself; check in only when different readings lead to materially different
work. Finish the whole task, not just the easy part — if you genuinely cannot
complete something, do the rest and state plainly what is missing and why.

Lead with the outcome. Your first sentence should answer what happened or what
you found. Supporting detail comes after.
`.trim();

export function buildSystemPrompt(role: RoleDefinition, request: RunRequest): string {
  const sections: string[] = [
    `You are the ${role.title} of an autonomous company. Your role key is \`${role.key}\`.`,
    '',
    '# Your mandate',
    role.mandate,
  ];

  if (role.deliverables.length > 0) {
    sections.push('', '# What you are accountable for producing', ...role.deliverables.map((d) => `- ${d}`));
  }

  if (role.authorities.length > 0) {
    sections.push(
      '',
      '# Your authority',
      `You hold: ${role.authorities.join(', ')}.`,
      role.spendCeilingMinorUsd === null
        ? 'You have no independent spend authority — every action that costs money needs human approval, which the platform requests for you automatically.'
        : `You may commit up to ${(role.spendCeilingMinorUsd / 100).toFixed(2)} USD per action without human approval. Above that the platform opens an approval request automatically.`,
      'Anything outside this list is refused by the policy layer before it runs. That is expected — report it rather than working around it.',
    );
  }

  sections.push('', OPERATING_RULES);

  if (role.reportsTo) {
    sections.push(
      '',
      '# Reporting',
      `You report to \`${role.reportsTo}\`. When you finish, your final message is your report: what you found or did, what it means for the business, and what you need from them.`,
    );
  }

  sections.push(
    '',
    '# Company context',
    `Company id: ${request.companyId}. Agent run id: ${request.runId}.`,
  );

  return sections.join('\n');
}

function renderObjective(request: RunRequest): string {
  const parts = [`# Objective\n${request.objective}`];
  const refs = request.inputRefs ?? {};
  if (Object.keys(refs).length > 0) {
    parts.push(`\n# Inputs\n${JSON.stringify(refs, null, 2)}`);
  }
  parts.push(
    '\nBegin. Use your tools to gather what you need rather than assuming. When you are done, write your report.',
  );
  return parts.join('\n');
}

function stringRef(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
