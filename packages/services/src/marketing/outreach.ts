/**
 * Proactive Linq outreach: send the fixed-price checkout *link* (Linq-hosted
 * `link`/`open` experience) to recipients we already know — configured handles
 * and existing Linq chats.
 *
 * Does not invent phone numbers. An empty recipient set is a blocked result,
 * not a fabricated send. A Stripe Payment Link may be `params.url` on `link`;
 * it is never an Agent Pay `checkout_url`. Opt-out is enforced by the Linq
 * adapter. Missing credentials return blocked, never throw.
 */

import { CredentialsMissingError, CapabilityUnsupportedError } from '@foundry/core';
import { companyConfig } from '@foundry/db';
import { LinqAdapter, StripeAdapter } from '@foundry/providers';
import { optionalCapability, type ServiceDeps, type ServiceOutcome } from '../deps.js';

export interface OutreachInput {
  readonly companyId: string;
  readonly runId?: string | null;
}

export interface OutreachSend {
  readonly toHandle: string;
  readonly chatId?: string;
  readonly messageIds: readonly string[];
}

export interface OutreachResult {
  readonly sent: readonly OutreachSend[];
  readonly skipped: readonly { readonly handle: string; readonly reason: string }[];
  readonly stripePaymentLinkUrl: string;
}

export class LinqOutreachService {
  constructor(private readonly deps: ServiceDeps) {}

  async reachOut(input: OutreachInput): Promise<ServiceOutcome<OutreachResult>> {
    const linq =
      optionalCapability<LinqAdapter>(this.deps, 'messaging.imessage_app') ??
      optionalCapability<LinqAdapter>(this.deps, 'messaging.imessage');
    if (!linq) {
      const status = this.deps.capabilities.resolveCapability('messaging.imessage_app');
      return {
        ok: false,
        blockedOn: {
          capability: 'messaging.imessage_app',
          reason: status.remediation ?? `messaging.imessage_app is ${status.state}`,
        },
      };
    }

    const company = await this.deps.repos.companies.byId(input.companyId);
    const config = companyConfig(company);
    const handles = new Set<string>(configuredOutreachHandles(config.messaging));
    const chatByHandle = new Map<string, string>();

    try {
      const chats = await linq.listChats({ limit: 50 });
      for (const chat of chats.data) {
        const participants = Array.isArray(chat.participants) ? chat.participants : [];
        for (const handle of participants) {
          if (typeof handle === 'string' && handle.length > 0) {
            handles.add(handle);
            chatByHandle.set(handle, chat.id);
          }
        }
      }
    } catch (error) {
      if (error instanceof CredentialsMissingError || error instanceof CapabilityUnsupportedError) {
        return {
          ok: false,
          blockedOn: { capability: 'messaging.imessage_app', reason: error.message },
        };
      }
      // Configured handles still go out; a failed chat list is not a fabricated roster.
    }

    if (handles.size === 0) {
      return {
        ok: false,
        blockedOn: {
          capability: 'messaging.imessage_app',
          reason:
            'No Linq outreach recipients. Set company.messaging.outreachHandles to real E.164/Linq handles, or wait until an inbound chat exists. Recipients are never invented.',
        },
      };
    }

    const stripe =
      optionalCapability<StripeAdapter>(this.deps, 'payments.payment_link') ??
      optionalCapability<StripeAdapter>(this.deps, 'payments.checkout.physical');
    if (!stripe) {
      const status = this.deps.capabilities.resolveCapability('payments.payment_link');
      return {
        ok: false,
        blockedOn: {
          capability: 'payments.payment_link',
          reason: status.remediation ?? `payments.payment_link is ${status.state}`,
        },
      };
    }

    let stripeUrl: string;
    try {
      const link = await stripe.resolveHackathonPaymentLink();
      stripeUrl = link.url;
    } catch (error) {
      return {
        ok: false,
        blockedOn: {
          capability: 'payments.payment_link',
          reason: error instanceof Error ? error.message : String(error),
        },
      };
    }

    const sent: OutreachSend[] = [];
    const skipped: { handle: string; reason: string }[] = [];

    for (const handle of handles) {
      const idempotencyKey = `outreach:${input.companyId}:${handle}`;
      try {
        const result = await linq.sendLink({
          to: handle,
          url: stripeUrl,
          title: 'Pay Zero Human Co',
          subtitle: 'Founding access — $99, catalogue price. You cannot type a different amount.',
          button: 'Pay $99',
          chatId: chatByHandle.get(handle),
          idempotencyKey,
        });
        await this.deps.repos.growth.support.recordMessage({
          companyId: input.companyId,
          channel: 'imessage',
          direction: 'outbound',
          provider: 'linq',
          fromHandle: 'company',
          toHandle: handle,
          body: `Fixed-price founding access checkout: ${stripeUrl}`,
          status: 'sent',
          externalChatId: result.chatId,
          externalMessageId: result.messageIds[0] ?? null,
          authoredByRunId: input.runId ?? null,
          authoredByHuman: input.runId ? null : 'system:outreach',
        });
        sent.push({ toHandle: handle, chatId: result.chatId, messageIds: result.messageIds });
      } catch (error) {
        if (error instanceof CredentialsMissingError || error instanceof CapabilityUnsupportedError) {
          return {
            ok: false,
            blockedOn: { capability: 'messaging.imessage_app', reason: error.message },
          };
        }
        skipped.push({ handle, reason: error instanceof Error ? error.message : String(error) });
      }
    }

    return { ok: true, data: { sent, skipped, stripePaymentLinkUrl: stripeUrl } };
  }
}

/** `outreachHandles` is a schema splice (see PATCH.md). Absent means empty, never invented. */
function configuredOutreachHandles(messaging: { readonly outreachHandles?: readonly string[] }): readonly string[] {
  const raw = messaging.outreachHandles;
  if (!Array.isArray(raw)) return [];
  return raw.filter((handle): handle is string => typeof handle === 'string' && handle.length > 0);
}
