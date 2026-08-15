/**
 * Tool input-schema sanitization at the Anthropic boundary.
 *
 * The strict custom-tool validator rejects JSON Schema constraint keywords
 * (`exclusiveMinimum`, `maxItems`, `minLength`, `pattern`, `format`, …) with a
 * 400. Zod's `toJSONSchema` and the hand-written catalog schemas both emit
 * them. These tests do not call the API. They pin what the adapter strips
 * before a request goes out: unsupported keywords are removed at every depth,
 * the constraint text moves into the node's `description` so the model still
 * sees the limit, structural keywords survive untouched, and the caller's
 * schema is never mutated.
 */

import { describe, expect, it } from 'vitest';
import { sanitizeToolSchema } from '@foundry/providers';

describe('sanitizeToolSchema', () => {
  it('removes integer bounds and appends the constraint note to the description', () => {
    const out = sanitizeToolSchema({
      type: 'object',
      additionalProperties: false,
      required: ['count'],
      properties: {
        count: { type: 'integer', exclusiveMinimum: 0, maximum: 100 },
      },
    });
    const count = (out.properties as Record<string, Record<string, unknown>>).count!;
    expect(count).not.toHaveProperty('exclusiveMinimum');
    expect(count).not.toHaveProperty('maximum');
    expect(count.type).toBe('integer');
    expect(count.description).toBe('Constraints: exclusiveMinimum 0; maximum 100.');
  });

  it('sanitizes every depth: array maxItems and item-level minLength, notes at the right nodes', () => {
    const out = sanitizeToolSchema({
      type: 'object',
      additionalProperties: false,
      required: ['queries'],
      properties: {
        queries: {
          type: 'array',
          maxItems: 8,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['text'],
            properties: {
              text: { type: 'string', minLength: 1, description: 'Search text.' },
            },
          },
        },
      },
    });
    const queries = (out.properties as Record<string, Record<string, unknown>>).queries!;
    expect(queries).not.toHaveProperty('maxItems');
    expect(queries.description).toBe('Constraints: maxItems 8.');

    const items = queries.items as Record<string, unknown>;
    const text = (items.properties as Record<string, Record<string, unknown>>).text!;
    expect(text).not.toHaveProperty('minLength');
    expect(text.description).toBe('Search text. Constraints: minLength 1.');
  });

  it('keeps enum, const, required, additionalProperties and type untouched', () => {
    const out = sanitizeToolSchema({
      type: 'object',
      additionalProperties: false,
      required: ['mode', 'version'],
      properties: {
        mode: { type: 'string', enum: ['fast', 'thorough'] },
        version: { const: 2 },
      },
    });
    expect(out.type).toBe('object');
    expect(out.additionalProperties).toBe(false);
    expect(out.required).toEqual(['mode', 'version']);
    const props = out.properties as Record<string, Record<string, unknown>>;
    expect(props.mode).toEqual({ type: 'string', enum: ['fast', 'thorough'] });
    expect(props.version).toEqual({ const: 2 });
  });

  it('never mutates the caller\'s schema', () => {
    const original = {
      type: 'object',
      additionalProperties: false,
      required: ['items'],
      properties: {
        items: {
          type: 'array',
          maxItems: 5,
          uniqueItems: true,
          items: { type: 'string', pattern: '^[a-z]+$', format: 'hostname' },
        },
      },
    };
    const snapshot = structuredClone(original);
    sanitizeToolSchema(original);
    expect(original).toEqual(snapshot);
  });

  it('sanitizes anyOf branches and $defs values', () => {
    const out = sanitizeToolSchema({
      type: 'object',
      additionalProperties: false,
      required: ['value'],
      properties: {
        value: {
          anyOf: [
            { type: 'integer', exclusiveMinimum: 0 },
            { type: 'string', pattern: '^[a-z]+$', format: 'hostname' },
          ],
        },
      },
      $defs: {
        money: { type: 'integer', minimum: 0, description: 'Minor units.' },
      },
    });
    const branches = (out.properties as Record<string, Record<string, unknown>>).value!
      .anyOf as Record<string, unknown>[];
    expect(branches[0]).toEqual({ type: 'integer', description: 'Constraints: exclusiveMinimum 0.' });
    expect(branches[1]).toEqual({
      type: 'string',
      description: 'Constraints: pattern ^[a-z]+$; format hostname.',
    });
    const money = (out.$defs as Record<string, Record<string, unknown>>).money!;
    expect(money).not.toHaveProperty('minimum');
    expect(money.description).toBe('Minor units. Constraints: minimum 0.');
  });
});
