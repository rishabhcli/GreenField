/**
 * Operator-gated `/metrics`, open health probes, and CORS wiring.
 *
 * The CORS helper is unit-tested in `http-policy.test.ts`. This file injects
 * the real Fastify plugins so a mis-registered callback cannot hide behind a
 * helper that is correct in isolation.
 */

import cors from '@fastify/cors';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import type { AppContext } from '@foundry/runtime';
import { registerErrorHandler } from '../src/errors.js';
import { corsAllowsOrigin } from '../src/http-policy.js';
import { registerReadinessRoutes } from '../src/routes/readiness.js';

function mockCtx(token?: string): AppContext {
  return {
    config: {
      operatorApiToken: token,
      environment: 'preview',
      releaseSha: 'test-sha',
    },
    health: {
      liveness: () => ({ state: 'healthy', release: 'test-sha', uptimeSeconds: 1 }),
      readiness: async () => ({
        state: 'healthy',
        checks: [],
        release: 'test-sha',
        uptimeSeconds: 1,
        checkedAt: '2026-08-15T00:00:00.000Z',
      }),
    },
    providers: { publishCapabilityMetrics: () => undefined },
  } as unknown as AppContext;
}

async function appWithReadiness(token?: string) {
  const app = Fastify({ logger: false });
  registerErrorHandler(app);
  await registerReadinessRoutes(app, mockCtx(token));
  return app;
}

describe('/metrics requires the operator token', () => {
  it('refuses when no token is configured (fail closed)', async () => {
    const app = await appWithReadiness(undefined);
    const response = await app.inject({ method: 'GET', url: '/metrics' });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('policy_denied');
    await app.close();
  });

  it('refuses a missing or wrong bearer token', async () => {
    const app = await appWithReadiness('correct-token');
    const missing = await app.inject({ method: 'GET', url: '/metrics' });
    expect(missing.statusCode).toBe(403);

    const wrong = await app.inject({
      method: 'GET',
      url: '/metrics',
      headers: { authorization: 'Bearer wrong-token' },
    });
    expect(wrong.statusCode).toBe(403);
    await app.close();
  });

  it('returns Prometheus text when the token matches', async () => {
    const app = await appWithReadiness('correct-token');
    const response = await app.inject({
      method: 'GET',
      url: '/metrics',
      headers: { authorization: 'Bearer correct-token' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toMatch(/text\/plain/);
    expect(response.body).toContain('# TYPE');
    await app.close();
  });

  it('leaves /health and /ready unauthenticated', async () => {
    const app = await appWithReadiness(undefined);
    const health = await app.inject({ method: 'GET', url: '/health' });
    const ready = await app.inject({ method: 'GET', url: '/ready' });
    expect(health.statusCode).toBe(200);
    expect(ready.statusCode).toBe(200);
    await app.close();
  });
});

describe('CORS plugin wiring', () => {
  const allowlist = ['https://shop.example.test'];

  async function appWithCors(failClosed: boolean) {
    const app = Fastify({ logger: false });
    await app.register(cors, {
      origin: (origin, cb) =>
        cb(null, corsAllowsOrigin(origin, { allowlist, failClosed })),
      credentials: false,
    });
    app.get('/ping', async () => ({ ok: true }));
    return app;
  }

  it('reflects a listed origin when fail-closed', async () => {
    const app = await appWithCors(true);
    const response = await app.inject({
      method: 'GET',
      url: '/ping',
      headers: { origin: 'https://shop.example.test' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['access-control-allow-origin']).toBe('https://shop.example.test');
    await app.close();
  });

  it('does not reflect an unknown origin when fail-closed', async () => {
    const app = await appWithCors(true);
    const response = await app.inject({
      method: 'GET',
      url: '/ping',
      headers: { origin: 'https://evil.example' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
    await app.close();
  });

  it('serves requests with no Origin (webhooks, health, curl)', async () => {
    const app = await appWithCors(true);
    const response = await app.inject({ method: 'GET', url: '/ping' });
    expect(response.statusCode).toBe(200);
    await app.close();
  });
});
