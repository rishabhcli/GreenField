/**
 * Dodo adapter construction and local guards.
 *
 * Missing live keys are expected. These tests assert the honest failure —
 * `CredentialsMissingError` naming `DODO_API_KEY` — and the physical-goods
 * refusal. They do not mock a successful live HTTP call as if it happened.
 */

import { describe, expect, it } from 'vitest';
import { CredentialsMissingError, SecretStore, ValidationError } from '@foundry/core';
import { DodoAdapter } from '../src/dodo/index.js';

function emptyAdapter(): DodoAdapter {
  return new DodoAdapter({
    secrets: new SecretStore({ get: () => undefined }),
    environment: 'preview',
    publicBaseUrl: 'https://example.test',
  });
}

describe('DodoAdapter without credentials', () => {
  it('constructs against an empty SecretStore', () => {
    const adapter = emptyAdapter();
    expect(adapter.manifest.id).toBe('dodo');
    expect(adapter.missingSecrets).toContain('DODO_API_KEY');
  });

  it('probe() throws CredentialsMissingError naming DODO_API_KEY', async () => {
    const adapter = emptyAdapter();
    await expect(adapter.probe()).rejects.toSatisfy((error: unknown) => {
      return (
        error instanceof CredentialsMissingError &&
        error.missing.includes('DODO_API_KEY') &&
        error.message.includes('DODO_API_KEY')
      );
    });
  });

  it('createCheckoutSession for a digital product throws CredentialsMissingError, not a stubbed success', async () => {
    const adapter = emptyAdapter();
    await expect(
      adapter.createCheckoutSession({
        orderId: 'ord_01ABC',
        productKind: 'digital_good',
        productCart: [{ productId: 'pdt_test', quantity: 1 }],
        returnUrl: 'https://example.test/return',
        idempotencyKey: 'idem_1',
      }),
    ).rejects.toBeInstanceOf(CredentialsMissingError);
  });
});

describe('physical goods compliance', () => {
  it('createCheckoutSession for physical_good throws ValidationError before any live call', async () => {
    const adapter = emptyAdapter();
    await expect(
      adapter.createCheckoutSession({
        orderId: 'ord_physical',
        productKind: 'physical_good',
        productCart: [{ productId: 'pdt_bottle', quantity: 1 }],
        returnUrl: 'https://example.test/return',
        idempotencyKey: 'idem_physical',
      }),
    ).rejects.toSatisfy((error: unknown) => {
      return error instanceof ValidationError && error.message.toLowerCase().includes('physical');
    });
  });

  it('createProduct for physical_good throws ValidationError', async () => {
    const adapter = emptyAdapter();
    await expect(
      adapter.createProduct({
        name: 'A physical bottle',
        productKind: 'physical_good',
        taxCategory: 'digital_products',
        priceMinor: 1999,
        currency: 'USD',
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});
