/**
 * finance.reconcile refund scope must read the refunds table. A Stripe refund
 * id (`re_*`) is not a payment id (`pi_*` / `ch_*`).
 */

import { describe, expect, it } from 'vitest';
import { refundLedgerLookup } from '../src/handlers.js';

describe('refundLedgerLookup', () => {
  it('uses the refunds table, not payments.byExternalId, for a re_* id', async () => {
    const calls: string[] = [];
    const repos = {
      commerce: {
        payments: {
          byExternalId: async () => {
            calls.push('payment');
            return { amount_minor: 5787, currency: 'USD', external_id: 'pi_1' };
          },
          refundByExternalId: async (_provider: string, externalId: string) => {
            calls.push('refund');
            return {
              external_id: externalId,
              amount_minor: 2000,
              currency: 'USD',
            };
          },
        },
      },
    };
    const found = await refundLedgerLookup(repos, 'stripe', 're_test_a1');
    expect(calls).toEqual(['refund']);
    expect(found).toEqual({ refundExternalId: 're_test_a1', refundAmountMinor: 2000, currency: 'USD' });
  });

  it('does not invent an amount when the refund row is missing', async () => {
    const found = await refundLedgerLookup(
      {
        commerce: {
          payments: {
            byExternalId: async () => ({ amount_minor: 5787, currency: 'USD', external_id: 'pi_1' }),
            refundByExternalId: async () => undefined,
          },
        },
      },
      'stripe',
      're_missing',
    );
    expect(found).toBeUndefined();
  });
});
