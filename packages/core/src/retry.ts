/**
 * Retry policy and circuit-breaker state — pure logic, no I/O, so the exact
 * backoff schedule used in production is unit-testable.
 */

import { type Clock, systemClock } from './clock.js';
import { FoundryError, isRetryable, toFoundryError } from './errors.js';

export interface RetryPolicy {
  readonly maxAttempts: number;
  readonly initialDelayMs: number;
  readonly maxDelayMs: number;
  readonly multiplier: number;
  /** Fraction of the delay applied as random jitter, 0..1. */
  readonly jitter: number;
  /** Hard ceiling on total elapsed time across all attempts. */
  readonly deadlineMs?: number;
}

export const DEFAULT_RETRY: RetryPolicy = {
  maxAttempts: 5,
  initialDelayMs: 500,
  maxDelayMs: 30_000,
  multiplier: 2,
  jitter: 0.25,
};

/** Payment and order mutations: fewer attempts, always idempotency-keyed. */
export const PAYMENT_RETRY: RetryPolicy = {
  maxAttempts: 3,
  initialDelayMs: 1_000,
  maxDelayMs: 8_000,
  multiplier: 2,
  jitter: 0.2,
  deadlineMs: 25_000,
};

/** Long research/browser work: patient, widely spaced. */
export const LONG_RUNNING_RETRY: RetryPolicy = {
  maxAttempts: 6,
  initialDelayMs: 2_000,
  maxDelayMs: 120_000,
  multiplier: 3,
  jitter: 0.3,
};

export function nextDelayMs(
  policy: RetryPolicy,
  attempt: number,
  retryAfterSeconds?: number,
  random: () => number = Math.random,
): number {
  // A provider's Retry-After always wins over our own schedule.
  if (retryAfterSeconds !== undefined && retryAfterSeconds >= 0) {
    return Math.min(retryAfterSeconds * 1000, policy.maxDelayMs);
  }
  const raw = policy.initialDelayMs * policy.multiplier ** Math.max(0, attempt - 1);
  const capped = Math.min(raw, policy.maxDelayMs);
  const jitterRange = capped * policy.jitter;
  return Math.max(0, Math.round(capped - jitterRange / 2 + random() * jitterRange));
}

export interface RetryContext {
  readonly attempt: number;
  readonly signal?: AbortSignal;
}

export interface RetryHooks {
  onRetry?(info: { attempt: number; delayMs: number; error: FoundryError }): void;
}

/**
 * Runs `fn` with exponential backoff. Only categories the taxonomy marks
 * retryable are retried — a 401 or a policy denial fails immediately rather
 * than hammering a provider that will never say yes.
 */
export async function withRetry<T>(
  operation: string,
  fn: (ctx: RetryContext) => Promise<T>,
  options: {
    policy?: RetryPolicy;
    clock?: Clock;
    signal?: AbortSignal;
    hooks?: RetryHooks;
    random?: () => number;
    /** Override retryability, e.g. to retry a specific provider quirk. */
    isRetryableError?: (error: FoundryError) => boolean;
  } = {},
): Promise<T> {
  const policy = options.policy ?? DEFAULT_RETRY;
  const clock = options.clock ?? systemClock;
  const retryable = options.isRetryableError ?? ((e: FoundryError) => isRetryable(e));
  const startedAt = clock.nowMs();

  let lastError: FoundryError | undefined;
  for (let attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
    try {
      return await fn({ attempt, signal: options.signal });
    } catch (raw) {
      const error = toFoundryError(raw, `${operation} failed`);
      lastError = error;
      if (attempt >= policy.maxAttempts || !retryable(error)) throw error;

      const delayMs = nextDelayMs(policy, attempt, error.retryAfterSeconds, options.random);
      const elapsed = clock.nowMs() - startedAt;
      if (policy.deadlineMs !== undefined && elapsed + delayMs > policy.deadlineMs) throw error;

      options.hooks?.onRetry?.({ attempt, delayMs, error });
      await clock.sleep(delayMs, options.signal);
    }
  }
  throw lastError ?? toFoundryError(new Error(`${operation} exhausted retries`));
}

/* -------------------------------------------------------------------------- */
/* Circuit breaker                                                             */
/* -------------------------------------------------------------------------- */

export type BreakerState = 'closed' | 'open' | 'half_open';

export interface CircuitBreakerOptions {
  readonly failureThreshold: number;
  readonly resetTimeoutMs: number;
  /** Consecutive successes in half-open before closing. */
  readonly successThreshold: number;
}

export const DEFAULT_BREAKER: CircuitBreakerOptions = {
  failureThreshold: 5,
  resetTimeoutMs: 30_000,
  successThreshold: 2,
};

/**
 * Per-provider breaker. Keeps a failing vendor from consuming the whole worker
 * pool and from burning our rate-limit budget while it is down.
 */
export class CircuitBreaker {
  #state: BreakerState = 'closed';
  #failures = 0;
  #successes = 0;
  #openedAt = 0;

  constructor(
    readonly name: string,
    private readonly options: CircuitBreakerOptions = DEFAULT_BREAKER,
    private readonly clock: Clock = systemClock,
  ) {}

  get state(): BreakerState {
    if (this.#state === 'open' && this.clock.nowMs() - this.#openedAt >= this.options.resetTimeoutMs) {
      this.#state = 'half_open';
      this.#successes = 0;
    }
    return this.#state;
  }

  get allowsRequest(): boolean {
    return this.state !== 'open';
  }

  recordSuccess(): void {
    if (this.state === 'half_open') {
      this.#successes += 1;
      if (this.#successes >= this.options.successThreshold) this.#close();
      return;
    }
    this.#failures = 0;
  }

  recordFailure(): void {
    if (this.state === 'half_open') {
      this.#open();
      return;
    }
    this.#failures += 1;
    if (this.#failures >= this.options.failureThreshold) this.#open();
  }

  #open(): void {
    this.#state = 'open';
    this.#openedAt = this.clock.nowMs();
    this.#successes = 0;
  }

  #close(): void {
    this.#state = 'closed';
    this.#failures = 0;
    this.#successes = 0;
  }

  /** Seconds until the breaker will next allow a probe. */
  get retryAfterSeconds(): number {
    if (this.state !== 'open') return 0;
    const remaining = this.options.resetTimeoutMs - (this.clock.nowMs() - this.#openedAt);
    return Math.max(0, Math.ceil(remaining / 1000));
  }
}
