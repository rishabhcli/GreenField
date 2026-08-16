/**
 * Operator-gated control-plane routes, open health/storefront probes, and CORS.
 *
 * The CORS helper is unit-tested in `http-policy.test.ts`. This file injects
 * the real Fastify plugins so a mis-registered callback cannot hide behind a
 * helper that is correct in isolation.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import cors from '@fastify/cors';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import type { AppContext, Services } from '@foundry/runtime';
import { timingSafeEqual } from '../src/auth.js';
import { registerErrorHandler } from '../src/errors.js';
import { corsAllowsOrigin } from '../src/http-policy.js';
import { registerCommerceRoutes } from '../src/routes/commerce.js';
import { registerCompanyRoutes } from '../src/routes/company.js';
import { registerGovernanceRoutes } from '../src/routes/governance.js';
import { registerReadinessRoutes } from '../src/routes/readiness.js';
import { registerWebhookRoutes } from '../src/routes/webhooks.js';

const apiSrc = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

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

  it('refuses /readiness intel routes without the operator token', async () => {
    const app = await appWithReadiness('correct-token');
    for (const url of [
      '/readiness/capabilities',
      '/readiness/providers',
      '/readiness/secrets',
      '/readiness/company',
    ]) {
      const response = await app.inject({ method: 'GET', url });
      expect(response.statusCode, url).toBe(403);
      expect(response.json().error.code).toBe('policy_denied');
    }
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

const OPERATOR = 'correct-token';
const COMPANY_ID = 'co_01M03F7RQW2M6540BY2GZHCFBW';

function mustNotRun(name: string) {
  return async () => {
    throw new Error(`${name} must not run without operator auth`);
  };
}

function operatorCtx(token: string | undefined = OPERATOR): AppContext {
  const captured: {
    decidedBy?: string;
    engagedBy?: string;
    releasedBy?: string;
    auditActor?: string;
    auditLimit?: number;
    auditDetail?: Record<string, unknown>;
  } = {};
  const ctx = {
    captured,
    config: {
      operatorApiToken: token,
      corsAllowedOrigins: ['https://shop.example.test'],
      environment: 'preview',
      releaseSha: 'test-sha',
    },
    repos: {
      companies: {
        first: async () => ({ id: COMPANY_ID }),
        list: async () => [
          {
            id: COMPANY_ID,
            name: 'GreenField',
            stage: 'discover',
            selected_opportunity_id: null,
            active_brand_id: null,
            active_site_id: null,
          },
        ],
        byId: async () => ({
          id: COMPANY_ID,
          name: 'GreenField',
          mission: 'Operate without fabricated evidence.',
          stage: 'discover',
          selected_opportunity_id: null,
          active_brand_id: null,
          active_site_id: null,
        }),
        updateConfig: mustNotRun('companies.updateConfig'),
      },
      loop: {
        currentOrStart: async () => ({
          id: 'cyc_1',
          cycle_number: 1,
          phase: 'observe',
          status: 'running',
          blocked_reason: null,
          blocked_on_capability: null,
          ceo_decision: null,
        }),
        history: async () => [],
      },
      research: { opportunities: { list: async () => [] } },
      governance: {
        approvals: {
          listPending: mustNotRun('approvals.listPending'),
          decide: async (
            id: string,
            _decision: string,
            decidedBy: string,
            _rationale: string,
          ) => {
            captured.decidedBy = decidedBy;
            return {
              id,
              company_id: COMPANY_ID,
              request: 'purchase',
              authority: 'finance.spend',
              amount_minor: 100,
              currency: 'USD',
              status: 'approved',
              decided_at: '2026-08-15T00:00:00.000Z',
            };
          },
        },
        killSwitches: {
          history: mustNotRun('killSwitches.history'),
          engagedScopes: mustNotRun('killSwitches.engagedScopes'),
          engage: async (
            _companyId: string,
            scope: string,
            _reason: string,
            engagedBy: string,
          ) => {
            captured.engagedBy = engagedBy;
            return { id: 'ks_1', scope, engaged_at: '2026-08-15T00:00:00.000Z' };
          },
          release: async (_companyId: string, _scope: string, releasedBy: string) => {
            captured.releasedBy = releasedBy;
          },
        },
        budgets: {
          list: mustNotRun('budgets.list'),
          upsert: async () => ({
            id: 'bud_1',
            scope: 'research',
            window_kind: 'daily',
            limit_minor: 1,
          }),
        },
      },
      audit: {
        list: async (_companyId: string, query: { limit?: number }) => {
          captured.auditLimit = query.limit;
          return [];
        },
        append: async (event: { actorId: string; detail?: Record<string, unknown> }) => {
          captured.auditActor = event.actorId;
          captured.auditDetail = event.detail;
        },
        verifyChain: mustNotRun('audit.verifyChain'),
      },
      agents: {
        runs: {
          listActive: mustNotRun('agents.runs.listActive'),
          usageByRole: mustNotRun('agents.runs.usageByRole'),
          byId: mustNotRun('agents.runs.byId'),
          children: mustNotRun('agents.runs.children'),
        },
        messages: { forRun: mustNotRun('agents.messages.forRun') },
      },
      webhooks: { stuckEvents: mustNotRun('webhooks.stuckEvents') },
      commerce: {
        products: { listActive: async () => [], bySku: mustNotRun('products.bySku') },
        customers: { upsert: mustNotRun('customers.upsert') },
        orders: {
          byId: async () => ({
            id: 'ord_1',
            order_number: 'GF-1',
            status: 'PAID',
            amount_paid_minor: 2500,
            currency: 'USD',
            total_minor: 2500,
            amount_refunded_minor: 0,
            placed_at: '2026-08-15T00:00:00.000Z',
            paid_at: '2026-08-15T00:00:00.000Z',
            shipped_at: null,
            delivered_at: null,
          }),
          lineItems: async () => [],
          events: mustNotRun('orders.events'),
          listByStatus: mustNotRun('orders.listByStatus'),
        },
      },
    },
    queues: { enqueue: mustNotRun('queues.enqueue') },
    capabilities: { resolveCapability: () => ({}) },
    secrets: { tryGet: () => undefined },
  };
  return ctx as unknown as AppContext & { captured: typeof captured };
}

function capturedOf(ctx: AppContext): {
  decidedBy?: string;
  engagedBy?: string;
  releasedBy?: string;
  auditActor?: string;
  auditLimit?: number;
  auditDetail?: Record<string, unknown>;
} {
  return (ctx as unknown as { captured: Record<string, never> }).captured;
}

async function appWithGates(token?: string) {
  const ctx = operatorCtx(token);
  const app = Fastify({ logger: false });
  registerErrorHandler(app);
  await registerCompanyRoutes(app, ctx, {
    loop: { tick: mustNotRun('loop.tick') },
  } as unknown as Services);
  await registerGovernanceRoutes(app, ctx);
  await registerCommerceRoutes(app, ctx);
  return { app, ctx };
}

async function appWithWebhooks(token?: string) {
  const ctx = operatorCtx(token);
  const app = Fastify({ logger: false });
  registerErrorHandler(app);
  await registerWebhookRoutes(app, ctx);
  return { app, ctx };
}

describe('company mutators require the operator token', () => {
  const mutators: { method: 'POST' | 'PUT'; url: string; payload?: Record<string, unknown> }[] = [
    {
      method: 'POST',
      url: '/api/companies',
      payload: {
        name: 'GreenField',
        mission: 'Operate without fabricated evidence.',
        ownerName: 'Operator',
        ownerEmail: 'operator@greenfield.local',
      },
    },
    { method: 'PUT', url: `/api/companies/${COMPANY_ID}/config`, payload: { config: {} } },
    { method: 'POST', url: `/api/companies/${COMPANY_ID}/loop/tick` },
    {
      method: 'POST',
      url: `/api/companies/${COMPANY_ID}/research`,
      payload: { query: 'standing desks', sourceKinds: ['blog_post'] },
    },
  ];

  it.each(mutators)('$method $url is 403 without a bearer token', async ({ method, url, payload }) => {
    const { app } = await appWithGates(OPERATOR);
    const response = await app.inject({ method, url, payload });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('policy_denied');
    await app.close();
  });

  it('leaves GET company and prize-track reads unauthenticated and does not leak config', async () => {
    const { app } = await appWithGates(OPERATOR);
    const list = await app.inject({ method: 'GET', url: '/api/companies' });
    const one = await app.inject({ method: 'GET', url: `/api/companies/${COMPANY_ID}` });
    expect(list.statusCode).toBe(200);
    expect(one.statusCode).toBe(200);
    const body = one.json() as Record<string, unknown>;
    expect(body).not.toHaveProperty('config');
    expect(body).not.toHaveProperty('risk');
    expect(JSON.stringify(body)).not.toContain('maxOrderValueMinor');
    await app.close();
  });
});

describe('governance routes require the operator token', () => {
  const routes: { method: 'GET' | 'POST' | 'PUT'; url: string; payload?: Record<string, unknown> }[] = [
    { method: 'GET', url: '/api/approvals' },
    {
      method: 'POST',
      url: '/api/approvals/apr_1/decide',
      payload: { decision: 'approved', rationale: 'reviewed', decidedBy: 'attacker' },
    },
    { method: 'GET', url: '/api/kill-switches' },
    {
      method: 'POST',
      url: '/api/kill-switches/engage',
      payload: { scope: 'ad_spend', reason: 'pause ads', engagedBy: 'attacker' },
    },
    {
      method: 'POST',
      url: '/api/kill-switches/ad_spend/release',
      payload: { releasedBy: 'attacker' },
    },
    { method: 'GET', url: '/api/budgets' },
    {
      method: 'PUT',
      url: '/api/budgets',
      payload: { scope: 'research', window: 'daily', limitMinor: 1, currency: 'USD' },
    },
    { method: 'GET', url: '/api/audit' },
    { method: 'GET', url: '/api/audit/verify' },
    { method: 'GET', url: '/api/agent-runs' },
    { method: 'GET', url: '/api/agent-runs/run_1' },
    { method: 'GET', url: '/api/agent-activity' },
  ];

  it.each(routes)('$method $url is 403 without a bearer token', async ({ method, url, payload }) => {
    const { app } = await appWithGates(OPERATOR);
    const response = await app.inject({ method, url, payload });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('policy_denied');
    await app.close();
  });

  it('records the operator actor and ignores client decidedBy/engagedBy/releasedBy', async () => {
    const { app, ctx } = await appWithGates(OPERATOR);
    const headers = { authorization: `Bearer ${OPERATOR}` };

    const decided = await app.inject({
      method: 'POST',
      url: '/api/approvals/apr_1/decide',
      headers,
      payload: { decision: 'approved', rationale: 'reviewed', decidedBy: 'attacker' },
    });
    expect(decided.statusCode).toBe(200);
    expect(capturedOf(ctx).decidedBy).toBe('operator');
    expect(capturedOf(ctx).auditActor).toBe('operator');

    const engaged = await app.inject({
      method: 'POST',
      url: '/api/kill-switches/engage',
      headers,
      payload: { scope: 'ad_spend', reason: 'pause ads', engagedBy: 'attacker' },
    });
    expect(engaged.statusCode).toBe(200);
    expect(capturedOf(ctx).engagedBy).toBe('operator');

    const released = await app.inject({
      method: 'POST',
      url: '/api/kill-switches/ad_spend/release',
      headers,
      payload: { releasedBy: 'attacker' },
    });
    expect(released.statusCode).toBe(200);
    expect(capturedOf(ctx).releasedBy).toBe('operator');
    await app.close();
  });

  /**
   * A shared `OPERATOR_API_TOKEN` cannot distinguish two humans, so the console
   * lets one type their name. That name is an *annotation*: it goes into the
   * event's `detail`, never into `actor_id`. Promoting it would let anyone
   * holding the token write an arbitrary identity into the audit chain, which
   * is the thing the chain exists to prevent.
   */
  it('records a self-declared operator name as an annotation, never as the actor', async () => {
    const { app, ctx } = await appWithGates(OPERATOR);
    const headers = { authorization: `Bearer ${OPERATOR}` };

    const decided = await app.inject({
      method: 'POST',
      url: '/api/approvals/apr_1/decide',
      headers,
      payload: {
        decision: 'approved',
        rationale: 'reviewed',
        decidedBy: 'attacker',
        decidedByLabel: 'Rishabh Bansal',
      },
    });
    expect(decided.statusCode).toBe(200);
    expect(capturedOf(ctx).auditActor).toBe('operator');
    expect(capturedOf(ctx).decidedBy).toBe('operator');
    expect(capturedOf(ctx).auditDetail?.operatorLabel).toBe('Rishabh Bansal');

    const released = await app.inject({
      method: 'POST',
      url: '/api/kill-switches/ad_spend/release',
      headers,
      payload: { releasedBy: 'attacker', releasedByLabel: 'Rishabh Bansal' },
    });
    expect(released.statusCode).toBe(200);
    expect(capturedOf(ctx).releasedBy).toBe('operator');
    expect(capturedOf(ctx).auditDetail?.operatorLabel).toBe('Rishabh Bansal');
    await app.close();
  });

  it('omits the annotation entirely when no name is supplied', async () => {
    const { app, ctx } = await appWithGates(OPERATOR);
    const decided = await app.inject({
      method: 'POST',
      url: '/api/approvals/apr_1/decide',
      headers: { authorization: `Bearer ${OPERATOR}` },
      payload: { decision: 'approved', rationale: 'reviewed' },
    });
    expect(decided.statusCode).toBe(200);
    expect(capturedOf(ctx).auditDetail).not.toHaveProperty('operatorLabel');
    await app.close();
  });

  it('rejects an unusable label rather than silently dropping it', async () => {
    const { app } = await appWithGates(OPERATOR);
    const response = await app.inject({
      method: 'POST',
      url: '/api/approvals/apr_1/decide',
      headers: { authorization: `Bearer ${OPERATOR}` },
      payload: { decision: 'approved', rationale: 'reviewed', decidedByLabel: 'x' },
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it('bounds GET /api/audit limit to 1–500 and defaults to 100', async () => {
    const { app, ctx } = await appWithGates(OPERATOR);
    const headers = { authorization: `Bearer ${OPERATOR}` };

    const omitted = await app.inject({ method: 'GET', url: '/api/audit', headers });
    expect(omitted.statusCode).toBe(200);
    expect(capturedOf(ctx).auditLimit).toBe(100);

    const max = await app.inject({ method: 'GET', url: '/api/audit?limit=500', headers });
    expect(max.statusCode).toBe(200);
    expect(capturedOf(ctx).auditLimit).toBe(500);

    const huge = await app.inject({ method: 'GET', url: '/api/audit?limit=9999', headers });
    expect(huge.statusCode).toBe(400);
    expect(capturedOf(ctx).auditLimit).toBe(500);

    const zero = await app.inject({ method: 'GET', url: '/api/audit?limit=0', headers });
    expect(zero.statusCode).toBe(400);
    await app.close();
  });
});

describe('GET /webhooks/stuck requires the operator token', () => {
  it('refuses an unauthenticated caller', async () => {
    const { app } = await appWithWebhooks(OPERATOR);
    const response = await app.inject({ method: 'GET', url: '/webhooks/stuck' });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('policy_denied');
    await app.close();
  });
});

describe('commerce storefront stays public; list and events stay gated', () => {
  it('refuses GET /api/orders and GET /api/orders/:id/events without a token', async () => {
    const { app } = await appWithGates(OPERATOR);
    const list = await app.inject({ method: 'GET', url: '/api/orders' });
    const events = await app.inject({ method: 'GET', url: '/api/orders/ord_1/events' });
    expect(list.statusCode).toBe(403);
    expect(events.statusCode).toBe(403);
    await app.close();
  });

  it('serves GET /api/orders/:id without a token (confirmation page)', async () => {
    const { app } = await appWithGates(OPERATOR);
    const response = await app.inject({ method: 'GET', url: '/api/orders/ord_1' });
    expect(response.statusCode).toBe(200);
    expect(response.json().orderNumber).toBe('GF-1');
    await app.close();
  });

  it('rejects checkout redirects off the CORS allowlist before creating an order', async () => {
    const { app } = await appWithGates(OPERATOR);
    const response = await app.inject({
      method: 'POST',
      url: '/api/checkout',
      payload: {
        items: [{ sku: 'zhc-founding', quantity: 1 }],
        successUrl: 'https://evil.example/steal',
        cancelUrl: 'https://shop.example.test/cancel',
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('validation');
    expect(response.json().error.message).toMatch(/allowlist/i);
    await app.close();
  });
});

describe('timingSafeEqual does not early-return on length', () => {
  it('hashes both sides then uses crypto.timingSafeEqual', () => {
    const src = readFileSync(join(apiSrc, 'auth.ts'), 'utf8');
    expect(src).toMatch(/createHash\(\s*['"]sha256['"]\s*\)/);
    expect(src).toMatch(/timingSafeEqual/);
    expect(src).not.toMatch(/if\s*\(\s*a\.length\s*!==\s*b\.length\s*\)\s*return\s*false/);
  });

  it('compares equal and unequal strings without throwing on length mismatch', () => {
    expect(timingSafeEqual('correct-token', 'correct-token')).toBe(true);
    expect(timingSafeEqual('short', 'much-longer-token')).toBe(false);
    expect(timingSafeEqual('', 'x')).toBe(false);
  });
});

describe('x-request-id is only accepted when it is a safe token', () => {
  it('rejects client ids that do not match the allowlist and generates otherwise', () => {
    const src = readFileSync(join(apiSrc, 'index.ts'), 'utf8');
    expect(src).toMatch(/resolveRequestId/);
    const policy = readFileSync(join(apiSrc, 'http-policy.ts'), 'utf8');
    expect(policy).toMatch(/\^\[a-zA-Z0-9_-\]\{8,64\}\$/);
  });
});
