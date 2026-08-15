import { describe, expect, it } from 'vitest';
import { ValidationError } from '@foundry/core';
import { CollectPaymentService } from '../src/commerce/collect.js';
import type { ServiceDeps } from '../src/deps.js';

function deps(order: { total_minor: number; company_id: string; payment_route?: string }): ServiceDeps {
  return {
    repos: {
      commerce: {
        orders: {
          byId: async () => ({
            id: 'ord_1',
            company_id: order.company_id,
            total_minor: order.total_minor,
            currency: 'USD',
            payment_route: order.payment_route ?? 'stripe_direct',
            external_refs: {},
          }),
          lineItems: async () => [
            { product_id: 'prd_1', name: 'Founding access', quantity: 1, unit_price_minor: order.total_minor },
          ],
          setExternalRef: async () => undefined,
        },
      },
      companies: {
        byId: async () => ({
          id: order.company_id,
          config: {
            commerce: { sellsTo: ['US'], shipsFrom: ['US'], baseCurrency: 'USD' },
            messaging: { outreachHandles: [] },
          },
        }),
      },
    },
    providers: {
      forCapability: () => ({ adapter: undefined, status: { state: 'blocked_missing_credentials', remediation: 'missing' } }),
    },
    capabilities: {
      resolveCapability: () => ({ state: 'blocked_missing_credentials', remediation: 'missing' }),
    },
    publicBaseUrl: 'https://api.example.test',
  } as unknown as ServiceDeps;
}

describe('CollectPaymentService', () => {
  it('refuses an order below the Stripe/Linq minimum instead of taking a caller amount', async () => {
    const service = new CollectPaymentService(deps({ total_minor: 49, company_id: 'co_1' }));
    await expect(
      service.collect({
        companyId: 'co_1',
        orderId: 'ord_1',
        toHandle: '+15555550100',
        description: 'test',
        idempotencyKey: 'k',
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('does not accept an amountMinor field on the collect input', () => {
    const input: Parameters<CollectPaymentService['collect']>[0] = {
      companyId: 'co_1',
      orderId: 'ord_1',
      toHandle: '+15555550100',
      description: 'test',
      idempotencyKey: 'k',
    };
    expect(input).not.toHaveProperty('amountMinor');
  });

  it('refuses to collect a Dodo-routed order rather than charging Stripe for it', async () => {
    const service = new CollectPaymentService(
      deps({ total_minor: 9900, company_id: 'co_1', payment_route: 'dodo_merchant_of_record' }),
    );
    await expect(
      service.collect({
        companyId: 'co_1',
        orderId: 'ord_1',
        toHandle: '+15555550100',
        description: 'test',
        idempotencyKey: 'k',
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});
