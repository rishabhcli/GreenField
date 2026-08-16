/**
 * Consumer dropship intake: a new idea must start real research, never a
 * invented price or storefront URL.
 */

import { describe, expect, it } from 'vitest';
import { DropshipStoreService, buildDropshipIdeaResponse } from '../src/commerce/store-intake.js';
import type { ServiceDeps } from '../src/deps.js';
import { defaultHackathonCompanyConfig } from '../src/org/default-config.js';

const DOG_COSTUME_IDEA =
  'Hey I want to dropship a website that sells custom made costumes for dogs';

function intakeDeps(opts: {
  readonly products?: readonly {
    sku: string;
    name: string;
    description?: string | null;
    price_minor: number;
    currency: string;
  }[];
}): {
  service: DropshipStoreService;
  enqueued: { queue: string; payload: Record<string, unknown> }[];
} {
  const enqueued: { queue: string; payload: Record<string, unknown> }[] = [];
  const ticket = {
    id: 'tkt_dog',
    company_id: 'co_1',
    order_id: null,
    intent: 'dropship_request',
    channel: 'web_form',
    external_chat_id: 'web:idea',
  };
  const service = new DropshipStoreService({
    repos: {
      growth: {
        support: {
          openOrGet: async () => ({ ticket, isNew: true }),
          byId: async () => ticket,
          recordMessage: async () => 'msg_idea',
          messageCount: async () => 1,
          conversation: async () => [],
          escalate: async () => undefined,
          link: async () => undefined,
        },
      },
      companies: {
        byId: async () => ({
          id: 'co_1',
          config: defaultHackathonCompanyConfig({ ownerName: 'Owner', ownerEmail: 'owner@example.test' }),
        }),
      },
      commerce: {
        products: {
          listActive: async () => opts.products ?? [
            {
              sku: 'zhc-founding',
              name: 'Founding access',
              description: 'Complete source and Render blueprint',
              price_minor: 9900,
              currency: 'USD',
            },
          ],
        },
        customers: {
          upsert: async () => ({ id: 'cus_1' }),
          recordConsent: async () => undefined,
        },
        orders: {
          byId: async () => {
            throw new Error('no order');
          },
        },
      },
    },
    providers: {
      forCapability: () => ({
        adapter: undefined,
        status: { usable: false, state: 'blocked_missing_credentials', remediation: 'LINQ_API_V3_API_KEY is not set' },
      }),
    },
    queues: {
      enqueue: async (queue: string, payload: Record<string, unknown>) => {
        enqueued.push({ queue, payload });
        return 'job_1';
      },
    },
  } as unknown as ServiceDeps);
  return { service, enqueued };
}

describe('DropshipStoreService.accept', () => {
  it('starts research for a dog-costume website idea and does not invent a price', async () => {
    const { service, enqueued } = intakeDeps({});
    const result = await service.accept({
      companyId: 'co_1',
      idea: DOG_COSTUME_IDEA,
      channel: 'web_form',
      customerHandle: 'web',
      externalChatId: 'web:idea',
      traceId: 'tr_dog',
    });
    expect(result.ok).toBe(true);
    expect(result.data?.intent).toBe('dropship_request');
    expect(result.data?.matches).toEqual([]);
    expect(result.data?.sourcingQueued).toBe(true);
    expect(result.data?.invoiceUrl).toBeNull();
    expect(result.data?.storefrontUrl).toBeNull();
    expect(result.data?.note).toMatch(/sourc/i);
    expect(result.data?.note).not.toMatch(/\$\d/);
    expect(enqueued).toEqual([
      expect.objectContaining({
        queue: 'research.collect',
        payload: expect.objectContaining({
          companyId: 'co_1',
          query: DOG_COSTUME_IDEA,
          sourceKinds: ['web', 'reddit'],
        }),
      }),
    ]);
  });

  it('does not start sourcing when the idea already matches a catalogue SKU', async () => {
    const { service, enqueued } = intakeDeps({
      products: [
        {
          sku: 'pour-over-ceramic',
          name: 'Ceramic pour-over',
          description: 'Cone dripper',
          price_minor: 4200,
          currency: 'USD',
        },
      ],
    });
    const result = await service.accept({
      companyId: 'co_1',
      idea: 'ship me a ceramic pour-over',
      channel: 'web_form',
      customerHandle: 'web',
      externalChatId: 'web:pour',
      traceId: 'tr_pour',
    });
    expect(result.ok).toBe(true);
    expect(result.data?.matches[0]?.sku).toBe('pour-over-ceramic');
    expect(result.data?.matches[0]?.priceMinor).toBe(4200);
    expect(result.data?.sourcingQueued).toBe(false);
    expect(enqueued).toEqual([]);
  });
});

describe('buildDropshipIdeaResponse', () => {
  it('never includes an invented invoice or storefront URL', () => {
    const body = buildDropshipIdeaResponse({
      ticketId: 'tkt_1',
      intent: 'dropship_request',
      matches: [],
      sourcingQueued: true,
      note: 'We started sourcing. No invoice until a catalogue price exists.',
    });
    expect(body.invoiceUrl).toBeNull();
    expect(body.storefrontUrl).toBeNull();
    expect(body.priceMinor).toBeNull();
  });
});
