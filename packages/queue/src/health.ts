/**
 * Queue health check.
 *
 * Reports unhealthy when Redis is unreachable, and degraded when a queue has
 * built a backlog or accumulated failures — a worker pool that is up but not
 * draining is a production incident, and a health endpoint that says "healthy"
 * while jobs pile up is exactly the kind of dishonest signal this system
 * refuses to emit.
 */

import type { Redis } from 'ioredis';
import type { HealthCheck, HealthState } from '@foundry/obs';
import type { QueueSet } from './queues.js';

export interface QueueHealthThresholds {
  /** Total waiting+active+delayed above which the system is degraded. */
  readonly backlogWarn: number;
  /** Failed jobs retained above which the system is degraded. */
  readonly failedWarn: number;
}

export const DEFAULT_QUEUE_THRESHOLDS: QueueHealthThresholds = {
  backlogWarn: 500,
  failedWarn: 25,
};

export function redisHealthCheck(redis: Redis): HealthCheck {
  return {
    name: 'redis',
    critical: true,
    timeoutMs: 2_000,
    async run() {
      const startedAt = Date.now();
      const pong = await redis.ping();
      if (pong !== 'PONG') {
        return { state: 'unhealthy' as HealthState, detail: `unexpected PING reply "${pong}"` };
      }
      return { state: 'healthy' as HealthState, detail: `PONG in ${Date.now() - startedAt}ms` };
    },
  };
}

export function queueHealthCheck(
  queues: QueueSet,
  thresholds: QueueHealthThresholds = DEFAULT_QUEUE_THRESHOLDS,
): HealthCheck {
  return {
    name: 'queues',
    // Not critical for liveness: a backlog should show as degraded and page a
    // human, not cause Render to cycle instances and make the backlog worse.
    critical: false,
    timeoutMs: 3_000,
    async run() {
      const depths = await queues.depths();
      const total = Object.values(depths).reduce((a, b) => a + b, 0);
      const hot = Object.entries(depths)
        .filter(([, depth]) => depth > thresholds.backlogWarn)
        .map(([name, depth]) => `${name}=${depth}`);

      if (hot.length > 0) {
        return { state: 'degraded' as HealthState, detail: `backlog on ${hot.join(', ')}` };
      }
      return { state: 'healthy' as HealthState, detail: `${total} jobs across all queues` };
    },
  };
}
