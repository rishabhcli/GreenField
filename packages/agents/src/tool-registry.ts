/**
 * Agent tool registry.
 *
 * A tool is the only way an agent affects the world. Each one declares the
 * authority it exercises, the capability it needs and whether it costs money,
 * so the policy gate can be applied uniformly rather than each tool
 * remembering to check. A tool that omits its authority cannot be registered.
 */

import { z } from 'zod';
import { ValidationError, type Authority, type BudgetScope, type Capability } from './deps.js';
import { getLogger } from '@foundry/obs';
import type { GateRequest, PolicyGate } from './policy-gate.js';

export interface ToolContext {
  readonly companyId: string;
  readonly runId: string;
  readonly roleKey: string;
  /** Actor handle used for policy decisions and audit attribution. */
  readonly actorHandle: string;
  readonly traceId: string;
  readonly signal: AbortSignal;
}

export interface ToolSpend {
  readonly amountMinor: number;
  readonly currency: string;
  readonly budgetScope: BudgetScope;
}

export interface AgentTool<TInput = unknown, TOutput = unknown> {
  readonly name: string;
  /**
   * Written for the model. States what the tool does AND when to call it —
   * a prescriptive trigger condition measurably improves call rate on current
   * models over a description that only says what it does.
   */
  readonly description: string;
  readonly inputSchema: z.ZodType<TInput>;
  /** JSON Schema handed to the API. Must set `additionalProperties: false`. */
  readonly jsonSchema: Record<string, unknown>;
  /** Authority exercised. Required — there is no unguarded tool. */
  readonly authority: Authority;
  /** Provider capability needed, if any. Checked before the tool runs. */
  readonly capability?: Capability;
  /** True when the tool contacts a third party, spends, or writes publicly. */
  readonly consequential: boolean;
  /** Computes the spend for this specific call, when the tool costs money. */
  readonly estimateSpend?: (input: TInput) => ToolSpend | null;
  /** Short label for the audit log and the approval request. */
  readonly describeAction: (input: TInput) => string;
  /** Resource this call is about, for the audit trail. */
  readonly subjectRef?: (input: TInput) => string | null;
  execute(input: TInput, ctx: ToolContext): Promise<TOutput>;
}

export type ToolResult =
  | { readonly ok: true; readonly output: unknown }
  | { readonly ok: false; readonly reason: string; readonly kind: 'denied' | 'needs_approval' | 'invalid_input' | 'failed' };

export class ToolRegistry {
  readonly #tools = new Map<string, AgentTool<never, unknown>>();

  register<TInput, TOutput>(tool: AgentTool<TInput, TOutput>): void {
    if (this.#tools.has(tool.name)) {
      throw new ValidationError(`Tool "${tool.name}" is already registered`);
    }
    if (!tool.authority) {
      throw new ValidationError(`Tool "${tool.name}" must declare an authority`);
    }
    const schema = tool.jsonSchema as { additionalProperties?: unknown; type?: unknown };
    if (schema.type !== 'object' || schema.additionalProperties !== false) {
      throw new ValidationError(
        `Tool "${tool.name}" must have an object jsonSchema with additionalProperties: false so strict tool use can validate it`,
      );
    }
    this.#tools.set(tool.name, tool as unknown as AgentTool<never, unknown>);
  }

  registerAll(tools: readonly AgentTool<never, unknown>[]): void {
    for (const tool of tools) this.register(tool);
  }

  get(name: string): AgentTool<never, unknown> | undefined {
    return this.#tools.get(name);
  }

  names(): readonly string[] {
    return [...this.#tools.keys()].sort();
  }

  /** The subset of tools a role is permitted to call, as declared in the org chart. */
  forRole(toolNames: readonly string[]): readonly AgentTool<never, unknown>[] {
    return toolNames
      .map((name) => this.#tools.get(name))
      .filter((tool): tool is AgentTool<never, unknown> => tool !== undefined);
  }

  /** Tool names a role references that do not exist. A configuration bug. */
  missingForRole(toolNames: readonly string[]): readonly string[] {
    return toolNames.filter((name) => !this.#tools.has(name));
  }
}

/**
 * Executes one tool call end to end: validate input, run the policy gate, run
 * the tool, settle the budget.
 *
 * Every failure path returns a `ToolResult` rather than throwing, because the
 * model needs to read the reason and adapt. The one exception is an abort,
 * which propagates so the run terminates.
 */
export async function executeToolCall(
  registry: ToolRegistry,
  gate: PolicyGate,
  call: { name: string; input: unknown },
  ctx: ToolContext,
): Promise<ToolResult> {
  const log = getLogger();
  const tool = registry.get(call.name);
  if (!tool) {
    return {
      ok: false,
      kind: 'invalid_input',
      reason: `No tool named "${call.name}" exists. Available tools: ${registry.names().join(', ')}`,
    };
  }

  const parsed = tool.inputSchema.safeParse(call.input);
  if (!parsed.success) {
    return {
      ok: false,
      kind: 'invalid_input',
      reason: `Input for "${call.name}" is invalid: ${parsed.error.message}. Correct it and call the tool again.`,
    };
  }
  const input = parsed.data as never;

  const spend = tool.estimateSpend?.(input) ?? null;
  const gateRequest: GateRequest = {
    companyId: ctx.companyId,
    actorHandle: ctx.actorHandle,
    authority: tool.authority,
    action: tool.describeAction(input),
    subjectRefId: tool.subjectRef?.(input) ?? null,
    ...(spend ? { amountMinor: spend.amountMinor, currency: spend.currency, budgetScope: spend.budgetScope } : {}),
    ...(tool.capability ? { capability: tool.capability } : {}),
  };

  const decision = await gate.evaluate(gateRequest);

  if (decision.outcome === 'deny') {
    log.info({ tool: call.name, runId: ctx.runId }, 'tool call denied by policy');
    return { ok: false, kind: 'denied', reason: decision.explanation };
  }
  if (decision.outcome === 'require_approval') {
    log.info({ tool: call.name, approvalId: decision.approvalId }, 'tool call awaiting approval');
    return { ok: false, kind: 'needs_approval', reason: decision.explanation };
  }

  try {
    const output = await tool.execute(input, ctx);
    await decision.settle(spend?.amountMinor ?? 0);
    return { ok: true, output };
  } catch (error) {
    // Release the reservation: the action did not happen, so the money must go
    // back rather than silently consuming the day's budget.
    await decision.release();
    if (ctx.signal.aborted) throw error;

    const message = error instanceof Error ? error.message : String(error);
    log.warn({ tool: call.name, runId: ctx.runId, err: error }, 'tool call failed');
    return {
      ok: false,
      kind: 'failed',
      reason: `"${call.name}" failed: ${message}. Do not report this step as done — either retry with different input, or continue without it and say what is missing.`,
    };
  }
}

/**
 * Helper for defining a tool from a zod schema, generating the JSON Schema the
 * API needs. Keeps the two representations from drifting apart.
 */
export function defineTool<TInput, TOutput>(
  spec: Omit<AgentTool<TInput, TOutput>, 'jsonSchema'> & { jsonSchema?: Record<string, unknown> },
): AgentTool<TInput, TOutput> {
  const jsonSchema = spec.jsonSchema ?? toJsonSchema(spec.inputSchema);
  return { ...spec, jsonSchema } as AgentTool<TInput, TOutput>;
}

/**
 * Converts a zod schema to the JSON Schema shape strict tool use requires.
 *
 * `additionalProperties: false` and a complete `required` array are mandatory
 * for strict mode, and zod's own output omits them, so they are forced here.
 */
export function toJsonSchema(schema: z.ZodType<unknown>): Record<string, unknown> {
  const generated = z.toJSONSchema(schema, { target: 'draft-2020-12', io: 'input' }) as Record<string, unknown>;
  return enforceStrict(generated);
}

function enforceStrict(node: Record<string, unknown>): Record<string, unknown> {
  if (node['type'] === 'object') {
    node['additionalProperties'] = false;
    const properties = node['properties'] as Record<string, unknown> | undefined;
    if (properties) {
      // Strict mode requires every property listed as required; optionality is
      // expressed by allowing null rather than by omission.
      node['required'] = Object.keys(properties);
      for (const value of Object.values(properties)) {
        if (value && typeof value === 'object') enforceStrict(value as Record<string, unknown>);
      }
    }
  }
  if (node['type'] === 'array' && node['items'] && typeof node['items'] === 'object') {
    enforceStrict(node['items'] as Record<string, unknown>);
  }
  for (const key of ['anyOf', 'oneOf', 'allOf'] as const) {
    const branch = node[key];
    if (Array.isArray(branch)) {
      for (const item of branch) {
        if (item && typeof item === 'object') enforceStrict(item as Record<string, unknown>);
      }
    }
  }
  return node;
}
