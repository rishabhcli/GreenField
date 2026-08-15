/**
 * Whop commerce service — catalogue + checkout for digital/membership only.
 *
 * Physical private-label goods are refused before the adapter is touched.
 * Missing WHOP_API_KEY / WHOP_COMPANY_ID is blocked, not retried.
 * GET /accounts/me is never treated as a checkout pass.
 */

import { describe, expect, it } from 'vitest';
import { CredentialsMissingError, ValidationError } from '@foundry/core';
import type { ServiceDeps } from '../src/deps.js';
import { WhopCommerceService } from '../src/commerce/whop.js';

interface AdapterCalls {
  readonly products: unknown[];
  readonly checkouts: unknown[];
  readonly probes: number;
}

function fakeAdapter(options: {
  readonly missing?: readonly string[];
  readonly calls: AdapterCalls;
}) {
  return {
    createProduct: async (input: Record<string, unknown>) => {
      if (options.missing?.length) {
        throw new CredentialsMissingError('whop', options.missing, 'https://whop.com/dashboard/developer');
      }
      options.calls.products.push(input);
      return { id: 'prod_whop_1', planId: 'plan_whop_1' };
    },
    createCheckout: async (input: Record<string, unknown>) => {
      if (options.missing?.length) {
        throw new CredentialsMissingError('whop', options.missing, 'https://whop.com/dashboard/developer');
      }
      options.calls.checkouts.push(input);
      return { id: 'ch_whop_1', url: 'https://whop.com/checkout/plan_whop_1' };
    },
    probe: async () => {
      options.calls.probes += 1;
      return { succeeded: true, detail: 'GET /accounts/me', evidence: { notACheckoutPass: true } };
    },
  };
}

function deps(options: {
  readonly adapter?: unknown;
  readonly kind?: string;
  readonly paymentRoute?: string;
  readonly calls: AdapterCalls;
  readonly refs?: Record<string, string>;
}): ServiceDeps {
  const productRefs: Record<string, string> = { ...options.refs };
  const orderRefs: Record<string, string> = {};
  return {
    providers: {
      adapter: (id: string) => (id === 'whop' ? options.adapter : undefined),
    },
    repos: {
      commerce: {
        products: {
          create: async (input: { kind: string; paymentRoute: string }) => {
            if (input.kind === 'physical_good') {
              throw new Error('local catalogue must not persist a physical good on the Whop route');
            }
            expect(input.paymentRoute).toBe('whop_checkout');
            return { id: 'prd_local_1', sku: 'zhc-operator' };
          },
          setExternalRef: async (_id: string, key: string, value: string) => {
            productRefs[key] = value;
          },
          byId: async () => ({
            id: 'prd_local_1',
            kind: options.kind ?? 'membership',
            payment_route: 'whop_checkout',
            external_refs: productRefs,
            price_minor: 9900,
            currency: 'usd',
          }),
        },
        orders: {
          byId: async () => ({
            id: 'ord_01ABC',
            company_id: 'co_1',
            status: 'CREATED',
            payment_route: options.paymentRoute ?? 'whop_checkout',
            total_minor: 9900,
            currency: 'usd',
            external_refs: orderRefs,
          }),
          setExternalRef: async (_id: string, key: string, value: string) => {
            orderRefs[key] = value;
          },
        },
      },
    },
  } as unknown as ServiceDeps;
}

describe('WhopCommerceService physical refusal', () => {
  it('catalogueProduct refuses physical_good without touching the adapter', async () => {
    const calls: AdapterCalls = { products: [], checkouts: [], probes: 0 };
    const service = new WhopCommerceService(
      deps({
        adapter: fakeAdapter({ calls }),
        calls,
      }),
    );
    await expect(
      service.catalogueProduct({
        companyId: 'co_1',
        sku: 'mug',
        name: 'Ceramic mug',
        kind: 'physical_good',
        description: 'A physical private-label good',
        priceMinor: 1999,
        currency: 'usd',
        idempotencyKey: 'idem_cat_physical',
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(calls.products).toHaveLength(0);
    expect(calls.probes).toBe(0);
  });

  it('startCheckout refuses physical_good without touching the adapter', async () => {
    const calls: AdapterCalls = { products: [], checkouts: [], probes: 0 };
    const service = new WhopCommerceService(
      deps({
        adapter: fakeAdapter({ calls }),
        kind: 'physical_good',
        calls,
      }),
    );
    await expect(
      service.startCheckout({
        companyId: 'co_1',
        orderId: 'ord_01ABC',
        productKind: 'physical_good',
        planId: 'plan_whop_1',
        idempotencyKey: 'idem_chk_physical',
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(calls.checkouts).toHaveLength(0);
    expect(calls.probes).toBe(0);
  });

  it('startCheckout refuses a stripe_direct order without calling Whop', async () => {
    const calls: AdapterCalls = { products: [], checkouts: [], probes: 0 };
    const service = new WhopCommerceService(
      deps({
        adapter: fakeAdapter({ calls }),
        paymentRoute: 'stripe_direct',
        calls,
      }),
    );
    await expect(
      service.startCheckout({
        companyId: 'co_1',
        orderId: 'ord_01ABC',
        productKind: 'membership',
        planId: 'plan_whop_1',
        idempotencyKey: 'idem_chk_stripe',
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(calls.checkouts).toHaveLength(0);
    expect(calls.probes).toBe(0);
  });
});

describe('WhopCommerceService missing credentials', () => {
  it('catalogueProduct returns blocked when WHOP_API_KEY is missing', async () => {
    const calls: AdapterCalls = { products: [], checkouts: [], probes: 0 };
    const service = new WhopCommerceService(
      deps({
        adapter: fakeAdapter({ missing: ['WHOP_API_KEY'], calls }),
        calls,
      }),
    );
    const result = await service.catalogueProduct({
      companyId: 'co_1',
      sku: 'zhc-operator',
      name: 'Operator',
      kind: 'membership',
      description: 'Founding operator membership',
      priceMinor: 29900,
      currency: 'usd',
      idempotencyKey: 'idem_cat_blocked',
    });
    expect(result.ok).toBe(false);
    expect(result.blockedOn?.capability).toBe('commerce.membership');
    expect(result.blockedOn?.reason).toMatch(/WHOP_API_KEY/);
    expect(calls.probes).toBe(0);
  });

  it('startCheckout returns blocked when WHOP_COMPANY_ID is missing', async () => {
    const calls: AdapterCalls = { products: [], checkouts: [], probes: 0 };
    const service = new WhopCommerceService(
      deps({
        adapter: fakeAdapter({ missing: ['WHOP_COMPANY_ID'], calls }),
        calls,
      }),
    );
    const result = await service.startCheckout({
      companyId: 'co_1',
      orderId: 'ord_01ABC',
      productKind: 'membership',
      planId: 'plan_whop_1',
      idempotencyKey: 'idem_chk_blocked',
    });
    expect(result.ok).toBe(false);
    expect(result.blockedOn?.capability).toBe('commerce.membership');
    expect(result.blockedOn?.reason).toMatch(/WHOP_COMPANY_ID/);
    expect(calls.probes).toBe(0);
  });
});

describe('WhopCommerceService digital path', () => {
  it('catalogues a membership and checks it out with order-linked metadata, without probing', async () => {
    const calls: AdapterCalls = { products: [], checkouts: [], probes: 0 };
    const service = new WhopCommerceService(deps({ adapter: fakeAdapter({ calls }), calls }));

    const catalogued = await service.catalogueProduct({
      companyId: 'co_1',
      sku: 'zhc-operator',
      name: 'Operator',
      kind: 'membership',
      description: 'Founding operator membership',
      priceMinor: 29900,
      currency: 'usd',
      idempotencyKey: 'idem_cat_ok',
    });
    expect(catalogued.ok).toBe(true);
    expect(catalogued.data?.whopProductId).toBe('prod_whop_1');
    expect(catalogued.data?.whopPlanId).toBe('plan_whop_1');
    expect(calls.products[0]).toMatchObject({
      kind: 'membership',
      title: 'Operator',
      initialPriceMinor: 29900,
    });

    const checkout = await service.startCheckout({
      companyId: 'co_1',
      orderId: 'ord_01ABC',
      productKind: 'membership',
      planId: 'plan_whop_1',
      idempotencyKey: 'idem_chk_ok',
    });
    expect(checkout.ok).toBe(true);
    expect(checkout.data?.checkoutId).toBe('ch_whop_1');
    expect(checkout.data?.checkoutUrl).toContain('/checkout/');
    expect(calls.checkouts[0]).toMatchObject({
      orderId: 'ord_01ABC',
      productKind: 'membership',
      planId: 'plan_whop_1',
      metadata: {
        order_id: 'ord_01ABC',
        internal_order_id: 'ord_01ABC',
        company_id: 'co_1',
      },
    });
    expect(calls.probes).toBe(0);
  });
});
