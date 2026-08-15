/**
 * Linq inbound webhooks must enqueue support.inbound the same way the web form does.
 * Market-phase outreach must not invent recipients; an empty audience is blocked.
 */

import { describe, expect, it } from 'vitest';
import { CredentialsMissingError } from '@foundry/core';
import type { ServiceDeps } from '../src/deps.js';
import { defaultHackathonCompanyConfig } from '../src/org/default-config.js';
import { WebhookProcessorService } from '../src/commerce/webhook-processor.js';
import { LinqOutreachService } from '../src/marketing/outreach.js';

function companyConfig() {
  return defaultHackathonCompanyConfig({ ownerName: 'Owner', ownerEmail: 'owner@example.test' });
}

describe('WebhookProcessorService Linq inbound', () => {
  it('enqueues support.inbound after ingesting a message.received event', async () => {
    const enqueued: { queue: string; payload: Record<string, unknown> }[] = [];
    const deps = {
      repos: {
        webhooks: {
          byId: async () => ({
            id: 'wh_1',
            provider: 'linq',
            event_type: 'message.received',
            payload: {
              data: {
                chat_id: 'chat_1',
                from: '+15551234567',
                body: 'Where is ord_abc?',
                service: 'SMS',
              },
            },
            company_id: 'co_1',
            signature_verified: true,
            processed_at: null,
          }),
          markProcessed: async () => undefined,
          markFailed: async () => undefined,
          markIgnored: async () => undefined,
        },
        companies: {
          byId: async () => ({
            id: 'co_1',
            config: companyConfig(),
          }),
          first: async () => ({ id: 'co_1' }),
        },
        growth: {
          support: {
            openOrGet: async () => ({
              ticket: { id: 'tkt_1', order_id: null, intent: 'unknown' },
              isNew: true,
            }),
            recordMessage: async () => 'msg_linq_1',
            messageCount: async () => 1,
            escalate: async () => undefined,
            link: async () => undefined,
          },
        },
        commerce: {
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
      queues: {
        enqueue: async (queue: string, payload: Record<string, unknown>) => {
          enqueued.push({ queue, payload });
          return 'job_1';
        },
      },
      providers: {
        forCapability: () => ({ adapter: undefined, status: { usable: false, state: 'blocked_missing_credentials' } }),
      },
    } as unknown as ServiceDeps;

    const result = await new WebhookProcessorService(deps).process('wh_1');
    expect(result.outcome).toBe('ingested');
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]?.queue).toBe('support.inbound');
    expect(enqueued[0]?.payload['supportMessageId']).toBe('msg_linq_1');
    expect(enqueued[0]?.payload['idempotencyKey']).toBe('support:tkt_1:msg_linq_1');
  });
});

describe('LinqOutreachService', () => {
  it('blocks an empty audience instead of inventing recipients, even when Stripe is absent', async () => {
    const deps = {
      repos: {
        companies: {
          byId: async () => ({ id: 'co_1', config: companyConfig() }),
        },
        growth: { support: { recordMessage: async () => 'msg_x' } },
      },
      providers: {
        forCapability: (capability: string) => {
          if (capability === 'messaging.imessage_app' || capability === 'messaging.imessage') {
            return {
              adapter: {
                listChats: async () => ({ data: [], next_cursor: null }),
                sendLink: async () => {
                  throw new Error('must not send to an invented recipient');
                },
                sendAgentPay: async () => {
                  throw new Error('must not use Agent Pay');
                },
                createPaymentRequest: async () => {
                  throw new Error('must not create Agent Pay payment_requests');
                },
              },
              status: { usable: true, state: 'live_verified' },
            };
          }
          return { adapter: undefined, status: { usable: false, state: 'blocked_missing_credentials', remediation: 'stripe missing' } };
        },
      },
      capabilities: {
        resolveCapability: (capability: string) => ({
          capability,
          state: 'blocked_missing_credentials',
          remediation: `${capability} missing`,
        }),
      },
    } as unknown as ServiceDeps;

    const result = await new LinqOutreachService(deps).reachOut({ companyId: 'co_1' });
    expect(result.ok).toBe(false);
    expect(result.blockedOn?.reason).toMatch(/recipient|invent/i);
    expect(result.blockedOn?.capability).toMatch(/^messaging\./);
  });

  it('returns blocked when Linq is missing rather than throwing', async () => {
    const deps = {
      repos: {
        companies: {
          byId: async () => ({ id: 'co_1', config: companyConfig() }),
        },
      },
      providers: {
        forCapability: () => ({
          adapter: undefined,
          status: { usable: false, state: 'blocked_missing_credentials', remediation: 'LINQ_API_V3_API_KEY is not set' },
        }),
      },
      capabilities: {
        resolveCapability: () => ({
          state: 'blocked_missing_credentials',
          remediation: 'LINQ_API_V3_API_KEY is not set',
        }),
      },
    } as unknown as ServiceDeps;

    const result = await new LinqOutreachService(deps).reachOut({ companyId: 'co_1' });
    expect(result.ok).toBe(false);
    expect(result.blockedOn?.reason).toMatch(/LINQ_API_V3_API_KEY|messaging\./i);
  });

  it('sends via linq.sendLink and never Agent Pay when a real handle exists', async () => {
    const calls: string[] = [];
    const config = {
      ...companyConfig(),
      messaging: { ...companyConfig().messaging, outreachHandles: ['+15551234567'] },
    };
    const deps = {
      repos: {
        companies: {
          byId: async () => ({ id: 'co_1', config }),
        },
        growth: {
          support: {
            recordMessage: async () => 'msg_out',
          },
        },
      },
      providers: {
        forCapability: (capability: string) => {
          if (capability.startsWith('payments.')) {
            return {
              adapter: {
                resolveHackathonPaymentLink: async () => ({
                  url: 'https://buy.stripe.com/bJe7sE7Ti3nmbLYdjb2go00',
                }),
              },
              status: { usable: true, state: 'live_verified' },
            };
          }
          return {
            adapter: {
              listChats: async () => ({ data: [], next_cursor: null }),
              sendLink: async (input: { url: string }) => {
                calls.push(`sendLink:${input.url}`);
                return { chatId: 'de316f38-5ead-4ded-8ca9-27a5c4851987', messageIds: ['msg_live'], fromSelection: { from: '+14153051853', reason: 'test' } };
              },
              sendAgentPay: async () => {
                calls.push('sendAgentPay');
                throw new Error('Payment Link is not agentpay checkout_url');
              },
              createPaymentRequest: async () => {
                calls.push('createPaymentRequest');
                throw new Error('Agent Pay 2011');
              },
            },
            status: { usable: true, state: 'live_verified' },
          };
        },
      },
      capabilities: {
        resolveCapability: () => ({ state: 'live_verified', remediation: null }),
      },
    } as unknown as ServiceDeps;

    const result = await new LinqOutreachService(deps).reachOut({ companyId: 'co_1' });
    expect(result.ok).toBe(true);
    expect(calls.some((c) => c.startsWith('sendLink:https://buy.stripe.com/'))).toBe(true);
    expect(calls).not.toContain('sendAgentPay');
    expect(calls).not.toContain('createPaymentRequest');
  });

  it('maps a CredentialsMissingError from Linq into blocked, not a throw', async () => {
    const config = {
      ...companyConfig(),
      messaging: { ...companyConfig().messaging, outreachHandles: ['+15551234567'] },
    };
    const deps = {
      repos: {
        companies: {
          byId: async () => ({ id: 'co_1', config }),
        },
        growth: { support: { recordMessage: async () => 'msg_out' } },
      },
      providers: {
        forCapability: (capability: string) => {
          if (capability.startsWith('payments.')) {
            return {
              adapter: {
                resolveHackathonPaymentLink: async () => ({ url: 'https://buy.stripe.com/bJe7sE7Ti3nmbLYdjb2go00' }),
              },
              status: { usable: true, state: 'live_verified' },
            };
          }
          return {
            adapter: {
              listChats: async () => ({ data: [], next_cursor: null }),
              sendLink: async () => {
                throw new CredentialsMissingError('linq', ['LINQ_API_V3_API_KEY']);
              },
            },
            status: { usable: true, state: 'configured_unverified' },
          };
        },
      },
      capabilities: {
        resolveCapability: () => ({ state: 'blocked_missing_credentials', remediation: 'LINQ_API_V3_API_KEY is not set' }),
      },
    } as unknown as ServiceDeps;

    const result = await new LinqOutreachService(deps).reachOut({ companyId: 'co_1' });
    expect(result.ok).toBe(false);
    expect(result.blockedOn?.reason).toMatch(/LINQ_API_V3_API_KEY/);
  });
});
