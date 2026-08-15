/**
 * Prompt-cache breakpoint placement for the Anthropic Messages API.
 *
 * The executor re-sends the same tool catalog and a growing conversation on
 * every one of up to 20 iterations. Without breakpoints those tokens are paid
 * at full input price each turn. The cost model already prices cache writes at
 * 1.25× and cache reads at 0.1×; this module is what makes those multipliers
 * actually fire.
 *
 * Constraints, from the Messages API (verified 2026-08-15):
 *
 *  - At most four `cache_control` breakpoints per request.
 *  - Writes happen only at an explicit breakpoint. Reads look backward up to
 *    20 blocks from each breakpoint for a prefix a prior request already wrote.
 *  - A growing tool loop will push a single trailing breakpoint more than 20
 *    blocks past the previous write, so a second history breakpoint has to sit
 *    on the first message — otherwise mid-run history falls out of the window
 *    and is re-paid in full.
 *  - 5-minute TTL is the default write (1.25×). A 20-iteration loop with
 *    multi-second provider calls still fits; a 1-hour write costs 2× and is
 *    not worth it for a prefix that dies with the run.
 *  - Prefixes below the model's minimum (1024 tokens on most, 2048 on Haiku)
 *    are silently ignored. Attaching a breakpoint to a small request is a
 *    no-op, not an error, so we still attach one.
 */

import type Anthropic from '@anthropic-ai/sdk';

export type CacheTtl = '5m' | '1h';

export interface CacheableTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly strict?: boolean;
}

export interface CacheableMessage {
  readonly role: string;
  readonly content: unknown;
}

/** Hard API limit. Exceeding it is a 400, not a silent drop. */
export const MAX_CACHE_BREAKPOINTS = 4;

/** 5-minute TTL: 1.25× write, fits a single agent run. */
export const CACHE_TTL: CacheTtl = '5m';

export const EPHEMERAL_CACHE = { type: 'ephemeral' as const, ttl: CACHE_TTL };

export interface PromptCacheInput {
  readonly system?: string;
  readonly cacheSystemPrompt?: boolean;
  readonly tools?: readonly CacheableTool[];
  readonly messages: readonly CacheableMessage[];
}

export interface PromptCacheResult {
  readonly system: Anthropic.MessageCreateParamsNonStreaming['system'];
  readonly tools: Anthropic.MessageCreateParamsNonStreaming['tools'];
  readonly messages: Anthropic.MessageParam[];
  readonly breakpointCount: number;
}

export function applyPromptCache(input: PromptCacheInput): PromptCacheResult {
  let breakpointCount = 0;

  let system: PromptCacheResult['system'];
  if (input.system) {
    if (input.cacheSystemPrompt !== false) {
      system = [{ type: 'text', text: input.system, cache_control: EPHEMERAL_CACHE }];
      breakpointCount += 1;
    } else {
      system = input.system;
    }
  }

  let tools: PromptCacheResult['tools'];
  if (input.tools && input.tools.length > 0) {
    tools = input.tools.map((t, index, all) => {
      const last = index === all.length - 1;
      if (last) breakpointCount += 1;
      return {
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
        ...(t.strict ? { strict: true } : {}),
        ...(last ? { cache_control: EPHEMERAL_CACHE } : {}),
      };
    });
  }

  const messages = input.messages.map((m) => cloneMessage(m));
  if (messages.length === 1) {
    messages[0] = withBreakpoint(messages[0]!);
    breakpointCount += 1;
  } else if (messages.length > 1) {
    // First message is the stable conversation start; last is the rolling
    // write. Two history breakpoints keep a 20-iteration tool loop inside
    // the 20-block lookback window.
    messages[0] = withBreakpoint(messages[0]!);
    messages[messages.length - 1] = withBreakpoint(messages[messages.length - 1]!);
    breakpointCount += 2;
  }

  if (breakpointCount > MAX_CACHE_BREAKPOINTS) {
    throw new Error(
      `Prompt cache placement produced ${breakpointCount} breakpoints; the API allows ${MAX_CACHE_BREAKPOINTS}.`,
    );
  }

  return { system, tools, messages, breakpointCount };
}

function cloneMessage(message: CacheableMessage): Anthropic.MessageParam {
  if (typeof message.content === 'string') {
    return { role: message.role, content: message.content } as Anthropic.MessageParam;
  }
  if (Array.isArray(message.content)) {
    return {
      role: message.role,
      content: message.content.map((block) => ({ ...block })),
    } as Anthropic.MessageParam;
  }
  return { ...message } as Anthropic.MessageParam;
}

function withBreakpoint(message: Anthropic.MessageParam): Anthropic.MessageParam {
  const content = message.content;
  if (typeof content === 'string') {
    return {
      ...message,
      content: [{ type: 'text', text: content, cache_control: EPHEMERAL_CACHE }],
    } as Anthropic.MessageParam;
  }
  if (!Array.isArray(content) || content.length === 0) return message;
  const blocks = content.map((block) => ({ ...block }));
  const last = blocks[blocks.length - 1] as Record<string, unknown>;
  blocks[blocks.length - 1] = { ...last, cache_control: EPHEMERAL_CACHE } as (typeof blocks)[number];
  return { ...message, content: blocks } as Anthropic.MessageParam;
}

/** Count `cache_control` markers on a built request, for tests. */
export function countCacheBreakpoints(result: PromptCacheResult): number {
  let count = 0;
  if (Array.isArray(result.system)) {
    for (const block of result.system) {
      if (block && typeof block === 'object' && 'cache_control' in block && block.cache_control) count += 1;
    }
  }
  if (result.tools) {
    for (const tool of result.tools) {
      if ('cache_control' in tool && tool.cache_control) count += 1;
    }
  }
  for (const message of result.messages) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block && typeof block === 'object' && 'cache_control' in block && block.cache_control) count += 1;
    }
  }
  return count;
}
