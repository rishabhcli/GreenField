/**
 * Injectable time. Every deadline, backoff window, experiment duration and
 * retention sweep reads the clock through this interface so the same production
 * code path is testable without sleeping.
 */

export interface Clock {
  now(): Date;
  nowMs(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export const systemClock: Clock = {
  now: () => new Date(),
  nowMs: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason instanceof Error ? signal.reason : new Error('Aborted'));
        return;
      }
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        reject(signal?.reason instanceof Error ? signal.reason : new Error('Aborted'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
    }),
};

/** Deterministic clock for tests and for replaying an audit trail. */
export class FixedClock implements Clock {
  private current: number;
  constructor(start: Date | number = 0) {
    this.current = typeof start === 'number' ? start : start.getTime();
  }
  now(): Date {
    return new Date(this.current);
  }
  nowMs(): number {
    return this.current;
  }
  advance(ms: number): void {
    this.current += ms;
  }
  async sleep(ms: number): Promise<void> {
    this.current += ms;
  }
}

export const SECOND_MS = 1_000;
export const MINUTE_MS = 60 * SECOND_MS;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

export function isoDate(d: Date): string {
  return d.toISOString();
}

/** UTC calendar day, `YYYY-MM-DD` — the grain used for budget and spend windows. */
export function utcDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}
