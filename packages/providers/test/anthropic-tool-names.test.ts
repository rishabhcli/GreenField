/**
 * Tool-name sanitization at the Anthropic boundary.
 *
 * Canonical tool names are dotted (`company.get_state`) and the Messages API
 * rejects anything outside `^[a-zA-Z0-9_-]{1,128}$`. These tests do not call
 * the API. They pin the mapping the adapter applies before a request goes
 * out: every sanitized name is API-safe, collisions and over-length names
 * stay distinct, and the sanitized → canonical map is bijective so
 * `toolUses` can report the names the rest of the system keys on.
 */

import { describe, expect, it } from 'vitest';
import { sanitizeToolNames, type ToolDefinition } from '@foundry/providers';

const API_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/;

function tool(name: string): ToolDefinition {
  return {
    name,
    description: `tool ${name}`,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  };
}

describe('sanitizeToolNames', () => {
  it('replaces dots with underscores and maps back to the canonical name', () => {
    const { tools, toCanonical } = sanitizeToolNames([tool('company.get_state')]);
    expect(tools).toHaveLength(1);
    expect(tools[0]?.name).toBe('company_get_state');
    expect(toCanonical.get('company_get_state')).toBe('company.get_state');
  });

  it('keeps an already-safe name unchanged with an identity map entry', () => {
    const { tools, toCanonical } = sanitizeToolNames([tool('record_result')]);
    expect(tools[0]?.name).toBe('record_result');
    expect(toCanonical.get('record_result')).toBe('record_result');
  });

  it('disambiguates canonical names that collide after sanitization', () => {
    const { tools, toCanonical } = sanitizeToolNames([tool('a.b'), tool('a_b')]);
    const names = tools.map((t) => t.name);
    expect(names[0]).toBe('a_b');
    expect(names[1]).toBe('a_b_2');
    expect(new Set(names).size).toBe(2);
    expect(toCanonical.get('a_b')).toBe('a.b');
    expect(toCanonical.get('a_b_2')).toBe('a_b');
  });

  it('truncates a 200-character name to at most 128 and still maps back', () => {
    const canonical = 'x.'.repeat(100);
    expect(canonical).toHaveLength(200);
    const { tools, toCanonical } = sanitizeToolNames([tool(canonical)]);
    const sanitized = tools[0]!.name;
    expect(sanitized.length).toBeLessThanOrEqual(128);
    expect(sanitized).toMatch(API_NAME_PATTERN);
    expect(toCanonical.get(sanitized)).toBe(canonical);
  });

  it('keeps long names that collide after truncation distinct and bijective', () => {
    const a = `ns.${'x'.repeat(140)}`;
    const b = `ns_${'x'.repeat(140)}`;
    const { tools, toCanonical } = sanitizeToolNames([tool(a), tool(b)]);
    const names = tools.map((t) => t.name);
    expect(new Set(names).size).toBe(2);
    for (const name of names) expect(name).toMatch(API_NAME_PATTERN);
    expect(toCanonical.get(names[0]!)).toBe(a);
    expect(toCanonical.get(names[1]!)).toBe(b);
  });

  it('produces only API-safe names for a catalog-shaped input, without touching schemas', () => {
    const catalog = [
      tool('company.get_state'),
      tool('org.dispatch_manager'),
      tool('research.collect'),
      tool('finance.report~beta'),
      tool('a'.repeat(200)),
    ];
    const { tools, toCanonical } = sanitizeToolNames(catalog);
    for (const t of tools) expect(t.name).toMatch(API_NAME_PATTERN);
    expect(new Set(tools.map((t) => t.name)).size).toBe(catalog.length);
    expect(toCanonical.size).toBe(catalog.length);
    expect(new Set(toCanonical.values()).size).toBe(catalog.length);
    expect(tools.map((t) => t.inputSchema)).toEqual(catalog.map((t) => t.inputSchema));
    expect(tools.map((t) => t.description)).toEqual(catalog.map((t) => t.description));
  });

  it('does not mutate the caller\'s tool definitions', () => {
    const input = [tool('company.get_state')];
    sanitizeToolNames(input);
    expect(input[0]?.name).toBe('company.get_state');
  });
});
