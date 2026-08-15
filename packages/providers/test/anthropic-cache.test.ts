/**
 * Prompt-cache breakpoint placement.
 *
 * These tests do not call the API. They pin the request shape the adapter
 * will send: where the breakpoints sit, that they stay within the limit, and
 * that `cacheSystemPrompt: false` still disables the system breakpoint.
 */

import { describe, expect, it } from 'vitest';
import {
  MAX_CACHE_BREAKPOINTS,
  applyPromptCache,
  countCacheBreakpoints,
  type ToolDefinition,
} from '@foundry/providers';

const tools: readonly ToolDefinition[] = [
  { name: 'alpha', description: 'first', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'omega', description: 'last', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, strict: true },
];

describe('applyPromptCache', () => {
  it('puts exactly one breakpoint on the last tool definition', () => {
    const result = applyPromptCache({
      system: 'role prompt',
      tools,
      messages: [{ role: 'user', content: 'go' }],
    });
    expect(result.tools).toHaveLength(2);
    expect(result.tools?.[0]).not.toHaveProperty('cache_control');
    expect(result.tools?.[1]).toMatchObject({
      name: 'omega',
      strict: true,
      cache_control: { type: 'ephemeral', ttl: '5m' },
    });
  });

  it('keeps the tools breakpoint on the same last tool across simulated loop iterations', () => {
    const turn1 = applyPromptCache({
      system: 'role prompt',
      tools,
      messages: [{ role: 'user', content: 'start' }],
    });
    const turn2 = applyPromptCache({
      system: 'role prompt',
      tools,
      messages: [
        { role: 'user', content: 'start' },
        { role: 'assistant', content: 'working' },
        { role: 'user', content: 'continue' },
      ],
    });
    expect(turn1.tools?.[1]).toMatchObject({ name: 'omega', cache_control: { type: 'ephemeral' } });
    expect(turn2.tools?.[1]).toMatchObject({ name: 'omega', cache_control: { type: 'ephemeral' } });
    expect(JSON.stringify(turn1.tools)).toBe(JSON.stringify(turn2.tools));
  });

  it('puts a rolling breakpoint on the last message and a stable one on the first when history grows', () => {
    const result = applyPromptCache({
      system: 'role prompt',
      tools,
      messages: [
        { role: 'user', content: 'start' },
        { role: 'assistant', content: 'mid' },
        { role: 'user', content: 'latest' },
      ],
    });
    const first = result.messages[0]?.content;
    const last = result.messages[result.messages.length - 1]?.content;
    expect(Array.isArray(first) && first[0]).toMatchObject({ cache_control: { type: 'ephemeral' } });
    expect(Array.isArray(last) && last[0]).toMatchObject({ cache_control: { type: 'ephemeral' } });
    expect(result.messages[1]?.content).toBe('mid');
  });

  it('does not cache the system prompt when cacheSystemPrompt is false', () => {
    const result = applyPromptCache({
      system: 'role prompt',
      cacheSystemPrompt: false,
      tools,
      messages: [{ role: 'user', content: 'go' }],
    });
    expect(result.system).toBe('role prompt');
  });

  it('never exceeds the API breakpoint limit', () => {
    const result = applyPromptCache({
      system: 'role prompt',
      tools,
      messages: [
        { role: 'user', content: 'a' },
        { role: 'assistant', content: 'b' },
        { role: 'user', content: 'c' },
        { role: 'assistant', content: 'd' },
        { role: 'user', content: 'e' },
      ],
    });
    expect(result.breakpointCount).toBeLessThanOrEqual(MAX_CACHE_BREAKPOINTS);
    expect(countCacheBreakpoints(result)).toBe(result.breakpointCount);
    expect(countCacheBreakpoints(result)).toBeLessThanOrEqual(MAX_CACHE_BREAKPOINTS);
  });

  it('does not mutate the caller\'s messages array', () => {
    const messages = [{ role: 'user' as const, content: 'go' }];
    applyPromptCache({ system: 's', tools, messages });
    expect(messages[0]?.content).toBe('go');
  });
});
