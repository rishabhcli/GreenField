/**
 * CORS allowlist and webhook exemption.
 *
 * These are pure decisions; the Fastify wiring is tested separately against
 * inject() so a mis-registered plugin cannot hide behind a helper that is
 * correct in isolation.
 */

import { describe, expect, it } from 'vitest';
import { corsAllowsOrigin, isWebhookPath } from '../src/http-policy.js';

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
