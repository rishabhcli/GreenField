/**
 * Render workflow trigger without RENDER_WORKFLOW_SLUG.
 * GET /v1/services is the probe, not the prize pass. The completed
 * tickCompanyLoop run is trn-0994gda0c8fvlk1mc73fl86u0 — do not mint a fake
 * second success in tests.
 */

import { describe, expect, it } from 'vitest';
import { CredentialsMissingError, SecretStore } from '@foundry/core';
import { RENDER_MANIFEST } from '../src/manifests.js';
import { RenderAdapter } from '../src/render/index.js';

describe('RenderAdapter workflows', () => {
  it('startTaskRun names RENDER_WORKFLOW_SLUG when the API key is present but the slug is not', async () => {
    const adapter = new RenderAdapter({
      secrets: new SecretStore({
        get: (name) => (name === 'RENDER_API_KEY' ? 'rnd_testkey_not_used' : undefined),
      }),
      environment: 'preview',
      publicBaseUrl: 'https://example.test',
    });
    await expect(adapter.startTaskRun('tickCompanyLoop', [{ companyId: 'co_1' }])).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof CredentialsMissingError && error.missing.includes('RENDER_WORKFLOW_SLUG'),
    );
  });

  it('probe() without RENDER_API_KEY is blocked, not a fabricated GET /v1/services pass', async () => {
    const adapter = new RenderAdapter({
      secrets: new SecretStore({ get: () => undefined }),
      environment: 'preview',
      publicBaseUrl: 'https://example.test',
    });
    expect(RENDER_MANIFEST.liveProbe.description).toMatch(/GET \/v1\/services/);
    await expect(adapter.probe()).rejects.toBeInstanceOf(CredentialsMissingError);
  });
});
