/**
 * Dodo digital MoR collect / refund / ledger.
 *
 * Physical private-label goods are refused before any provider call.
 * Missing keys and HTTP 401 are blocked states, not successes.
 * Dodo has no Idempotency-Key header — refunds are keyed
 * `refund:${orderId}:${amount}` on the local ledger, stored under `re_*`.
 */

import { describe, expect, it } from 'vitest';
import { ConflictError, ProviderAuthError } from '@foundry/core';
import { DodoCommerceService } from '../src/commerce/dodo.js';
import type { ServiceDeps } from '../src/deps.js';

const ORDER_ID = 'ord_dodo_1';
const COMPANY_ID = 'co_1';
const PAYMENT_ID = 'pay_dodo_1';
const REFUND_ID = 're_dodo_test_a1';

function digitalProduct(overrides: Record<string, unknown> = {}) {
  return {
    id: 'prd_digital',
    company_id: COMPANY_ID,
    sku: 'addon-1',
    name: 'Digital add-on',
    kind: 'digital_good',
    payment_route: 'dodo_merchant_of_record',
    external_refs: { dodo_product: 'pdt_addon' },
    price_minor: 4000,
    currency: 'USD',
    ...overrides,
  };
}

function orderRow(overrides: Record<string, unknown> = {}) {
  return {
    id: ORDER_ID,
    company_id: COMPANY_ID,
    order_number: 'ORD-9',
    status: 'CREATED',
    payment_route: 'dodo_merchant_of_record',
    currency: 'USD',
    total_minor: 4000,
    amount_paid_minor: 4000,
    amount_refunded_minor: 0,
    external_refs: { dodo_payment_id: PAYMENT_ID, dodo_checkout_session: 'cks_1' },
    ...overrides,
  };
}

function makeDeps(opts: {
  product?: Record<string, unknown>;
  order?: Record<string, unknown>;
  adapter?: {
    createCheckout?: (input: unknown) => Promise<unknown>;
    refund?: (input: unknown) => Promise<unknown>;
  } | null;
  capabilityState?: 'usable' | 'missing';
  idempotency?: { run: ServiceDeps['repos']['idempotency']['run'] };
}) {
  const product = opts.product ?? digitalProduct();
  let order = orderRow(opts.order);
  const refundWrites: unknown[] = [];
  const externalRefs: Record<string, string> = { ...order.external_refs };
  const enqueueCalls: unknown[] = [];
  const idempotencyKeys: string[] = [];

  const adapter = opts.adapter === null ? undefined : {
    createCheckout: opts.adapter?.createCheckout ?? (async () => ({
      sessionId: 'cks_1',
      checkoutUrl: 'https://test.dodopayments.com/checkout/cks_1',
      paymentId: PAYMENT_ID,
    })),
    refund: opts.adapter?.refund ?? (async () => ({
      refundId: REFUND_ID,
      status: 'succeeded',
      amountMinor: 1500,
    })),
  };

  const deps = {
    publicBaseUrl: 'https://example.test',
    environment: 'preview',
    repos: {
      commerce: {
        orders: {
          byId: async () => order,
          lineItems: async () => [
            {
              product_id: product.id,
              name: product.name,
              quantity: 1,
              unit_price_minor: product.price_minor,
            },
          ],
          setExternalRef: async (_id: string, key: string, value: string) => {
            externalRefs[key] = value;
            order = { ...order, external_refs: { ...externalRefs } };
          },
          applyEvent: async () => ({ outcome: 'applied' }),
        },
        products: {
          byId: async () => product,
        },
        payments: {
          byExternalId: async (provider: string, externalId: string) => {
            if (provider === 'dodo' && externalId === PAYMENT_ID) {
              return { id: 'payrow_1', provider: 'dodo', external_id: PAYMENT_ID, amount_minor: 4000, currency: 'USD' };
            }
            return undefined;
          },
          upsert: async () => ({ id: 'payrow_1' }),
          recordRefund: async (input: unknown) => {
            refundWrites.push(input);
            return 'rfd_1';
          },
        },
      },
      idempotency: {
        run: opts.idempotency?.run ?? (async (key: string, _scope: string, fn: () => Promise<unknown>) => {
          idempotencyKeys.push(key);
          return { result: await fn(), replayed: false };
        }),
      },
    },
    providers: {
      forCapability: (capability: string) => {
        if (opts.capabilityState === 'missing' || !adapter) {
          return {
            adapter: undefined,
            status: {
              capability,
              provider: 'dodo',
              state: 'blocked_missing_credentials',
              usable: false,
              evidence: null,
              remediation: 'Issue a working DODO_API_KEY',
              missingSecrets: ['DODO_API_KEY'],
              lastVerifiedAt: null,
              alternatives: [],
            },
          };
        }
        return {
          adapter,
          status: {
            capability,
            provider: 'dodo',
            state: 'configured_unverified',
            usable: true,
            evidence: null,
            remediation: null,
            missingSecrets: [],
            lastVerifiedAt: null,
            alternatives: [],
          },
        };
      },
    },
    queues: {
      enqueue: async (name: string, payload: unknown) => {
        enqueueCalls.push({ name, payload });
        return 'job_1';
      },
    },
  } as unknown as ServiceDeps;

  return { deps, refundWrites, externalRefs, enqueueCalls, idempotencyKeys };
}

describe('DodoCommerceService physical refusal', () => {
  it('throws assertPaymentRoute when a physical bottle is routed through Dodo', async () => {
    const { deps } = makeDeps({
      product: digitalProduct({
        kind: 'physical_good',
        name: 'Private-label bottle',
        payment_route: 'dodo_merchant_of_record',
      }),
      order: { amount_paid_minor: 0, status: 'CREATED' },
    });
    const service = new DodoCommerceService(deps);
    await expect(
      service.startDigitalCheckout({
        companyId: COMPANY_ID,
        orderId: ORDER_ID,
        returnUrl: 'https://example.test/return',
        idempotencyKey: 'checkout:ord_dodo_1',
      }),
    ).rejects.toBeInstanceOf(ConflictError);
  });
});

describe('DodoCommerceService digital checkout', () => {
  it('creates a Dodo checkout for an eligible digital product and stores Dodo refs', async () => {
    const { deps, externalRefs } = makeDeps({
      order: { amount_paid_minor: 0, status: 'CREATED', external_refs: {} },
    });
    const service = new DodoCommerceService(deps);
    const result = await service.startDigitalCheckout({
      companyId: COMPANY_ID,
      orderId: ORDER_ID,
      returnUrl: 'https://example.test/return',
      idempotencyKey: 'checkout:ord_dodo_1',
    });
    expect(result.ok).toBe(true);
    expect(result.data?.checkoutUrl).toContain('dodopayments.com');
    expect(externalRefs['dodo_checkout_session']).toBe('cks_1');
    expect(externalRefs['dodo_payment_id']).toBe(PAYMENT_ID);
  });

  it('returns blocked_missing_credentials rather than a fake checkout when the key is missing', async () => {
    const { deps } = makeDeps({ capabilityState: 'missing', order: { amount_paid_minor: 0, external_refs: {} } });
    const service = new DodoCommerceService(deps);
    const result = await service.startDigitalCheckout({
      companyId: COMPANY_ID,
      orderId: ORDER_ID,
      returnUrl: 'https://example.test/return',
      idempotencyKey: 'checkout:ord_dodo_1',
    });
    expect(result.ok).toBe(false);
    expect(result.blockedOn?.capability).toBe('payments.checkout.digital_mor');
    expect(result.blockedOn?.reason).toMatch(/DODO_API_KEY/);
  });

  it('returns blocked on HTTP 401 rather than treating auth failure as success', async () => {
    const { deps } = makeDeps({
      order: { amount_paid_minor: 0, external_refs: {} },
      adapter: {
        createCheckout: async () => {
          throw new ProviderAuthError('dodo', 'HTTP 401 on checkouts.create', { status: 401 });
        },
      },
    });
    const service = new DodoCommerceService(deps);
    const result = await service.startDigitalCheckout({
      companyId: COMPANY_ID,
      orderId: ORDER_ID,
      returnUrl: 'https://example.test/return',
      idempotencyKey: 'checkout:ord_dodo_1',
    });
    expect(result.ok).toBe(false);
    expect(result.blockedOn?.reason).toMatch(/401|auth|credential/i);
  });
});

describe('DodoCommerceService refund ledger', () => {
  it('keys the local ledger refund:${orderId}:${amount} and stores re_* not the payment id', async () => {
    const { deps, refundWrites, idempotencyKeys, enqueueCalls } = makeDeps({});
    const service = new DodoCommerceService(deps);
    const result = await service.issueRefund({
      companyId: COMPANY_ID,
      orderId: ORDER_ID,
      amountMinor: 1500,
      reason: 'requested_by_customer',
      actorId: 'human:op',
    });
    expect(result.ok).toBe(true);
    expect(result.data?.refundId).toBe(REFUND_ID);
    expect(idempotencyKeys).toContain(`refund:${ORDER_ID}:1500`);
    expect(refundWrites).toHaveLength(1);
    const recorded = refundWrites[0] as { externalId: string; provider: string };
    expect(recorded.provider).toBe('dodo');
    expect(recorded.externalId).toBe(REFUND_ID);
    expect(recorded.externalId.startsWith('re_')).toBe(true);
    expect(recorded.externalId).not.toBe(PAYMENT_ID);
    const ledgerJob = enqueueCalls.find((call) => (call as { name: string }).name === 'finance.reconcile') as
      | { payload: { refundExternalId: string } }
      | undefined;
    expect(ledgerJob?.payload.refundExternalId).toBe(REFUND_ID);
  });

  it('replays a completed local ledger row instead of calling Dodo again', async () => {
    let refundCalls = 0;
    const { deps } = makeDeps({
      adapter: {
        refund: async () => {
          refundCalls += 1;
          return { refundId: REFUND_ID, status: 'succeeded', amountMinor: 1500 };
        },
      },
      idempotency: {
        run: async () => ({
          result: { refundId: REFUND_ID, amountMinor: 1500 },
          replayed: true,
        }),
      },
    });
    const service = new DodoCommerceService(deps);
    const result = await service.issueRefund({
      companyId: COMPANY_ID,
      orderId: ORDER_ID,
      amountMinor: 1500,
      reason: 'requested_by_customer',
      actorId: 'human:op',
    });
    expect(result.ok).toBe(true);
    expect(result.data?.refundId).toBe(REFUND_ID);
    expect(refundCalls).toBe(0);
  });
});

describe('DodoCommerceService missing capability', () => {
  it('does not throw CredentialsMissingError out of issueRefund — blocked, not retry', async () => {
    const { deps } = makeDeps({ capabilityState: 'missing' });
    const service = new DodoCommerceService(deps);
    const result = await service.issueRefund({
      companyId: COMPANY_ID,
      orderId: ORDER_ID,
      amountMinor: 1500,
      reason: 'requested_by_customer',
      actorId: 'human:op',
    });
    expect(result.ok).toBe(false);
    expect(result.blockedOn?.capability).toBe('payments.refund');
  });
});
