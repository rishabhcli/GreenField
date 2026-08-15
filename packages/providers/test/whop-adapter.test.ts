/**
 * Whop adapter refusal paths and pinned REST contract.
 *
 * These tests never call the live Whop API. Empty secrets must raise a typed
 * `CredentialsMissingError` naming `WHOP_API_KEY` / `WHOP_COMPANY_ID`. Asking
 * the adapter to sell a physical good must raise `ValidationError` before any
 * HTTP. `GET /accounts/me` is an identity probe, not a checkout pass.
 */

import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConflictError, CredentialsMissingError, SecretStore, ValidationError } from '@foundry/core';
import { WHOP_API_VERSION_DATE, WhopAdapter } from '../src/whop/index.js';
import { WebhookVerificationError } from '../src/http/webhook-verify.js';

const WEBHOOK_SECRET = 'whsec_' + Buffer.from('a-32-byte-standard-webhooks-key!').toString('base64');
const WEBHOOK_KEY = Buffer.from(WEBHOOK_SECRET.slice('whsec_'.length), 'base64');
const NOW_MS = 1_700_000_000_000;
const NOW_SECONDS = Math.floor(NOW_MS / 1000);

function adapterWith(
  env: Record<string, string | undefined> = {},
  environment: 'production' | 'staging' | 'preview' = 'preview',
) {
  return new WhopAdapter({
    secrets: new SecretStore({ get: (name) => env[name] }),
    environment,
    publicBaseUrl: 'https://example.test',
  });
}

function configured(
  env: Record<string, string | undefined> = {},
  environment: 'production' | 'staging' | 'preview' = 'preview',
) {
  return adapterWith(
    {
      WHOP_API_KEY: 'whop_test_key',
      WHOP_COMPANY_ID: 'biz_testcompany1',
      WHOP_WEBHOOK_SECRET: WEBHOOK_SECRET,
      ...env,
    },
    environment,
  );
}

function headerMap(headers: unknown): Record<string, string> {
  if (!headers) return {};
  if (headers instanceof Headers) return Object.fromEntries([...headers.entries()].map(([k, v]) => [k.toLowerCase(), v]));
  return Object.fromEntries(Object.entries(headers as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function stubFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    return handler(url, init ?? {});
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('WhopAdapter credentials', () => {
  it('probe with empty secrets throws CredentialsMissingError naming WHOP_API_KEY', async () => {
    const fetch = stubFetch(() => {
      throw new Error('HTTP must not run when WHOP_API_KEY is missing');
    });
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
    expect(fetch).not.toHaveBeenCalled();
  });

  it('probe with a key but no WHOP_COMPANY_ID throws before HTTP', async () => {
    const fetch = stubFetch(() => {
      throw new Error('HTTP must not run when WHOP_COMPANY_ID is missing');
    });
    const adapter = adapterWith({ WHOP_API_KEY: 'whop_test_key' });
    await expect(adapter.probe()).rejects.toBeInstanceOf(CredentialsMissingError);
    try {
      await adapter.probe();
    } catch (error) {
      expect(error).toBeInstanceOf(CredentialsMissingError);
      if (!(error instanceof CredentialsMissingError)) return;
      expect(error.missing).toContain('WHOP_COMPANY_ID');
    }
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('WhopAdapter physical goods', () => {
  it('createProduct rejects physical_good without calling Whop', async () => {
    const fetch = stubFetch(() => {
      throw new Error('physical createProduct must not call Whop');
    });
    const adapter = configured();
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
    expect(fetch).not.toHaveBeenCalled();
  });

  it('createCheckout rejects physical_good without calling Whop', async () => {
    const fetch = stubFetch(() => {
      throw new Error('physical createCheckout must not call Whop');
    });
    const adapter = configured();
    await expect(
      adapter.createCheckout({
        orderId: 'ord_01ABC',
        productKind: 'physical_good',
        planId: 'plan_test',
        idempotencyKey: 'idem_checkout_physical',
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('createCheckoutConfiguration rejects physical_good without calling Whop', async () => {
    const fetch = stubFetch(() => {
      throw new Error('physical createCheckoutConfiguration must not call Whop');
    });
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
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('WhopAdapter pinned REST contract', () => {
  it('pins WHOP_API_VERSION_DATE to 2026-07-23 and sends Api-Version-Date on every request', async () => {
    expect(WHOP_API_VERSION_DATE).toBe('2026-07-23');
    const fetch = stubFetch((url, init) => {
      expect(url).toBe('https://sandbox-api.whop.com/api/v1/products');
      const headers = headerMap(init.headers);
      expect(headers['api-version-date']).toBe('2026-07-23');
      const raw = init.headers as Record<string, string>;
      expect(Object.keys(raw).some((key) => key.toLowerCase() === 'api-version-date')).toBe(true);
      return jsonResponse({ id: 'prod_test_a1', title: 'Membership' });
    });

    const created = await configured().createProduct({
      kind: 'membership',
      title: 'Founding membership',
      idempotencyKey: 'idem_product_digital',
    });
    expect(created.id).toBe('prod_test_a1');
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('uses the production host only in production, otherwise sandbox-api.whop.com', async () => {
    const urls: string[] = [];
    stubFetch((url) => {
      urls.push(url);
      return jsonResponse({ id: 'prod_live', title: 'Membership' });
    });
    await configured({}, 'production').createProduct({
      kind: 'digital_good',
      title: 'Guide',
      idempotencyKey: 'idem_prod_host',
    });
    expect(urls[0]).toBe('https://api.whop.com/api/v1/products');

    vi.unstubAllGlobals();
    urls.length = 0;
    stubFetch((url) => {
      urls.push(url);
      return jsonResponse({ id: 'prod_sbx', title: 'Membership' });
    });
    await configured({}, 'preview').createProduct({
      kind: 'digital_good',
      title: 'Guide',
      idempotencyKey: 'idem_sbx_host',
    });
    expect(urls[0]).toBe('https://sandbox-api.whop.com/api/v1/products');
  });

  it('sends account_id (2026-07-23 pin) and never company_id on product create', async () => {
    let body: Record<string, unknown> = {};
    stubFetch((_url, init) => {
      body = JSON.parse(String(init.body)) as Record<string, unknown>;
      return jsonResponse({ id: 'prod_test_a1', title: 'Membership', plans: [{ id: 'plan_test_a1' }] });
    });
    const created = await configured().createProduct({
      kind: 'subscription',
      title: 'Operator',
      currency: 'usd',
      initialPriceMinor: 9900,
      planType: 'renewal',
      metadata: { sku: 'zhc-operator' },
      idempotencyKey: 'idem_account_id',
    });
    expect(created.id).toBe('prod_test_a1');
    expect(created.planId).toBe('plan_test_a1');
    expect(body['account_id']).toBe('biz_testcompany1');
    expect(body['company_id']).toBeUndefined();
    expect(body['title']).toBe('Operator');
    const planOptions = body['plan_options'] as Record<string, unknown>;
    expect(planOptions['initial_price']).toBe(99);
    expect(planOptions['plan_type']).toBe('renewal');
  });

  it('checkout configuration carries order-linked metadata and the version header', async () => {
    let body: Record<string, unknown> = {};
    const fetch = stubFetch((url, init) => {
      expect(url).toBe('https://sandbox-api.whop.com/api/v1/checkout-configurations');
      expect(headerMap(init.headers)['api-version-date']).toBe('2026-07-23');
      body = JSON.parse(String(init.body)) as Record<string, unknown>;
      return jsonResponse({
        id: 'ch_test_a1',
        purchase_url: 'https://whop.com/checkout/plan_test_a1',
        plan_id: 'plan_test_a1',
      });
    });
    const checkout = await configured().createCheckout({
      orderId: 'ord_01ABC',
      productKind: 'membership',
      planId: 'plan_test_a1',
      idempotencyKey: 'idem_checkout_meta',
    });
    expect(checkout.id).toBe('ch_test_a1');
    expect(checkout.url).toBe('https://whop.com/checkout/plan_test_a1');
    expect(body['account_id']).toBe('biz_testcompany1');
    expect(body['plan_id']).toBe('plan_test_a1');
    expect(body['metadata']).toEqual({
      internal_order_id: 'ord_01ABC',
      order_id: 'ord_01ABC',
    });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('refunds POST /payments/:id/refund with partial_amount in major units', async () => {
    let url = '';
    let body: Record<string, unknown> = {};
    stubFetch((requestUrl, init) => {
      url = requestUrl;
      body = JSON.parse(String(init.body)) as Record<string, unknown>;
      expect(headerMap(init.headers)['api-version-date']).toBe('2026-07-23');
      return jsonResponse({
        id: 'pay_test_a1',
        refunded_amount: 20,
        refunds: [{ id: 'rf_test_a1', amount: 20, status: 'pending' }],
      });
    });
    const refunded = await configured().refundPayment({
      paymentId: 'pay_test_a1',
      amountMinor: 2000,
      idempotencyKey: 'idem_refund_1',
    });
    expect(url).toBe('https://sandbox-api.whop.com/api/v1/payments/pay_test_a1/refund');
    expect(body['partial_amount']).toBe(20);
    expect(body['amount']).toBeUndefined();
    expect(refunded.id).toBe('rf_test_a1');
  });

  it('probe GET /accounts/me records identity evidence and is not a checkout pass', async () => {
    stubFetch((url, init) => {
      expect(url).toBe('https://sandbox-api.whop.com/api/v1/accounts/me');
      expect(headerMap(init.headers)['api-version-date']).toBe('2026-07-23');
      return jsonResponse({ id: 'biz_testcompany1', name: 'Zero Human Co' });
    });
    const result = await configured().probe();
    expect(result.succeeded).toBe(true);
    expect(result.evidence['endpoint']).toBe('GET /accounts/me');
    expect(result.evidence['notACheckoutPass']).toBe(true);
    expect(result.evidence['apiVersionDate']).toBe('2026-07-23');
    expect(result.detail.toLowerCase()).not.toMatch(/checkout/);
  });
});

describe('WhopAdapter webhook verify', () => {
  const body = '{"type":"payment.succeeded","data":{"id":"pay_test_a1"}}';

  function sign(id: string, timestamp: number): string {
    return createHmac('sha256', WEBHOOK_KEY).update(`${id}.${timestamp}.${body}`).digest('base64');
  }

  it('refuses an unsigned webhook when WHOP_WEBHOOK_SECRET is missing', () => {
    const adapter = adapterWith({ WHOP_API_KEY: 'whop_test_key', WHOP_COMPANY_ID: 'biz_testcompany1' });
    expect(() =>
      adapter.verifyWebhook({
        rawBody: body,
        headers: {
          'webhook-id': 'msg_1',
          'webhook-timestamp': String(NOW_SECONDS),
          'webhook-signature': `v1,${sign('msg_1', NOW_SECONDS)}`,
        },
        nowMs: NOW_MS,
      }),
    ).toThrow(ConflictError);
  });

  it('accepts a correctly signed Standard Webhooks payload', () => {
    const result = configured().verifyWebhook({
      rawBody: body,
      headers: {
        'webhook-id': 'msg_1',
        'webhook-timestamp': String(NOW_SECONDS),
        'webhook-signature': `v1,${sign('msg_1', NOW_SECONDS)}`,
      },
      nowMs: NOW_MS,
    });
    expect(result.verified).toBe(true);
    expect(result.eventId).toBe('msg_1');
    expect(result.scheme).toBe('standard_webhooks');
  });

  it('rejects a tampered signature', () => {
    expect(() =>
      configured().verifyWebhook({
        rawBody: body,
        headers: {
          'webhook-id': 'msg_1',
          'webhook-timestamp': String(NOW_SECONDS),
          'webhook-signature': 'v1,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
        },
        nowMs: NOW_MS,
      }),
    ).toThrow(WebhookVerificationError);
  });
});
