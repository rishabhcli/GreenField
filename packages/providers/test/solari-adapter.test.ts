/**
 * Solari adapter: missing credentials fail closed; exec sends live `{cmd,args}`;
 * GET /sessions/:id is a real GET; POST /desktops is blocked, not invented.
 */

import { describe, expect, it } from 'vitest';
import { CapabilityUnsupportedError, CredentialsMissingError, SecretStore, ValidationError } from '@foundry/core';
import type { AdapterContext } from '../src/http/adapter.js';
import { SolariAdapter, solariExecBody } from '../src/solari/index.js';

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

describe('SolariAdapter credentials', () => {
  it('probe names SOLARI_API_KEY when the key is absent', async () => {
    const adapter = new SolariAdapter(ctx());
    await expect(adapter.probe()).rejects.toSatisfy(
      (error: unknown) => error instanceof CredentialsMissingError && error.missing.includes('SOLARI_API_KEY'),
    );
  });
});

describe('solariExecBody', () => {
  it('sends cmd/args and never a command field', () => {
    const body = solariExecBody({ cmd: 'echo', args: ['foundry-solari-ok'], cwd: '/tmp', timeoutMs: 5_000 });
    expect(body).toEqual({ cmd: 'echo', args: ['foundry-solari-ok'], cwd: '/tmp', timeoutMs: 5_000 });
    expect(body).not.toHaveProperty('command');
  });

  it('maps a shell line to sh -c', () => {
    expect(solariExecBody({ command: 'echo foundry-solari-ok' })).toEqual({
      cmd: 'sh',
      args: ['-c', 'echo foundry-solari-ok'],
    });
  });

  it('rejects empty cmd and command', () => {
    expect(() => solariExecBody({})).toThrow(ValidationError);
    expect(() => solariExecBody({ command: '  ' })).toThrow(ValidationError);
  });
});

describe('SolariAdapter session status and exec', () => {
  it('GET /sessions/:id instead of throwing, and exec posts {cmd,args}', async () => {
    const captured: { method: string; url: string; body: unknown }[] = [];
    const adapter = new SolariAdapter(ctx({ SOLARI_API_KEY: KEY }), {
      fetchImpl: async (input, init) => {
        const url = String(input);
        const method = (init?.method ?? 'GET').toUpperCase();
        const body = typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body;
        captured.push({ method, url, body });
        if (method === 'GET' && url.includes('/sessions/sess_1') && !url.includes('replay')) {
          return json({
            id: 'sess_1',
            status: 'active',
            kind: 'browser',
            org: 'org_1',
            createdAt: '2026-08-15T00:00:00.000Z',
            expiresAt: '2026-08-15T02:00:00.000Z',
            wsEndpoint: 'wss://example.test/ws/sess_1',
            cdpEndpoint: 'wss://example.test/cdp/sess_1',
          });
        }
        if (method === 'POST' && url.includes('/sandboxes/sbx_1/exec')) {
          return json({ exitCode: 0, stdout: 'foundry-solari-ok\n', stderr: '' });
        }
        return json({ error: `unhandled ${method} ${url}` }, 500);
      },
    });

    const status = await adapter.getSessionStatus('sess_1');
    expect(status.status).toBe('active');
    expect(status.id).toBe('sess_1');
    expect(captured.some((c) => c.method === 'GET' && c.url.includes('/sessions/sess_1'))).toBe(true);

    const exec = await adapter.execInSandbox('sbx_1', { command: 'echo foundry-solari-ok' });
    expect(exec.exitCode).toBe(0);
    expect(exec.stdout).toContain('foundry-solari-ok');
    const execCall = captured.find((c) => c.method === 'POST' && String(c.url).includes('/exec'));
    expect(execCall?.body).toEqual({ cmd: 'sh', args: ['-c', 'echo foundry-solari-ok'] });
    expect(execCall?.body).not.toHaveProperty('command');
  });
});

describe('SolariAdapter desktop create', () => {
  it('throws CapabilityUnsupportedError without calling POST /desktops', async () => {
    let called = false;
    const adapter = new SolariAdapter(ctx({ SOLARI_API_KEY: KEY }), {
      fetchImpl: async () => {
        called = true;
        return json({ error: 'should not be called' }, 500);
      },
    });
    expect(() => adapter.createDesktop()).toThrow(CapabilityUnsupportedError);
    expect(called).toBe(false);
  });
});
