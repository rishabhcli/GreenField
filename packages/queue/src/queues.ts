/**
 * Queue and worker construction over BullMQ.
 */

import { Queue, Worker, QueueEvents, type Job, type JobsOptions, UnrecoverableError } from 'bullmq';
import type { Redis } from 'ioredis';
import { toFoundryError, ValidationError } from '@foundry/core';
import { getLogger, metrics, withContext } from '@foundry/obs';
import {
  JOB_SCHEMAS,
  QUEUE_NAMES,
  QUEUE_POLICIES,
  SCHEDULED_JOBS,
  type JobPayload,
  type QueueName,
} from './contracts.js';

/**
 * Namespaced so staging and production can share a Key Value instance safely.
 * BullMQ ≥5 rejects `:` in queue names (`Queue name cannot contain :`).
 */
export function queueKey(environment: string, name: QueueName): string {
  const key = `${environment}.${name}`;
  if (key.includes(':')) {
    throw new Error(`BullMQ queue name cannot contain ':': got ${JSON.stringify(key)}`);
  }
  return key;
}

export interface QueueSetOptions {
  readonly connection: Redis;
  readonly environment: string;
}

export class QueueSet {
  readonly #queues = new Map<QueueName, Queue>();
  readonly #environment: string;
  readonly #connection: Redis;

  constructor(options: QueueSetOptions) {
    this.#connection = options.connection;
    this.#environment = options.environment;
    for (const name of QUEUE_NAMES) {
      const policy = QUEUE_POLICIES[name];
      this.#queues.set(
        name,
        new Queue(queueKey(this.#environment, name), {
          connection: this.#connection,
          defaultJobOptions: {
            attempts: policy.attempts,
            backoff: { type: 'exponential', delay: policy.backoffMs },
            removeOnComplete: { count: policy.keepCompleted },
            // Failed jobs are retained deliberately: a consequential job that
            // exhausted its retries is an operational event a human must see,
            // not garbage to sweep away.
            removeOnFail: { count: policy.keepFailed },
          },
        }),
      );
    }
  }

  get(name: QueueName): Queue {
    const queue = this.#queues.get(name);
    if (!queue) throw new Error(`Unknown queue "${name}"`);
    return queue;
  }

  /**
   * Enqueue with payload validation at the boundary. A `jobId` derived from the
   * payload's idempotency key makes duplicate enqueues collapse to one job —
   * BullMQ ignores an add() for an existing job id.
   */
  async enqueue<Q extends QueueName>(
    name: Q,
    payload: JobPayload<Q>,
    options: JobsOptions & { jobId?: string } = {},
  ): Promise<string> {
    const schema = JOB_SCHEMAS[name];
    const parsed = schema.safeParse(payload);
    if (!parsed.success) {
      throw new ValidationError(`Invalid payload for queue "${name}": ${parsed.error.message}`, {
        queue: name,
        issues: parsed.error.issues,
      });
    }
    const jobId =
      options.jobId ??
      (payload.idempotencyKey ? `${name}:${payload.idempotencyKey}` : undefined);

    const job = await this.get(name).add(name, parsed.data, { ...options, ...(jobId ? { jobId } : {}) });
    getLogger().debug({ queue: name, jobId: job.id, traceId: payload.traceId }, 'job enqueued');
    return job.id ?? '';
  }

  /** Registers the repeatable jobs that keep the operating loop running. */
  async installSchedules(): Promise<void> {
    for (const scheduled of SCHEDULED_JOBS) {
      const queue = this.get(scheduled.queue);
      await queue.upsertJobScheduler(
        scheduled.name,
        { pattern: scheduled.cron, tz: 'UTC' },
        {
          name: scheduled.queue,
          data: {
            companyId: 'SCHEDULED',
            traceId: `sched_${scheduled.name}`,
            originRunId: null,
            idempotencyKey: null,
            ...scheduled.payload,
          },
        },
      );
      getLogger().info({ queue: scheduled.queue, name: scheduled.name, cron: scheduled.cron }, 'schedule installed');
    }
  }

  /** Removes schedules that are no longer declared, so a rename does not leave a ghost. */
  async pruneSchedules(): Promise<readonly string[]> {
    const declared = new Set(SCHEDULED_JOBS.map((s) => `${s.queue}::${s.name}`));
    const removed: string[] = [];
    for (const name of QUEUE_NAMES) {
      const schedulers = await this.get(name).getJobSchedulers();
      for (const scheduler of schedulers) {
        if (scheduler.key && !declared.has(`${name}::${scheduler.key}`)) {
          await this.get(name).removeJobScheduler(scheduler.key);
          removed.push(`${name}::${scheduler.key}`);
        }
      }
    }
    return removed;
  }

  async depths(): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    for (const name of QUEUE_NAMES) {
      const counts = await this.get(name).getJobCounts('waiting', 'active', 'delayed', 'failed');
      out[name] = (counts['waiting'] ?? 0) + (counts['active'] ?? 0) + (counts['delayed'] ?? 0);
      metrics.queueDepth.set(out[name] ?? 0, { queue: name });
      metrics.queueDepth.set(counts['failed'] ?? 0, { queue: name, state: 'failed' });
    }
    return out;
  }

  async close(): Promise<void> {
    await Promise.all([...this.#queues.values()].map((q) => q.close()));
  }
}

/* -------------------------------------------------------------------------- */
/* Workers                                                                     */
/* -------------------------------------------------------------------------- */

export interface JobContext {
  readonly traceId: string;
  readonly companyId: string;
  readonly jobId: string;
  readonly attempt: number;
  readonly signal: AbortSignal;
}

export type JobHandler<Q extends QueueName> = (
  payload: JobPayload<Q>,
  ctx: JobContext,
) => Promise<unknown>;

export type HandlerMap = { [Q in QueueName]?: JobHandler<Q> };

export interface WorkerSetOptions {
  readonly connection: Redis;
  readonly environment: string;
  readonly handlers: HandlerMap;
  /** Scales every queue's concurrency; set from WORKER_CONCURRENCY. */
  readonly concurrencyMultiplier?: number;
  /** Called when a consequential job exhausts its retries. */
  readonly onDeadLetter?: (info: {
    queue: QueueName;
    jobId: string;
    payload: unknown;
    error: unknown;
    attempts: number;
  }) => Promise<void>;
}

export class WorkerSet {
  readonly #workers: Worker[] = [];
  readonly #events: QueueEvents[] = [];
  readonly #options: WorkerSetOptions;

  constructor(options: WorkerSetOptions) {
    this.#options = options;
  }

  start(): void {
    const multiplier = this.#options.concurrencyMultiplier ?? 1;

    for (const name of QUEUE_NAMES) {
      const handler = this.#options.handlers[name] as JobHandler<typeof name> | undefined;
      if (!handler) continue;

      const policy = QUEUE_POLICIES[name];
      const worker = new Worker(
        queueKey(this.#options.environment, name),
        async (job: Job) => this.#process(name, handler, job),
        {
          connection: this.#options.connection,
          concurrency: Math.max(1, Math.round(policy.concurrency * multiplier)),
          // Stalled jobs are re-queued; a low count avoids a wedged worker
          // silently holding a consequential job forever.
          maxStalledCount: 2,
          stalledInterval: 30_000,
          ...(policy.limiter ? { limiter: { max: policy.limiter.max, duration: policy.limiter.durationMs } } : {}),
        },
      );

      worker.on('failed', (job, error) => {
        const attempts = job?.attemptsMade ?? 0;
        metrics.jobsProcessed.inc({ queue: name, result: 'failed' });
        getLogger().error(
          { queue: name, jobId: job?.id, attempts, err: error },
          'job failed',
        );
        if (job && attempts >= policy.attempts && policy.consequential) {
          void this.#options
            .onDeadLetter?.({ queue: name, jobId: job.id ?? '', payload: job.data, error, attempts })
            .catch((e) => getLogger().error({ err: e, queue: name }, 'dead-letter handler threw'));
        }
      });
      worker.on('completed', () => metrics.jobsProcessed.inc({ queue: name, result: 'completed' }));
      worker.on('error', (error) => getLogger().error({ queue: name, err: error }, 'worker error'));

      this.#workers.push(worker);
    }

    getLogger().info({ workers: this.#workers.length }, 'workers started');
  }

  async #process<Q extends QueueName>(name: Q, handler: JobHandler<Q>, job: Job): Promise<unknown> {
    const schema = JOB_SCHEMAS[name];
    const parsed = schema.safeParse(job.data);
    if (!parsed.success) {
      // A malformed payload will never succeed on retry. Failing it terminally
      // is honest; retrying it ten times would just hide the bug.
      throw new UnrecoverableError(
        `Job ${job.id} on "${name}" has an invalid payload: ${parsed.error.message}`,
      );
    }
    const payload = parsed.data as JobPayload<Q>;
    const policy = QUEUE_POLICIES[name];

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`job exceeded ${policy.jobTimeoutMs}ms`)), policy.jobTimeoutMs);

    const ctx: JobContext = {
      traceId: payload.traceId,
      companyId: payload.companyId,
      jobId: job.id ?? '',
      attempt: job.attemptsMade + 1,
      signal: controller.signal,
    };

    const startedAt = Date.now();
    try {
      return await withContext(
        { traceId: payload.traceId, companyId: payload.companyId, jobId: job.id, route: name },
        async () => {
          const result = await handler(payload, ctx);
          metrics.jobDuration.observe((Date.now() - startedAt) / 1000, { queue: name });
          return result;
        },
      );
    } catch (error) {
      const foundry = toFoundryError(error);
      metrics.jobDuration.observe((Date.now() - startedAt) / 1000, { queue: name, outcome: 'error' });
      // Terminal categories must not consume the retry budget. Retrying a
      // policy denial or a missing credential cannot change the outcome and
      // only delays the operator seeing the real problem.
      if (!foundry.retryable) {
        throw new UnrecoverableError(`${foundry.code}: ${foundry.message}`);
      }
      throw foundry;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Graceful drain so Render's shutdown window does not kill in-flight jobs. */
  async stop(gracePeriodMs = 25_000): Promise<void> {
    getLogger().info('draining workers');
    await Promise.all(
      this.#workers.map((w) =>
        Promise.race([
          w.close(),
          new Promise((resolve) => setTimeout(resolve, gracePeriodMs)),
        ]),
      ),
    );
    await Promise.all(this.#events.map((e) => e.close()));
    getLogger().info('workers drained');
  }
}
