/**
 * Redis connection for BullMQ, targeting Render Key Value (Valkey 8).
 *
 * Two production details are load-bearing here:
 *  - `maxRetriesPerRequest: null` is required by BullMQ's blocking commands.
 *    Without it, a blocked worker connection throws after the default retry
 *    count and jobs stall silently.
 *  - Render's external Key Value endpoints are TLS-only (`rediss://`) while
 *    internal same-region traffic is plain `redis://`. We detect the scheme
 *    rather than hard-coding, so the same image runs in both topologies.
 */

import { Redis, type RedisOptions } from 'ioredis';
import { getLogger } from '@foundry/obs';
import { ValidationError } from '@foundry/core';

export interface RedisConnectionOptions {
  readonly url: string;
  /** Distinguishes the blocking worker connection from the client connection. */
  readonly role: 'client' | 'worker' | 'subscriber';
  readonly connectionName?: string;
}

export function createRedisConnection(options: RedisConnectionOptions): Redis {
  if (!options.url) {
    throw new ValidationError('REDIS_URL is required. Bind it from the Render Key Value instance.');
  }
  const isTls = options.url.startsWith('rediss://');

  const config: RedisOptions = {
    // BullMQ requires this to be null on any connection that runs blocking
    // commands; setting it globally keeps client and worker behaviour uniform.
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    connectionName: options.connectionName ?? `foundry-${options.role}`,
    // A worker that cannot reach Redis should keep trying rather than exit —
    // Render will restart the instance if the health check stays red.
    retryStrategy: (times: number) => Math.min(times * 200, 5_000),
    reconnectOnError: (err) => {
      // READONLY happens during a Key Value failover; reconnecting picks up the
      // new primary instead of failing every job in flight.
      if (err.message.includes('READONLY')) return 2;
      return false;
    },
    ...(isTls ? { tls: {} } : {}),
  };

  const redis = new Redis(options.url, config);

  redis.on('error', (error: Error) => {
    getLogger().error({ err: error, role: options.role }, 'redis connection error');
  });
  redis.on('reconnecting', (delay: number) => {
    getLogger().warn({ role: options.role, delay }, 'redis reconnecting');
  });
  redis.on('ready', () => {
    getLogger().info({ role: options.role }, 'redis ready');
  });

  return redis;
}

/**
 * Verifies the eviction policy at boot.
 *
 * BullMQ requires `maxmemory-policy noeviction`; Render's own documentation
 * says the same for job queues. Under an LRU policy Redis silently evicts job
 * hashes when memory fills, which loses jobs with no error anywhere — exactly
 * the class of silent failure this system must not have. So we check, and we
 * refuse to run in production if it is wrong.
 */
export async function assertEvictionPolicy(
  redis: Redis,
  environment: 'production' | 'staging' | 'preview',
): Promise<{ policy: string; acceptable: boolean }> {
  let policy = 'unknown';
  try {
    const result = (await redis.config('GET', 'maxmemory-policy')) as unknown as string[];
    policy = result?.[1] ?? 'unknown';
  } catch (error) {
    // Some managed providers disable CONFIG GET. That is not fatal, but it must
    // be visible rather than assumed fine.
    getLogger().warn({ err: error }, 'could not read maxmemory-policy; verify it is noeviction in the provider console');
    return { policy: 'unreadable', acceptable: environment !== 'production' };
  }

  const acceptable = policy === 'noeviction';
  if (!acceptable) {
    const message =
      `Redis maxmemory-policy is "${policy}" but BullMQ requires "noeviction". ` +
      `Under an eviction policy queued jobs are silently dropped when memory fills. ` +
      `Set maxmemoryPolicy: noeviction on the Render Key Value service.`;
    if (environment === 'production') throw new ValidationError(message, { policy });
    getLogger().error({ policy }, message);
  }
  return { policy, acceptable };
}
