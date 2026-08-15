import { describe, expect, it } from 'vitest';
import { ReconciliationService } from '../src/finance/reconciliation.js';
import type { ServiceDeps } from '../src/deps.js';

describe('ReconciliationService provider selection', () => {
  it('loads listPayments from payments.checkout.physical, not payments.webhooks', async () => {
    const requested: string[] = [];
    const adapter = {
      listPayments: async () => [
        {
          externalId: 'pi_test_a1',
          amountMinor: 5787,
          currency: 'usd',
          status: 'succeeded',
          feeMinor: 198,
          netMinor: 5589,
        },
      ],
    };
    const deps = {
      providers: {
        forCapability: (capability: string) => {
          requested.push(capability);
          if (capability === 'payments.checkout.physical') {
            return { adapter, status: { state: 'live_verified' } };
          }
          return {
            adapter: undefined,
            status: { state: 'unimplemented', remediation: `no adapter for ${capability}` },
          };
        },
      },
      repos: {
        commerce: {
          payments: {
            listForReconciliation: async () => [
              {
                external_id: 'pi_test_a1',
                amount_minor: 5787,
                currency: 'usd',
                status: 'succeeded',
                order_id: 'ord_1',
                fee_minor: 198,
              },
            ],
            upsert: async () => ({}),
          },
        },
        audit: { append: async () => undefined },
        ledger: {
          findUnbalancedTransactions: async () => [],
          writeTransactionOnce: async () => ({ written: false }),
        },
      },
    } as unknown as ServiceDeps;

    const report = await new ReconciliationService(deps).run('co_1', 'stripe');
    expect(requested).toContain('payments.checkout.physical');
    expect(requested).not.toContain('payments.webhooks');
    expect(report.skippedReason).toBeUndefined();
    expect(report.result.matched).toBe(1);
    expect(report.result.clean).toBe(true);
  });
});
