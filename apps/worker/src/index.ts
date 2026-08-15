/**
 * Worker service.
 *
 * Consumes the BullMQ queues. Two roles are deployed from this same binary,
 * selected by `WORKER_ROLE`:
 *
 *   general — everything except the agent organisation
 *   agents  — only `agent.run` and `loop.tick`
 *
 * They are separate Render services because model calls are slow, expensive
 * and rate-limited: mixing them with fulfilment work lets one stuck agent run
 * starve order processing, and makes per-role cost attribution meaningless.
 *
 * Shutdown drains rather than kills. Render sends SIGTERM and waits; a job
 * abandoned mid-flight is a half-applied money transition, so in-flight work is
 * allowed to finish before the connections close.
 */

import { describeError, loadWorkerRole, serviceNameFromEnv } from '@foundry/core';
import { getLogger } from '@foundry/obs';
import { QUEUE_NAMES, WorkerSet, type HandlerMap, type QueueName } from '@foundry/queue';
import { buildContext, bootstrapOperatingCompany, wireRuntime } from '@foundry/runtime';
import { buildHandlers, unhandledQueues } from './handlers.js';

/** Kept in sync with `packages/db/src/migrations`; the schema health check reads it. */
const EXPECTED_MIGRATIONS = 6;

/** Queues each role consumes. A queue in neither list is consumed by nobody. */
const AGENT_QUEUES: readonly QueueName[] = ['agent.run', 'loop.tick'];

async function main(): Promise<void> {
  const role = loadWorkerRole();

  const ctx = await buildContext({
    serviceName: serviceNameFromEnv(`foundry-worker-${role}`),
    expectedMigrations: EXPECTED_MIGRATIONS,
    // Only one process may own the repeatable schedules, otherwise every
    // instance re-registers them and the cron fires N times.
    installSchedules: role === 'agents',
  });
  const services = wireRuntime(ctx);
  const boot = await bootstrapOperatingCompany(ctx);
  const log = getLogger();
  log.info(
    {
      companyId: boot.companyId,
      created: boot.created,
      cycleId: boot.cycleId,
      bandChatId: boot.bandRoom.chatId,
    },
    'operating company ready',
  );
  const all = buildHandlers(ctx, services);
  const handlers = filterByRole(all, role);

  const idle = unhandledQueues(handlers, QUEUE_NAMES);
  if (idle.length > 0) {
    // Not a warning to be ignored: a queue with no consumer accepts jobs that
    // will never run. Naming them at boot is the difference between a known
    // gap and a silent one.
    log.warn(
      { role, unconsumed: idle },
      'these queues have no handler in this deployment; jobs enqueued to them will not be processed',
    );
  }

  const workers = new WorkerSet({
    connection: ctx.redis,
    environment: ctx.config.environment,
    handlers,
    concurrencyMultiplier: ctx.config.workerConcurrency / 8,
    onDeadLetter: async (info) => {
      // A consequential job that exhausted its retries is an incident. It is
      // written to the audit trail so it survives log rotation, and so the
      // governance view can surface it.
      log.error(
        { queue: info.queue, jobId: info.jobId, attempts: info.attempts, err: describeError(info.error) },
        'consequential job dead-lettered',
      );
      const company = await ctx.repos.companies.first();
      if (!company) return;
      await ctx.repos.audit.append({
        companyId: company.id,
        kind: 'human_intervention',
        actorId: 'system:worker',
        actorKind: 'system_job',
        action: `dead-letter on ${info.queue}`,
        subjectType: 'job',
        subjectRefId: info.jobId,
        outcome: 'failure',
        detail: {
          queue: info.queue,
          attempts: info.attempts,
          error: describeError(info.error),
          payload: info.payload,
        },
      });
    },
  });

  workers.start();
  ctx.health.markReady();
  log.info(
    { role, queues: Object.keys(handlers), concurrency: ctx.config.workerConcurrency },
    'worker started',
  );

  installShutdownHandlers(workers, ctx);
}

function filterByRole(handlers: HandlerMap, role: 'general' | 'agents'): HandlerMap {
  const wanted = (name: QueueName): boolean =>
    role === 'agents' ? AGENT_QUEUES.includes(name) : !AGENT_QUEUES.includes(name);

  const filtered: HandlerMap = {};
  for (const name of QUEUE_NAMES) {
    const handler = handlers[name];
    if (handler && wanted(name)) {
      // The cast is safe: `name` indexes both maps with the same key type, and
      // the handler came from the same map it is being written back into.
      (filtered as Record<string, unknown>)[name] = handler;
    }
  }
  return filtered;
}

function installShutdownHandlers(workers: WorkerSet, ctx: Awaited<ReturnType<typeof buildContext>>): void {
  const log = getLogger();
  let shuttingDown = false;

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal }, 'worker shutting down; draining in-flight jobs');
    ctx.health.beginShutdown();

    try {
      // `close()` waits for active jobs. A job killed halfway through a money
      // transition is far worse than a slow deploy.
      await workers.stop();
      await ctx.shutdown();
      log.info('worker shutdown complete');
      process.exit(0);
    } catch (error) {
      log.error({ err: describeError(error) }, 'worker shutdown failed');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    log.error({ err: describeError(reason) }, 'unhandled rejection in worker');
  });
  process.on('uncaughtException', (error) => {
    log.fatal({ err: describeError(error) }, 'uncaught exception in worker; exiting');
    process.exit(1);
  });
}

main().catch((error) => {
  console.error('Worker failed to start:', error);
  process.exit(1);
});
