/**
 * Linq Agent Pay, iMessage experiences, and partner imessage_app guards.
 *
 * Live 2026-08-15: POST /v3/payment_requests is 2011 (no connected payment
 * account). Stripe Payment Links are not agentpay checkout_urls. iMessage Apps
 * go through Linq-hosted experiences (agentpay / agentcard / link). Partner
 * `imessage_app` parts need a real Apple team_id + bundle_id.
 */

import { describe, expect, it } from 'vitest';
import { CredentialsMissingError, SecretStore, ValidationError } from '@foundry/core';
import {
  LinqAdapter,
  LinqChatList,
  LinqMessageList,
  LinqSendMessageResponse,
  LINQ_AGENT_PAY_ERROR_2011,
  isLinqCheckoutUrl,
  isStripePaymentLinkUrl,
} from '../src/linq/index.js';

function emptyAdapter(): LinqAdapter {
  return new LinqAdapter({
    secrets: new SecretStore({ get: () => undefined }),
    environment: 'preview',
    publicBaseUrl: 'https://example.test',
  });
}

function keyedAdapter(fetchImpl: typeof fetch, extra: Record<string, string> = {}): LinqAdapter {
  return new LinqAdapter(
    {
      secrets: new SecretStore({
        get: (name) =>
          name === 'LINQ_API_V3_API_KEY' ? 'linq_test_not_live' : extra[name],
      }),
      environment: 'preview',
      publicBaseUrl: 'https://example.test',
    },
    { fetchImpl },
  );
}

const LIVE_CHAT_SEND = {
  chat_id: 'de316f38-5ead-4ded-8ca9-27a5c4851987',
  message: {
    id: 'cadf5718-203a-4f91-ac05-0a7db9f731cb',
    delivery_status: 'pending',
    parts: [
      {
        type: 'imessage_app',
        app: {
          app_store_id: 6794029060,
          bundle_id: 'com.Linq.AgentKit.MessagesExtension',
          name: 'Agent Apps',
          team_id: 'M9X86M4PHN',
        },
        url: 'https://zero.linqapp.com/c/example',
      },
    ],
  },
};

const LIVE_MESSAGES_SEND = {
  chat_id: 'de316f38-5ead-4ded-8ca9-27a5c4851987',
  created_new_chat: false,
  from: '+14153051853',
  from_selection: { reason: 'reused_active_chat', reused_existing_chat: true },
  message: { id: '3a358962-14ca-4a63-8e99-0b4a11f3af01' },
  service: 'iMessage',
};

describe('LinqAdapter Agent Pay', () => {
  it('createPaymentRequest without credentials names LINQ_API_V3_API_KEY', async () => {
    const adapter = emptyAdapter();
    await expect(
      adapter.createPaymentRequest({
        amountMinor: 500,
        currency: 'usd',
        description: 'test',
      }),
    ).rejects.toSatisfy(
      (error: unknown) => error instanceof CredentialsMissingError && error.missing.includes('LINQ_API_V3_API_KEY'),
    );
  });

  it('createPaymentRequest refuses sub-50-cent amounts before any live call', async () => {
    const adapter = emptyAdapter();
    await expect(
      adapter.createPaymentRequest({
        amountMinor: 49,
        currency: 'usd',
        description: 'too small',
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('sendExperience refuses multi-recipient cards', async () => {
    const adapter = emptyAdapter();
    await expect(
      adapter.sendExperience({
        to: ['+15551212', '+15553434'],
        experience: { name: 'agentpay', action: 'request_payment', params: { checkout_url: 'https://zero.linqapp.com/pay/x' } },
        idempotencyKey: 'k1',
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('sendAgentPay refuses a Stripe Payment Link before any live call', async () => {
    const adapter = emptyAdapter();
    await expect(
      adapter.sendAgentPay({
        to: '+15551212',
        checkoutUrl: 'https://buy.stripe.com/bJe7sE7Ti3nmbLYdjb2go00',
        idempotencyKey: 'k-plink',
      }),
    ).rejects.toSatisfy(
      (error: unknown) => error instanceof ValidationError && /Stripe Payment Link/i.test((error as Error).message),
    );
  });

  it('sendAgentPay refuses a non-Linq checkout_url before any live call', async () => {
    const adapter = emptyAdapter();
    await expect(
      adapter.sendAgentPay({
        to: '+15551212',
        checkoutUrl: 'https://example.test/pay/not-linq',
        idempotencyKey: 'k-other',
      }),
    ).rejects.toSatisfy(
      (error: unknown) => error instanceof ValidationError && /Linq checkout/i.test((error as Error).message),
    );
  });

  it('createPaymentRequest classifies live 2011 as ValidationError, not success', async () => {
    const adapter = keyedAdapter(async () => {
      return new Response(
        JSON.stringify({
          error: {
            code: 2011,
            message: 'no connected payment account on file for your account',
          },
        }),
        { status: 400, headers: { 'content-type': 'application/json' } },
      );
    });

    await expect(
      adapter.createPaymentRequest({
        amountMinor: 50,
        currency: 'usd',
        description: 'foundry live probe — do not collect',
      }),
    ).rejects.toSatisfy((error: unknown) => {
      if (!(error instanceof ValidationError)) return false;
      if (error.retryable) return false;
      return (
        error.message === LINQ_AGENT_PAY_ERROR_2011 &&
        (error.context as { linqErrorCode?: unknown } | undefined)?.linqErrorCode === 2011
      );
    });
  });
});

describe('Linq checkout URL guards', () => {
  it('accepts zero.linqapp.com and rejects buy.stripe.com', () => {
    expect(isLinqCheckoutUrl('https://zero.linqapp.com/pay/acme?session=tok')).toBe(true);
    expect(isLinqCheckoutUrl('https://buy.stripe.com/bJe7sE7Ti3nmbLYdjb2go00')).toBe(false);
    expect(isStripePaymentLinkUrl('https://buy.stripe.com/bJe7sE7Ti3nmbLYdjb2go00')).toBe(true);
    expect(isStripePaymentLinkUrl('https://zero.linqapp.com/pay/acme')).toBe(false);
  });
});

describe('Linq iMessage Apps', () => {
  it('sendIMessageApp refuses docs-placeholder team_id/bundle_id before any live call', async () => {
    const adapter = emptyAdapter();
    await expect(
      adapter.sendIMessageApp({
        to: ['+15551212'],
        part: {
          type: 'imessage_app',
          app: { name: 'Example App', team_id: 'A1B2C3D4E5', bundle_id: 'com.example.app.MessageExtension' },
          url: 'https://example.com/card',
          layout: { caption: 'Example App' },
        },
        idempotencyKey: 'k-app',
      }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof ValidationError && /team_id|bundle_id|Messages extension/i.test((error as Error).message),
    );
  });

  it('sendMessage refuses mixing a link part with text', async () => {
    const adapter = emptyAdapter();
    await expect(
      adapter.sendMessage({
        to: ['+15551212'],
        parts: [
          { type: 'text', value: 'nope' },
          { type: 'link', value: 'https://linqapp.com' },
        ],
        idempotencyKey: 'k-mix',
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('sendMessage refuses SMS for an imessage_app part', async () => {
    const adapter = emptyAdapter();
    await expect(
      adapter.sendMessage({
        to: ['+15551212'],
        preferredService: 'SMS',
        parts: [
          {
            type: 'imessage_app',
            app: { name: 'Agent Apps', team_id: 'M9X86M4PHN', bundle_id: 'com.Linq.AgentKit.MessagesExtension' },
            url: 'https://zero.linqapp.com/c/x',
            layout: { caption: 'Open' },
          },
        ],
        idempotencyKey: 'k-sms-app',
      }),
    ).rejects.toSatisfy(
      (error: unknown) => error instanceof ValidationError && /iMessage/i.test((error as Error).message),
    );
  });

  it('sendLink posts a link/open experience, never parts, on iMessage', async () => {
    let posted: { path: string; body: unknown } | undefined;
    const adapter = keyedAdapter(async (input, init) => {
      const url = new URL(String(input));
      posted = { path: url.pathname, body: JSON.parse(String(init?.body ?? '')) };
      return new Response(JSON.stringify(LIVE_MESSAGES_SEND), {
        status: 202,
        headers: { 'content-type': 'application/json' },
      });
    });

    const result = await adapter.sendLink({
      to: '+15109530626',
      url: 'https://buy.stripe.com/bJe7sE7Ti3nmbLYdjb2go00',
      title: 'Pay Foundry',
      idempotencyKey: 'k-link-exp',
    });

    expect(posted?.body).toMatchObject({
      to: ['+15109530626'],
      message: {
        preferred_service: 'iMessage',
        experience: {
          name: 'link',
          action: 'open',
          params: { url: 'https://buy.stripe.com/bJe7sE7Ti3nmbLYdjb2go00', title: 'Pay Foundry' },
        },
      },
    });
    expect(posted?.body).not.toHaveProperty('message.parts');
    expect(JSON.stringify(posted?.body)).not.toContain('"parts"');
    expect(result.messageIds).toEqual(['3a358962-14ca-4a63-8e99-0b4a11f3af01']);
    expect(result.chatId).toBe('de316f38-5ead-4ded-8ca9-27a5c4851987');
  });

  it('sendMessage and sendLink default from to LINQ_FROM_NUMBER when the caller omits it', async () => {
    const posted: unknown[] = [];
    const adapter = keyedAdapter(async (_input, init) => {
      posted.push(JSON.parse(String(init?.body ?? '')));
      return new Response(JSON.stringify(LIVE_MESSAGES_SEND), {
        status: 202,
        headers: { 'content-type': 'application/json' },
      });
    }, { LINQ_FROM_NUMBER: '+14155550100' });

    await adapter.sendMessage({
      to: ['+15551234567'],
      parts: [{ type: 'text', value: 'here is your invoice' }],
      idempotencyKey: 'k-from-text',
      preferredService: 'SMS',
    });
    await adapter.sendLink({
      to: '+15551234567',
      url: 'https://invoice.stripe.com/i/acct_test/hosted',
      title: 'Stripe invoice',
      idempotencyKey: 'k-from-link',
    });

    expect(posted[0]).toMatchObject({ from: '+14155550100', to: ['+15551234567'] });
    expect(posted[1]).toMatchObject({ from: '+14155550100', to: ['+15551234567'] });
  });

  it('sendExperience posts experience XOR parts with preferred_service iMessage', async () => {
    let posted: unknown;
    const adapter = keyedAdapter(async (input, init) => {
      posted = JSON.parse(String(init?.body ?? ''));
      return new Response(JSON.stringify(LIVE_CHAT_SEND), {
        status: 202,
        headers: { 'content-type': 'application/json' },
      });
    });

    const result = await adapter.sendExperience({
      to: ['+15109530626'],
      chatId: 'de316f38-5ead-4ded-8ca9-27a5c4851987',
      experience: { name: 'agentcard', action: 'attach_card', params: { title: 'Foundry wallet' } },
      idempotencyKey: 'k-card',
    });

    expect(posted).toMatchObject({
      message: {
        preferred_service: 'iMessage',
        experience: { name: 'agentcard', action: 'attach_card', params: { title: 'Foundry wallet' } },
      },
    });
    expect(JSON.stringify(posted)).not.toContain('"parts"');
    expect(result.messageIds).toEqual(['cadf5718-203a-4f91-ac05-0a7db9f731cb']);
  });

  it('sendAgentCard refuses approve_card without payment_id', async () => {
    const adapter = emptyAdapter();
    await expect(
      adapter.sendAgentCard({
        to: '+15551212',
        action: 'approve_card',
        idempotencyKey: 'k-approve',
      }),
    ).rejects.toSatisfy(
      (error: unknown) => error instanceof ValidationError && /payment_id/i.test((error as Error).message),
    );
  });
});

describe('Linq live response envelopes', () => {
  it('parses POST /v3/messages 202 without message_ids/created_chat/trace_id', () => {
    const parsed = LinqSendMessageResponse.safeParse(LIVE_MESSAGES_SEND);
    expect(parsed.success).toBe(true);
  });

  it('parses POST /v3/chats/{id}/messages 202 with only chat_id+message', () => {
    const parsed = LinqSendMessageResponse.safeParse(LIVE_CHAT_SEND);
    expect(parsed.success).toBe(true);
  });

  it('parses GET /v3/chats { chats } with object health_status', () => {
    const parsed = LinqChatList.safeParse({
      chats: [
        {
          id: 'de316f38-5ead-4ded-8ca9-27a5c4851987',
          health_status: { status: 'HEALTHY', doc_url: 'https://docs.linqapp.com/guides/chats/chat-health#healthy' },
          handles: [{ handle: '+15109530626', is_me: false, service: 'iMessage' }],
          service: 'iMessage',
        },
      ],
      next_cursor: null,
    });
    expect(parsed.success).toBe(true);
  });

  it('parses GET /v3/chats/{id}/messages { messages }', () => {
    const parsed = LinqMessageList.safeParse({
      messages: [
        {
          id: 'abb84404-e7fe-43e2-904c-5be5803df3dc',
          chat_id: 'de316f38-5ead-4ded-8ca9-27a5c4851987',
          from: '+14153051853',
          parts: [{ type: 'link', value: 'https://linqapp.com' }],
          service: 'iMessage',
          status: 'delivered',
        },
      ],
      next_cursor: null,
    });
    expect(parsed.success).toBe(true);
  });
});
