/**
 * The webhook raw-body parser must not escape the webhook routes.
 *
 * `registerWebhookRoutes` installs `addContentTypeParser('application/json',
 * { parseAs: 'buffer' })` because every signature scheme signs the exact bytes.
 * Fastify applies a content-type parser to the instance it is called on, so
 * when `index.ts` called `registerWebhookRoutes(app, ctx)` directly on the root
 * app, that parser became global: every other route received `request.body` as
 * a Buffer. A Zod `.parse()` on a Buffer sees an object with none of its fields,
 * so `PUT /api/budgets` returned a validation error listing every field as
 * missing, and the same failure silently broke the approve/deny writes, the
 * kill-switch release, and `POST /api/checkout` — the money path.
 *
 * The fix is to register the webhook routes as an encapsulated plugin. These
 * tests pin both halves of that: JSON stays parsed everywhere else, and the
 * webhook route still sees the exact bytes it must verify a signature against.
 */

import Fastify, { type FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { Secret } from '@foundry/core';
import { registerErrorHandler } from '../src/errors.js';
import { registerWebhookRoutes } from '../src/routes/webhooks.js';
import type { AppContext } from '@foundry/runtime';

function ctxStub(): AppContext {
  return {
    secrets: { tryGet: () => new Secret('STRIPE_WEBHOOK_SECRET', 'whsec_x', 'test') },
    repos: {
      webhooks: {
        recordIfNew: async () => ({ isNew: true, event: { id: 'whk_1', company_id: 'co_1' } }),
        stuckEvents: async () => [],
      },
    },
    queues: { enqueue: async () => undefined },
  } as unknown as AppContext;
}

/** Mirrors how apps/api/src/index.ts wires the two together. */
async function buildApp(): Promise<{ app: FastifyInstance; seenByWebhook: { value: unknown } }> {
  const app = Fastify({ logger: false });
  registerErrorHandler(app);

  const seenByWebhook = { value: undefined as unknown };
  await app.register(async (instance) => {
    await registerWebhookRoutes(instance, ctxStub());
    instance.post('/webhooks/__probe', async (request) => {
      seenByWebhook.value = request.body;
      return { ok: true };
    });
  });

  app.post('/api/__probe', async (request) => ({ body: request.body }));

  return { app, seenByWebhook };
}

describe('webhook raw-body parser encapsulation', () => {
  it('leaves JSON parsed on non-webhook routes', async () => {
    const { app } = await buildApp();

    const response = await app.inject({
      method: 'POST',
      url: '/api/__probe',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ scope: 'company_total', limitMinor: 200000 }),
    });

    expect(response.statusCode).toBe(200);
    // The regression this guards: a Buffer here instead of the object.
    expect(response.json()).toEqual({ body: { scope: 'company_total', limitMinor: 200000 } });
  });

  it('still hands the webhook route the exact bytes', async () => {
    const { app, seenByWebhook } = await buildApp();
    const raw = JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed' });

    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/__probe',
      headers: { 'content-type': 'application/json' },
      payload: raw,
    });

    expect(response.statusCode).toBe(200);
    expect(Buffer.isBuffer(seenByWebhook.value)).toBe(true);
    expect((seenByWebhook.value as Buffer).toString('utf8')).toBe(raw);
  });
});
