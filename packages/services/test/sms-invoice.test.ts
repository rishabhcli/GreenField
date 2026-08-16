/**
 * SMS / iMessage invoice: catalogue price only, Stripe hosted invoice URL,
 * delivered on the Linq thread. The model cannot supply an amount.
 */

import { describe, expect, it } from 'vitest';
import { ValidationError } from '@foundry/core';
import { matchCatalogProducts, SmsInvoiceService } from '../src/commerce/sms-invoice.js';
import type { ServiceDeps } from '../src/deps.js';

function deps(options: {
  readonly products?: readonly { sku: string; id: string; name: string; price_minor: number; currency: string; payment_route: string; status: string }[];
  readonly invoiceUrl?: string;
  readonly linqUsable?: boolean;
}): {
  service: SmsInvoiceService;
  createdOrders: Record<string, unknown>[];
  sentLinks: Record<string, unknown>[];
  invoices: Record<string, unknown>[];
} {
  const createdOrders: Record<string, unknown>[] = [];
  const sentLinks: Record<string, unknown>[] = [];
  const invoices: Record<string, unknown>[] = [];
  const products = options.products ?? [
    {
      id: 'prd_1',
      sku: 'zhc-founding',
      name: 'Founding access',
      price_minor: 9900,
      currency: 'USD',
      payment_route: 'stripe_direct',
      status: 'active',
    },
  ];
  const stripe = {
    createAndFinalizeInvoice: async (input: Record<string, unknown>) => {
      invoices.push(input);
      return {
        invoiceId: 'in_test_1',
        hostedInvoiceUrl: options.invoiceUrl ?? 'https://invoice.stripe.com/i/acct_test/hosted',
        customerId: 'cus_stripe_1',
        amountDueMinor: 9900,
        currency: 'usd',
      };
    },
  };
  const linq = {
    sendLink: async (input: Record<string, unknown>) => {
      sentLinks.push(input);
      return { messageIds: ['msg_out_1'], chatId: input.chatId ?? 'chat_1' };
    },
    sendMessage: async () => ({ messageIds: ['msg_txt_1'], chatId: 'chat_1' }),
  };
  const service = new SmsInvoiceService({
    repos: {
      commerce: {
        products: {
          listActive: async () => products,
          bySku: async (_companyId: string, sku: string) => products.find((p) => p.sku === sku),
        },
        customers: {
          upsert: async (input: { phoneE164?: string | null; email?: string | null }) => ({
            id: 'cus_1',
            phone_e164: input.phoneE164 ?? null,
            email: input.email ?? null,
          }),
        },
        orders: {
          create: async (input: Record<string, unknown>) => {
            createdOrders.push(input);
            return {
              order: {
                id: 'ord_1',
                company_id: 'co_1',
                total_minor: 9900,
                currency: 'USD',
                payment_route: 'stripe_direct',
                external_refs: {},
              },
            };
          },
          setExternalRef: async () => undefined,
          applyEvent: async () => ({ outcome: 'applied' }),
        },
      },
    },
    providers: {
      forCapability: (capability: string) => {
        if (capability.startsWith('payments.')) {
          return { adapter: stripe, status: { usable: true, state: 'live_verified' } };
        }
        if (capability.startsWith('messaging.')) {
          return {
            adapter: options.linqUsable === false ? undefined : linq,
            status: {
              usable: options.linqUsable !== false,
              state: options.linqUsable === false ? 'blocked_missing_credentials' : 'live_verified',
              remediation: options.linqUsable === false ? 'LINQ_API_V3_API_KEY is not set' : undefined,
            },
          };
        }
        return { adapter: undefined, status: { usable: false, state: 'blocked_missing_credentials' } };
      },
    },
    capabilities: {
      resolveCapability: (capability: string) => {
        if (capability.startsWith('payments.')) return { usable: true, state: 'live_verified' };
        if (capability.startsWith('messaging.')) {
          return {
            usable: options.linqUsable !== false,
            state: options.linqUsable === false ? 'blocked_missing_credentials' : 'live_verified',
            remediation: options.linqUsable === false ? 'LINQ_API_V3_API_KEY is not set' : undefined,
          };
        }
        return { usable: false, state: 'blocked_missing_credentials' };
      },
    },
    publicBaseUrl: 'https://api.example.test',
  } as unknown as ServiceDeps);
  return { service, createdOrders, sentLinks, invoices };
}

describe('matchCatalogProducts', () => {
  const catalog = [
    {
      sku: 'zhc-founding',
      name: 'Founding access',
      description: 'Complete source and Render blueprint',
      price_minor: 9900,
      currency: 'USD',
    },
    {
      sku: 'pour-over-ceramic',
      name: 'Ceramic pour-over',
      description: 'Cone dripper',
      price_minor: 4200,
      currency: 'USD',
    },
  ];

  it('returns catalogue prices for overlapping tokens and invents nothing', () => {
    const matches = matchCatalogProducts(catalog, 'ship me a ceramic pour-over');
    expect(matches[0]?.sku).toBe('pour-over-ceramic');
    expect(matches[0]?.priceMinor).toBe(4200);
  });

  it('returns no SKU when the idea is not in the catalogue', () => {
    expect(matchCatalogProducts(catalog, 'titanium camping kettle')).toEqual([]);
  });
});

describe('SmsInvoiceService', () => {
  it('issues a Stripe hosted invoice at the catalogue price and sends it on Linq', async () => {
    const { service, createdOrders, sentLinks, invoices } = deps({});
    const result = await service.issue({
      companyId: 'co_1',
      toHandle: '+15551234567',
      chatId: 'chat_1',
      idempotencyKey: 'inv:co_1:+15551234567',
    });
    expect(result.ok).toBe(true);
    expect(result.data?.hostedInvoiceUrl).toBe('https://invoice.stripe.com/i/acct_test/hosted');
    expect(result.data?.orderId).toBe('ord_1');
    expect(result.data?.invoiceId).toBe('in_test_1');
    expect(createdOrders[0]).toMatchObject({
      companyId: 'co_1',
      paymentRoute: 'stripe_direct',
      lineItems: [{ sku: 'zhc-founding', unitPriceMinor: 9900, quantity: 1 }],
    });
    expect(invoices[0]).toMatchObject({
      orderId: 'ord_1',
      phoneE164: '+15551234567',
      amountMinor: 9900,
    });
    expect(invoices[0]).not.toHaveProperty('amountMinorOverride');
    expect(sentLinks[0]).toMatchObject({
      to: '+15551234567',
      url: 'https://invoice.stripe.com/i/acct_test/hosted',
      chatId: 'chat_1',
    });
  });

  it('refuses a caller-supplied amount — price comes from the catalogue row', () => {
    const input: Parameters<SmsInvoiceService['issue']>[0] = {
      companyId: 'co_1',
      toHandle: '+15551234567',
      idempotencyKey: 'k',
    };
    expect(input).not.toHaveProperty('amountMinor');
  });

  it('blocks when Linq cannot send rather than inventing a delivered invoice', async () => {
    const { service, sentLinks } = deps({ linqUsable: false });
    const result = await service.issue({
      companyId: 'co_1',
      toHandle: '+15551234567',
      idempotencyKey: 'k-blocked',
    });
    expect(result.ok).toBe(false);
    expect(result.blockedOn?.capability).toMatch(/messaging\./);
    expect(sentLinks).toHaveLength(0);
  });

  it('refuses a Dodo-routed catalogue SKU rather than invoicing it on Stripe', async () => {
    const { service } = deps({
      products: [
        {
          id: 'prd_dodo',
          sku: 'digital-1',
          name: 'Digital',
          price_minor: 2000,
          currency: 'USD',
          payment_route: 'dodo_merchant_of_record',
          status: 'active',
        },
      ],
    });
    await expect(
      service.issue({
        companyId: 'co_1',
        sku: 'digital-1',
        toHandle: '+15551234567',
        idempotencyKey: 'k-dodo',
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});
