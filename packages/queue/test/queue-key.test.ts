import { describe, expect, it } from 'vitest';
import { QUEUE_NAMES } from '../src/contracts.js';
import { assertBullmqId, bullmqId, jobKey, queueKey } from '../src/queues.js';

describe('queueKey', () => {
  it('never contains a colon (BullMQ 5 rejects : in queue names)', () => {
    for (const name of QUEUE_NAMES) {
      for (const environment of ['production', 'staging', 'preview'] as const) {
        const key = queueKey(environment, name);
        expect(key.includes(':')).toBe(false);
        expect(key).toBe(`${environment}.${name}`);
      }
    }
  });

  it('replaces remaining colons in the environment segment', () => {
    expect(queueKey('prod:us', 'loop.tick')).toBe('prod.us.loop.tick');
  });
});

describe('jobKey', () => {
  it('turns the loop.tick start idempotency key into a colon-free custom id', () => {
    // Enqueue currently builds `${queue}:${idempotencyKey}` → loop.tick:loop:start:<companyId>
    // which BullMQ 5 rejects (`Custom Id cannot contain :`).
    const companyId = 'co_abc';
    expect(jobKey('loop.tick', `loop:start:${companyId}`)).toBe(`loop.tick.loop.start.${companyId}`);
  });

  it('never contains a colon for any queue name', () => {
    for (const name of QUEUE_NAMES) {
      const key = jobKey(name, 'a:b:c');
      expect(key.includes(':')).toBe(false);
      expect(key).toBe(`${name}.a.b.c`);
    }
  });
});

describe('bullmqId', () => {
  it('replaces colons in an explicit custom job id', () => {
    expect(bullmqId('loop.tick:loop:start:co_abc')).toBe('loop.tick.loop.start.co_abc');
  });
});

describe('assertBullmqId', () => {
  it('rejects the colon-separated custom id BullMQ 5 forbids', () => {
    expect(() => assertBullmqId('loop.tick:loop:start:co_abc')).toThrow(/cannot contain ':'/);
  });

  it('accepts a colon-free id', () => {
    expect(assertBullmqId('loop.tick.loop.start.co_abc')).toBe('loop.tick.loop.start.co_abc');
  });
});
