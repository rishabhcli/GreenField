/**
 * Pioneer and Egoist adapters without live keys.
 *
 * Missing credentials must throw a named error. Egoist has no public API, so
 * even a constructed adapter refuses with VendorApprovalRequiredError rather
 * than hitting a guessed host.
 */

import { describe, expect, it } from 'vitest';
import { CredentialsMissingError, SecretStore, VendorApprovalRequiredError } from '@foundry/core';
import { EgoistAdapter } from '../src/egoist/index.js';
import { PioneerAdapter } from '../src/pioneer/index.js';

function emptyCtx() {
  return {
    secrets: new SecretStore({ get: () => undefined }),
    environment: 'preview' as const,
    publicBaseUrl: 'https://example.test',
  };
}

describe('PioneerAdapter without credentials', () => {
  it('probe() throws CredentialsMissingError naming PIONEER_API_KEY', async () => {
    const adapter = new PioneerAdapter(emptyCtx());
    expect(adapter.manifest.id).toBe('pioneer');
    await expect(adapter.probe()).rejects.toSatisfy((error: unknown) => {
      return error instanceof CredentialsMissingError && error.missing.includes('PIONEER_API_KEY');
    });
  });

  it('scanPii does not return a stubbed empty list', async () => {
    const adapter = new PioneerAdapter(emptyCtx());
    await expect(adapter.scanPii('John lives at 1 Main St')).rejects.toBeInstanceOf(CredentialsMissingError);
  });
});

describe('EgoistAdapter', () => {
  it('probe() refuses rather than calling an invented endpoint', async () => {
    const adapter = new EgoistAdapter(emptyCtx());
    expect(adapter.manifest.id).toBe('egoist');
    await expect(adapter.probe()).rejects.toBeInstanceOf(VendorApprovalRequiredError);
  });

  it('readPassport stays blocked even if someone later pastes a key', async () => {
    const adapter = new EgoistAdapter(emptyCtx());
    await expect(adapter.readPassport('user_1')).rejects.toBeInstanceOf(VendorApprovalRequiredError);
  });
});
