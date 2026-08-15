import { describe, expect, it } from 'vitest';
import { JOB_SCHEMAS, QUEUE_NAMES, QUEUE_POLICIES, SCHEDULED_JOBS } from '../src/contracts.js';

describe('queue contract completeness', () => {
  it('gives every named queue a schema and a policy', () => {
    for (const name of QUEUE_NAMES) {
      expect(JOB_SCHEMAS[name], `missing JOB_SCHEMAS[${name}]`).toBeDefined();
      expect(QUEUE_POLICIES[name], `missing QUEUE_POLICIES[${name}]`).toBeDefined();
    }
  });

  it('only schedules queues that exist', () => {
    const names = new Set<string>(QUEUE_NAMES);
    for (const job of SCHEDULED_JOBS) {
      expect(names.has(job.queue), `SCHEDULED_JOBS references unknown queue ${job.queue}`).toBe(true);
    }
  });

  it('does not schedule verification.probe — apps/verifier is the sole writer', () => {
    expect(QUEUE_NAMES).toContain('verification.probe');
    expect(JOB_SCHEMAS['verification.probe']).toBeDefined();
    expect(QUEUE_POLICIES['verification.probe']).toBeDefined();
    expect(SCHEDULED_JOBS.map((job) => job.queue)).not.toContain('verification.probe');
  });
});
