/**
 * Database health check.
 *
 * Reports degraded rather than healthy when the pool is near saturation: a
 * service that answers `SELECT 1` while every connection is checked out is
 * about to start timing out real requests, and a health endpoint that hides
 * that is worse than no health endpoint.
 */

import type { HealthCheck, HealthState } from '@foundry/obs';
import type { DbPool } from './pool.js';

export function databaseHealthCheck(pool: DbPool, options: { saturationWarnRatio?: number } = {}): HealthCheck {
  const warnRatio = options.saturationWarnRatio ?? 0.8;

  return {
    name: 'postgres',
    critical: true,
    // Render requires a health response within 5s; stay well inside it.
    timeoutMs: 2_500,
    async run() {
      const startedAt = Date.now();
      await pool.query('SELECT 1');
      const latencyMs = Date.now() - startedAt;

      const total = pool.totalCount;
      const idle = pool.idleCount;
      const waiting = pool.waitingCount;
      const max = (pool.options as { max?: number }).max ?? 10;
      const inUse = total - idle;
      const saturation = max === 0 ? 0 : inUse / max;

      if (waiting > 0 || saturation >= warnRatio) {
        return {
          state: 'degraded' as HealthState,
          detail: `pool ${inUse}/${max} in use, ${waiting} waiting, ${latencyMs}ms ping`,
        };
      }
      return {
        state: 'healthy' as HealthState,
        detail: `pool ${inUse}/${max} in use, ${latencyMs}ms ping`,
      };
    },
  };
}

/**
 * Verifies the schema is current. A running instance whose migrations have not
 * been applied will fail in confusing ways later; failing readiness now is
 * clearer and keeps it out of the load balancer.
 */
export function schemaHealthCheck(pool: DbPool, expectedMigrationCount: number): HealthCheck {
  return {
    name: 'schema',
    critical: true,
    timeoutMs: 2_500,
    async run() {
      const result = await pool.query<{ n: string }>('SELECT COUNT(*)::text AS n FROM schema_migrations');
      const applied = Number(result.rows[0]?.n ?? 0);
      if (applied < expectedMigrationCount) {
        return {
          state: 'unhealthy' as HealthState,
          detail: `${applied} migrations applied but this build expects ${expectedMigrationCount}; run the migrate pre-deploy command`,
        };
      }
      return { state: 'healthy' as HealthState, detail: `${applied} migrations applied` };
    },
  };
}
