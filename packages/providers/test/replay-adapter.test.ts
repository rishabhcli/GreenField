/**
 * Replay adapter: missing credentials fail closed, and create-project is the
 * documented "start QA" call — we poll project timing rather than kicking off
 * a second exploration.
 */

import { describe, expect, it } from 'vitest';
import { CredentialsMissingError, SecretStore, TimeoutError } from '@foundry/core';
import type { AdapterContext } from '../src/http/adapter.js';
import { ReplayAdapter } from '../src/replay/index.js';

function ctx(env: Record<string, string> = {}): AdapterContext {
  return {
    secrets: new SecretStore({ get: (name) => env[name] }),
    environment: 'preview',
    publicBaseUrl: 'https://example.test',
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function router(handlers: Array<{ match: (url: string, method: string) => boolean; response: () => Response }>): typeof fetch {
  return async (input, init) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    const hit = handlers.find((h) => h.match(url, method));
    if (!hit) return json({ error: `unhandled ${method} ${url}` }, 500);
    return hit.response();
  };
}

const KEY = 'lqa_testkey00000000000000000000000000000000';

describe('ReplayAdapter credentials', () => {
  it('createProject names REPLAY_API_KEY when the token is absent', async () => {
    const adapter = new ReplayAdapter(ctx());
    await expect(
      adapter.createProject({ name: 'Storefront', targetUrl: 'https://shop.example.test' }),
    ).rejects.toSatisfy(
      (error: unknown) => error instanceof CredentialsMissingError && error.missing.includes('REPLAY_API_KEY'),
    );
  });
});

describe('ReplayAdapter waitForProjectIdle', () => {
  it('returns when GET /projects/{id}/timing has finished_at', async () => {
    const adapter = new ReplayAdapter(ctx({ REPLAY_API_KEY: KEY }), {
      fetchImpl: router([
        {
          match: (url) => url.includes('openapi.json'),
          response: () => json({ servers: [{ url: 'https://loop-qa.replay.io/api/v1' }] }),
        },
        {
          match: (url, method) => method === 'GET' && url.includes('/projects/proj_1/timing'),
          response: () =>
            json({
              created_at: '2026-08-15T11:00:00.000Z',
              started_at: '2026-08-15T11:01:00.000Z',
              finished_at: '2026-08-15T11:10:00.000Z',
            }),
        },
      ]),
    });

    const timing = await adapter.waitForProjectIdle('proj_1', { timeoutMs: 5_000, pollIntervalMs: 10 });
    expect(timing.finished_at).toBe('2026-08-15T11:10:00.000Z');
  });

  it('times out rather than inventing a completed run when finished_at stays null', async () => {
    const adapter = new ReplayAdapter(ctx({ REPLAY_API_KEY: KEY }), {
      fetchImpl: router([
        {
          match: (url) => url.includes('openapi.json'),
          response: () => json({ servers: [{ url: 'https://loop-qa.replay.io/api/v1' }] }),
        },
        {
          match: (url, method) => method === 'GET' && url.includes('/timing'),
          response: () => json({ started_at: '2026-08-15T11:01:00.000Z', finished_at: null }),
        },
      ]),
    });

    await expect(adapter.waitForProjectIdle('proj_1', { timeoutMs: 20, pollIntervalMs: 5 })).rejects.toBeInstanceOf(
      TimeoutError,
    );
  });
});

describe('ReplayAdapter ensureProjectForTarget', () => {
  it('reattaches to an existing project with the same target_url instead of creating a second one', async () => {
    const posts: string[] = [];
    const adapter = new ReplayAdapter(ctx({ REPLAY_API_KEY: KEY }), {
      fetchImpl: router([
        {
          match: (url) => url.includes('openapi.json'),
          response: () => json({ servers: [{ url: 'https://loop-qa.replay.io/api/v1' }] }),
        },
        {
          match: (url, method) => method === 'GET' && /\/projects(\?|$)/.test(url),
          response: () =>
            json({
              items: [
                {
                  id: 'proj_existing',
                  name: 'qa:site_1',
                  target_url: 'https://shop.example.test/',
                },
              ],
            }),
        },
        {
          match: (url, method) => method === 'POST' && url.includes('/projects'),
          response: () => {
            posts.push('create');
            return json({ id: 'proj_new', name: 'dup', target_url: 'https://shop.example.test' }, 201);
          },
        },
      ]),
    });

    const project = await adapter.ensureProjectForTarget({
      name: 'qa:site_1',
      targetUrl: 'https://shop.example.test',
    });
    expect(project.id).toBe('proj_existing');
    expect(posts).toEqual([]);
  });
});
