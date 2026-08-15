/**
 * Dodo adapter construction and local guards.
 *
 * Missing live keys are expected. These tests assert the honest failure —
 * `CredentialsMissingError` naming `DODO_API_KEY` — and the physical-goods
 * refusal. They do not mock a successful live HTTP call as if it happened.
 *
 * HTTP 401 on GET /products is a credential blocker, never a probe success.
 * Dodo publishes no Idempotency-Key header; retries use the local ledger.
 */

import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ConflictError, CredentialsMissingError, Secret, SecretStore } from '@foundry/core';
import { DodoAdapter, refusePhysicalGoods } from '../src/dodo/index.js';
import { WebhookVerificationError } from '../src/http/webhook-verify.js';

function emptyAdapter(): DodoAdapter {
  return new DodoAdapter({
    secrets: new SecretStore({ get: () => undefined }),
    environment: 'preview',
    publicBaseUrl: 'https://example.test',
  });
}

function keyedAdapter(fetchImpl: typeof fetch, webhookSecret?: string): DodoAdapter {
  return new DodoAdapter(
    {
      secrets: new SecretStore({
        get: (name) => {
          if (name === 'DODO_API_KEY') return 'dodo_test_key_not_live';
          if (name === 'DODO_WEBHOOK_SECRET') return webhookSecret;
          return undefined;
        },
      }),
      environment: 'preview',
      publicBaseUrl: 'https://example.test',
    },
    { fetchImpl },
  );
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
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
  it('createCheckoutSession for physical_good throws via assertPaymentRoute before any live call', async () => {
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
      return (
        error instanceof ConflictError &&
        error.message.includes('Merchant of Record') &&
        error.message.toLowerCase().includes('tax') &&
        error.message.includes('stripe_direct')
      );
    });
  });

  it('createProduct for a physical bottle throws via assertPaymentRoute', async () => {
    const adapter = emptyAdapter();
    await expect(
      adapter.createProduct({
        name: 'A physical bottle',
        productKind: 'physical_good',
        taxCategory: 'digital_products',
        priceMinor: 1999,
        currency: 'USD',
      }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it('refusePhysicalGoods is the same tax-liability refusal', () => {
    expect(() => refusePhysicalGoods()).toThrow(ConflictError);
  });
});

describe('HTTP 401 is a credential blocker, not a pass', () => {
  it('probe() records GET /products HTTP 401 as succeeded=false', async () => {
    const adapter = keyedAdapter(async () =>
      jsonResponse(401, { message: 'Unauthorized' }),
    );
    const result = await adapter.probe();
    expect(result.succeeded).toBe(false);
    expect(result.evidence['status']).toBe(401);
    expect(result.detail).toMatch(/401/);
    expect(JSON.stringify(result.evidence['body'])).toMatch(/Unauthorized/i);
  });

  it('does not treat a 401 body as live_verified evidence of Stripe test-mode', async () => {
    const adapter = keyedAdapter(async () =>
      jsonResponse(401, { message: 'Unauthorized', livemode: false }),
    );
    const result = await adapter.probe();
    expect(result.succeeded).toBe(false);
    expect(result.detail.toLowerCase()).not.toContain('live_verified');
  });
});

describe('Dodo has no Idempotency-Key header', () => {
  it('createCheckout does not send Idempotency-Key', async () => {
    const seen: string[] = [];
    const adapter = keyedAdapter(async (_url, init) => {
      const headers = new Headers(init?.headers);
      const value = headers.get('Idempotency-Key') ?? headers.get('idempotency-key');
      if (value) seen.push(value);
      return jsonResponse(200, {
        session_id: 'cks_test_digital',
        checkout_url: 'https://test.dodopayments.com/checkout/cks_test_digital',
        payment_id: 'pay_test_digital',
      });
    });
    const result = await adapter.createCheckout({
      orderId: 'ord_digital',
      productKind: 'digital_good',
      productCart: [{ productId: 'pdt_addon', quantity: 1 }],
      returnUrl: 'https://example.test/return',
      idempotencyKey: 'checkout:ord_digital',
    });
    expect(result.sessionId).toBe('cks_test_digital');
    expect(seen).toEqual([]);
  });
});

describe('webhook verify — raw body, 503-equivalent missing secret, 400-equivalent bad signature', () => {
  const NOW_MS = 1_700_000_000_000;
  const NOW_SECONDS = Math.floor(NOW_MS / 1000);
  const rawSecret = 'whsec_' + Buffer.from('a-32-byte-standard-webhooks-key!').toString('base64');
  const keyBytes = Buffer.from(rawSecret.slice('whsec_'.length), 'base64');
  const body = JSON.stringify({
    type: 'payment.succeeded',
    data: { payment_id: 'pay_test_a1', total_amount: 4000, currency: 'USD' },
  });

  function sign(id: string, timestamp: number, payload: string): string {
    return createHmac('sha256', keyBytes).update(`${id}.${timestamp}.${payload}`).digest('base64');
  }

  it('refuses an unsigned webhook when DODO_WEBHOOK_SECRET is missing (route maps this to 503)', () => {
    const adapter = emptyAdapter();
    expect(() =>
      adapter.verifyWebhook({
        rawBody: body,
        headers: {
          'webhook-id': 'msg_1',
          'webhook-timestamp': String(NOW_SECONDS),
          'webhook-signature': 'v1,deadbeef',
        },
        secret: new Secret('DODO_WEBHOOK_SECRET', rawSecret, 'unknown'),
        nowMs: NOW_MS,
      }),
    ).toThrow(ConflictError);
  });

  it('rejects a bad signature over the exact raw bytes (route maps this to 400)', () => {
    const adapter = keyedAdapter(async () => jsonResponse(200, { items: [] }), rawSecret);
    expect(() =>
      adapter.verifyWebhook({
        rawBody: body,
        headers: {
          'webhook-id': 'msg_1',
          'webhook-timestamp': String(NOW_SECONDS),
          'webhook-signature': 'v1,not-a-valid-signature',
        },
        nowMs: NOW_MS,
      }),
    ).toThrow(WebhookVerificationError);
  });

  it('accepts a correctly signed digital payment.succeeded fixture', () => {
    const adapter = keyedAdapter(async () => jsonResponse(200, { items: [] }), rawSecret);
    const result = adapter.verifyWebhook({
      rawBody: body,
      headers: {
        'webhook-id': 'msg_paid',
        'webhook-timestamp': String(NOW_SECONDS),
        'webhook-signature': `v1,${sign('msg_paid', NOW_SECONDS, body)}`,
      },
      nowMs: NOW_MS,
    });
    expect(result.verified).toBe(true);
    expect(result.eventId).toBe('msg_paid');
    expect(result.scheme).toBe('standard_webhooks');
  });
});
