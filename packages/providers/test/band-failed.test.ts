/**
 * BAND markMessageFailed must match POST .../messages/{id}/failed: `{ error }`.
 * Live 422 for `{ reason }` was Unexpected field: reason (details `/reason`).
 */

import { describe, expect, it } from 'vitest';
import { SecretStore, ValidationError } from '@foundry/core';
import { BandAdapter } from '../src/band/index.js';
import { bandMarkFailedBody } from '../src/band/schemas.js';

function previewAdapter(): BandAdapter {
  return new BandAdapter({
    secrets: new SecretStore({
      get: (name) => (name === 'BAND_AGENT_API_KEY' ? 'band_a_testkey' : undefined),
    }),
    environment: 'preview',
    publicBaseUrl: 'https://example.test',
  });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('BAND markMessageFailed request shape', () => {
  it('maps the executor reason onto the live `error` field, not `reason`', () => {
    expect(bandMarkFailedBody('Anthropic overloaded')).toEqual({ error: 'Anthropic overloaded' });
  });

  it('posts { error } and unwraps the status envelope', async () => {
    let posted: unknown;
    const original = globalThis.fetch;
    globalThis.fetch = async (_input, init) => {
      posted = JSON.parse(String(init?.body));
      return json({
        data: {
          id: '7776ee7c-89a3-4f90-9f2b-0bbbf47c9067',
          status: 'failed',
          success: true,
          attempt_number: 1,
        },
      });
    };
    try {
      const message = await previewAdapter().markMessageFailed(
        'a70129cc-0663-4090-86b5-c5a98025532e',
        '7776ee7c-89a3-4f90-9f2b-0bbbf47c9067',
        'Anthropic inference failed',
      );
      expect(posted).toEqual({ error: 'Anthropic inference failed' });
      expect(message.id).toBe('7776ee7c-89a3-4f90-9f2b-0bbbf47c9067');
      expect(message.status).toBe('failed');
    } finally {
      globalThis.fetch = original;
    }
  });

  it('refuses a blank error before any HTTP call', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = async () => {
      throw new Error('markMessageFailed must not call BAND without error');
    };
    try {
      await expect(
        previewAdapter().markMessageFailed(
          'a70129cc-0663-4090-86b5-c5a98025532e',
          '7776ee7c-89a3-4f90-9f2b-0bbbf47c9067',
          '   ',
        ),
      ).rejects.toSatisfy(
        (error: unknown) => error instanceof ValidationError && /error/i.test(error.message),
      );
    } finally {
      globalThis.fetch = original;
    }
  });
});
