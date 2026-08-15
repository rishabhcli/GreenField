/**
 * Linq Agent Pay local guards.
 *
 * A Stripe Payment Link is not a valid agentpay checkout_url. Amounts below
 * 50 cents are refused before any network call.
 */

import { describe, expect, it } from 'vitest';
import { CredentialsMissingError, SecretStore, ValidationError } from '@foundry/core';
import { LinqAdapter } from '../src/linq/index.js';

function emptyAdapter(): LinqAdapter {
  return new LinqAdapter({
    secrets: new SecretStore({ get: () => undefined }),
    environment: 'preview',
    publicBaseUrl: 'https://example.test',
  });
}

describe('LinqAdapter Agent Pay', () => {
  it('createPaymentRequest without credentials names LINQ_API_V3_API_KEY', async () => {
    const adapter = emptyAdapter();
    await expect(
      adapter.createPaymentRequest({
        amountMinor: 500,
        currency: 'usd',
        description: 'test',
      }),
    ).rejects.toSatisfy(
      (error: unknown) => error instanceof CredentialsMissingError && error.missing.includes('LINQ_API_V3_API_KEY'),
    );
  });

  it('createPaymentRequest refuses sub-50-cent amounts before any live call', async () => {
    const adapter = emptyAdapter();
    await expect(
      adapter.createPaymentRequest({
        amountMinor: 49,
        currency: 'usd',
        description: 'too small',
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('sendExperience refuses multi-recipient cards', async () => {
    const adapter = emptyAdapter();
    await expect(
      adapter.sendExperience({
        to: ['+15551212', '+15553434'],
        experience: { name: 'agentpay', action: 'request_payment', params: { checkout_url: 'https://example.test' } },
        idempotencyKey: 'k1',
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});
