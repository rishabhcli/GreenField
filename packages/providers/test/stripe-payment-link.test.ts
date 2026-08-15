/**
 * Stripe Payment Link helpers without live keys.
 */

import { describe, expect, it } from 'vitest';
import { CredentialsMissingError, SecretStore } from '@foundry/core';
import { StripeAdapter } from '../src/stripe/index.js';

describe('StripeAdapter payment links', () => {
  it('hackathonPaymentLinkUrl is undefined when the env is unset', () => {
    const adapter = new StripeAdapter({
      secrets: new SecretStore({ get: () => undefined }),
      environment: 'preview',
      publicBaseUrl: 'https://example.test',
    });
    expect(adapter.hackathonPaymentLinkUrl()).toBeUndefined();
  });

  it('retrievePaymentLink throws CredentialsMissingError, not a stub URL', async () => {
    const adapter = new StripeAdapter({
      secrets: new SecretStore({ get: () => undefined }),
      environment: 'preview',
      publicBaseUrl: 'https://example.test',
    });
    await expect(adapter.retrievePaymentLink('plink_test')).rejects.toBeInstanceOf(CredentialsMissingError);
  });
});
