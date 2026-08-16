/**
 * Inbound ingest returns the persisted message id, opt-out keywords persist
 * consent withdrawal, sensitive intents escalate, and a missing Linq key
 * blocks a reply instead of throwing (retrying an unissued key burns budget).
 */

import { describe, expect, it } from 'vitest';
import { CredentialsMissingError } from '@foundry/core';
import type { ServiceDeps } from '../src/deps.js';
import { defaultHackathonCompanyConfig } from '../src/org/default-config.js';
import { SupportInboxService } from '../src/support/inbox.js';

function inboxDeps(opts: {
  recordConsent?: (id: string, channel: 'email' | 'sms', granted: boolean, source: string) => Promise<void>;
  upsertCustomer?: (input: { phoneE164?: string | null; email?: string | null }) => Promise<{ id: string }>;
  ticket?: Record<string, unknown>;
  conversation?: Array<Record<string, unknown>>;
  linqAdapter?: unknown;
  linqStatus?: { usable: boolean; state: string; remediation?: string };
  products?: readonly {
    sku: string;
    name: string;
    description?: string | null;
    price_minor: number;
    currency: string;
  }[];
  enqueue?: (queue: string, payload: Record<string, unknown>) => Promise<string>;
}): {
  deps: ServiceDeps;
  consents: { granted: boolean; channel: string; source: string }[];
  escalations: { ticketId: string; reason: string }[];
} {
  const consents: { granted: boolean; channel: string; source: string }[] = [];
  const escalations: { ticketId: string; reason: string }[] = [];
  const ticket = {
    id: 'tkt_1',
    company_id: 'co_1',
    order_id: null,
    intent: 'unknown',
    channel: 'sms',
    external_chat_id: 'chat_1',
    ...opts.ticket,
  };
  const deps = {
    repos: {
      growth: {
        support: {
          openOrGet: async () => ({ ticket, isNew: true }),
          byId: async () => ticket,
          recordMessage: async () => 'msg_1',
          messageCount: async () => 1,
          conversation: async () => opts.conversation ?? [],
          escalate: async (ticketId: string, reason: string) => {
            escalations.push({ ticketId, reason });
          },
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
        customers: {
          upsert: opts.upsertCustomer ?? (async () => ({ id: 'cus_1' })),
          recordConsent: async (id: string, channel: 'email' | 'sms', granted: boolean, source: string) => {
            consents.push({ granted, channel, source });
            await opts.recordConsent?.(id, channel, granted, source);
          },
        },
        products: {
          listActive: async () => opts.products ?? [],
        },
        orders: {
          byId: async () => {
            throw new Error('no order');
          },
        },
      },
    },
    queues: {
      enqueue: opts.enqueue ?? (async () => 'job_unused'),
    },
    providers: {
      forCapability: () => ({
        adapter: opts.linqAdapter,
        status: opts.linqStatus ?? { usable: false, state: 'blocked_missing_credentials', remediation: 'LINQ_API_V3_API_KEY is not set' },
      }),
    },
  } as unknown as ServiceDeps;
  return { deps, consents, escalations };
}

describe('SupportInboxService.ingestInbound', () => {
  it('returns the persisted inbound message id', async () => {
    const { deps } = inboxDeps({});
    const result = await new SupportInboxService(deps).ingestInbound({
      companyId: 'co_1',
      channel: 'sms',
      externalChatId: 'chat_1',
      body: 'Where is my order?',
      customerHandle: '+15551234567',
    });
    expect(result.ok).toBe(true);
    expect(result.data?.messageId).toBe('msg_1');
    expect(result.data?.ticketId).toBe('tkt_1');
  });

  it('records consent withdrawal when the inbound body is an opt-out keyword', async () => {
    const { deps, consents } = inboxDeps({});
    const result = await new SupportInboxService(deps).ingestInbound({
      companyId: 'co_1',
      channel: 'sms',
      externalChatId: 'chat_1',
      body: 'STOP',
      customerHandle: '+15551234567',
    });
    expect(result.ok).toBe(true);
    expect(result.data?.intent).toBe('marketing_opt_out');
    expect(consents).toEqual([{ granted: false, channel: 'sms', source: 'inbound_opt_out' }]);
  });

  it('classifies a buy / invoice request as product_question so the agent can send a Stripe invoice', async () => {
    const cases = ['send me the invoice', 'I want to buy the founding access', 'can I pay over text?'];
    for (const body of cases) {
      const { deps } = inboxDeps({});
      const result = await new SupportInboxService(deps).ingestInbound({
        companyId: 'co_1',
        channel: 'sms',
        externalChatId: 'chat_1',
        body,
        customerHandle: '+15551234567',
      });
      expect(result.ok).toBe(true);
      expect(result.data?.intent).toBe('product_question');
      expect(result.data?.escalated).toBe(false);
    }
  });

  it('treats a dropship idea as the store, greets on first text, and does not escalate', async () => {
    const sent: { body: string }[] = [];
    const { deps, escalations } = inboxDeps({
      linqAdapter: {
        sendToChat: async (_chatId: string, input: { parts: { value: string }[] }) => {
          sent.push({ body: input.parts[0]?.value ?? '' });
          return { messageIds: ['msg_greet'], chatId: 'chat_1', fromSelection: { from: '+14155550100' } };
        },
      },
      linqStatus: { usable: true, state: 'live_verified' },
    });
    const result = await new SupportInboxService(deps).ingestInbound({
      companyId: 'co_1',
      channel: 'sms',
      externalChatId: 'chat_1',
      body: 'ship me a ceramic pour-over',
      customerHandle: '+15551234567',
    });
    expect(result.ok).toBe(true);
    expect(result.data?.intent).toBe('dropship_request');
    expect(result.data?.escalated).toBe(false);
    expect(escalations).toEqual([]);
    expect(sent[0]?.body).toMatch(/this is the store/i);
  });

  it('queues research.collect for a dog-costume website idea that is not in the catalogue', async () => {
    const enqueued: { queue: string; payload: Record<string, unknown> }[] = [];
    const idea = 'Hey I want to dropship a website that sells custom made costumes for dogs';
    const { deps, escalations } = inboxDeps({
      products: [{ sku: 'zhc-founding', name: 'Founding access', description: null, price_minor: 9900, currency: 'USD' }],
      enqueue: async (queue, payload) => {
        enqueued.push({ queue, payload });
        return 'job_1';
      },
    });
    const result = await new SupportInboxService(deps).ingestInbound({
      companyId: 'co_1',
      channel: 'sms',
      externalChatId: 'chat_1',
      body: idea,
      customerHandle: '+15551234567',
    });
    expect(result.ok).toBe(true);
    expect(result.data?.intent).toBe('dropship_request');
    expect(result.data?.sourcingQueued).toBe(true);
    expect(escalations).toEqual([]);
    expect(enqueued[0]).toMatchObject({
      queue: 'research.collect',
      payload: { query: idea, sourceKinds: ['web', 'reddit'] },
    });
  });

  it('treats a hello as a store enquiry rather than a low-confidence unknown', async () => {
    const { deps, escalations } = inboxDeps({});
    const result = await new SupportInboxService(deps).ingestInbound({
      companyId: 'co_1',
      channel: 'sms',
      externalChatId: 'chat_1',
      body: 'hi',
      customerHandle: '+15551234567',
    });
    expect(result.ok).toBe(true);
    expect(result.data?.intent).toBe('general_enquiry');
    expect(result.data?.escalated).toBe(false);
    expect(escalations).toEqual([]);
  });

  it('escalates legal, safety, chargeback, and regulator inbound rather than answering', async () => {
    const cases = [
      { body: 'I will sue you and have my attorney call', intent: 'legal_threat' },
      { body: 'This product injured me at the hospital', intent: 'safety_incident' },
      { body: 'I am filing a chargeback with my bank', intent: 'chargeback_threat' },
      { body: 'This is a regulator inquiry from the FTC', intent: 'regulator_or_media' },
    ] as const;
    for (const c of cases) {
      const { deps, escalations } = inboxDeps({});
      const result = await new SupportInboxService(deps).ingestInbound({
        companyId: 'co_1',
        channel: 'sms',
        externalChatId: 'chat_1',
        body: c.body,
        customerHandle: '+15551234567',
      });
      expect(result.ok).toBe(true);
      expect(result.data?.intent).toBe(c.intent);
      expect(result.data?.escalated).toBe(true);
      expect(escalations.length).toBeGreaterThan(0);
    }
  });
});

describe('SupportInboxService.reply', () => {
  it('returns blocked when Linq credentials are missing instead of throwing', async () => {
    const { deps } = inboxDeps({
      ticket: { intent: 'general_enquiry' },
      conversation: [{ direction: 'inbound', from_handle: '+15551234567', body: 'hi' }],
    });
    const result = await new SupportInboxService(deps).reply({ ticketId: 'tkt_1', body: 'We received your message.' });
    expect(result.ok).toBe(false);
    expect(result.blockedOn?.reason).toMatch(/LINQ_API_V3_API_KEY|missing|blocked/i);
  });

  it('does not send when the last inbound message was an opt-out keyword', async () => {
    let sent = 0;
    const { deps } = inboxDeps({
      ticket: { intent: 'general_enquiry' },
      conversation: [{ direction: 'inbound', from_handle: '+15551234567', body: 'STOP' }],
      linqAdapter: {
        sendMessage: async () => {
          sent += 1;
          throw new Error('must not send');
        },
        sendToChat: async () => {
          sent += 1;
          throw new Error('must not send');
        },
      },
      linqStatus: { usable: true, state: 'live_verified' },
    });
    const result = await new SupportInboxService(deps).reply({ ticketId: 'tkt_1', body: 'Thanks' });
    expect(result.ok).toBe(false);
    expect(sent).toBe(0);
    expect(result.blockedOn?.reason).toMatch(/opt-out/i);
  });

  it('maps a CredentialsMissingError from Linq into a blocked outcome, not a throw', async () => {
    const { deps } = inboxDeps({
      ticket: { intent: 'general_enquiry', external_chat_id: null },
      conversation: [{ direction: 'inbound', from_handle: '+15551234567', body: 'hi' }],
      linqAdapter: {
        sendMessage: async () => {
          throw new CredentialsMissingError('linq', ['LINQ_API_V3_API_KEY']);
        },
      },
      linqStatus: { usable: true, state: 'configured_unverified' },
    });
    const result = await new SupportInboxService(deps).reply({ ticketId: 'tkt_1', body: 'We received your message.' });
    expect(result.ok).toBe(false);
    expect(result.blockedOn?.capability).toBe('messaging.sms');
  });
});
