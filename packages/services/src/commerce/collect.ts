/**
 * Collect a payment over iMessage: Stripe Checkout at the catalogue price,
 * delivered via Linq `link` experience.
 *
 * Amount always comes from the order row (which came from the product
 * catalogue). The caller cannot supply a price. Linq Agent Pay is attempted
 * only when that capability is usable; a 2011 block falls through to the
 * working Stripe Checkout + Linq link path rather than failing the collect.
 */

import { CredentialsMissingError, ValidationError, type Capability } from '@foundry/core';
import { companyConfig } from '@foundry/db';
import { LinqAdapter, StripeAdapter } from '@foundry/providers';
import { optionalCapability, requireCapability, type ServiceDeps, type ServiceOutcome } from '../deps.js';

export interface CollectPaymentInput {
  readonly companyId: string;
  readonly orderId: string;
  readonly toHandle: string;
  readonly description: string;
  readonly chatId?: string;
  readonly idempotencyKey: string;
}

export interface CollectPaymentResult {
  readonly orderId: string;
  readonly amountMinor: number;
  readonly currency: string;
  readonly checkoutUrl: string | null;
  readonly linqPaymentRequestId: string | null;
  readonly linqCheckoutUrl: string | null;
  readonly linqMessageIds: readonly string[];
  readonly stripeLinkMessageIds: readonly string[];
}

export class CollectPaymentService {
  constructor(private readonly deps: ServiceDeps) {}

  async collect(input: CollectPaymentInput): Promise<ServiceOutcome<CollectPaymentResult>> {
    const order = await this.deps.repos.commerce.orders.byId(input.orderId);
    if (order.company_id !== input.companyId) {
      throw new ValidationError('Order does not belong to this company', { orderId: input.orderId });
    }
    if (
      order.payment_route === 'dodo_merchant_of_record' ||
      order.payment_route === 'whop_checkout'
    ) {
      throw new ValidationError(
        'CollectPaymentService only charges stripe_direct orders. Physical goods must not be collected via Dodo or Whop.',
        { orderId: order.id, paymentRoute: order.payment_route },
      );
    }
    if (order.total_minor < 50) {
      throw new ValidationError('Collection amount is below Linq/Stripe practical minimums', {
        amountMinor: order.total_minor,
        orderId: order.id,
      });
    }
    const lines = await this.deps.repos.commerce.orders.lineItems(order.id);
    if (lines.length === 0) {
      throw new ValidationError('Order has no line items to charge', { orderId: order.id });
    }

    const checkoutUrl = await this.#ensureCheckoutUrl(order, lines, input.idempotencyKey);

    let linq: LinqAdapter;
    try {
      linq =
        optionalCapability<LinqAdapter>(this.deps, 'messaging.imessage_app') ??
        requireCapability<LinqAdapter>(this.deps, 'messaging.imessage').adapter;
    } catch (error) {
      if (error instanceof CredentialsMissingError) {
        return {
          ok: false,
          blockedOn: { capability: 'messaging.imessage', reason: error.message },
        };
      }
      throw error;
    }

    let linqPaymentRequestId: string | null = null;
    let linqCheckoutUrl: string | null = null;
    let linqMessageIds: readonly string[] = [];
    const agentPay = optionalCapability<LinqAdapter>(this.deps, 'payments.imessage_checkout');
    if (agentPay) {
      try {
        const request = await agentPay.createPaymentRequest({
          amountMinor: order.total_minor,
          currency: order.currency,
          description: input.description,
          metadata: { order_id: order.id, company_id: input.companyId },
        });
        const sent = await agentPay.sendAgentPay({
          to: input.toHandle,
          checkoutUrl: request.checkout_url,
          chatId: input.chatId,
          idempotencyKey: `${input.idempotencyKey}:agentpay`,
        });
        linqPaymentRequestId = request.id;
        linqCheckoutUrl = request.checkout_url;
        linqMessageIds = sent.messageIds;
      } catch {
        // Agent Pay is blocked (2011) or otherwise unusable. The Stripe
        // Checkout URL below is the working collection path.
      }
    }

    let stripeLinkMessageIds: readonly string[] = [];
    if (checkoutUrl) {
      const fallback = await linq.sendLink({
        to: input.toHandle,
        url: checkoutUrl,
        title: 'Pay Zero Human Co',
        subtitle: input.description,
        button: 'Pay',
        chatId: input.chatId,
        idempotencyKey: `${input.idempotencyKey}:checkout-link`,
      });
      stripeLinkMessageIds = fallback.messageIds;
    }

    if (!checkoutUrl && linqMessageIds.length === 0) {
      return {
        ok: false,
        blockedOn: {
          capability: 'payments.checkout.physical',
          reason: 'No checkout URL and Linq Agent Pay did not send',
        },
      };
    }

    return {
      ok: true,
      data: {
        orderId: order.id,
        amountMinor: order.total_minor,
        currency: order.currency,
        checkoutUrl,
        linqPaymentRequestId,
        linqCheckoutUrl,
        linqMessageIds,
        stripeLinkMessageIds,
      },
    };
  }

  async #ensureCheckoutUrl(
    order: {
      readonly id: string;
      readonly company_id: string;
      readonly currency: string;
      readonly payment_route?: string;
      readonly external_refs: Record<string, string>;
    },
    lines: readonly {
      readonly product_id: string;
      readonly name: string;
      readonly quantity: number;
      readonly unit_price_minor: number;
    }[],
    idempotencyKey: string,
  ): Promise<string | null> {
    const stripe =
      optionalCapability<StripeAdapter>(this.deps, 'payments.checkout.physical') ??
      optionalCapability<StripeAdapter>(this.deps, 'payments.payment_link');
    if (!stripe) return null;

    const existing = order.external_refs['stripe_checkout_session'];
    if (existing) {
      try {
        const session = await stripe.retrieveCheckoutSession(existing);
        if (session.url) return session.url;
      } catch {
        // Session expired or missing; create a new one below.
      }
    }

    if (typeof stripe.createCheckoutSession !== 'function') {
      return stripe.hackathonPaymentLinkUrl();
    }

    const company = await this.deps.repos.companies.byId(order.company_id);
    const config = companyConfig(company);
    const session = await stripe.createCheckoutSession({
      orderId: order.id,
      currency: order.currency,
      lineItems: lines.map((line) => ({
        productId: line.product_id,
        name: line.name,
        unitPriceMinor: line.unit_price_minor,
        quantity: line.quantity,
      })),
      successUrl: `${this.deps.publicBaseUrl}/?paid=1`,
      cancelUrl: `${this.deps.publicBaseUrl}/#pricing`,
      allowedShippingCountries: config.commerce.sellsTo,
      idempotencyKey: `${idempotencyKey}:checkout`,
    });
    await this.deps.repos.commerce.orders.setExternalRef(order.id, 'stripe_checkout_session', session.sessionId);
    if (session.paymentIntentId) {
      await this.deps.repos.commerce.orders.setExternalRef(order.id, 'stripe_payment_intent', session.paymentIntentId);
    }
    return session.url;
  }

  blockedCapability(capability: Capability, reason: string): ServiceOutcome<CollectPaymentResult> {
    return { ok: false, blockedOn: { capability, reason } };
  }
}
