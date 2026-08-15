/**
 * sandbox0 identities are isolated exec workspaces. Untrusted / model-generated
 * code belongs here. Pause does not preserve processes — that is Superserve.
 */

import { describe, expect, it } from 'vitest';
import { CredentialsMissingError, SecretStore, ValidationError } from '@foundry/core';
import type { AdapterContext } from '../src/http/adapter.js';
import {
  SANDBOX0_PAUSE_PRESERVES_PROCESSES,
  Sandbox0Adapter,
  assertIsolatedFromControlPlane,
  assertSandbox0Workload,
  isolatedExecIdentity,
} from '../src/sandbox0/index.js';

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

const COMPANY = 'co_01TESTCOMPANY000000000000';

describe('sandbox0 isolated-exec identities', () => {
  it('does not claim process-preserving pause', () => {
    expect(SANDBOX0_PAUSE_PRESERVES_PROCESSES).toBe(false);
  });

  it('gives engineering and research distinct identities that are not the control plane', () => {
    const engineering = isolatedExecIdentity('engineering', COMPANY);
    const research = isolatedExecIdentity('research', COMPANY);
    expect(engineering.plane).toBe('sandbox0');
    expect(research.plane).toBe('sandbox0');
    expect(engineering.name).not.toBe(research.name);
    expect(engineering.name).not.toBe(isolatedExecIdentity('engineering', 'co_OTHER').name);
    expect(engineering.metadata.isolation).toBe('untrusted_exec');
    expect(engineering.metadata.control_plane).toBe(false);
    expect(engineering.name).not.toMatch(/foundry-api|foundry-worker/);
  });

  it('refuses control-plane names and persistent/browser workloads', () => {
    expect(() => assertIsolatedFromControlPlane('foundry-worker')).toThrow(ValidationError);
    expect(() => assertSandbox0Workload('untrusted_model_code')).not.toThrow();
    expect(() => assertSandbox0Workload('persistent_multi_hour')).toThrow(ValidationError);
    expect(() => assertSandbox0Workload('browser_or_gui')).toThrow(ValidationError);
  });

  it('claim stamps function identity into metadata and does not invent a reattach', async () => {
    let posted: Record<string, unknown> | undefined;
    const adapter = new Sandbox0Adapter(ctx({ SANDBOX0_TOKEN: 's0_test_token' }), {
      fetchImpl: async (input, init) => {
        const url = String(input);
        const method = (init?.method ?? 'GET').toUpperCase();
        if (method === 'GET' && url.includes('/api/v1/sandboxes')) {
          return json({ data: { sandboxes: [], has_more: false } });
        }
        if (method === 'POST' && url.endsWith('/api/v1/sandboxes')) {
          posted = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
          return json({ data: { sandbox_id: 'sb_eng', status: 'running' } });
        }
        return json({ error: `unhandled ${method} ${url}` }, 500);
      },
    });

    const claimed = await adapter.claimOrCreateSandbox({
      template: 'default',
      metadata: { agent_run_id: 'run_eng_1' },
      businessFunction: 'engineering',
      companyId: COMPANY,
    });
    expect('sandbox_id' in claimed && claimed.sandbox_id === 'sb_eng').toBe(true);
    const metadata = posted?.metadata as Record<string, unknown>;
    expect(metadata['foundry_function']).toBe('engineering');
    expect(metadata['foundry_plane']).toBe('sandbox0');
    expect(metadata['isolation']).toBe('untrusted_exec');
    expect(metadata['control_plane']).toBe(false);
    expect(metadata['company_id']).toBe(COMPANY);
  });

  it('names SANDBOX0_TOKEN when the token is absent', async () => {
    const adapter = new Sandbox0Adapter(ctx());
    await expect(
      adapter.claimOrCreateSandbox({
        template: 'default',
        metadata: { agent_run_id: 'run_1' },
        businessFunction: 'engineering',
        companyId: COMPANY,
      }),
    ).rejects.toBeInstanceOf(CredentialsMissingError);
  });
});
