/**
 * Issue a Stripe hosted invoice from a Linq conversation.
 *
 * Price is always the catalogue row. The model cannot supply an amount.
 * Delivery is a Linq text (SMS-safe) plus a link card when iMessage can
 * render one. Missing Linq or Stripe credentials block; they do not invent
 * a sent invoice.
 */

import { CredentialsMissingError, ValidationError, type Capability } from '@foundry/core';
import { LinqAdapter, StripeAdapter } from '@foundry/providers';
import { optionalCapability, type ServiceDeps, type ServiceOutcome } from '../deps.js';

/** First reply on a new Linq thread. The text thread is the store. */
export const LINQ_STORE_GREETING =
  'This is the store. Text what you want shipped — a product, a brand, or an idea. ' +
  'If it is in the catalogue we will send a Stripe invoice. If it is not, we will source it and only invoice once we have a real price. ' +
  'Reply STOP to opt out.';

export interface CatalogMatch {
  readonly sku: string;
  readonly name: string;
  readonly priceMinor: number;
  readonly currency: string;
  readonly score: number;
}

/** Keyword overlap against catalogue rows. Never invents a price or a SKU. */
export function matchCatalogProducts(
  products: readonly {
    readonly sku: string;
    readonly name: string;
    readonly description?: string | null;
    readonly price_minor: number;
    readonly currency: string;
  }[],
  idea: string,
): readonly CatalogMatch[] {
  const tokens = tokenize(idea);
  if (tokens.length === 0) return [];
  const scored = products
    .map((product) => {
      const hay = tokenize(`${product.sku} ${product.name} ${product.description ?? ''}`);
      const score = tokens.reduce((sum, token) => sum + (hay.includes(token) ? 1 : 0), 0);
      return {
        sku: product.sku,
        name: product.name,
        priceMinor: product.price_minor,
        currency: product.currency,
        score,
      };
    })
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored;
}

function tokenize(text: string): readonly string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 3);
}

export interface IssueSmsInvoiceInput {
  readonly companyId: string;
  readonly toHandle: string;
  readonly sku?: string;
  readonly email?: string;
  readonly chatId?: string;
  readonly ticketId?: string;
  readonly idempotencyKey: string;
}

export interface IssueSmsInvoiceResult {
  readonly orderId: string;
  readonly invoiceId: string;
  readonly hostedInvoiceUrl: string;
  readonly amountMinor: number;
  readonly currency: string;
  readonly sku: string;
  readonly linqMessageIds: readonly string[];
}

export class SmsInvoiceService {
  constructor(private readonly deps: ServiceDeps) {}

  async issue(input: IssueSmsInvoiceInput): Promise<ServiceOutcome<IssueSmsInvoiceResult>> {
    const contact = contactFromHandle(input.toHandle, input.email);
    if (!contact.phoneE164 && !contact.email) {
      throw new ValidationError(
        'Need an E.164 phone or an email to issue a Stripe invoice. Ask for one on the thread.',
        { toHandle: input.toHandle },
      );
    }

    const linq = this.#linq();
    if (!linq) {
      return {
        ok: false,
        blockedOn: {
          capability: 'messaging.sms',
          reason: this.#reason('messaging.imessage_app') ?? this.#reason('messaging.sms'),
        },
      };
    }

    const stripe =
      optionalCapability<StripeAdapter>(this.deps, 'payments.checkout.physical') ??
      optionalCapability<StripeAdapter>(this.deps, 'payments.payment_link');
    if (!stripe || typeof stripe.createAndFinalizeInvoice !== 'function') {
      return {
        ok: false,
        blockedOn: {
          capability: 'payments.checkout.physical',
          reason: this.#reason('payments.checkout.physical'),
        },
      };
    }

    const product = await this.#product(input.companyId, input.sku);
    if (product.payment_route !== 'stripe_direct') {
      throw new ValidationError(
        'SmsInvoiceService only invoices stripe_direct catalogue items. Digital MoR SKUs stay on their own rail.',
        { sku: product.sku, paymentRoute: product.payment_route },
      );
    }
    if (product.price_minor < 50) {
      throw new ValidationError('Catalogue price is below Stripe practical minimums', {
        sku: product.sku,
        priceMinor: product.price_minor,
      });
    }

    const customer = await this.deps.repos.commerce.customers.upsert({
      companyId: input.companyId,
      email: contact.email ?? null,
      phoneE164: contact.phoneE164 ?? null,
    });

    const created = await this.deps.repos.commerce.orders.create({
      companyId: input.companyId,
      customerId: customer.id,
      currency: product.currency,
      paymentRoute: 'stripe_direct',
      lineItems: [
        {
          productId: product.id,
          sku: product.sku,
          name: product.name,
          quantity: 1,
          unitPriceMinor: product.price_minor,
        },
      ],
      attribution: { source: 'linq_sms_invoice' },
    });
    const order = created.order;

    let invoice: Awaited<ReturnType<StripeAdapter['createAndFinalizeInvoice']>>;
    try {
      invoice = await stripe.createAndFinalizeInvoice({
        orderId: order.id,
        currency: product.currency,
        amountMinor: product.price_minor,
        phoneE164: contact.phoneE164,
        email: contact.email,
        description: product.name,
        idempotencyKey: input.idempotencyKey,
        lineItems: [
          {
            productId: product.id,
            name: product.name,
            unitPriceMinor: product.price_minor,
            quantity: 1,
          },
        ],
      });
    } catch (error) {
      if (error instanceof CredentialsMissingError) {
        return {
          ok: false,
          blockedOn: { capability: 'payments.checkout.physical', reason: error.message },
        };
      }
      throw error;
    }

    await this.deps.repos.commerce.orders.setExternalRef(order.id, 'stripe_invoice', invoice.invoiceId);
    await this.deps.repos.commerce.orders.setExternalRef(order.id, 'stripe_customer', invoice.customerId);
    if (invoice.paymentIntentId) {
      await this.deps.repos.commerce.orders.setExternalRef(order.id, 'stripe_payment_intent', invoice.paymentIntentId);
    }
    await this.deps.repos.commerce.orders.applyEvent({
      orderId: order.id,
      kind: 'checkout_started',
      toStatus: 'CHECKOUT_STARTED',
      actor: 'linq:sms-invoice',
      payload: { invoiceId: invoice.invoiceId, hostedInvoiceUrl: invoice.hostedInvoiceUrl },
    });
    if (input.ticketId) {
      await this.deps.repos.growth.support.link(input.ticketId, {
        customerId: customer.id,
        orderId: order.id,
      });
    }

    const dollars = (product.price_minor / 100).toFixed(2);
    const body =
      `Your Stripe invoice for ${product.name} is $${dollars} ${product.currency}. ` +
      `Pay here: ${invoice.hostedInvoiceUrl}`;

    const linqMessageIds: string[] = [];
    try {
      if (input.chatId && typeof linq.sendToChat === 'function') {
        const text = await linq.sendToChat(input.chatId, {
          parts: [{ type: 'text', value: body }],
          idempotencyKey: `${input.idempotencyKey}:text`,
        });
        linqMessageIds.push(...text.messageIds);
      } else {
        const text = await linq.sendMessage({
          to: [input.toHandle],
          parts: [{ type: 'text', value: body }],
          preferredService: 'SMS',
          idempotencyKey: `${input.idempotencyKey}:text`,
        });
        linqMessageIds.push(...text.messageIds);
      }

      const card = await linq.sendLink({
        to: input.toHandle,
        url: invoice.hostedInvoiceUrl,
        title: 'Stripe invoice',
        subtitle: `${product.name} · $${dollars}`,
        button: 'Pay invoice',
        chatId: input.chatId,
        idempotencyKey: `${input.idempotencyKey}:link`,
      });
      linqMessageIds.push(...card.messageIds);
    } catch (error) {
      if (error instanceof CredentialsMissingError) {
        return {
          ok: false,
          blockedOn: { capability: 'messaging.sms', reason: error.message },
        };
      }
      throw error;
    }

    return {
      ok: true,
      data: {
        orderId: order.id,
        invoiceId: invoice.invoiceId,
        hostedInvoiceUrl: invoice.hostedInvoiceUrl,
        amountMinor: product.price_minor,
        currency: product.currency,
        sku: product.sku,
        linqMessageIds,
      },
    };
  }

  async #product(companyId: string, sku?: string) {
    if (sku) {
      const row = await this.deps.repos.commerce.products.bySku(companyId, sku);
      if (!row || row.status !== 'active') {
        throw new ValidationError(`No active catalogue product for sku "${sku}"`, { sku });
      }
      return row;
    }
    const active = await this.deps.repos.commerce.products.listActive(companyId);
    const preferred =
      active.find((p) => p.sku === 'zhc-founding' && p.payment_route === 'stripe_direct') ??
      active.find((p) => p.payment_route === 'stripe_direct');
    if (!preferred) {
      throw new ValidationError('No active stripe_direct catalogue product to invoice', { companyId });
    }
    return preferred;
  }

  #linq(): LinqAdapter | undefined {
    return (
      optionalCapability<LinqAdapter>(this.deps, 'messaging.imessage_app') ??
      optionalCapability<LinqAdapter>(this.deps, 'messaging.imessage') ??
      optionalCapability<LinqAdapter>(this.deps, 'messaging.sms')
    );
  }

  #reason(capability: Capability): string {
    const status = this.deps.capabilities.resolveCapability(capability);
    return status.remediation ?? `${capability} is ${status.state}`;
  }
}

function contactFromHandle(
  handle: string,
  email?: string,
): { phoneE164?: string; email?: string } {
  const trimmed = handle.trim();
  const fromEmail = trimmed.includes('@') ? trimmed : undefined;
  const fromPhone = /^\+[1-9]\d{6,14}$/.test(trimmed) ? trimmed : undefined;
  return {
    phoneE164: fromPhone,
    email: email ?? fromEmail,
  };
}
