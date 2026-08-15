/**
 * Whop adapter refusal paths.
 *
 * These tests never call the live Whop API. Empty secrets must raise a typed
 * `CredentialsMissingError` naming `WHOP_API_KEY`. Asking the adapter to sell
 * a physical good must raise `ValidationError` — Whop is digital/membership
 * commerce, and attributing private-label sourcing to it would be a false
 * claim.
 */

import { describe, expect, it } from 'vitest';
import { CredentialsMissingError, SecretStore, ValidationError } from '@foundry/core';
import { WhopAdapter } from '../src/whop/index.js';

function adapterWith(env: Record<string, string | undefined> = {}) {
  return new WhopAdapter({
    secrets: new SecretStore({ get: (name) => env[name] }),
    environment: 'preview',
    publicBaseUrl: 'https://example.test',
  });
}

describe('WhopAdapter credentials', () => {
  it('probe with empty secrets throws CredentialsMissingError naming WHOP_API_KEY', async () => {
    const adapter = adapterWith();
    await expect(adapter.probe()).rejects.toBeInstanceOf(CredentialsMissingError);
    try {
      await adapter.probe();
    } catch (error) {
      expect(error).toBeInstanceOf(CredentialsMissingError);
      if (!(error instanceof CredentialsMissingError)) return;
      expect(error.missing).toContain('WHOP_API_KEY');
      expect(error.message).toContain('WHOP_API_KEY');
    }
  });
});

describe('WhopAdapter physical goods', () => {
  it('createProduct rejects physical_good without calling Whop', async () => {
    const adapter = adapterWith();
    await expect(
      adapter.createProduct({
        kind: 'physical_good',
        title: 'Ceramic mug',
        description: 'A physical private-label good',
        idempotencyKey: 'idem_product_1',
      }),
    ).rejects.toBeInstanceOf(ValidationError);

    try {
      await adapter.createProduct({
        kind: 'physical_good',
        title: 'Ceramic mug',
        idempotencyKey: 'idem_product_1',
      });
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      if (!(error instanceof ValidationError)) return;
      expect(error.message.toLowerCase()).toMatch(/physical/);
    }
  });

  it('createCheckoutConfiguration rejects physical_good without calling Whop', async () => {
    const adapter = adapterWith();
    await expect(
      adapter.createCheckoutConfiguration({
        kind: 'physical_good',
        currency: 'usd',
        initialPriceMinor: 1999,
        planType: 'one_time',
        idempotencyKey: 'idem_checkout_1',
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});
