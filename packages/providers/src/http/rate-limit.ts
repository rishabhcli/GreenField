/**
 * Client-side token bucket, sized from each provider's published limits.
 *
 * Being rate limited is not free: Terac allows 100 req/min, Whop 600 req/min
 * per operation, Dodo 40 req/s. Waiting locally for a token costs milliseconds;
 * getting a 429 costs a round trip, a backoff and a place in the provider's
 * bad-citizen bookkeeping.
 */

import { type Clock, systemClock, TimeoutError } from '@foundry/core';

export interface TokenBucketOptions {
  readonly capacity: number;
  /** Tokens replenished per second. */
  readonly refillPerSecond: number;
  /** Give up rather than queue forever behind a saturated bucket. */
  readonly maxWaitMs?: number;
  readonly name: string;
}

export class TokenBucketLimiter {
  #tokens: number;
  #lastRefillMs: number;
  readonly #options: TokenBucketOptions;
  readonly #clock: Clock;
  readonly #waiters: { resolve: () => void; reject: (e: unknown) => void; need: number }[] = [];
  #pumpScheduled = false;

  constructor(options: TokenBucketOptions, clock: Clock = systemClock) {
    this.#options = options;
    this.#clock = clock;
    this.#tokens = options.capacity;
    this.#lastRefillMs = clock.nowMs();
  }

  get availableTokens(): number {
    this.#refill();
    return this.#tokens;
  }

  /** Resolves when `count` tokens are available, or rejects on timeout/abort. */
  async acquire(count = 1, signal?: AbortSignal): Promise<void> {
    if (count > this.#options.capacity) {
      throw new Error(
        `${this.#options.name}: cannot acquire ${count} tokens from a bucket with capacity ${this.#options.capacity}`,
      );
    }
    this.#refill();
    if (this.#tokens >= count && this.#waiters.length === 0) {
      this.#tokens -= count;
      return;
    }

    const maxWaitMs = this.#options.maxWaitMs ?? 60_000;
    return new Promise<void>((resolve, reject) => {
      const entry = { resolve, reject, need: count };
      this.#waiters.push(entry);

      const timer = setTimeout(() => {
        remove();
        reject(new TimeoutError(`${this.#options.name} rate-limit wait`, maxWaitMs));
      }, maxWaitMs);

      const onAbort = () => {
        remove();
        reject(signal?.reason instanceof Error ? signal.reason : new Error('Aborted'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });

      const remove = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        const idx = this.#waiters.indexOf(entry);
        if (idx >= 0) this.#waiters.splice(idx, 1);
      };

      entry.resolve = () => {
        remove();
        resolve();
      };
      entry.reject = (e) => {
        remove();
        reject(e);
      };

      this.#schedulePump();
    });
  }

  #refill(): void {
    const now = this.#clock.nowMs();
    const elapsedSeconds = (now - this.#lastRefillMs) / 1000;
    if (elapsedSeconds <= 0) return;
    this.#tokens = Math.min(this.#options.capacity, this.#tokens + elapsedSeconds * this.#options.refillPerSecond);
    this.#lastRefillMs = now;
  }

  #schedulePump(): void {
    if (this.#pumpScheduled) return;
    this.#pumpScheduled = true;
    // Wake up when the next waiter could plausibly be served.
    const head = this.#waiters[0];
    const deficit = head ? Math.max(0, head.need - this.#tokens) : 0;
    const waitMs = Math.max(10, Math.ceil((deficit / this.#options.refillPerSecond) * 1000));
    setTimeout(() => {
      this.#pumpScheduled = false;
      this.#pump();
    }, waitMs).unref?.();
  }

  #pump(): void {
    this.#refill();
    while (this.#waiters.length > 0) {
      const head = this.#waiters[0]!;
      if (this.#tokens < head.need) break;
      this.#tokens -= head.need;
      this.#waiters.shift();
      head.resolve();
    }
    if (this.#waiters.length > 0) this.#schedulePump();
  }
}

/**
 * Limiters sized from documented provider limits, with headroom so a burst of
 * our own concurrent workers cannot trip a 429 on its own.
 */
export function limiterFor(provider: string): TokenBucketLimiter | undefined {
  switch (provider) {
    case 'terac':
      // Documented: 100 requests/minute per API key.
      return new TokenBucketLimiter({ name: 'terac', capacity: 20, refillPerSecond: 100 / 60 / 1.2 });
    case 'whop':
      // Documented: 600 requests/minute per operation per credential.
      return new TokenBucketLimiter({ name: 'whop', capacity: 60, refillPerSecond: 600 / 60 / 1.2 });
    case 'dodo':
      // Documented tier 0: 40 req/s burst, 240/min sustained.
      return new TokenBucketLimiter({ name: 'dodo', capacity: 30, refillPerSecond: 240 / 60 / 1.2 });
    case 'sandbox0':
      // Documented self-hosted default: 100 req/s, burst 200.
      return new TokenBucketLimiter({ name: 'sandbox0', capacity: 100, refillPerSecond: 80 });
    case 'stripe':
      // Stripe does not publish a fixed number; 25/s is well inside live-mode norms.
      return new TokenBucketLimiter({ name: 'stripe', capacity: 25, refillPerSecond: 25 });
    case 'linq':
      // Documented burst: 30 messages per 60 s per sender-recipient pair. This
      // is a coarse account-level guard on top of that.
      return new TokenBucketLimiter({ name: 'linq', capacity: 10, refillPerSecond: 2 });
    case 'render':
    case 'replay':
    case 'band':
    case 'superserve':
    case 'solari':
      // No published numeric limits. A conservative default avoids becoming the
      // reason a limit gets published.
      return new TokenBucketLimiter({ name: provider, capacity: 10, refillPerSecond: 5 });
    default:
      return undefined;
  }
}
