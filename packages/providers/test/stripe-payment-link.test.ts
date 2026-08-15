/**
 * Stripe Payment Link helpers without live keys.
 *
 * The submitted hackathon link is a public URL. These tests never mint a
 * second link and never fabricate a webhook signing secret.
 */

import { describe, expect, it } from 'vitest';
import { CredentialsMissingError, SecretStore } from '@foundry/core';
import {
  HACKATHON_PAYMENT_LINK_ID,
  HACKATHON_PAYMENT_LINK_URL,
  StripeAdapter,
} from '../src/stripe/index.js';

function adapterWith(env: Record<string, string> = {}): StripeAdapter {
  return new StripeAdapter({
    secrets: new SecretStore({ get: (name) => env[name] }),
    environment: 'preview',
    publicBaseUrl: 'https://example.test',
  });
}

describe('StripeAdapter payment links', () => {
  it('pins the submitted customer-chooses-price Payment Link', () => {
    expect(HACKATHON_PAYMENT_LINK_ID).toBe('plink_1U4lK242nB81EBguRPuIHrxS');
    expect(HACKATHON_PAYMENT_LINK_URL).toBe('https://buy.stripe.com/bJe7sE7Ti3nmbLYdjb2go00');
  });

  it('hackathonPaymentLinkUrl is the submitted URL when env is unset', () => {
    expect(adapterWith().hackathonPaymentLinkUrl()).toBe(HACKATHON_PAYMENT_LINK_URL);
  });

  it('agentPaymentLink wires the submitted id and URL into the agent payment tool', () => {
    expect(adapterWith().agentPaymentLink()).toEqual({
      id: HACKATHON_PAYMENT_LINK_ID,
      url: HACKATHON_PAYMENT_LINK_URL,
    });
  });

  it('does not substitute a different env URL for the submitted Payment Link', () => {
    const adapter = adapterWith({
      STRIPE_HACKATHON_PAYMENT_LINK_URL: 'https://buy.stripe.com/this-would-be-a-second-link',
    });
    expect(adapter.hackathonPaymentLinkUrl()).toBe(HACKATHON_PAYMENT_LINK_URL);
    expect(adapter.agentPaymentLink().id).toBe(HACKATHON_PAYMENT_LINK_ID);
  });

  it('retrievePaymentLink throws CredentialsMissingError, not a stub URL', async () => {
    await expect(adapterWith().retrievePaymentLink('plink_test')).rejects.toBeInstanceOf(CredentialsMissingError);
  });

  it('resolveHackathonPaymentLink names STRIPE_SECRET_KEY when unset, not a minted URL', async () => {
    await expect(adapterWith().resolveHackathonPaymentLink()).rejects.toSatisfy((error: unknown) => {
      return error instanceof CredentialsMissingError && error.missing.includes('STRIPE_SECRET_KEY');
    });
  });

  it('createPaymentLink reuses the submitted link and does not mint without credentials', async () => {
    await expect(
      adapterWith().createPaymentLink({
        priceId: 'price_would_mint_a_second_link',
        idempotencyKey: 'do-not-create',
      }),
    ).rejects.toSatisfy((error: unknown) => {
      return error instanceof CredentialsMissingError && error.missing.includes('STRIPE_SECRET_KEY');
    });
  });
});

describe('StripeAdapter webhook ingest', () => {
  it('reports STRIPE_WEBHOOK_SECRET as blocked when unset, not ready', () => {
    expect(adapterWith().webhookIngestStatus()).toEqual({
      ready: false,
      blockedOn: 'STRIPE_WEBHOOK_SECRET',
    });
  });

  it('verifyWebhook throws CredentialsMissingError instead of accepting an unsigned body', () => {
    expect(() => adapterWith().verifyWebhook('{"id":"evt_fake"}', {})).toThrow(CredentialsMissingError);
    try {
      adapterWith().verifyWebhook('{"id":"evt_fake"}', {});
    } catch (error) {
      expect(error).toBeInstanceOf(CredentialsMissingError);
      expect((error as CredentialsMissingError).missing).toContain('STRIPE_WEBHOOK_SECRET');
    }
  });
});
