/**
 * API service — the control plane.
 *
 * Serves health and readiness for Render, ingests provider webhooks, exposes
 * the storefront's commerce API, and gives an operator the governance surface
 * (approvals, kill switches, budgets, audit).
 *
 * Shutdown is deliberate: on SIGTERM the instance stops reporting ready before
 * it closes anything, so Render drains it from the load balancer while
 * in-flight requests finish.
 */

import Fastify from 'fastify';
import cors from '@fastify/cors';
import sensible from '@fastify/sensible';
import rateLimit from '@fastify/rate-limit';
import { describeError, serviceNameFromEnv } from '@foundry/core';
import { getLogger, metrics, withContext } from '@foundry/obs';
import { buildContext, bootstrapOperatingCompany, wireRuntime, type AppContext } from '@foundry/runtime';
import { registerErrorHandler } from './errors.js';
import { corsAllowsOrigin, isWebhookPath, resolveRequestId } from './http-policy.js';
import { registerWebhookRoutes } from './routes/webhooks.js';
import { registerReadinessRoutes } from './routes/readiness.js';
import { registerGovernanceRoutes } from './routes/governance.js';
import { registerCommerceRoutes } from './routes/commerce.js';
import { registerCompanyRoutes } from './routes/company.js';

/** Kept in sync with `packages/db/src/migrations`; the schema check reads it. */
const EXPECTED_MIGRATIONS = 6;

async function main(): Promise<void> {
  const ctx = await buildContext({
    serviceName: serviceNameFromEnv('foundry-api'),
    expectedMigrations: EXPECTED_MIGRATIONS,
    installSchedules: false,
  });
  const services = wireRuntime(ctx);
  const boot = await bootstrapOperatingCompany(ctx);
  const log = getLogger();
  log.info(
    {
      companyId: boot.companyId,
      created: boot.created,
      cycleId: boot.cycleId,
      actorsSeeded: boot.actorsSeeded,
      loopJobId: boot.loopJobId,
      bandChatId: boot.bandRoom.chatId,
      bandBlocked: boot.bandRoom.blockedOn,
    },
    'operating company ready',
  );

  const app = Fastify({
    logger: false, // pino is configured centrally in @foundry/obs
    trustProxy: true,
    bodyLimit: 5 * 1024 * 1024,
    // Render's proxy closes idle connections at 60s; staying under that avoids
    // half-open sockets accumulating on the instance.
    keepAliveTimeout: 55_000,
    disableRequestLogging: true,
  });

  await app.register(sensible);
  await app.register(cors, {
    origin: (origin, cb) =>
      cb(
        null,
        corsAllowsOrigin(origin, {
          allowlist: ctx.config.corsAllowedOrigins,
          failClosed: ctx.config.corsFailClosed,
        }),
      ),
    credentials: false,
  });

  /**
   * Rate limiting protects the control plane from a runaway agent as much as
   * from the outside world. Webhooks are exempted: a provider retry storm is
   * legitimate traffic and dropping it would lose money state.
   *
   * The store is Redis, not the default in-process Map: this API runs two
   * instances, so an in-memory 300/min is really 600/min and resets on every
   * deploy. Keys are written with the window as TTL (`@fastify/rate-limit`
   * `incr` takes `timeWindow` and expires the key); they cannot accumulate
   * unbounded in a `noeviction` Key Value instance. `continueExceeding` stays
   * off so a client over the limit does not refresh the TTL on every hit.
   *
   * `skipOnError: true` — if Redis is unreachable the limiter lets the
   * request through rather than taking the API down. A missing rate limit is
   * worse than a 500 on every request, but not worse than dropping webhooks
   * and checkouts. Health checks still have to answer.
   */
  await app.register(rateLimit, {
    max: 300,
    timeWindow: '1 minute',
    redis: ctx.redis,
    nameSpace: 'foundry-rl-',
    skipOnError: true,
    allowList: (request) => isWebhookPath(request.url),
    keyGenerator: (request) => request.ip,
  });

  /* ---------------------------------------------------------------------- */
  /* Request context and logging                                             */
  /* ---------------------------------------------------------------------- */

  app.addHook('onRequest', (request, _reply, done) => {
    const traceId = resolveRequestId(
      request.headers,
      () => `req_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
    );
    (request as { traceId?: string }).traceId = traceId;
    (request as { startedAt?: number }).startedAt = Date.now();
    withContext({ traceId, route: request.routeOptions?.url ?? request.url }, () => done());
  });

  app.addHook('onResponse', (request, reply, done) => {
    const route = request.routeOptions?.url ?? 'unmatched';
    const startedAt = (request as { startedAt?: number }).startedAt ?? Date.now();
    metrics.httpRequests.inc({ method: request.method, route, status: String(reply.statusCode) });
    metrics.httpDuration.observe((Date.now() - startedAt) / 1000, { method: request.method, route });
    // Health checks fire every few seconds; logging them buries everything else.
    if (!request.url.startsWith('/health') && !request.url.startsWith('/ready')) {
      log.info(
        { method: request.method, route, status: reply.statusCode, durationMs: Date.now() - startedAt },
        'request',
      );
    }
    done();
  });

  registerErrorHandler(app);

  /* ---------------------------------------------------------------------- */
  /* Routes                                                                  */
  /* ---------------------------------------------------------------------- */

  await registerReadinessRoutes(app, ctx);
  // Webhooks MUST be encapsulated in their own plugin scope. They install a
  // raw-buffer parser for `application/json` because every signature scheme
  // signs the exact bytes, and `addContentTypeParser` applies to whatever
  // instance it is called on. Called directly on the root app it hijacked the
  // JSON body of every other route in the API — `request.body` arrived as a
  // Buffer, so `SetBudget.parse` and friends saw an object with no fields, and
  // PUT /api/budgets, the approve/deny writes, the kill-switch release and
  // POST /api/checkout all failed validation. Registering as a plugin confines
  // the parser to the webhook routes.
  await app.register(async (instance) => {
    await registerWebhookRoutes(instance, ctx);
  });
  await registerGovernanceRoutes(app, ctx);
  await registerCommerceRoutes(app, ctx);
  await registerCompanyRoutes(app, ctx, services);

  app.get('/', async () => ({
    service: 'foundry-api',
    release: ctx.config.releaseSha,
    environment: ctx.config.environment,
    docs: {
      health: '/health',
      readiness: '/ready',
      capabilities: '/readiness/capabilities',
      providers: '/readiness/providers',
      company: '/readiness/company',
      companies: '/api/companies',
      prizeTracks: '/api/prize-tracks',
      metrics: '/metrics',
    },
  }));

  /* ---------------------------------------------------------------------- */
  /* Listen and drain                                                        */
  /* ---------------------------------------------------------------------- */

  await app.listen({ port: ctx.config.port, host: '0.0.0.0' });
  ctx.health.markReady();
  log.info({ port: ctx.config.port, environment: ctx.config.environment }, 'api listening');

  installShutdownHandlers(app, ctx);
}

function installShutdownHandlers(app: ReturnType<typeof Fastify>, ctx: AppContext): void {
  const log = getLogger();
  let shuttingDown = false;

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal }, 'shutting down');

    // Stop reporting ready first so Render removes this instance from rotation
    // before we start closing connections underneath in-flight requests.
    ctx.health.beginShutdown();
    await new Promise((resolve) => setTimeout(resolve, 3_000));

    try {
      await app.close();
      await ctx.shutdown();
      log.info('shutdown complete');
      process.exit(0);
    } catch (error) {
      log.error({ err: error }, 'shutdown failed');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    log.error({ err: describeError(reason) }, 'unhandled rejection');
  });
  process.on('uncaughtException', (error) => {
    // An uncaught exception leaves the process in an unknown state. Exiting
    // lets Render replace the instance rather than serving from a broken one.
    log.fatal({ err: describeError(error) }, 'uncaught exception; exiting');
    process.exit(1);
  });
}

main().catch((error) => {
  // The logger may not exist yet if config loading failed, so this writes
  // directly — a boot failure must never be silent.
  console.error('API failed to start:', error);
  process.exit(1);
});
