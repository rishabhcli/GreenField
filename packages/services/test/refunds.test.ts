import { describe, expect, it } from 'vitest';
import { statusAfterRefund } from '@foundry/core';
import { lostDisputeRefundDelta, RefundService } from '../src/commerce/refunds.js';
import type { ServiceDeps } from '../src/deps.js';

describe('RefundService adapter contract', () => {
  it('calls adapter.refund and records the provider amount, not a caller-invented one', async () => {
    const refundCalls: unknown[] = [];
    const applyCalls: unknown[] = [];
    const refundRows: unknown[] = [];
    const adapter = {
      refund: async (input: unknown) => {
        refundCalls.push(input);
        return { refundId: 're_1', status: 'succeeded', amountMinor: 2000 };
      },
    };
    const deps = {
      repos: {
        commerce: {
          orders: {
            byId: async () => ({
              id: 'ord_1',
              company_id: 'co_1',
              order_number: 'ORD-1001',
              currency: 'USD',
              amount_paid_minor: 5787,
              amount_refunded_minor: 0,
              external_refs: { stripe_payment_intent: 'pi_1' },
            }),
            applyEvent: async (input: unknown) => {
              applyCalls.push(input);
              return { outcome: 'applied' };
            },
          },
          payments: {
            byExternalId: async () => ({ id: 'pay_1', external_id: 'pi_1' }),
            recordRefund: async (row: unknown) => {
              refundRows.push(row);
              return 'rf_1';
            },
          },
        },
        governance: { killSwitches: { engagedScopes: async () => [] } },
        audit: { append: async () => undefined },
      },
      gate: {
        evaluate: async () => ({
          outcome: 'allow',
          release: async () => undefined,
          settle: async () => undefined,
        }),
      },
      providers: {
        forCapability: (capability: string) => {
          if (capability === 'payments.refund') {
            return { adapter, status: { state: 'live_verified' } };
          }
          return { adapter: undefined, status: { state: 'unimplemented' } };
        },
      },
      queues: { enqueue: async () => undefined },
    } as unknown as ServiceDeps;

    const result = await new RefundService(deps).issue({
      orderId: 'ord_1',
      amountMinor: 2000,
      reason: 'requested_by_customer',
      actorId: 'human:ops',
      actorKind: 'human_operator',
    });
    expect(result).toEqual({ outcome: 'refunded', refundId: 're_1', amountMinor: 2000 });
    expect(refundCalls).toHaveLength(1);
    expect(applyCalls[0]).toMatchObject({
      toStatus: statusAfterRefund({ amountPaidMinor: 5787, amountRefundedMinor: 0 }, 2000),
      amountRefundedDeltaMinor: 2000,
    });
    expect(refundRows[0]).toMatchObject({ externalId: 're_1', amountMinor: 2000, paymentId: 'pay_1' });
  });

  it('refuses an amount above the captured-minus-already-refunded ceiling', async () => {
    const adapter = {
      refund: async () => {
        throw new Error('provider must not be called when the ceiling is exceeded');
      },
    };
    const deps = {
      repos: {
        commerce: {
          orders: {
            byId: async () => ({
              id: 'ord_1',
              company_id: 'co_1',
              order_number: 'ORD-1001',
              currency: 'USD',
              amount_paid_minor: 5787,
              amount_refunded_minor: 2000,
              external_refs: { stripe_payment_intent: 'pi_1' },
            }),
          },
        },
        governance: { killSwitches: { engagedScopes: async () => [] } },
      },
      gate: { evaluate: async () => ({ outcome: 'allow' }) },
      providers: { forCapability: () => ({ adapter, status: { state: 'live_verified' } }) },
    } as unknown as ServiceDeps;

    const result = await new RefundService(deps).issue({
      orderId: 'ord_1',
      amountMinor: 4000,
      reason: 'requested_by_customer',
      actorId: 'human:ops',
      actorKind: 'human_operator',
    });
    expect(result.outcome).toBe('refused');
    if (result.outcome === 'refused') {
      expect(result.reason).toContain('exceeds the refundable balance of 3787');
    }
  });

  it('a lost dispute reduces remaining captured, not the original charge twice', () => {
    expect(
      lostDisputeRefundDelta({ amountPaidMinor: 5787, amountRefundedMinor: 2000 }),
    ).toBe(3787);
    expect(lostDisputeRefundDelta({ amountPaidMinor: 5787, amountRefundedMinor: 5787 })).toBeUndefined();
  });
});
