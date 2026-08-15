/**
 * Session recording/replay is a real GET. A missing URL is blocked, not
 * fabricated. GET /health is a probe, not prize-method completion.
 */

import { describe, expect, it } from 'vitest';
import { CredentialsMissingError, ProviderContractError, SecretStore } from '@foundry/core';
import type { AdapterContext } from '../src/http/adapter.js';
import { SolariAdapter } from '../src/solari/index.js';

function ctx(env: Record<string, string> = {}): AdapterContext {
  return {
    secrets: new SecretStore({ get: (name) => env[name] }),
    environment: 'preview',
    publicBaseUrl: 'https://example.test',
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: body === null ? undefined : { 'content-type': 'application/json' },
  });
}

const KEY = 'slr_test_abcdefghijklmnopqrstuvwxyz';

describe('Solari session replay', () => {
  it('getReplayUrl throws when the API returns no URL field', async () => {
    const adapter = new SolariAdapter(ctx({ SOLARI_API_KEY: KEY }), {
      fetchImpl: async (input) => {
        const url = String(input);
        if (url.includes('/replay-url')) return json({ ok: true });
        return json({ error: `unhandled ${url}` }, 500);
      },
    });
    await expect(adapter.getReplayUrl('sess_1')).rejects.toBeInstanceOf(ProviderContractError);
  });

  it('getReplayUrl returns the documented field when present', async () => {
    const adapter = new SolariAdapter(ctx({ SOLARI_API_KEY: KEY }), {
      fetchImpl: async (input) => {
        const url = String(input);
        if (url.includes('/replay-url')) return json({ replayUrl: 'https://replay.example/sess_1' });
        return json({ error: `unhandled ${url}` }, 500);
      },
    });
    await expect(adapter.getReplayUrl('sess_1')).resolves.toBe('https://replay.example/sess_1');
  });

  it('probe success is GET /health + GET /sandboxes, not a prize-method claim', async () => {
    const adapter = new SolariAdapter(ctx({ SOLARI_API_KEY: KEY }), {
      fetchImpl: async (input) => {
        const url = String(input);
        if (url.includes('/health')) return json({ ok: true });
        if (url.includes('/sandboxes')) return json({ sandboxes: [] });
        return json({ error: `unhandled ${url}` }, 500);
      },
    });
    const result = await adapter.probe();
    expect(result.succeeded).toBe(true);
    expect(result.detail).toMatch(/GET \/health/);
    expect(result.detail).toMatch(/GET \/sandboxes/);
    expect(result.detail).not.toMatch(/live_verified|prize/);
  });

  it('missing key is blocked, not a fabricated replay', async () => {
    const adapter = new SolariAdapter(ctx());
    await expect(adapter.getReplayUrl('sess_1')).rejects.toBeInstanceOf(CredentialsMissingError);
  });
});
