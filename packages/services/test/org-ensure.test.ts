import { describe, expect, it } from 'vitest';
import { ConflictError } from '@foundry/core';
import type { Repositories } from '@foundry/db';
import type { QueueSet } from '@foundry/queue';
import { companyAlreadyExistsError, ensureOperatingCompany } from '../src/org/ensure.js';

const EXISTING_ID = 'co_01M03F7RQW2M6540BY2GZHCFBW';

describe('companyAlreadyExistsError', () => {
  it('is a 409 conflict that names the existing company', () => {
    const error = companyAlreadyExistsError(EXISTING_ID);
    expect(error).toBeInstanceOf(ConflictError);
    expect(error.httpStatus).toBe(409);
    expect(error.code).toBe('conflict');
    expect(error.message).toContain(EXISTING_ID);
  });
});

describe('ensureOperatingCompany', () => {
  it('returns the existing company and does not throw when enqueue fails', async () => {
    let created = false;
    const repos = {
      companies: {
        first: async () => ({
          id: EXISTING_ID,
          name: 'Zero Human Co',
          config: { commerce: { baseCurrency: 'USD' } },
        }),
        create: async () => {
          created = true;
          throw new Error('must not create a second company');
        },
      },
      governance: {
        actors: {
          upsert: async () => ({ id: 'act_1' }),
        },
      },
      loop: {
        currentOrStart: async () => ({ id: 'task_1', phase: 'discover', status: 'running' }),
      },
    } as unknown as Repositories;
    const queues = {
      enqueue: async () => {
        throw new Error("BullMQ custom id cannot contain ':': got \"loop.tick:loop:start:co_abc\"");
      },
    } as unknown as QueueSet;

    const result = await ensureOperatingCompany({ repos, queues });

    expect(created).toBe(false);
    expect(result.created).toBe(false);
    expect(result.companyId).toBe(EXISTING_ID);
    expect(result.loopJobId).toBeNull();
    expect(result.enqueueError).toMatch(/cannot contain ':'/);
  });
});
