/**
 * Support inbox: inbound classification, escalation, replies and refunds.
 *
 * Order status is read from the order row when we have an id, never invented.
 * Opt-out recipients are not messaged. Refunds go through RefundService.
 */

import {
  CapabilityUnsupportedError,
  CredentialsMissingError,
  decideEscalation,
  isOptOutMessage,
  type Capability,
  type MessageChannel,
  type TicketIntent,
} from '@foundry/core';
import { companyConfig } from '@foundry/db';
import { LinqAdapter, LinqOptOutError } from '@foundry/providers';
import { optionalCapability, type ServiceDeps, type ServiceOutcome } from '../deps.js';
import { RefundService, type RefundOutcome, type RefundRequest } from '../commerce/refunds.js';

export interface IngestInboundInput {
  readonly companyId: string;
  readonly channel: MessageChannel;
  readonly externalChatId: string;
  readonly body: string;
  readonly customerHandle: string;
}

export class SupportInboxService {
  constructor(private readonly deps: ServiceDeps) {}

  async ingestInbound(input: IngestInboundInput): Promise<ServiceOutcome<{
    ticketId: string;
    intent: TicketIntent;
    escalated: boolean;
  }>> {
    const classified = classifyIntent(input.body);
    const { ticket } = await this.deps.repos.growth.support.openOrGet({
      companyId: input.companyId,
      channel: input.channel,
      externalChatId: input.externalChatId,
      subject: input.body.slice(0, 120) || classified.intent,
      intent: classified.intent,
      intentConfidence: classified.confidence,
    });

    await this.deps.repos.growth.support.recordMessage({
      companyId: input.companyId,
      ticketId: ticket.id,
      channel: input.channel,
      direction: 'inbound',
      provider: 'linq',
      fromHandle: input.customerHandle,
      toHandle: 'support',
      body: input.body,
      status: 'delivered',
      externalChatId: input.externalChatId,
    });

    const linq = this.#linq(input.channel);
    if (linq && typeof linq.markRead === 'function' && input.externalChatId) {
      try {
        await linq.markRead(input.externalChatId);
      } catch (error) {
        if (error instanceof CredentialsMissingError || error instanceof CapabilityUnsupportedError) {
          // Inbound body is already persisted; outbound will block separately.
        } else {
          throw error;
        }
      }
    }

    let orderFound = Boolean(ticket.order_id);
    if (!orderFound) {
      const maybeId = input.body.match(/\b(ord_[a-z0-9]+)\b/i)?.[1];
      if (maybeId) {
        try {
          const order = await this.deps.repos.commerce.orders.byId(maybeId);
          if (order.company_id === input.companyId) {
            await this.deps.repos.growth.support.link(ticket.id, { orderId: order.id });
            orderFound = true;
          }
        } catch {
          orderFound = false;
        }
      }
    }

    const company = await this.deps.repos.companies.byId(input.companyId);
    const config = companyConfig(company);
    const inboundCount = await this.deps.repos.growth.support.messageCount(ticket.id, 'inbound');
    const decision = decideEscalation({
      intent: classified.intent,
      intentConfidence: classified.confidence,
      requestedRefundMinor: extractRefundRequest(input.body),
      agentRefundLimitMinor: config.risk.agentRefundLimitMinor,
      orderFound,
      customerMessageCount: inboundCount,
      requiresUnverifiableClaim:
        classified.intent === 'order_status' && !orderFound,
    });

    if (decision.escalate) {
      await this.deps.repos.growth.support.escalate(ticket.id, decision.reason ?? 'escalated', decision.priority);
    }

    return {
      ok: true,
      data: { ticketId: ticket.id, intent: classified.intent, escalated: decision.escalate },
    };
  }

  async reply(input: { ticketId: string; body: string }): Promise<ServiceOutcome<{ messageId: string }>> {
    const ticket = await this.deps.repos.growth.support.byId(input.ticketId);
    if (ticket.intent === 'marketing_opt_out') {
      return {
        ok: false,
        blockedOn: { capability: 'messaging.sms', reason: 'Ticket is an opt-out; no outbound message is sent.' },
      };
    }

    const conversation = await this.deps.repos.growth.support.conversation(ticket.id);
    const lastInbound = [...conversation].reverse().find((m) => m.direction === 'inbound');
    if (typeof lastInbound?.body === 'string' && isOptOutMessage(lastInbound.body)) {
      return {
        ok: false,
        blockedOn: { capability: 'messaging.sms', reason: 'Last inbound message was an opt-out keyword; not sending.' },
      };
    }

    const channel = ticket.channel as MessageChannel;
    const linq = this.#linq(channel);
    if (!linq) return blocked(capabilityFor(channel), this.#reason(capabilityFor(channel)));

    const handle = await this.#replyHandle(ticket.id);
    if (!handle) {
      return blocked(capabilityFor(channel), 'No customer handle on the ticket thread to reply to');
    }

    try {
      const sent = ticket.external_chat_id && typeof linq.sendToChat === 'function'
        ? await linq.sendToChat(ticket.external_chat_id, {
            parts: [{ type: 'text', value: input.body }],
            idempotencyKey: `support.reply:${ticket.id}:${hashBody(input.body)}`,
          })
        : await linq.sendMessage({
            to: [handle],
            parts: [{ type: 'text', value: input.body }],
            idempotencyKey: `support.reply:${ticket.id}:${hashBody(input.body)}`,
            preferredService: preferredService(channel),
          });

      const messageId = await this.deps.repos.growth.support.recordMessage({
        companyId: ticket.company_id,
        ticketId: ticket.id,
        channel: ticket.channel,
        direction: 'outbound',
        provider: 'linq',
        fromHandle: sent.fromSelection?.from ?? 'support',
        toHandle: handle,
        body: input.body,
        status: 'sent',
        externalChatId: sent.chatId ?? ticket.external_chat_id,
        externalMessageId: sent.messageIds?.[0] ?? null,
      });
      return { ok: true, data: { messageId } };
    } catch (error) {
      if (error instanceof LinqOptOutError) {
        await this.deps.repos.growth.support.recordMessage({
          companyId: ticket.company_id,
          ticketId: ticket.id,
          channel: ticket.channel,
          direction: 'outbound',
          provider: 'linq',
          fromHandle: 'support',
          toHandle: handle,
          body: input.body,
          status: 'blocked_opt_out',
          failureCode: 'opt_out',
          failureReason: error.message,
          externalChatId: ticket.external_chat_id,
        });
        return {
          ok: false,
          blockedOn: { capability: capabilityFor(channel), reason: error.message },
        };
      }
      return this.#fromProviderError(capabilityFor(channel), error);
    }
  }

  async issueRefund(request: RefundRequest): Promise<RefundOutcome> {
    return new RefundService(this.deps).issue(request);
  }

  #linq(channel: MessageChannel): LinqAdapter | undefined {
    return optionalCapability<LinqAdapter>(this.deps, capabilityFor(channel));
  }

  async #replyHandle(ticketId: string): Promise<string | undefined> {
    const conversation = await this.deps.repos.growth.support.conversation(ticketId);
    const inbound = conversation.find((m) => m.direction === 'inbound');
    return typeof inbound?.from_handle === 'string' ? inbound.from_handle : undefined;
  }

  #reason(capability: Capability): string {
    const status = this.deps.providers.forCapability(capability).status;
    return status.remediation ?? `capability state is ${status.state}`;
  }

  #fromProviderError<T>(capability: Capability, error: unknown): ServiceOutcome<T> {
    if (error instanceof CredentialsMissingError || error instanceof CapabilityUnsupportedError) {
      return blocked(capability, error.message);
    }
    throw error;
  }
}

function blocked<T>(capability: Capability, reason: string): ServiceOutcome<T> {
  return { ok: false, blockedOn: { capability, reason } };
}

function capabilityFor(channel: MessageChannel): Capability {
  switch (channel) {
    case 'imessage':
      return 'messaging.imessage';
    case 'rcs':
      return 'messaging.rcs';
    case 'voice':
      return 'messaging.voice';
    default:
      return 'messaging.sms';
  }
}

function preferredService(channel: MessageChannel): 'iMessage' | 'RCS' | 'SMS' | undefined {
  if (channel === 'imessage') return 'iMessage';
  if (channel === 'rcs') return 'RCS';
  if (channel === 'sms') return 'SMS';
  return undefined;
}

function classifyIntent(body: string): { intent: TicketIntent; confidence: number } {
  const text = body.toLowerCase();
  if (isOptOutMessage(body)) return { intent: 'marketing_opt_out', confidence: 0.95 };
  if (/\b(charg.?back|attorney|lawyer|sue|legal action)\b/.test(text)) return { intent: 'legal_threat', confidence: 0.75 };
  if (/\b(injured|injury|hospital|unsafe|safety)\b/.test(text)) return { intent: 'safety_incident', confidence: 0.7 };
  if (/\brefund\b/.test(text)) return { intent: 'refund_request', confidence: 0.7 };
  if (/\breturn\b/.test(text)) return { intent: 'return_request', confidence: 0.65 };
  if (/\b(where is|tracking|shipped|delivery)\b/.test(text)) return { intent: 'shipping_delay', confidence: 0.65 };
  if (/\b(order status|my order|ord_)\b/.test(text)) return { intent: 'order_status', confidence: 0.6 };
  if (/\bcancel\b/.test(text)) return { intent: 'cancel_order', confidence: 0.6 };
  return { intent: 'unknown', confidence: 0.2 };
}

function extractRefundRequest(body: string): number | null {
  const match = body.match(/\$(\d+(?:\.\d{1,2})?)/);
  if (!match) return null;
  return Math.round(Number.parseFloat(match[1]!) * 100);
}

function hashBody(body: string): string {
  return body.slice(0, 48).replace(/\s+/g, '_');
}
