/**
 * Webhook processor side effects: persist shipping, upsert the payments row on
 * capture, open disputes through RefundService, and hold mismatched amounts.
 */

import { describe, expect, it } from 'vitest';
import { statusAfterRefund } from '@foundry/core';
import { WebhookProcessorService } from '../src/commerce/webhook-processor.js';
import type { ServiceDeps } from '../src/deps.js';

const NOW = Math.floor(Date.now() / 1000);

function checkoutObject(overrides: Record<string, unknown> = {}) {
  return {
    id: 'cs_test_a1',
    object: 'checkout.session',
    mode: 'payment',
    status: 'complete',
    payment_status: 'paid',
    url: null,
    client_reference_id: 'ord_1',
    amount_subtotal: 4700,
    amount_total: 5787,
    currency: 'usd',
    total_details: { amount_discount: 0, amount_shipping: 699, amount_tax: 388 },
    payment_intent: 'pi_test_a1',
    metadata: { internal_order_id: 'ord_1' },
    customer_details: { email: 'buyer@example.test', name: 'A Buyer', phone: null },
    collected_information: {
      shipping_details: {
        name: 'A Buyer',
        address: {
          line1: '1 Main St',
          city: 'Austin',
          state: 'TX',
          postal_code: '78701',
          country: 'US',
        },
      },
    },
    livemode: false,
    ...overrides,
  };
}

function baseOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ord_1',
    company_id: 'co_1',
    order_number: 'ORD-1001',
    status: 'CHECKOUT_STARTED',
    currency: 'USD',
    total_minor: 5787,
    amount_paid_minor: 0,
    amount_refunded_minor: 0,
    external_refs: { stripe_checkout_session: 'cs_test_a1', stripe_payment_intent: 'pi_test_a1' },
    paid_at: null,
    ...overrides,
  };
}

function makeProcessor(opts: {
  eventType: string;
  payload: unknown;
  order: ReturnType<typeof baseOrder>;
  extras?: {
    disputeRateBps?: number;
    companyConfig?: unknown;
  };
}) {
  const applyCalls: unknown[] = [];
  const paymentUpserts: unknown[] = [];
  const refundWrites: unknown[] = [];
  const enqueueCalls: unknown[] = [];
  const shippingWrites: unknown[] = [];
  const disputes: unknown[] = [];
  let order = { ...opts.order };

  const deps = {
    repos: {
      webhooks: {
        byId: async () => ({
          id: 'wh_1',
          provider: 'stripe',
          event_type: opts.eventType,
          payload: opts.payload,
          signature_verified: true,
          processed_at: null,
          company_id: 'co_1',
        }),
        markProcessed: async () => undefined,
        markFailed: async () => undefined,
        markIgnored: async () => undefined,
      },
      companies: {
        first: async () => ({ id: 'co_1', config: opts.extras?.companyConfig ?? {} }),
        byId: async () => ({ id: 'co_1', config: opts.extras?.companyConfig ?? {} }),
      },
      commerce: {
        orders: {
          byId: async () => order,
          byExternalRef: async (_companyId: string, key: string, value: string) => {
            if (order.external_refs[key] === value) return order;
            if (key === 'stripe_checkout_session' && value === 'cs_test_a1') return order;
            if (key === 'internal_order_id' && value === 'ord_1') return order;
            if (key === 'stripe_payment_intent' && value === 'pi_test_a1') return order;
            if (key === 'stripe_charge' && value === 'ch_test_a1') return order;
            if (key === 'stripe_dispute' && value === 'dp_test_a1') return order;
            return undefined;
          },
          applyEvent: async (input: {
            toStatus: string | null;
            amountPaidDeltaMinor?: number;
            amountRefundedDeltaMinor?: number;
            manualReviewReason?: string;
          }) => {
            applyCalls.push(input);
            if (input.toStatus) order = { ...order, status: input.toStatus };
            if (input.amountPaidDeltaMinor) {
              order = {
                ...order,
                amount_paid_minor: order.amount_paid_minor + input.amountPaidDeltaMinor,
                paid_at: new Date(),
              };
            }
            if (input.amountRefundedDeltaMinor) {
              order = {
                ...order,
                amount_refunded_minor: order.amount_refunded_minor + input.amountRefundedDeltaMinor,
              };
            }
            return { outcome: 'applied', order, eventId: 'evt_1' };
          },
          setExternalRef: async () => undefined,
          setShippingAddress: async (_id: string, address: unknown) => {
            shippingWrites.push(address);
          },
          disputeRateBps: async () => opts.extras?.disputeRateBps ?? 0,
        },
        payments: {
          upsert: async (row: unknown) => {
            paymentUpserts.push(row);
            return { id: 'pay_1', ...((row as object) ?? {}) };
          },
          byExternalId: async (_provider: string, externalId: string) => {
            if (externalId === 'pi_test_a1' || externalId === 'ch_test_a1') {
              return { id: 'pay_1', external_id: externalId };
            }
            return undefined;
          },
          recordRefund: async (row: unknown) => {
            refundWrites.push(row);
            return 'rfd_1';
          },
          upsertDispute: async (row: unknown) => {
            disputes.push(row);
          },
        },
      },
      audit: { append: async () => undefined },
      governance: { killSwitches: { engage: async () => undefined } },
    },
    queues: {
      enqueue: async (queue: string, payload: unknown) => {
        enqueueCalls.push({ queue, payload });
      },
    },
    providers: { forCapability: () => ({ adapter: undefined, status: { state: 'unimplemented' } }) },
    capabilities: { resolveCapability: () => ({ state: 'unimplemented' }) },
  } as unknown as ServiceDeps;

  return {
    service: new WebhookProcessorService(deps),
    applyCalls,
    paymentUpserts,
    refundWrites,
    enqueueCalls,
    shippingWrites,
    disputes,
    getOrder: () => order,
  };
}

describe('WebhookProcessorService paid capture', () => {
  it('escalates to MANUAL_REVIEW when the paid amount disagrees with the order total', async () => {
    const { service, applyCalls } = makeProcessor({
      eventType: 'checkout.session.completed',
      payload: { data: { object: checkoutObject({ amount_total: 9900 }) } },
      order: baseOrder(),
    });
    const result = await service.process('wh_1');
    expect(result.outcome).toBe('escalated');
    expect(result.toStatus).toBe('MANUAL_REVIEW');
    const paid = applyCalls.find((c) => (c as { toStatus?: string }).toStatus === 'PAID');
    expect(paid).toBeUndefined();
  });

  it('upserts a payments row when the order becomes PAID', async () => {
    const { service, paymentUpserts } = makeProcessor({
      eventType: 'checkout.session.completed',
      payload: { data: { object: checkoutObject() } },
      order: baseOrder(),
    });
    const result = await service.process('wh_1');
    expect(result.outcome).toBe('applied');
    expect(result.toStatus).toBe('PAID');
    expect(paymentUpserts).toHaveLength(1);
    expect(paymentUpserts[0]).toMatchObject({
      orderId: 'ord_1',
      provider: 'stripe',
      externalId: 'pi_test_a1',
      amountMinor: 5787,
      currency: 'USD',
    });
  });

  it('persists the Stripe shipping address onto the order', async () => {
    const { service, shippingWrites } = makeProcessor({
      eventType: 'checkout.session.completed',
      payload: { data: { object: checkoutObject() } },
      order: baseOrder(),
    });
    await service.process('wh_1');
    expect(shippingWrites[0]).toMatchObject({
      name: 'A Buyer',
      line1: '1 Main St',
      city: 'Austin',
      postalCode: '78701',
      country: 'US',
    });
  });
});

describe('WebhookProcessorService disputes and refunds', () => {
  it('records an opened dispute through RefundService', async () => {
    const { service, disputes } = makeProcessor({
      eventType: 'charge.dispute.created',
      payload: {
        data: {
          object: {
            id: 'dp_test_a1',
            object: 'dispute',
            amount: 5787,
            currency: 'usd',
            status: 'needs_response',
            reason: 'product_not_received',
            charge: 'ch_test_a1',
            payment_intent: 'pi_test_a1',
            evidence_details: {
              due_by: NOW + 604_800,
              has_evidence: false,
              past_due: false,
              submission_count: 0,
            },
            created: NOW,
          },
        },
      },
      order: baseOrder({ status: 'PAID', amount_paid_minor: 5787 }),
    });
    const result = await service.process('wh_1');
    expect(result.outcome).toBe('applied');
    expect(disputes).toHaveLength(1);
    expect(disputes[0]).toMatchObject({
      orderId: 'ord_1',
      provider: 'stripe',
      externalId: 'dp_test_a1',
      amountMinor: 5787,
    });
  });

  it('uses statusAfterRefund so a full refund is REFUNDED', () => {
    expect(statusAfterRefund({ amountPaidMinor: 5787, amountRefundedMinor: 0 }, 5787)).toBe('REFUNDED');
    expect(statusAfterRefund({ amountPaidMinor: 5787, amountRefundedMinor: 0 }, 2000)).toBe('PARTIALLY_REFUNDED');
  });

  it('applies a full refund as REFUNDED rather than always PARTIALLY_REFUNDED', async () => {
    const { service, applyCalls, refundWrites, enqueueCalls } = makeProcessor({
      eventType: 'refund.created',
      payload: {
        data: {
          object: {
            id: 're_test_a1',
            object: 'refund',
            status: 'succeeded',
            amount: 5787,
            currency: 'usd',
            charge: 'ch_test_a1',
            payment_intent: 'pi_test_a1',
            created: NOW,
          },
        },
      },
      order: baseOrder({ status: 'PAID', amount_paid_minor: 5787 }),
    });
    const result = await service.process('wh_1');
    expect(result.outcome).toBe('applied');
    const applied = applyCalls[0] as { toStatus: string; amountRefundedDeltaMinor: number };
    expect(applied.toStatus).toBe('REFUNDED');
    expect(applied.amountRefundedDeltaMinor).toBe(5787);
    expect(refundWrites).toHaveLength(1);
    expect(refundWrites[0]).toMatchObject({
      orderId: 'ord_1',
      externalId: 're_test_a1',
      amountMinor: 5787,
      authorisedBy: 'webhook',
    });
    expect(enqueueCalls.some((call) => (call as { queue: string }).queue === 'finance.reconcile')).toBe(true);
  });

  it('a lost dispute refunds only remaining captured, not the original charge twice', async () => {
    const { service, applyCalls } = makeProcessor({
      eventType: 'charge.dispute.closed',
      payload: {
        data: {
          object: {
            id: 'dp_test_a1',
            object: 'dispute',
            amount: 5787,
            currency: 'usd',
            status: 'lost',
            reason: 'product_not_received',
            charge: 'ch_test_a1',
            payment_intent: 'pi_test_a1',
            created: NOW,
          },
        },
      },
      order: baseOrder({
        status: 'DISPUTED',
        amount_paid_minor: 5787,
        amount_refunded_minor: 2000,
        external_refs: { stripe_payment_intent: 'pi_test_a1', stripe_charge: 'ch_test_a1' },
      }),
    });
    const result = await service.process('wh_1');
    expect(result.outcome).toBe('applied');
    const applied = applyCalls[0] as { toStatus: string; amountRefundedDeltaMinor: number };
    expect(applied.amountRefundedDeltaMinor).toBe(3787);
    expect(applied.toStatus).toBe('REFUNDED');
  });
});
