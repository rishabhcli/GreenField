/**
 * Stripe webhook HTTP contract: raw bytes, v1 signature, 400 / 503 / duplicate.
 *
 * The route lives in webhooks.ts (shared). These tests pin the Stripe arm of
 * that surface so a splice cannot silently change money-authority status codes.
 */

import { createHmac } from 'node:crypto';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { Secret } from '@foundry/core';
import { registerErrorHandler } from '../src/errors.js';
import { registerWebhookRoutes } from '../src/routes/webhooks.js';
import type { AppContext } from '@foundry/runtime';

const WEBHOOK_SECRET = 'whsec_testsecretvalue';
const BODY = JSON.stringify({
  id: 'evt_test_duplicate',
  object: 'event',
  type: 'checkout.session.completed',
  data: { object: { id: 'cs_test_a1' } },
});

function sign(body: string, timestamp: number): string {
  return createHmac('sha256', WEBHOOK_SECRET).update(`${timestamp}.${body}`).digest('hex');
}

function webhookCtx(opts: {
  readonly hasSecret: boolean;
  readonly isDuplicate?: boolean;
}): AppContext {
  const recorded: unknown[] = [];
  const enqueued: unknown[] = [];
  return {
    secrets: {
      tryGet: () => (opts.hasSecret ? new Secret('STRIPE_WEBHOOK_SECRET', WEBHOOK_SECRET, 'test') : undefined),
    },
    repos: {
      webhooks: {
        recordIfNew: async (row: unknown) => {
          recorded.push(row);
          return {
            isNew: opts.isDuplicate ? false : true,
            event: { id: 'whk_1', company_id: 'co_1' },
          };
        },
        stuckEvents: async () => [],
      },
    },
    queues: {
      enqueue: async (queue: string, payload: unknown) => {
        enqueued.push({ queue, payload });
      },
    },
    recorded,
    enqueued,
  } as unknown as AppContext;
}

async function appWith(ctx: AppContext) {
  const app = Fastify({ logger: false });
  registerErrorHandler(app);
  await registerWebhookRoutes(app, ctx);
  return app;
}

describe('POST /webhooks/stripe', () => {
  it('returns 503 when STRIPE_WEBHOOK_SECRET is missing', async () => {
    const app = await appWith(webhookCtx({ hasSecret: false }));
    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/stripe',
      headers: { 'content-type': 'application/json' },
      payload: BODY,
    });
    expect(response.statusCode).toBe(503);
    expect(response.json().error).toMatch(/STRIPE_WEBHOOK_SECRET/);
    await app.close();
  });

  it('returns 400 on a bad Stripe-Signature (v1), not 401', async () => {
    const app = await appWith(webhookCtx({ hasSecret: true }));
    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/stripe',
      headers: {
        'content-type': 'application/json',
        'stripe-signature': `t=${Math.floor(Date.now() / 1000)},v1=${'ab'.repeat(32)}`,
      },
      payload: BODY,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatch(/Signature verification failed/);
    await app.close();
  });

  it('returns 200 { duplicate: true } on a redelivery', async () => {
    const ctx = webhookCtx({ hasSecret: true, isDuplicate: true });
    const app = await appWith(ctx);
    const timestamp = Math.floor(Date.now() / 1000);
    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/stripe',
      headers: {
        'content-type': 'application/json',
        'stripe-signature': `t=${timestamp},v1=${sign(BODY, timestamp)}`,
      },
      payload: BODY,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ received: true, duplicate: true });
    expect((ctx as unknown as { enqueued: unknown[] }).enqueued).toHaveLength(0);
    await app.close();
  });
});
