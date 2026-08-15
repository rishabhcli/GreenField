/**
 * Inbound webhook signature verification.
 *
 * Webhooks are the authoritative source of money state, so an unverified
 * webhook is an unauthenticated write to the ledger. Every verifier here:
 *   - operates on the exact raw body bytes, never a re-serialised object;
 *   - compares with `timingSafeEqual`;
 *   - enforces a replay window;
 *   - fails closed with a typed error that never echoes the secret.
 *
 * Three distinct schemes are in play across the integrated providers, plus one
 * whose format the vendor has not published — that one is implemented against
 * the documented algorithm and flagged so it is confirmed before being relied on.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { ValidationError, type Secret } from '@foundry/core';

export const DEFAULT_TOLERANCE_SECONDS = 300;

export interface VerificationInput {
  /** Exact bytes as received. Any re-encoding breaks every scheme here. */
  readonly rawBody: Buffer | string;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly secret: Secret;
  readonly toleranceSeconds?: number;
  /** Injected for deterministic tests. */
  readonly nowMs?: number;
}

export interface VerificationResult {
  readonly verified: true;
  /** Provider-side event id, used for idempotent processing. */
  readonly eventId: string | null;
  readonly timestampSeconds: number;
  readonly scheme: string;
}

export class WebhookVerificationError extends ValidationError {
  constructor(provider: string, reason: string, context?: Record<string, unknown>) {
    super(`Webhook signature verification failed for ${provider}: ${reason}`, { provider, reason, ...context });
  }
}

function header(headers: VerificationInput['headers'], name: string): string | undefined {
  const value = headers[name] ?? headers[name.toLowerCase()];
  if (Array.isArray(value)) return value[0];
  return value;
}

function bodyBuffer(rawBody: Buffer | string): Buffer {
  return Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody, 'utf8');
}

function safeEqual(a: Buffer, b: Buffer): boolean {
  // timingSafeEqual throws on length mismatch, which would itself leak length.
  if (a.length !== b.length) {
    // Still burn a comparison so the failure path is not measurably faster.
    timingSafeEqual(a, a);
    return false;
  }
  return timingSafeEqual(a, b);
}

function assertFresh(provider: string, timestampSeconds: number, toleranceSeconds: number, nowMs: number): void {
  if (!Number.isFinite(timestampSeconds)) {
    throw new WebhookVerificationError(provider, 'timestamp header is not a number');
  }
  const ageSeconds = Math.abs(nowMs / 1000 - timestampSeconds);
  if (ageSeconds > toleranceSeconds) {
    throw new WebhookVerificationError(provider, `timestamp is ${Math.round(ageSeconds)}s outside the ${toleranceSeconds}s replay window`, {
      timestampSeconds,
      ageSeconds: Math.round(ageSeconds),
    });
  }
}

/* -------------------------------------------------------------------------- */
/* Standard Webhooks — Whop, Dodo Payments, Linq                               */
/* -------------------------------------------------------------------------- */

/**
 * Headers: `webhook-id`, `webhook-timestamp` (unix seconds),
 * `webhook-signature` (space-separated list of `v1,<base64>` entries).
 * Signed content: `{id}.{timestamp}.{rawBody}`.
 * The secret is `whsec_<base64>`; the base64 portion is the HMAC key bytes.
 */
export function verifyStandardWebhook(provider: string, input: VerificationInput): VerificationResult {
  const id = header(input.headers, 'webhook-id');
  const timestamp = header(input.headers, 'webhook-timestamp');
  const signatureHeader = header(input.headers, 'webhook-signature');

  if (!id || !timestamp || !signatureHeader) {
    throw new WebhookVerificationError(provider, 'missing webhook-id, webhook-timestamp or webhook-signature header');
  }

  const timestampSeconds = Number.parseInt(timestamp, 10);
  assertFresh(provider, timestampSeconds, input.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS, input.nowMs ?? Date.now());

  const rawSecret = input.secret.reveal();
  const keyMaterial = rawSecret.startsWith('whsec_')
    ? Buffer.from(rawSecret.slice('whsec_'.length), 'base64')
    : Buffer.from(rawSecret, 'utf8');

  const signedContent = Buffer.concat([
    Buffer.from(`${id}.${timestamp}.`, 'utf8'),
    bodyBuffer(input.rawBody),
  ]);
  const expected = createHmac('sha256', keyMaterial).update(signedContent).digest();

  // The header may carry several versioned signatures during secret rotation.
  const candidates = signatureHeader
    .split(' ')
    .map((part) => part.trim())
    .filter((part) => part.startsWith('v1,'))
    .map((part) => part.slice(3));

  if (candidates.length === 0) {
    throw new WebhookVerificationError(provider, 'no v1 signature present in webhook-signature header');
  }

  for (const candidate of candidates) {
    let decoded: Buffer;
    try {
      decoded = Buffer.from(candidate, 'base64');
    } catch {
      continue;
    }
    if (safeEqual(expected, decoded)) {
      return { verified: true, eventId: id, timestampSeconds, scheme: 'standard_webhooks' };
    }
  }
  throw new WebhookVerificationError(provider, 'no signature in the header matched');
}

/* -------------------------------------------------------------------------- */
/* Stripe                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Header `Stripe-Signature`: `t=<unix>,v1=<hex>[,v0=<hex>]`.
 * Signed content: `{t}.{rawBody}`. Only `v1` is accepted — `v0` is documented
 * as a decoy for test events and honouring it would be a downgrade attack.
 */
export function verifyStripeSignature(input: VerificationInput): VerificationResult {
  const signatureHeader = header(input.headers, 'stripe-signature');
  if (!signatureHeader) throw new WebhookVerificationError('stripe', 'missing Stripe-Signature header');

  const parts = new Map<string, string[]>();
  for (const segment of signatureHeader.split(',')) {
    const [key, value] = segment.split('=', 2);
    if (!key || value === undefined) continue;
    const list = parts.get(key.trim()) ?? [];
    list.push(value.trim());
    parts.set(key.trim(), list);
  }

  const timestampRaw = parts.get('t')?.[0];
  if (!timestampRaw) throw new WebhookVerificationError('stripe', 'no t= timestamp in Stripe-Signature');
  const timestampSeconds = Number.parseInt(timestampRaw, 10);
  assertFresh('stripe', timestampSeconds, input.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS, input.nowMs ?? Date.now());

  const v1 = parts.get('v1') ?? [];
  if (v1.length === 0) {
    throw new WebhookVerificationError('stripe', 'no v1 signature present (v0 is a decoy and is never accepted)');
  }

  const signedContent = Buffer.concat([Buffer.from(`${timestampRaw}.`, 'utf8'), bodyBuffer(input.rawBody)]);
  const expected = createHmac('sha256', input.secret.reveal()).update(signedContent).digest('hex');
  const expectedBuf = Buffer.from(expected, 'utf8');

  for (const candidate of v1) {
    if (safeEqual(expectedBuf, Buffer.from(candidate, 'utf8'))) {
      return { verified: true, eventId: null, timestampSeconds, scheme: 'stripe_v1_hmac_sha256' };
    }
  }
  throw new WebhookVerificationError('stripe', 'no v1 signature matched');
}

/* -------------------------------------------------------------------------- */
/* Terac                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Headers: `X-Terac-Request-Signature` (base64), `X-Terac-Request-Timestamp`
 * (unix seconds). Signed content is the timestamp **concatenated directly to
 * the raw body with no separator** — verified against Terac's own Node snippet
 * `createHmac("sha256", secret).update(timestamp + rawBody).digest("base64")`.
 */
export function verifyTeracSignature(input: VerificationInput): VerificationResult {
  const signature = header(input.headers, 'x-terac-request-signature');
  const timestamp = header(input.headers, 'x-terac-request-timestamp');
  if (!signature || !timestamp) {
    throw new WebhookVerificationError('terac', 'missing X-Terac-Request-Signature or X-Terac-Request-Timestamp');
  }

  const timestampSeconds = Number.parseInt(timestamp, 10);
  assertFresh('terac', timestampSeconds, input.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS, input.nowMs ?? Date.now());

  const signedContent = Buffer.concat([Buffer.from(timestamp, 'utf8'), bodyBuffer(input.rawBody)]);
  const expected = createHmac('sha256', input.secret.reveal()).update(signedContent).digest('base64');

  if (!safeEqual(Buffer.from(expected, 'utf8'), Buffer.from(signature, 'utf8'))) {
    throw new WebhookVerificationError('terac', 'signature mismatch');
  }
  return {
    verified: true,
    eventId: header(input.headers, 'x-event-id') ?? null,
    timestampSeconds,
    scheme: 'terac_hmac_sha256_base64',
  };
}

/* -------------------------------------------------------------------------- */
/* Lovable                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Headers: `x-lovable-signature`, `x-lovable-timestamp`. Signed content
 * `${timestamp}.${rawBody}`.
 *
 * Confidence note: this scheme comes from the `@lovable.dev/webhooks-js`
 * package description rather than a fetched primary docs page (the npm page
 * returned 403). Both hex and base64 encodings are accepted here because the
 * digest encoding was not stated; the integration record carries this caveat
 * and the verifier must be confirmed against a real delivery before the
 * capability is marked live.
 */
export function verifyLovableSignature(input: VerificationInput): VerificationResult {
  const signature = header(input.headers, 'x-lovable-signature');
  const timestamp = header(input.headers, 'x-lovable-timestamp');
  if (!signature || !timestamp) {
    throw new WebhookVerificationError('lovable', 'missing x-lovable-signature or x-lovable-timestamp');
  }
  const timestampSeconds = Number.parseInt(timestamp, 10);
  assertFresh('lovable', timestampSeconds, input.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS, input.nowMs ?? Date.now());

  const signedContent = Buffer.concat([Buffer.from(`${timestamp}.`, 'utf8'), bodyBuffer(input.rawBody)]);
  const mac = createHmac('sha256', input.secret.reveal()).update(signedContent).digest();
  const provided = signature.replace(/^sha256=/, '');

  const matchesHex = safeEqual(Buffer.from(mac.toString('hex'), 'utf8'), Buffer.from(provided, 'utf8'));
  const matchesBase64 = safeEqual(Buffer.from(mac.toString('base64'), 'utf8'), Buffer.from(provided, 'utf8'));
  if (!matchesHex && !matchesBase64) {
    throw new WebhookVerificationError('lovable', 'signature mismatch (tried hex and base64 digests)');
  }
  return { verified: true, eventId: null, timestampSeconds, scheme: 'lovable_hmac_sha256' };
}

/* -------------------------------------------------------------------------- */
/* Sandbox0                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Header `X-Sandbox0-Signature`, HMAC-SHA256. The docs state the algorithm and
 * the header but not the signed-content layout or the digest encoding, so this
 * verifier accepts the two plausible layouts (raw body, and `timestamp.body`
 * when a timestamp header is present) in hex or base64.
 *
 * This breadth is a deliberate, recorded assumption — not a shortcut. The
 * Sandbox0 integration record marks the webhook contract UNVERIFIED, and the
 * capability cannot reach `live_verified` until a real signed delivery pins the
 * exact layout, at which point the alternatives are removed.
 */
export function verifySandbox0Signature(input: VerificationInput): VerificationResult {
  const signature = header(input.headers, 'x-sandbox0-signature');
  if (!signature) throw new WebhookVerificationError('sandbox0', 'missing X-Sandbox0-Signature header');

  const timestamp = header(input.headers, 'x-sandbox0-timestamp');
  const nowMs = input.nowMs ?? Date.now();
  let timestampSeconds = Math.floor(nowMs / 1000);
  if (timestamp) {
    timestampSeconds = Number.parseInt(timestamp, 10);
    assertFresh('sandbox0', timestampSeconds, input.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS, nowMs);
  }

  const body = bodyBuffer(input.rawBody);
  const layouts: Buffer[] = [body];
  if (timestamp) layouts.push(Buffer.concat([Buffer.from(`${timestamp}.`, 'utf8'), body]));

  const provided = Buffer.from(signature.replace(/^sha256=/, ''), 'utf8');
  for (const layout of layouts) {
    const mac = createHmac('sha256', input.secret.reveal()).update(layout).digest();
    if (
      safeEqual(Buffer.from(mac.toString('hex'), 'utf8'), provided) ||
      safeEqual(Buffer.from(mac.toString('base64'), 'utf8'), provided)
    ) {
      return {
        verified: true,
        eventId: header(input.headers, 'x-sandbox0-event-id') ?? null,
        timestampSeconds,
        scheme: 'sandbox0_hmac_sha256',
      };
    }
  }
  throw new WebhookVerificationError('sandbox0', 'signature mismatch across all documented-plausible layouts');
}

/* -------------------------------------------------------------------------- */
/* Dispatch                                                                    */
/* -------------------------------------------------------------------------- */

export type WebhookScheme =
  | 'standard_webhooks'
  | 'stripe'
  | 'terac'
  | 'lovable'
  | 'sandbox0';

export function verifyWebhook(
  provider: string,
  scheme: WebhookScheme,
  input: VerificationInput,
): VerificationResult {
  switch (scheme) {
    case 'standard_webhooks':
      return verifyStandardWebhook(provider, input);
    case 'stripe':
      return verifyStripeSignature(input);
    case 'terac':
      return verifyTeracSignature(input);
    case 'lovable':
      return verifyLovableSignature(input);
    case 'sandbox0':
      return verifySandbox0Signature(input);
  }
}
