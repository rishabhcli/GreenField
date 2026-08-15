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
