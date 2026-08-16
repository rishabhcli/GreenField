/**
 * Anthropic adapter — the inference layer the whole agent organisation runs on.
 *
 * Three things here are deliberate:
 *
 *  - The agentic loop is hand-written rather than using the SDK's tool runner,
 *    because every step must be persisted before the next request is made. A
 *    worker that dies mid-run has to be resumable from the database, and the
 *    tool runner owns the loop, so it cannot give us that.
 *  - Structured output goes through strict tool use rather than free-text JSON,
 *    so a manager agent's scorecard either validates or fails loudly.
 *  - `stop_reason: 'refusal'` is checked before `content` is read. On Claude
 *    Opus 5 the safety classifiers can decline a request and return HTTP 200
 *    with an empty content array; indexing `content[0]` would throw.
 *
 * Model ids, pricing and API semantics verified against the Anthropic API
 * reference on 2026-08-15.
 */

import Anthropic from '@anthropic-ai/sdk';
import {
  MODEL_PRICING_CENTS_PER_MTOK,
  ProviderAuthError,
  ProviderContractError,
  ProviderUnavailableError,
  RateLimitError,
  TimeoutError,
  ValidationError,
  type ModelTier,
} from '@foundry/core';
import { getLogger, metrics } from '@foundry/obs';
import type { z } from 'zod';
import { ProviderAdapter, type AdapterContext, type ProbeResult } from '../http/adapter.js';
import { ANTHROPIC_MANIFEST, SECRETS } from '../manifests.js';
import { applyPromptCache } from './cache.js';

export {
  applyPromptCache,
  countCacheBreakpoints,
  MAX_CACHE_BREAKPOINTS,
  CACHE_TTL,
  EPHEMERAL_CACHE,
} from './cache.js';

/** Thinking depth / token spend. Higher costs more and reasons harder. */
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** Cache lifetime. `5m` writes at 1.25x base input, `1h` at 2x. */
export type CacheTtl = '5m' | '1h';

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  /**
   * Guarantees `input` validates against the schema exactly. Requires
   * `additionalProperties: false` and a `required` array.
   */
  readonly strict?: boolean;
}

export interface CompletionUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheCreationInputTokens: number;
  readonly cacheReadInputTokens: number;
  readonly costMinorUsd: number;
}

export type ContentBlock = Anthropic.ContentBlock;
export type MessageParam = Anthropic.MessageParam;

export interface CompletionResult {
  readonly model: string;
  readonly content: readonly ContentBlock[];
  readonly text: string;
  readonly stopReason: string | null;
  /** Populated only on a refusal. */
  readonly refusal: { category: string | null; explanation: string | null } | null;
  readonly toolUses: readonly { id: string; name: string; input: unknown }[];
  readonly usage: CompletionUsage;
}

export interface CompleteInput {
  readonly model: string;
  readonly system?: string;
  readonly messages: readonly MessageParam[];
  readonly tools?: readonly ToolDefinition[];
  readonly maxTokens?: number;
  readonly effort?: Effort;
  /** Adaptive thinking is on by default on Opus 5; set false to disable it. */
  readonly thinking?: boolean;
  /** Returns a readable summary of the reasoning instead of empty blocks. */
  readonly showThinking?: boolean;
  /**
   * Caches the system prompt and tool definitions. Worth it whenever the same
   * role prompt is reused, which is every agent run.
   */
  readonly cacheSystemPrompt?: boolean;
  readonly signal?: AbortSignal;
}

/**
 * The Messages API only accepts tool names matching `^[a-zA-Z0-9_-]{1,128}$`,
 * but canonical tool names are dotted (`company.get_state`) and must stay that
 * way everywhere else — the org chart, PolicyGate and the tool registry all
 * key on them. So names are rewritten at this boundary only, and `toCanonical`
 * (sanitized → canonical) lets the result map `tool_use` blocks back. Colliding
 * names get a deterministic `_2`, `_3`… suffix that survives truncation, so
 * the mapping stays bijective and a resumed run re-derives identical names.
 */
export function sanitizeToolNames(tools: readonly ToolDefinition[]): {
  tools: ToolDefinition[];
  toCanonical: Map<string, string>;
} {
  const MAX_NAME_LENGTH = 128;
  const toCanonical = new Map<string, string>();
  const sanitized: ToolDefinition[] = [];

  for (const tool of tools) {
    const base = tool.name.replace(/[^a-zA-Z0-9_-]/g, '_');
    let name = base.slice(0, MAX_NAME_LENGTH);
    for (let n = 2; toCanonical.has(name); n += 1) {
      const suffix = `_${n}`;
      name = base.slice(0, MAX_NAME_LENGTH - suffix.length) + suffix;
    }
    toCanonical.set(name, tool.name);
    sanitized.push(name === tool.name ? tool : { ...tool, name });
  }

  return { tools: sanitized, toCanonical };
}

/**
 * JSON Schema keywords Anthropic's strict custom-tool validator rejects with a
 * 400 ("For 'integer' type, properties exclusiveMinimum, maximum are not
 * supported"). Zod's `toJSONSchema` emits them from `.positive()`, `.max()`,
 * `.url()` and friends, and the hand-written catalog schemas use `maxItems`.
 */
const UNSUPPORTED_TOOL_SCHEMA_KEYWORDS = new Set([
  'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf',
  'minLength', 'maxLength', 'pattern', 'format',
  'minItems', 'maxItems', 'uniqueItems', 'default',
  'minProperties', 'maxProperties', 'patternProperties', 'propertyNames',
  'contains', 'minContains', 'maxContains',
]);

/**
 * Strips the keywords above from every node of a tool input schema before it
 * reaches the API. The constraint is not lost: it is appended to the node's
 * `description` so the model still sees the limit, and the tool registry's
 * server-side zod validation still enforces it at execution time. The caller's
 * schema is never mutated.
 */
export function sanitizeToolSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const clone = structuredClone(schema) as Record<string, unknown>;
  stripUnsupportedKeywords(clone);
  return clone;
}

function stripUnsupportedKeywords(node: Record<string, unknown>): void {
  const notes: string[] = [];
  for (const key of Object.keys(node)) {
    if (!UNSUPPORTED_TOOL_SCHEMA_KEYWORDS.has(key)) continue;
    notes.push(`${key} ${formatConstraintValue(node[key])}`);
    delete node[key];
  }
  if (notes.length > 0) {
    const note = `Constraints: ${notes.join('; ')}.`;
    node.description =
      typeof node.description === 'string' && node.description.length > 0
        ? `${node.description} ${note}`
        : note;
  }

  for (const mapKey of ['properties', '$defs']) {
    const map = node[mapKey];
    if (!isRecord(map)) continue;
    for (const child of Object.values(map)) {
      if (isRecord(child)) stripUnsupportedKeywords(child);
    }
  }
  const items = node['items'];
  if (Array.isArray(items)) {
    for (const child of items) if (isRecord(child)) stripUnsupportedKeywords(child);
  } else if (isRecord(items)) {
    stripUnsupportedKeywords(items);
  }
  for (const branchKey of ['anyOf', 'oneOf', 'allOf']) {
    const branches = node[branchKey];
    if (!Array.isArray(branches)) continue;
    for (const child of branches) if (isRecord(child)) stripUnsupportedKeywords(child);
  }
}

function formatConstraintValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class AnthropicAdapter extends ProviderAdapter {
  override readonly manifest = ANTHROPIC_MANIFEST;
  #client: Anthropic | undefined;

  constructor(ctx: AdapterContext) {
    super(ctx);
  }

  #anthropic(): Anthropic {
    if (this.#client) return this.#client;
    const secret = this.requireSecret(SECRETS.anthropicApiKey);
    this.#client = new Anthropic({
      apiKey: secret.reveal(),
      // Retry, backoff and breaker behaviour is owned by the platform so it is
      // uniform across providers; letting the SDK also retry would multiply
      // attempts and make the effective deadline unpredictable.
      maxRetries: 0,
      timeout: 10 * 60_000,
    });
    return this.#client;
  }

  /* ---------------------------------------------------------------------- */
  /* Probe                                                                   */
  /* ---------------------------------------------------------------------- */

  override async probe(): Promise<ProbeResult> {
    const started = Date.now();
    const response = await this.#call('messages.create', () =>
      this.#anthropic().messages.create({
        model: 'claude-haiku-4-5',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'ok' }],
      }),
    );
    return {
      succeeded: true,
      detail: `POST /v1/messages accepted (model ${response.model}, stop_reason ${response.stop_reason})`,
      evidence: {
        endpoint: 'POST /v1/messages',
        model: response.model,
        stopReason: response.stop_reason,
        inputTokens: response.usage.input_tokens,
        latencyMs: Date.now() - started,
      },
    };
  }

  /* ---------------------------------------------------------------------- */
  /* Completion                                                              */
  /* ---------------------------------------------------------------------- */

  async complete(input: CompleteInput): Promise<CompletionResult> {
    this.assertActivated();
    const client = this.#anthropic();

    const safeTools = input.tools
      ? sanitizeToolNames(
          input.tools.map((t) => ({ ...t, inputSchema: sanitizeToolSchema(t.inputSchema) })),
        )
      : undefined;

    const cached = applyPromptCache({
      system: input.system,
      cacheSystemPrompt: input.cacheSystemPrompt,
      tools: safeTools?.tools,
      messages: input.messages,
    });

    const params: Anthropic.MessageCreateParamsNonStreaming = {
      model: input.model,
      max_tokens: input.maxTokens ?? 16_000,
      messages: cached.messages,
      ...(cached.system ? { system: cached.system } : {}),
      ...(cached.tools && cached.tools.length > 0 ? { tools: cached.tools } : {}),
      // Adaptive thinking lets the model decide depth per request; effort caps
      // the overall spend. `budget_tokens` is rejected on current models.
      ...(input.thinking === false
        ? { thinking: { type: 'disabled' as const } }
        : {
            thinking: {
              type: 'adaptive' as const,
              ...(input.showThinking ? { display: 'summarized' as const } : {}),
            },
          }),
      ...(input.effort ? { output_config: { effort: input.effort } } : {}),
    };

    // Disabling thinking above `high` effort is rejected with a 400 on Opus 5.
    if (input.thinking === false && (input.effort === 'xhigh' || input.effort === 'max')) {
      throw new ValidationError(
        `Disabling thinking is only permitted at effort "high" or below; got "${input.effort}".`,
        { model: input.model, effort: input.effort },
      );
    }

    const response = await this.#call('messages.create', () =>
      client.messages.create(params, input.signal ? { signal: input.signal } : {}),
    );

    return this.#toResult(response, safeTools?.toCanonical);
  }

  #toResult(response: Anthropic.Message, toCanonical?: ReadonlyMap<string, string>): CompletionResult {
    const usage = this.#usage(response);

    // Refusal is checked before content is read: the classifiers can decline
    // pre-output and return an empty content array.
    if (response.stop_reason === 'refusal') {
      const details = (response as { stop_details?: { category?: string; explanation?: string } }).stop_details;
      getLogger().warn(
        { model: response.model, category: details?.category ?? null },
        'anthropic declined the request',
      );
      return {
        model: response.model,
        content: response.content,
        text: '',
        stopReason: response.stop_reason,
        refusal: { category: details?.category ?? null, explanation: details?.explanation ?? null },
        toolUses: [],
        usage,
      };
    }

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');

    // `content` keeps the sanitized names the API saw — those blocks are echoed
    // back verbatim on the next loop iteration. Only this convenience array,
    // which callers use to execute tools by name, is mapped back to canonical.
    const toolUses = response.content
      .filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')
      .map((b) => ({ id: b.id, name: toCanonical?.get(b.name) ?? b.name, input: b.input }));

    return {
      model: response.model,
      content: response.content,
      text,
      stopReason: response.stop_reason,
      refusal: null,
      toolUses,
      usage,
    };
  }

  #usage(response: Anthropic.Message): CompletionUsage {
    const u = response.usage;
    const cacheCreate = u.cache_creation_input_tokens ?? 0;
    const cacheRead = u.cache_read_input_tokens ?? 0;
    const costMinorUsd = estimateCostMinorUsd(response.model, {
      inputTokens: u.input_tokens,
      outputTokens: u.output_tokens,
      cacheCreationInputTokens: cacheCreate,
      cacheReadInputTokens: cacheRead,
    });

    metrics.agentTokens.inc({ model: response.model, direction: 'input' }, u.input_tokens);
    metrics.agentTokens.inc({ model: response.model, direction: 'output' }, u.output_tokens);
    if (cacheRead > 0) metrics.agentTokens.inc({ model: response.model, direction: 'cache_read' }, cacheRead);
    if (cacheCreate > 0) metrics.agentTokens.inc({ model: response.model, direction: 'cache_write' }, cacheCreate);

    return {
      inputTokens: u.input_tokens,
      outputTokens: u.output_tokens,
      cacheCreationInputTokens: cacheCreate,
      cacheReadInputTokens: cacheRead,
      costMinorUsd,
    };
  }

  /* ---------------------------------------------------------------------- */
  /* Structured output                                                       */
  /* ---------------------------------------------------------------------- */

  /**
   * Forces a schema-valid object out of the model using strict tool use.
   *
   * Strict mode guarantees the tool input validates, but the schema the model
   * sees is JSON Schema while ours is zod, so the result is validated again on
   * our side. A mismatch is retried once with the validation error appended —
   * beyond that it is a real failure, not something to paper over with a
   * default value.
   */
  async completeStructured<T>(input: CompleteInput & {
    schema: z.ZodType<T>;
    jsonSchema: Record<string, unknown>;
    resultName?: string;
    resultDescription?: string;
  }): Promise<{ value: T; usage: CompletionUsage; attempts: number }> {
    const toolName = input.resultName ?? 'record_result';
    const tool: ToolDefinition = {
      name: toolName,
      description:
        input.resultDescription ??
        'Record your structured result. Call this exactly once with the complete answer.',
      inputSchema: input.jsonSchema,
      strict: true,
    };

    let messages = [...input.messages];
    let totalUsage: CompletionUsage = {
      inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, costMinorUsd: 0,
    };

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const result = await this.complete({ ...input, messages, tools: [tool] });
      totalUsage = addUsage(totalUsage, result.usage);

      if (result.refusal) {
        throw new ValidationError(
          `Model declined the request (${result.refusal.category ?? 'unspecified'}): ${result.refusal.explanation ?? 'no explanation given'}`,
          { category: result.refusal.category },
        );
      }

      const call = result.toolUses.find((t) => t.name === toolName);
      if (!call) {
        if (attempt === 2) {
          throw new ProviderContractError(
            'anthropic',
            `model did not call "${toolName}" after ${attempt} attempts; it replied with text instead`,
            { text: result.text.slice(0, 500) },
          );
        }
        messages = [
          ...messages,
          { role: 'assistant', content: result.content as Anthropic.ContentBlockParam[] },
          { role: 'user', content: `You must call the ${toolName} tool with your structured result.` },
        ];
        continue;
      }

      const parsed = input.schema.safeParse(call.input);
      if (parsed.success) {
        return { value: parsed.data, usage: totalUsage, attempts: attempt };
      }

      if (attempt === 2) {
        throw new ProviderContractError(
          'anthropic',
          `structured result failed validation after ${attempt} attempts: ${parsed.error.message}`,
          { issues: parsed.error.issues.slice(0, 10) },
        );
      }

      messages = [
        ...messages,
        { role: 'assistant', content: result.content as Anthropic.ContentBlockParam[] },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result' as const,
              tool_use_id: call.id,
              is_error: true,
              content: `Your result failed validation: ${parsed.error.message}. Call ${toolName} again with a corrected object.`,
            },
          ],
        },
      ];
    }

    throw new ProviderContractError('anthropic', 'structured completion exhausted its attempts');
  }

  /* ---------------------------------------------------------------------- */
  /* Agentic loop                                                            */
  /* ---------------------------------------------------------------------- */

  /**
   * The loop every agent run executes.
   *
   * Written by hand rather than using the SDK tool runner because `onStep` must
   * be able to persist each message before the next request goes out — that is
   * what makes a run resumable after a worker restart, and it is also where the
   * policy gate on each tool call lives.
   */
  async runToolLoop(input: {
    model: string;
    system: string;
    messages: readonly MessageParam[];
    tools: readonly ToolDefinition[];
    executeTool: (call: { id: string; name: string; input: unknown }) => Promise<{ content: string; isError: boolean }>;
    maxIterations?: number;
    maxTokens?: number;
    effort?: Effort;
    /**
     * Consulted before every request. Returning a non-null reason ends the loop
     * with `stopReason: 'stopped_early'` and whatever usage has accrued, instead
     * of spending another turn.
     *
     * The hook exists because the caller — not this adapter — owns the reasons a
     * run should stop: a wall-clock deadline, a loop that has stopped making
     * progress, a budget. The adapter's own `maxIterations` cap only counts
     * turns, and counting turns says nothing about whether the next one is worth
     * making.
     */
    stopBeforeIteration?: (info: { iteration: number }) => string | null;
    onStep?: (step: {
      iteration: number;
      assistant: readonly ContentBlock[];
      toolResults: readonly { toolUseId: string; content: string; isError: boolean }[];
      usage: CompletionUsage;
    }) => Promise<void>;
    signal?: AbortSignal;
  }): Promise<{
    finalText: string;
    stopReason: string | null;
    refusal: CompletionResult['refusal'];
    iterations: number;
    usage: CompletionUsage;
    messages: readonly MessageParam[];
  }> {
    const maxIterations = input.maxIterations ?? 20;
    let messages: MessageParam[] = [...input.messages];
    let total: CompletionUsage = {
      inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, costMinorUsd: 0,
    };

    for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
      if (input.signal?.aborted) {
        throw new TimeoutError('agent tool loop', 0);
      }

      // Checked before the request, so the decision to stop costs nothing and
      // everything already persisted stays the run's result.
      if (input.stopBeforeIteration?.({ iteration })) {
        return {
          finalText: '',
          stopReason: 'stopped_early',
          refusal: null,
          iterations: iteration - 1,
          usage: total,
          messages,
        };
      }

      const result = await this.complete({
        model: input.model,
        system: input.system,
        messages,
        tools: input.tools,
        maxTokens: input.maxTokens,
        effort: input.effort,
        cacheSystemPrompt: true,
        signal: input.signal,
      });
      total = addUsage(total, result.usage);

      if (result.refusal) {
        return {
          finalText: '',
          stopReason: result.stopReason,
          refusal: result.refusal,
          iterations: iteration,
          usage: total,
          messages,
        };
      }

      messages = [...messages, { role: 'assistant', content: result.content as Anthropic.ContentBlockParam[] }];

      // A paused turn means a server-side tool hit its iteration cap. Re-sending
      // the conversation resumes it; adding a "continue" message would confuse
      // the model, because the API detects the trailing block itself.
      if (result.stopReason === 'pause_turn') {
        await input.onStep?.({ iteration, assistant: result.content, toolResults: [], usage: result.usage });
        continue;
      }

      if (result.toolUses.length === 0) {
        await input.onStep?.({ iteration, assistant: result.content, toolResults: [], usage: result.usage });
        return {
          finalText: result.text,
          stopReason: result.stopReason,
          refusal: null,
          iterations: iteration,
          usage: total,
          messages,
        };
      }

      // Tool calls in one assistant turn run concurrently, and every result
      // goes back in a single user message. Splitting them across messages
      // trains the model to stop making parallel calls.
      const executed = await Promise.all(
        result.toolUses.map(async (call) => {
          const outcome = await input.executeTool(call);
          return { toolUseId: call.id, content: outcome.content, isError: outcome.isError };
        }),
      );

      messages = [
        ...messages,
        {
          role: 'user',
          content: executed.map((r) => ({
            type: 'tool_result' as const,
            tool_use_id: r.toolUseId,
            content: r.content,
            ...(r.isError ? { is_error: true } : {}),
          })),
        },
      ];

      await input.onStep?.({ iteration, assistant: result.content, toolResults: executed, usage: result.usage });
    }

    // Hitting the cap is a real outcome, reported as such rather than dressed
    // up as a completed run.
    return {
      finalText: '',
      stopReason: 'max_iterations',
      refusal: null,
      iterations: maxIterations,
      usage: total,
      messages,
    };
  }

  /* ---------------------------------------------------------------------- */
  /* Errors                                                                  */
  /* ---------------------------------------------------------------------- */

  async #call<T>(operation: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      throw this.#translate(operation, error);
    }
  }

  #translate(operation: string, error: unknown): Error {
    if (error instanceof Anthropic.APIConnectionError) {
      return new ProviderUnavailableError('anthropic', `${operation}: ${error.message}`, { operation });
    }
    if (error instanceof Anthropic.RateLimitError) {
      const retryAfter = Number(error.headers?.get?.('retry-after') ?? '');
      return new RateLimitError('anthropic', Number.isFinite(retryAfter) ? retryAfter : undefined, { operation });
    }
    if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) {
      return new ProviderAuthError('anthropic', error.message, { operation, status: error.status });
    }
    if (error instanceof Anthropic.InternalServerError) {
      // Includes 529 overloaded_error, which is retryable.
      return new ProviderUnavailableError('anthropic', error.message, { operation, status: error.status });
    }
    if (error instanceof Anthropic.BadRequestError || error instanceof Anthropic.NotFoundError) {
      return new ValidationError(`Anthropic rejected ${operation}: ${error.message}`, {
        operation,
        status: error.status,
        type: (error as { type?: string }).type,
      });
    }
    if (error instanceof Anthropic.APIError) {
      return new ProviderContractError('anthropic', `${operation}: ${error.message}`, {
        operation,
        status: (error as { status?: number }).status,
      });
    }
    return new ProviderUnavailableError('anthropic', `${operation}: ${String(error)}`, { operation });
  }
}

/* -------------------------------------------------------------------------- */
/* Cost                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Cost in USD minor units (cents), rounded up.
 *
 * Cache writes cost 1.25x base input and cache reads 0.1x, so a run that reuses
 * a cached role prompt is materially cheaper — modelling that correctly is what
 * makes the per-role cost report actionable rather than decorative.
 */
export function estimateCostMinorUsd(
  model: string,
  usage: { inputTokens: number; outputTokens: number; cacheCreationInputTokens?: number; cacheReadInputTokens?: number },
): number {
  const pricing = MODEL_PRICING_CENTS_PER_MTOK[normaliseModelId(model)];
  if (!pricing) {
    getLogger().warn({ model }, 'no published pricing for model; inference cost reported as 0');
    return 0;
  }
  const perToken = (centsPerMTok: number, tokens: number): number => (centsPerMTok * tokens) / 1_000_000;

  const cents =
    perToken(pricing.input, usage.inputTokens) +
    perToken(pricing.input * 1.25, usage.cacheCreationInputTokens ?? 0) +
    perToken(pricing.input * 0.1, usage.cacheReadInputTokens ?? 0) +
    perToken(pricing.output, usage.outputTokens);

  return Math.ceil(cents);
}

/** Strips a date suffix if a caller passes one; pricing is keyed on the alias. */
function normaliseModelId(model: string): string {
  return model.replace(/-\d{8}$/, '');
}

export function addUsage(a: CompletionUsage, b: CompletionUsage): CompletionUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheCreationInputTokens: a.cacheCreationInputTokens + b.cacheCreationInputTokens,
    cacheReadInputTokens: a.cacheReadInputTokens + b.cacheReadInputTokens,
    costMinorUsd: a.costMinorUsd + b.costMinorUsd,
  };
}

/** Effort default per org tier: executives reason harder, specialists stay cheap. */
export function effortForTier(tier: ModelTier): Effort {
  switch (tier) {
    case 'executive':
      return 'xhigh';
    case 'manager':
      return 'high';
    case 'specialist':
      return 'medium';
    case 'fast':
      return 'low';
  }
}
