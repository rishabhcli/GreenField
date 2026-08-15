/**
 * CORS allowlist and webhook exemption.
 *
 * These are pure decisions; the Fastify wiring is tested separately against
 * inject() so a mis-registered plugin cannot hide behind a helper that is
 * correct in isolation.
 */

import { describe, expect, it } from 'vitest';
import { checkoutRedirectAllowed, corsAllowsOrigin, isWebhookPath, resolveRequestId, resolveWebhookEventId } from '../src/http-policy.js';

describe('isWebhookPath', () => {
  it('exempts provider webhook routes', () => {
    expect(isWebhookPath('/webhooks/stripe')).toBe(true);
    expect(isWebhookPath('/webhooks/dodo')).toBe(true);
  });

  it('does not exempt lookalikes', () => {
    expect(isWebhookPath('/api/webhooks/stripe')).toBe(false);
    expect(isWebhookPath('/metrics')).toBe(false);
    expect(isWebhookPath('/ready')).toBe(false);
  });
});

describe('corsAllowsOrigin', () => {
  const allowlist = ['https://api.example.test', 'https://shop.example.test'];

  it('allows requests with no Origin (webhooks, health, curl)', () => {
    expect(corsAllowsOrigin(undefined, { allowlist, failClosed: true })).toBe(true);
  });

  it('rejects an unknown origin when fail-closed', () => {
    expect(corsAllowsOrigin('https://evil.example', { allowlist, failClosed: true })).toBe(false);
  });

  it('allows a listed origin when fail-closed', () => {
    expect(corsAllowsOrigin('https://shop.example.test', { allowlist, failClosed: true })).toBe(true);
  });

  it('allows any origin when fail-open (preview/staging)', () => {
    expect(corsAllowsOrigin('https://evil.example', { allowlist, failClosed: false })).toBe(true);
  });
});

describe('checkoutRedirectAllowed', () => {
  const allowlist = ['https://shop.example.test', 'https://foundry-api.example.test'];

  it('accepts an allowlisted https origin', () => {
    expect(checkoutRedirectAllowed('https://shop.example.test/thanks', allowlist)).toBe(true);
  });

  it('rejects an unknown origin', () => {
    expect(checkoutRedirectAllowed('https://evil.example/steal', allowlist)).toBe(false);
  });

  it('rejects a non-URL', () => {
    expect(checkoutRedirectAllowed('not-a-url', allowlist)).toBe(false);
  });
});

describe('resolveWebhookEventId', () => {
  it('prefers webhook-id over a colliding body payment id for Standard Webhooks', () => {
    expect(
      resolveWebhookEventId({
        preferDeliveryHeader: true,
        bodyId: 'pay_same_for_every_event',
        headerId: 'msg_unique_delivery',
      }),
    ).toBe('msg_unique_delivery');
  });

  it('uses the body id when no delivery header is present', () => {
    expect(
      resolveWebhookEventId({
        preferDeliveryHeader: true,
        bodyId: 'pay_1',
        headerId: null,
      }),
    ).toBe('pay_1');
  });

  it('uses the body id first when the header is not the delivery id', () => {
    expect(
      resolveWebhookEventId({
        preferDeliveryHeader: false,
        bodyId: 'evt_stripe',
        headerId: 'msg_other',
      }),
    ).toBe('evt_stripe');
  });
});

describe('resolveRequestId', () => {
  const generate = () => 'req_generated_id';

  it('accepts a client x-request-id that matches the safe token', () => {
    expect(resolveRequestId({ 'x-request-id': 'req_abc12' }, generate)).toBe('req_abc12');
    expect(resolveRequestId({ 'x-request-id': 'A'.repeat(64) }, generate)).toBe('A'.repeat(64));
  });

  it('generates when the client id is missing, too short, too long, or has unsafe characters', () => {
    expect(resolveRequestId({}, generate)).toBe('req_generated_id');
    expect(resolveRequestId({ 'x-request-id': 'short' }, generate)).toBe('req_generated_id');
    expect(resolveRequestId({ 'x-request-id': 'A'.repeat(65) }, generate)).toBe('req_generated_id');
    expect(resolveRequestId({ 'x-request-id': 'req id with spaces' }, generate)).toBe('req_generated_id');
    expect(resolveRequestId({ 'x-request-id': 'req/../../../etc' }, generate)).toBe('req_generated_id');
  });
});
