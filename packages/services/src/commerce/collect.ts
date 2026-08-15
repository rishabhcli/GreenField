/**
 * Collect a payment over iMessage (Linq Agent Pay) and/or the submitted
 * Stripe Payment Link.
 *
 * Two rails, deliberately not interchangeable:
 *   - Linq `POST /v3/payment_requests` + `agentpay` experience. Funds settle
 *     to the connected Stripe account. The checkout_url is Linq's; a Stripe
 *     Payment Link is rejected as an agentpay param.
 *   - Stripe Payment Link (`STRIPE_HACKATHON_PAYMENT_LINK_URL`). Organizers
 *     track hackathon revenue from this one URL. Reusing it is required.
 *
 * Recipients who cannot take an iMessage card get the Stripe link as a `link`
 * part (SMS/RCS-capable). That is a second send, never mixed into the card.
 */

import { CredentialsMissingError, ValidationError, type Capability } from '@foundry/core';
import { LinqAdapter, StripeAdapter } from '@foundry/providers';
import { optionalCapability, requireCapability, type ServiceDeps, type ServiceOutcome } from '../deps.js';

export interface CollectPaymentInput {
  readonly companyId: string;
  readonly orderId: string;
  readonly toHandle: string;
  readonly amountMinor: number;
  readonly currency: string;
  readonly description: string;
  readonly chatId?: string;
  readonly idempotencyKey: string;
}

export interface CollectPaymentResult {
  readonly linqPaymentRequestId: string | null;
  readonly linqCheckoutUrl: string | null;
  readonly linqMessageIds: readonly string[];
  readonly stripePaymentLinkUrl: string | null;
  readonly stripeLinkMessageIds: readonly string[];
}

export class CollectPaymentService {
  constructor(private readonly deps: ServiceDeps) {}

  async collect(input: CollectPaymentInput): Promise<ServiceOutcome<CollectPaymentResult>> {
    if (input.amountMinor < 50) {
      throw new ValidationError('Collection amount is below Linq/Stripe practical minimums', {
        amountMinor: input.amountMinor,
      });
    }

    let linq: LinqAdapter;
    try {
      linq = requireCapability<LinqAdapter>(this.deps, 'payments.imessage_checkout').adapter;
    } catch (error) {
      if (error instanceof CredentialsMissingError) {
        return {
          ok: false,
          blockedOn: { capability: 'payments.imessage_checkout', reason: error.message },
        };
      }
      throw error;
    }

    const request = await linq.createPaymentRequest({
      amountMinor: input.amountMinor,
      currency: input.currency,
      description: input.description,
      metadata: { order_id: input.orderId, company_id: input.companyId },
    });

    const agentPay = await linq.sendAgentPay({
      to: input.toHandle,
      checkoutUrl: request.checkout_url,
      chatId: input.chatId,
      idempotencyKey: `${input.idempotencyKey}:agentpay`,
    });

    const stripe = optionalCapability<StripeAdapter>(this.deps, 'payments.payment_link');
    const stripeUrl = stripe?.hackathonPaymentLinkUrl() ?? null;
    let stripeLinkMessageIds: readonly string[] = [];
    if (stripeUrl) {
      const fallback = await linq.sendMessage({
        to: [input.toHandle],
        parts: [{ type: 'link', value: stripeUrl }],
        idempotencyKey: `${input.idempotencyKey}:stripe-link`,
      });
      stripeLinkMessageIds = fallback.messageIds;
    }

    return {
      ok: true,
      data: {
        linqPaymentRequestId: request.id,
        linqCheckoutUrl: request.checkout_url,
        linqMessageIds: agentPay.messageIds,
        stripePaymentLinkUrl: stripeUrl,
        stripeLinkMessageIds,
      },
    };
  }

  blockedCapability(capability: Capability, reason: string): ServiceOutcome<CollectPaymentResult> {
    return { ok: false, blockedOn: { capability, reason } };
  }
}
