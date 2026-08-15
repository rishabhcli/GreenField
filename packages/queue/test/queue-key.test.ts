import { describe, expect, it } from 'vitest';
import { QUEUE_NAMES } from '../src/contracts.js';
import { queueKey } from '../src/queues.js';

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
});
