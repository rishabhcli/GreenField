/**
 * Consumer store intake: a dropship idea becomes a ticket and, when it is
 * not in the catalogue, a real research.collect job. Never a price or a
 * storefront URL invented for the idea.
 */

import type { MessageChannel, TicketIntent } from '@foundry/core';
import type { ServiceDeps, ServiceOutcome } from '../deps.js';
import { matchCatalogProducts, type CatalogMatch } from './sms-invoice.js';

export interface DropshipIdeaInput {
  readonly companyId: string;
  readonly idea: string;
  readonly channel: MessageChannel;
  readonly customerHandle: string;
  readonly externalChatId: string;
  readonly traceId: string;
}

export interface DropshipIdeaResult {
  readonly ticketId: string;
  readonly messageId: string;
  readonly intent: TicketIntent;
  readonly matches: readonly CatalogMatch[];
  readonly sourcingQueued: boolean;
  readonly note: string;
  readonly invoiceUrl: null;
  readonly storefrontUrl: null;
}

export function buildDropshipIdeaResponse(input: {
  readonly ticketId: string;
  readonly intent: TicketIntent;
  readonly matches: readonly CatalogMatch[];
  readonly sourcingQueued: boolean;
  readonly note: string;
}): DropshipIdeaResult & { readonly priceMinor: null } {
  return {
    ticketId: input.ticketId,
    messageId: '',
    intent: input.intent,
    matches: input.matches,
    sourcingQueued: input.sourcingQueued,
    note: input.note,
    invoiceUrl: null,
    storefrontUrl: null,
    priceMinor: null,
  };
}

export async function queueDropshipIfUnmatched(
  deps: Pick<ServiceDeps, 'repos' | 'queues'>,
  input: {
    readonly companyId: string;
    readonly ticketId: string;
    readonly idea: string;
    readonly traceId: string;
  },
): Promise<{ matches: CatalogMatch[]; sourcingQueued: boolean; note: string }> {
  const products = (await deps.repos.commerce.products.listActive(input.companyId)) ?? [];
  const matches = [...matchCatalogProducts(products, input.idea)];
  if (matches.length > 0) {
    return {
      matches,
      sourcingQueued: false,
      note:
        `Matched ${matches[0]!.name} at the catalogue price. ` +
        'A Stripe invoice is sent only for that SKU — never for an invented amount.',
    };
  }

  await deps.queues.enqueue('research.collect', {
    companyId: input.companyId,
    traceId: input.traceId,
    originRunId: null,
    idempotencyKey: `dropship:${input.ticketId}`,
    query: input.idea,
    sourceKinds: ['web', 'reddit'],
    maxItems: 20,
    opportunityId: null,
  });
  return {
    matches,
    sourcingQueued: true,
    note:
      'This idea is not in the catalogue. We started sourcing demand and suppliers. ' +
      'We will only invoice once a real catalogue price exists.',
  };
}

export class DropshipStoreService {
  constructor(private readonly deps: ServiceDeps) {}

  async accept(input: DropshipIdeaInput): Promise<ServiceOutcome<DropshipIdeaResult>> {
    const idea = input.idea.trim();
    const { ticket } = await this.deps.repos.growth.support.openOrGet({
      companyId: input.companyId,
      channel: input.channel,
      externalChatId: input.externalChatId,
      subject: idea.slice(0, 120) || 'dropship_request',
      intent: 'dropship_request',
      intentConfidence: 0.7,
    });

    const messageId = await this.deps.repos.growth.support.recordMessage({
      companyId: input.companyId,
      ticketId: ticket.id,
      channel: input.channel,
      direction: 'inbound',
      provider: input.channel === 'web_form' ? 'web' : 'linq',
      fromHandle: input.customerHandle,
      toHandle: 'store',
      body: idea,
      status: 'delivered',
      externalChatId: input.externalChatId,
    });

    const follow = await queueDropshipIfUnmatched(this.deps, {
      companyId: input.companyId,
      ticketId: ticket.id,
      idea,
      traceId: input.traceId,
    });

    return {
      ok: true,
      data: {
        ticketId: ticket.id,
        messageId,
        intent: 'dropship_request',
        matches: follow.matches,
        sourcingQueued: follow.sourcingQueued,
        note: follow.note,
        invoiceUrl: null,
        storefrontUrl: null,
      },
    };
  }
}
