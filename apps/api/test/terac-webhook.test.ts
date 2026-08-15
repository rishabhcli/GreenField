/**
 * POST /webhooks/terac: HMAC over timestamp+rawBody, 400 on bad sig, 503 if
 * secret missing, 200 duplicate. Does not process inline.
 */

import { createHmac } from 'node:crypto';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { Secret } from '@foundry/core';
import { SECRETS } from '@foundry/providers';
import type { AppContext } from '@foundry/runtime';
import { registerErrorHandler } from '../src/errors.js';
import { registerWebhookRoutes } from '../src/routes/webhooks.js';

const WEBHOOK_SECRET = 'terac-signing-secret';

function sign(timestamp: number, body: string): string {
  return createHmac('sha256', WEBHOOK_SECRET).update(`${timestamp}${body}`).digest('base64');
}

async function appWithTerac(options: {
  readonly secret?: Secret;
  readonly seen?: Set<string>;
}) {
  const seen = options.seen ?? new Set<string>();
  const enqueued: unknown[] = [];
  const ctx = {
    secrets: {
      tryGet: (spec: { env: string }) =>
        spec.env === SECRETS.teracWebhookSecret.env ? options.secret : undefined,
    },
    repos: {
      webhooks: {
        recordIfNew: async (input: { externalEventId: string }) => {
          const isNew = !seen.has(input.externalEventId);
          seen.add(input.externalEventId);
          return {
            isNew,
            event: { id: `whe_${input.externalEventId}`, company_id: null },
          };
        },
      },
    },
    queues: {
      enqueue: async (queue: string, payload: unknown) => {
        enqueued.push({ queue, payload });
        return 'job_1';
      },
    },
  } as unknown as AppContext;

  const app = Fastify({ logger: false });
  registerErrorHandler(app);
  await registerWebhookRoutes(app, ctx);
  return { app, enqueued, seen };
}

describe('POST /webhooks/terac', () => {
  const body = JSON.stringify({
    event_id: 'evt_terac_1',
    event_type: 'submission.status.change',
    opportunity_id: 'opp_1',
  });

  it('returns 503 when TERAC_WEBHOOK_SECRET is missing', async () => {
    const { app } = await appWithTerac({ secret: undefined });
    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/terac',
      headers: { 'content-type': 'application/json' },
      payload: Buffer.from(body),
    });
    expect(response.statusCode).toBe(503);
    expect(response.json().error).toMatch(/TERAC_WEBHOOK_SECRET/);
    await app.close();
  });

  it('returns 400 on a bad HMAC', async () => {
    const timestamp = Math.floor(Date.now() / 1000);
    const { app } = await appWithTerac({
      secret: new Secret('TERAC_WEBHOOK_SECRET', WEBHOOK_SECRET, 'unknown'),
    });
    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/terac',
      headers: {
        'content-type': 'application/json',
        'x-terac-request-timestamp': String(timestamp),
        'x-terac-request-signature': 'not-a-valid-hmac',
      },
      payload: Buffer.from(body),
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatch(/Signature verification failed/);
    await app.close();
  });

  it('accepts a correctly signed body and acknowledges a redelivery as duplicate', async () => {
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = sign(timestamp, body);
    const secret = new Secret('TERAC_WEBHOOK_SECRET', WEBHOOK_SECRET, 'unknown');
    const seen = new Set<string>();
    const { app, enqueued } = await appWithTerac({ secret, seen });
    const headers = {
      'content-type': 'application/json',
      'x-terac-request-timestamp': String(timestamp),
      'x-terac-request-signature': signature,
      'x-event-id': 'evt_terac_1',
    };

    const first = await app.inject({
      method: 'POST',
      url: '/webhooks/terac',
      headers,
      payload: Buffer.from(body),
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ received: true, duplicate: false });
    expect(enqueued).toHaveLength(1);
    expect((enqueued[0] as { queue: string }).queue).toBe('commerce.webhook');

    const second = await app.inject({
      method: 'POST',
      url: '/webhooks/terac',
      headers,
      payload: Buffer.from(body),
    });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual({ received: true, duplicate: true });
    expect(enqueued).toHaveLength(1);
    await app.close();
  });
});
