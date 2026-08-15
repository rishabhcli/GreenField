/**
 * Webhook signature verification tests.
 *
 * An unverified webhook is an unauthenticated write to the money ledger, so
 * these tests assert the negative cases as hard as the positive ones: wrong
 * secret, tampered body, replayed timestamp, missing header, and — for Stripe —
 * a `v0` signature, which the docs describe as a decoy for test events and
 * which accepting would be a downgrade attack.
 */

import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Secret } from '@foundry/core';
import {
  verifyLovableSignature,
  verifySandbox0Signature,
  verifyStandardWebhook,
  verifyStripeSignature,
  verifyTeracSignature,
  WebhookVerificationError,
} from '@foundry/providers';

const NOW_MS = 1_760_000_000_000;
const NOW_SECONDS = Math.floor(NOW_MS / 1000);
const BODY = JSON.stringify({ id: 'evt_1', type: 'charge.refunded', data: { object: { amount: 4700 } } });

/* -------------------------------------------------------------------------- */
/* Stripe                                                                      */
/* -------------------------------------------------------------------------- */

describe('Stripe signature verification', () => {
  const secret = new Secret('STRIPE_WEBHOOK_SECRET', 'whsec_testsecretvalue', 'test');

  function sign(body: string, timestamp: number, key = 'whsec_testsecretvalue'): string {
    return createHmac('sha256', key).update(`${timestamp}.${body}`).digest('hex');
  }

  it('accepts a correctly signed payload', () => {
    const header = `t=${NOW_SECONDS},v1=${sign(BODY, NOW_SECONDS)}`;
    const result = verifyStripeSignature({
      rawBody: BODY,
      headers: { 'stripe-signature': header },
      secret,
      nowMs: NOW_MS,
    });
    expect(result.verified).toBe(true);
    expect(result.timestampSeconds).toBe(NOW_SECONDS);
    expect(result.scheme).toBe('stripe_v1_hmac_sha256');
  });

  it('accepts when several v1 signatures are present, as during secret rotation', () => {
    const header = `t=${NOW_SECONDS},v1=${'0'.repeat(64)},v1=${sign(BODY, NOW_SECONDS)}`;
    expect(
      verifyStripeSignature({ rawBody: BODY, headers: { 'stripe-signature': header }, secret, nowMs: NOW_MS }).verified,
    ).toBe(true);
  });

  it('rejects a signature made with a different secret', () => {
    const header = `t=${NOW_SECONDS},v1=${sign(BODY, NOW_SECONDS, 'whsec_wrong')}`;
    expect(() =>
      verifyStripeSignature({ rawBody: BODY, headers: { 'stripe-signature': header }, secret, nowMs: NOW_MS }),
    ).toThrow(WebhookVerificationError);
  });

  it('rejects a tampered body', () => {
    const header = `t=${NOW_SECONDS},v1=${sign(BODY, NOW_SECONDS)}`;
    const tampered = BODY.replace('4700', '1');
    expect(() =>
      verifyStripeSignature({ rawBody: tampered, headers: { 'stripe-signature': header }, secret, nowMs: NOW_MS }),
    ).toThrow(/no v1 signature matched/);
  });

  it('rejects a replayed delivery outside the tolerance window', () => {
    const old = NOW_SECONDS - 600;
    const header = `t=${old},v1=${sign(BODY, old)}`;
    expect(() =>
      verifyStripeSignature({ rawBody: BODY, headers: { 'stripe-signature': header }, secret, nowMs: NOW_MS }),
    ).toThrow(/replay window/);
  });

  it('accepts a delivery inside the tolerance window', () => {
    const recent = NOW_SECONDS - 240;
    const header = `t=${recent},v1=${sign(BODY, recent)}`;
    expect(
      verifyStripeSignature({ rawBody: BODY, headers: { 'stripe-signature': header }, secret, nowMs: NOW_MS }).verified,
    ).toBe(true);
  });

  it('never accepts a v0 signature, which the docs describe as a decoy', () => {
    const v0 = createHmac('sha256', 'whsec_testsecretvalue').update(`${NOW_SECONDS}.${BODY}`).digest('hex');
    const header = `t=${NOW_SECONDS},v0=${v0}`;
    expect(() =>
      verifyStripeSignature({ rawBody: BODY, headers: { 'stripe-signature': header }, secret, nowMs: NOW_MS }),
    ).toThrow(/v0 is a decoy/);
  });

  it('rejects a missing header', () => {
    expect(() => verifyStripeSignature({ rawBody: BODY, headers: {}, secret, nowMs: NOW_MS })).toThrow(
      /missing Stripe-Signature/,
    );
  });

  it('rejects a header with no timestamp', () => {
    expect(() =>
      verifyStripeSignature({
        rawBody: BODY,
        headers: { 'stripe-signature': `v1=${sign(BODY, NOW_SECONDS)}` },
        secret,
        nowMs: NOW_MS,
      }),
    ).toThrow(/no t= timestamp/);
  });

  it('verifies against exact bytes, so a re-serialised body fails', () => {
    const header = `t=${NOW_SECONDS},v1=${sign(BODY, NOW_SECONDS)}`;
    // Re-serialising changes whitespace; this is the single most common cause
    // of "signature failed" in production and must not silently pass.
    const reserialised = JSON.stringify(JSON.parse(BODY), null, 2);
    expect(() =>
      verifyStripeSignature({ rawBody: reserialised, headers: { 'stripe-signature': header }, secret, nowMs: NOW_MS }),
    ).toThrow(WebhookVerificationError);
  });

  it('accepts a Buffer body identical to the signed bytes', () => {
    const header = `t=${NOW_SECONDS},v1=${sign(BODY, NOW_SECONDS)}`;
    expect(
      verifyStripeSignature({
        rawBody: Buffer.from(BODY, 'utf8'),
        headers: { 'stripe-signature': header },
        secret,
        nowMs: NOW_MS,
      }).verified,
    ).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* Standard Webhooks — Whop, Dodo, Linq                                        */
/* -------------------------------------------------------------------------- */

describe('Standard Webhooks verification', () => {
  const rawSecret = 'whsec_' + Buffer.from('a-32-byte-standard-webhooks-key!').toString('base64');
  const secret = new Secret('WHOP_WEBHOOK_SECRET', rawSecret, 'unknown');
  const keyBytes = Buffer.from(rawSecret.slice('whsec_'.length), 'base64');

  function sign(id: string, timestamp: number, body: string, key = keyBytes): string {
    return createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64');
  }

  it('accepts a correctly signed payload', () => {
    const result = verifyStandardWebhook('whop', {
      rawBody: BODY,
      headers: {
        'webhook-id': 'msg_1',
        'webhook-timestamp': String(NOW_SECONDS),
        'webhook-signature': `v1,${sign('msg_1', NOW_SECONDS, BODY)}`,
      },
      secret,
      nowMs: NOW_MS,
    });
    expect(result.verified).toBe(true);
    expect(result.eventId).toBe('msg_1');
    expect(result.scheme).toBe('standard_webhooks');
  });

  it('binds the signature to the event id, so it cannot be replayed under another id', () => {
    expect(() =>
      verifyStandardWebhook('whop', {
        rawBody: BODY,
        headers: {
          'webhook-id': 'msg_DIFFERENT',
          'webhook-timestamp': String(NOW_SECONDS),
          'webhook-signature': `v1,${sign('msg_1', NOW_SECONDS, BODY)}`,
        },
        secret,
        nowMs: NOW_MS,
      }),
    ).toThrow(WebhookVerificationError);
  });

  it('accepts one of several space-separated signatures', () => {
    const header = `v1,${Buffer.from('wrong').toString('base64')} v1,${sign('msg_2', NOW_SECONDS, BODY)}`;
    expect(
      verifyStandardWebhook('dodo', {
        rawBody: BODY,
        headers: { 'webhook-id': 'msg_2', 'webhook-timestamp': String(NOW_SECONDS), 'webhook-signature': header },
        secret,
        nowMs: NOW_MS,
      }).verified,
    ).toBe(true);
  });

  it('rejects a stale timestamp', () => {
    const old = NOW_SECONDS - 900;
    expect(() =>
      verifyStandardWebhook('linq', {
        rawBody: BODY,
        headers: {
          'webhook-id': 'msg_3',
          'webhook-timestamp': String(old),
          'webhook-signature': `v1,${sign('msg_3', old, BODY)}`,
        },
        secret,
        nowMs: NOW_MS,
      }),
    ).toThrow(/replay window/);
  });

  it('rejects when no v1 entry is present', () => {
    expect(() =>
      verifyStandardWebhook('whop', {
        rawBody: BODY,
        headers: {
          'webhook-id': 'msg_4',
          'webhook-timestamp': String(NOW_SECONDS),
          'webhook-signature': `v2,${sign('msg_4', NOW_SECONDS, BODY)}`,
        },
        secret,
        nowMs: NOW_MS,
      }),
    ).toThrow(/no v1 signature/);
  });

  it('rejects missing headers', () => {
    expect(() =>
      verifyStandardWebhook('whop', { rawBody: BODY, headers: { 'webhook-id': 'msg_5' }, secret, nowMs: NOW_MS }),
    ).toThrow(/missing webhook-id/);
  });

  it('handles a plain (non-base64) secret without a whsec_ prefix', () => {
    const plain = new Secret('LINQ_WEBHOOK_SECRET', 'plaintextsecret', 'unknown');
    const sig = createHmac('sha256', 'plaintextsecret').update(`msg_6.${NOW_SECONDS}.${BODY}`).digest('base64');
    expect(
      verifyStandardWebhook('linq', {
        rawBody: BODY,
        headers: { 'webhook-id': 'msg_6', 'webhook-timestamp': String(NOW_SECONDS), 'webhook-signature': `v1,${sig}` },
        secret: plain,
        nowMs: NOW_MS,
      }).verified,
    ).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* Terac                                                                       */
/* -------------------------------------------------------------------------- */

describe('Terac signature verification', () => {
  const secret = new Secret('TERAC_WEBHOOK_SECRET', 'terac-signing-secret', 'unknown');

  // Terac's own Node snippet concatenates timestamp and body with no separator.
  function sign(timestamp: number, body: string, key = 'terac-signing-secret'): string {
    return createHmac('sha256', key).update(`${timestamp}${body}`).digest('base64');
  }

  it('accepts a correctly signed payload using the documented no-separator layout', () => {
    const result = verifyTeracSignature({
      rawBody: BODY,
      headers: {
        'x-terac-request-signature': sign(NOW_SECONDS, BODY),
        'x-terac-request-timestamp': String(NOW_SECONDS),
        'x-event-id': 'dlv_7h3k9',
      },
      secret,
      nowMs: NOW_MS,
    });
    expect(result.verified).toBe(true);
    expect(result.eventId).toBe('dlv_7h3k9');
  });

  it('rejects the dot-separated layout, confirming we implemented the documented one', () => {
    const wrongLayout = createHmac('sha256', 'terac-signing-secret')
      .update(`${NOW_SECONDS}.${BODY}`)
      .digest('base64');
    expect(() =>
      verifyTeracSignature({
        rawBody: BODY,
        headers: { 'x-terac-request-signature': wrongLayout, 'x-terac-request-timestamp': String(NOW_SECONDS) },
        secret,
        nowMs: NOW_MS,
      }),
    ).toThrow(/signature mismatch/);
  });

  it('rejects a stale timestamp', () => {
    const old = NOW_SECONDS - 1000;
    expect(() =>
      verifyTeracSignature({
        rawBody: BODY,
        headers: { 'x-terac-request-signature': sign(old, BODY), 'x-terac-request-timestamp': String(old) },
        secret,
        nowMs: NOW_MS,
      }),
    ).toThrow(/replay window/);
  });

  it('rejects a missing signature header', () => {
    expect(() =>
      verifyTeracSignature({
        rawBody: BODY,
        headers: { 'x-terac-request-timestamp': String(NOW_SECONDS) },
        secret,
        nowMs: NOW_MS,
      }),
    ).toThrow(/missing X-Terac-Request-Signature/);
  });
});

/* -------------------------------------------------------------------------- */
/* Lovable and Sandbox0 — schemes with recorded uncertainty                    */
/* -------------------------------------------------------------------------- */

describe('Lovable signature verification', () => {
  const secret = new Secret('LOVABLE_WEBHOOK_SECRET', 'lovable-key', 'unknown');

  it('accepts a hex digest over timestamp.body', () => {
    const sig = createHmac('sha256', 'lovable-key').update(`${NOW_SECONDS}.${BODY}`).digest('hex');
    expect(
      verifyLovableSignature({
        rawBody: BODY,
        headers: { 'x-lovable-signature': sig, 'x-lovable-timestamp': String(NOW_SECONDS) },
        secret,
        nowMs: NOW_MS,
      }).verified,
    ).toBe(true);
  });

  it('accepts a base64 digest, because the encoding is not documented', () => {
    const sig = createHmac('sha256', 'lovable-key').update(`${NOW_SECONDS}.${BODY}`).digest('base64');
    expect(
      verifyLovableSignature({
        rawBody: BODY,
        headers: { 'x-lovable-signature': sig, 'x-lovable-timestamp': String(NOW_SECONDS) },
        secret,
        nowMs: NOW_MS,
      }).verified,
    ).toBe(true);
  });

  it('still rejects a wrong secret despite accepting either encoding', () => {
    const sig = createHmac('sha256', 'not-the-key').update(`${NOW_SECONDS}.${BODY}`).digest('hex');
    expect(() =>
      verifyLovableSignature({
        rawBody: BODY,
        headers: { 'x-lovable-signature': sig, 'x-lovable-timestamp': String(NOW_SECONDS) },
        secret,
        nowMs: NOW_MS,
      }),
    ).toThrow(/signature mismatch/);
  });
});

describe('Sandbox0 signature verification', () => {
  const secret = new Secret('SANDBOX0_WEBHOOK_SECRET', 'sandbox0-key', 'unknown');

  it('accepts a hex digest over the raw body when no timestamp header is sent', () => {
    const sig = createHmac('sha256', 'sandbox0-key').update(BODY).digest('hex');
    expect(
      verifySandbox0Signature({
        rawBody: BODY,
        headers: { 'x-sandbox0-signature': sig },
        secret,
        nowMs: NOW_MS,
      }).verified,
    ).toBe(true);
  });

  it('accepts the timestamped layout when a timestamp header is sent', () => {
    const sig = createHmac('sha256', 'sandbox0-key').update(`${NOW_SECONDS}.${BODY}`).digest('base64');
    expect(
      verifySandbox0Signature({
        rawBody: BODY,
        headers: { 'x-sandbox0-signature': sig, 'x-sandbox0-timestamp': String(NOW_SECONDS) },
        secret,
        nowMs: NOW_MS,
      }).verified,
    ).toBe(true);
  });

  it('rejects a wrong secret across every accepted layout', () => {
    const sig = createHmac('sha256', 'wrong').update(BODY).digest('hex');
    expect(() =>
      verifySandbox0Signature({ rawBody: BODY, headers: { 'x-sandbox0-signature': sig }, secret, nowMs: NOW_MS }),
    ).toThrow(/signature mismatch across all documented-plausible layouts/);
  });
});
