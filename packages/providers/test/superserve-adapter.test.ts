/**
 * Superserve is the persistent-VM execution plane. Pause must drop the cached
 * data-plane token (resume rotates it). Sandbox0 pause does not keep processes;
 * these tests pin the Superserve-side contract that does.
 */

import { describe, expect, it } from 'vitest';
import { CredentialsMissingError, SecretStore } from '@foundry/core';
import type { AdapterContext } from '../src/http/adapter.js';
import { SuperserveAdapter, superservePreviewUrl } from '../src/superserve/index.js';

function ctx(env: Record<string, string> = {}): AdapterContext {
  return {
    secrets: new SecretStore({ get: (name) => env[name] }),
    environment: 'production',
    publicBaseUrl: 'https://example.test',
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: body === null ? undefined : { 'content-type': 'application/json' },
  });
}

const KEY = 'ss_live_use_testkey0000000000000000000000';

describe('SuperserveAdapter credentials', () => {
  it('createSandbox names SUPERSERVE_API_KEY when the key is absent', async () => {
    const adapter = new SuperserveAdapter(ctx());
    await expect(adapter.createSandbox({ name: 'foundry' })).rejects.toSatisfy(
      (error: unknown) => error instanceof CredentialsMissingError && error.missing.includes('SUPERSERVE_API_KEY'),
    );
  });
});

describe('superservePreviewUrl', () => {
  it('builds the documented browser hostname for a published port', () => {
    expect(superservePreviewUrl('abc-123', 8080)).toBe('https://8080-abc-123.sandbox.superserve.ai');
  });
});

describe('SuperserveAdapter pause token rotation', () => {
  it('clears the cached access token on pause so a stale data-plane token cannot be reused', async () => {
    const adapter = new SuperserveAdapter(ctx({ SUPERSERVE_API_KEY: KEY }), {
      fetchImpl: async (input, init) => {
        const url = String(input);
        const method = (init?.method ?? 'GET').toUpperCase();
        if (method === 'POST' && url.endsWith('/sandboxes')) {
          return json({
            id: 'sbx_1',
            status: 'active',
            access_token: 'tok_create',
          });
        }
        if (method === 'POST' && url.endsWith('/sandboxes/sbx_1/pause')) {
          return new Response(null, { status: 204 });
        }
        if (method === 'GET' && url.endsWith('/sandboxes/sbx_1')) {
          return json({ id: 'sbx_1', status: 'paused' });
        }
        return json({ error: `unhandled ${method} ${url}` }, 500);
      },
    });

    const created = await adapter.createSandbox({ name: 'foundry-pause' });
    expect(created.id).toBe('sbx_1');
    expect(adapter.hasCachedAccessToken('sbx_1')).toBe(true);

    const paused = await adapter.pauseSandbox('sbx_1');
    expect(paused.status).toBe('paused');
    expect(adapter.hasCachedAccessToken('sbx_1')).toBe(false);
  });
});
