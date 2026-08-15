import { describe, expect, it } from 'vitest';
import { ValidationError } from '@foundry/core';
import type { ServiceDeps } from '../src/deps.js';
import { SourcingRfqService } from '../src/sourcing/rfq.js';

function fakeDeps(rfqs: {
  attachApproval: (id: string, approvalId: string) => Promise<void>;
  markSent: (id: string, externalMessageId: string) => Promise<unknown>;
  markDeliveryFailed: (id: string, error: string) => Promise<void>;
  byId: (id: string) => Promise<unknown>;
}): ServiceDeps {
  return {
    repos: {
      sourcing: {
        rfqs,
        suppliers: {
          byId: async () => {
            throw new Error('suppliers.byId must not run when send is refused');
          },
        },
      },
    },
    providers: {
      forCapability: () => {
        throw new Error('providers.forCapability must not run when send is refused');
      },
    },
  } as unknown as ServiceDeps;
}

describe('SourcingRfqService.send', () => {
  it('cannot mark an RFQ sent when approvalId is missing', async () => {
    const calls: string[] = [];
    const rfqs = {
      byId: async () => {
        calls.push('byId');
        return { id: 'rfq_1', approval_id: null, supplier_id: 'sup_1', message_body: 'hello', specification: {} };
      },
      attachApproval: async () => {
        calls.push('attachApproval');
      },
      markSent: async () => {
        calls.push('markSent');
        throw new Error('markSent must not be called without approval');
      },
      markDeliveryFailed: async () => {
        calls.push('markDeliveryFailed');
      },
    };

    const service = new SourcingRfqService(fakeDeps(rfqs));

    await expect(service.send({ rfqId: 'rfq_1', approvalId: '' })).rejects.toBeInstanceOf(ValidationError);
    await expect(service.send({ rfqId: 'rfq_1', approvalId: '   ' })).rejects.toThrow(/approval/i);

    expect(calls).not.toContain('markSent');
    expect(calls).not.toContain('attachApproval');
    expect(calls).not.toContain('markDeliveryFailed');
  });
});
