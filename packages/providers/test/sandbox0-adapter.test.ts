/**
 * Sandbox0 adapter tests.
 *
 * These prove the honest failure path and the two pure helpers the rest of
 * the system will depend on. They do not fake a successful live claim — a
 * green `claimOrCreateSandbox` here without `SANDBOX0_TOKEN` would be a lie.
 */

import { describe, expect, it } from 'vitest';
import { CredentialsMissingError, SecretStore } from '@foundry/core';
import type { AdapterContext } from '../src/http/adapter.js';
import {
  Sandbox0Adapter,
  SANDBOX0_CLAIM_METADATA_PERSISTED,
  SANDBOX0_PAUSE_PRESERVES_PROCESSES,
  buildFailClosedNetworkPolicy,
  sandboxContextExecPath,
  sandboxContextsPath,
  sandboxFilesListPath,
  sandboxFilesPath,
  sandboxNetworkPath,
  sandboxPreviewsPath,
} from '../src/sandbox0/index.js';

function emptyContext(): AdapterContext {
  return {
    secrets: new SecretStore({ get: () => undefined }),
    environment: 'preview',
    publicBaseUrl: 'https://example.test',
  };
}

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

describe('Sandbox0Adapter credentials', () => {
  it('throws CredentialsMissingError naming SANDBOX0_TOKEN when the token is absent', async () => {
    const adapter = new Sandbox0Adapter(emptyContext());

    await expect(adapter.probe()).rejects.toBeInstanceOf(CredentialsMissingError);
    await expect(adapter.probe()).rejects.toThrow(/SANDBOX0_TOKEN/);

    await expect(
      adapter.claimOrCreateSandbox({
        template: 'default',
        metadata: { agent_run_id: 'run_test_1' },
      }),
    ).rejects.toBeInstanceOf(CredentialsMissingError);
  });
});

describe('buildFailClosedNetworkPolicy', () => {
  it('produces fail-closed credentialRules JSON', () => {
    const policy = buildFailClosedNetworkPolicy({
      trafficRules: [{ name: 'allow-api', action: 'allow', domains: ['api.example.com'] }],
      credentialRules: [
        {
          name: 'api-token',
          credentialRef: 'api-token',
          protocol: 'https',
          domains: ['api.example.com'],
          failurePolicy: 'fail-open',
        },
      ],
      credentialBindings: [
        {
          ref: 'api-token',
          sourceRef: 'api-source',
          projection: { type: 'placeholder_substitution' },
        },
      ],
    });

    const json = JSON.stringify(policy);
    expect(json).toContain('"failurePolicy":"fail-closed"');
    expect(json).not.toContain('fail-open');
    expect(policy.mode).toBe('block-all');
    const rules = (policy.egress as { credentialRules: readonly { failurePolicy: string; credentialRef: string }[] })
      .credentialRules;
    expect(rules).toHaveLength(1);
    expect(rules[0]?.failurePolicy).toBe('fail-closed');
    expect(rules[0]?.credentialRef).toBe('api-token');
  });
});

describe('Sandbox0 path helpers', () => {
  it('are functions so a first-live-probe correction is a one-line reassignment', () => {
    expect(typeof sandboxContextsPath).toBe('function');
    expect(typeof sandboxContextExecPath).toBe('function');
    expect(typeof sandboxFilesPath).toBe('function');
    expect(typeof sandboxFilesListPath).toBe('function');
    expect(typeof sandboxNetworkPath).toBe('function');
    expect(typeof sandboxPreviewsPath).toBe('function');

    expect(sandboxContextsPath('sb_1')).toContain('sb_1');
    expect(sandboxContextExecPath('sb_1', 'ctx_1')).toContain('ctx_1');
    expect(sandboxFilesPath('sb_1')).toMatch(/files/);
    expect(sandboxFilesListPath('sb_1')).toMatch(/files\/list/);
    expect(sandboxNetworkPath('sb_1')).toMatch(/network/);
    expect(sandboxPreviewsPath('sb_1')).toMatch(/previews/);
  });
});

describe('Sandbox0Adapter pause/resume', () => {
  it('does not claim process-preserving pause (unlike Superserve)', () => {
    expect(SANDBOX0_PAUSE_PRESERVES_PROCESSES).toBe(false);
    expect(SANDBOX0_CLAIM_METADATA_PERSISTED).toBe(false);
  });

  it('POSTs /api/v1/sandboxes/:id/pause and returns paused:false without rewriting it', async () => {
    const captured: { method: string; url: string }[] = [];
    const adapter = new Sandbox0Adapter(ctx({ SANDBOX0_TOKEN: 's0_test_token' }), {
      fetchImpl: async (input, init) => {
        const url = String(input);
        const method = (init?.method ?? 'GET').toUpperCase();
        captured.push({ method, url });
        if (method === 'POST' && url.includes('/api/v1/sandboxes/sb_1/pause')) {
          return json({ data: { sandbox_id: 'sb_1', paused: false, status: 'running' } });
        }
        if (method === 'POST' && url.includes('/api/v1/sandboxes/sb_1/resume')) {
          return json({ data: { sandbox_id: 'sb_1', resumed: true, status: 'running' } });
        }
        return json({ error: `unhandled ${method} ${url}` }, 500);
      },
    });

    const paused = await adapter.pauseSandbox('sb_1');
    expect(paused.paused).toBe(false);
    expect(paused.status).toBe('running');
    expect(captured.some((c) => c.method === 'POST' && c.url.includes('/api/v1/sandboxes/sb_1/pause'))).toBe(true);
    expect(captured.some((c) => c.url.includes('/v1/sandboxes') && !c.url.includes('/api/v1'))).toBe(false);

    const resumed = await adapter.resumeSandbox('sb_1');
    expect(resumed.resumed).toBe(true);
    expect(captured.some((c) => c.method === 'POST' && c.url.includes('/api/v1/sandboxes/sb_1/resume'))).toBe(true);
  });
});
