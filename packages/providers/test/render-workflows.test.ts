/**
 * Render workflow trigger without RENDER_WORKFLOW_SLUG.
 */

import { describe, expect, it } from 'vitest';
import { CredentialsMissingError, SecretStore } from '@foundry/core';
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
});
