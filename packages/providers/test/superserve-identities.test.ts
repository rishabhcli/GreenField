/**
 * Superserve identities are persistent workspaces per business function.
 * A research crash must not share a VM with sourcing or with foundry-api/worker.
 */

import { describe, expect, it } from 'vitest';
import { CredentialsMissingError, SecretStore, ValidationError } from '@foundry/core';
import type { AdapterContext } from '../src/http/adapter.js';
import {
  SuperserveAdapter,
  assertIsolatedFromControlPlane,
  assertSuperserveWorkload,
  persistentWorkspaceIdentity,
} from '../src/superserve/index.js';

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
const COMPANY = 'co_01TESTCOMPANY000000000000';

describe('Superserve persistent workspace identities', () => {
  it('gives research and sourcing distinct names and metadata', () => {
    const research = persistentWorkspaceIdentity('research', COMPANY);
    const sourcing = persistentWorkspaceIdentity('sourcing', COMPANY);
    expect(research.plane).toBe('superserve');
    expect(sourcing.plane).toBe('superserve');
    expect(research.name).not.toBe(sourcing.name);
    expect(research.metadata.foundry_function).toBe('research');
    expect(sourcing.metadata.foundry_function).toBe('sourcing');
    expect(research.metadata.control_plane).toBe(false);
    expect(research.name).not.toMatch(/foundry-api|foundry-worker/);
    expect(sourcing.name).not.toMatch(/foundry-api|foundry-worker/);
  });

  it('refuses identities that collide with the control plane', () => {
    expect(() => assertIsolatedFromControlPlane('foundry-api')).toThrow(ValidationError);
    expect(() => assertIsolatedFromControlPlane('ss-foundry-worker-research')).toThrow(ValidationError);
    expect(() => assertIsolatedFromControlPlane(persistentWorkspaceIdentity('qa', COMPANY).name)).not.toThrow();
  });

  it('accepts only persistent multi-hour work, not untrusted exec or browser', () => {
    expect(() => assertSuperserveWorkload('persistent_multi_hour')).not.toThrow();
    expect(() => assertSuperserveWorkload('untrusted_model_code')).toThrow(ValidationError);
    expect(() => assertSuperserveWorkload('browser_or_gui')).toThrow(ValidationError);
  });

  it('createSandbox stamps function identity onto name and metadata', async () => {
    let posted: Record<string, unknown> | undefined;
    const adapter = new SuperserveAdapter(ctx({ SUPERSERVE_API_KEY: KEY }), {
      fetchImpl: async (input, init) => {
        const url = String(input);
        const method = (init?.method ?? 'GET').toUpperCase();
        if (method === 'POST' && url.endsWith('/sandboxes')) {
          posted = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
          return json({ id: 'sbx_research', status: 'active', access_token: 'tok' });
        }
        return json({ error: `unhandled ${method} ${url}` }, 500);
      },
    });

    const created = await adapter.createSandbox({
      businessFunction: 'research',
      companyId: COMPANY,
    });
    expect(created.id).toBe('sbx_research');
    expect(typeof posted?.name).toBe('string');
    expect(String(posted?.name)).toContain('research');
    expect(String(posted?.name)).not.toMatch(/foundry-api|foundry-worker/);
    const metadata = posted?.metadata as Record<string, unknown>;
    expect(metadata['foundry_function']).toBe('research');
    expect(metadata['foundry_plane']).toBe('superserve');
    expect(metadata['company_id']).toBe(COMPANY);
    expect(metadata['control_plane']).toBe(false);
  });

  it('names SUPERSERVE_API_KEY when the key is absent', async () => {
    const adapter = new SuperserveAdapter(ctx());
    await expect(
      adapter.createSandbox({ businessFunction: 'research', companyId: COMPANY }),
    ).rejects.toSatisfy(
      (error: unknown) => error instanceof CredentialsMissingError && error.missing.includes('SUPERSERVE_API_KEY'),
    );
  });
});
