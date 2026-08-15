/**
 * Health checks.
 *
 * Render removes an instance from rotation after 15 s of failing checks and
 * restarts it after 60 s, and a check must answer 2xx/3xx within 5 s. Two
 * distinct checks exist for a reason the docs call out explicitly: a liveness
 * probe that returns 200 the moment the process boots would let Render route
 * traffic to an instance whose database pool is not open yet.
 */

import { describeError } from '@foundry/core';

export type HealthState = 'healthy' | 'degraded' | 'unhealthy';

export interface HealthCheckResult {
  readonly name: string;
  readonly state: HealthState;
  readonly detail: string;
  readonly durationMs: number;
  /** A degraded non-critical dependency does not fail the whole check. */
  readonly critical: boolean;
}

export interface HealthCheck {
  readonly name: string;
  readonly critical: boolean;
  /** Must resolve well inside the 5 s Render budget. */
  readonly timeoutMs: number;
  run(): Promise<{ state: HealthState; detail: string }>;
}

export interface HealthReport {
  readonly state: HealthState;
  readonly checks: readonly HealthCheckResult[];
  readonly release: string;
  readonly uptimeSeconds: number;
  readonly checkedAt: string;
}

const startedAt = Date.now();

export class HealthRegistry {
  readonly #checks: HealthCheck[] = [];
  #ready = false;
  #shuttingDown = false;

  constructor(private readonly release: string) {}

  register(check: HealthCheck): void {
    this.#checks.push(check);
  }

  /** Flipped once migrations, pools and queues are actually open. */
  markReady(): void {
    this.#ready = true;
  }

  /** Flipped on SIGTERM so Render drains this instance before it exits. */
  beginShutdown(): void {
    this.#shuttingDown = true;
    this.#ready = false;
  }

  get isReady(): boolean {
    return this.#ready && !this.#shuttingDown;
  }

  /** Liveness: is the process itself alive? Cheap, no dependency I/O. */
  liveness(): { state: HealthState; release: string; uptimeSeconds: number } {
    return {
      state: this.#shuttingDown ? 'unhealthy' : 'healthy',
      release: this.release,
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    };
  }

  /** Readiness: may this instance take traffic? Exercises real dependencies. */
  async readiness(): Promise<HealthReport> {
    const results = await Promise.all(
      this.#checks.map(async (check): Promise<HealthCheckResult> => {
        const start = Date.now();
        try {
          const outcome = await withTimeout(check.run(), check.timeoutMs, check.name);
          return {
            name: check.name,
            state: outcome.state,
            detail: outcome.detail,
            durationMs: Date.now() - start,
            critical: check.critical,
          };
        } catch (error) {
          return {
            name: check.name,
            state: 'unhealthy',
            detail: String(describeError(error)['message'] ?? 'check failed'),
            durationMs: Date.now() - start,
            critical: check.critical,
          };
        }
      }),
    );

    let state: HealthState = 'healthy';
    if (!this.isReady) state = 'unhealthy';
    for (const r of results) {
      if (r.state === 'unhealthy' && r.critical) state = 'unhealthy';
      else if (r.state !== 'healthy' && state === 'healthy') state = 'degraded';
    }

    return {
      state,
      checks: results,
      release: this.release,
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      checkedAt: new Date().toISOString(),
    };
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number, name: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`health check "${name}" exceeded ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
