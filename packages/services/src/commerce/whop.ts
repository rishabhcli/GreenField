/**
 * Whop digital/membership catalogue and checkout.
 *
 * Physical private-label goods are refused before the adapter is touched.
 * Missing WHOP_API_KEY / WHOP_COMPANY_ID is a blocked capability, not a
 * retryable failure. GET /accounts/me is never invoked here — that probe is
 * identity only and is not a checkout pass.
 *
 * Whop is the agentic commerce primitive. It does not take Stripe's physical
 * volume and it is not Merchant of Record for physical goods (that claim
 * belongs to Dodo for eligible digital SKUs only).
 */

import {
  CredentialsMissingError,
  ValidationError,
  assertPaymentRoute,
  type Capability,
  type ProductKind,
} from '@foundry/core';
import { WhopAdapter } from '@foundry/providers';
import type { ServiceDeps, ServiceOutcome } from '../deps.js';

const PHYSICAL_REFUSAL =
  'Whop cannot sell physical goods. Use Stripe as merchant of record for physical products.';

export interface CatalogueWhopProductInput {
  readonly companyId: string;
  readonly sku: string;
  readonly name: string;
  readonly kind: ProductKind;
  readonly description: string;
  readonly priceMinor: number;
  readonly currency: string;
  readonly idempotencyKey: string;
}

export interface CatalogueWhopProductResult {
  readonly productId: string;
  readonly whopProductId: string;
  readonly whopPlanId: string | null;
}

export interface StartWhopCheckoutInput {
  readonly companyId: string;
  readonly orderId: string;
  readonly productKind: ProductKind;
  readonly planId?: string;
  readonly productId?: string;
  readonly idempotencyKey: string;
}

export interface StartWhopCheckoutResult {
  readonly orderId: string;
  readonly checkoutId: string;
  readonly checkoutUrl: string | null;
}

function refusePhysical(kind: ProductKind): void {
  if (kind === 'physical_good') {
    throw new ValidationError(PHYSICAL_REFUSAL, { kind, route: 'whop_checkout' });
  }
  assertPaymentRoute(kind, 'whop_checkout');
}

export class WhopCommerceService {
  constructor(private readonly deps: ServiceDeps) {}

  async catalogueProduct(input: CatalogueWhopProductInput): Promise<ServiceOutcome<CatalogueWhopProductResult>> {
    refusePhysical(input.kind);
    const adapter = this.#adapter();
    if (!adapter) return this.#notConfigured();

    let created: { id: string; planId?: string };
    try {
      created = await adapter.createProduct({
        kind: input.kind,
        title: input.name,
        description: input.description,
        currency: input.currency,
        initialPriceMinor: input.priceMinor,
        planType: input.kind === 'subscription' ? 'renewal' : 'one_time',
        metadata: { sku: input.sku, company_id: input.companyId },
        idempotencyKey: input.idempotencyKey,
      });
    } catch (error) {
      return this.#blocked(error);
    }

    const product = await this.deps.repos.commerce.products.create({
      companyId: input.companyId,
      sku: input.sku,
      name: input.name,
      kind: input.kind,
      description: input.description,
      paymentRoute: 'whop_checkout',
      priceMinor: input.priceMinor,
      currency: input.currency,
    });
    await this.deps.repos.commerce.products.setExternalRef(product.id, 'whop_product', created.id);
    if (created.planId) {
      await this.deps.repos.commerce.products.setExternalRef(product.id, 'whop_plan', created.planId);
    }

    return {
      ok: true,
      data: {
        productId: product.id,
        whopProductId: created.id,
        whopPlanId: created.planId ?? null,
      },
    };
  }

  async startCheckout(input: StartWhopCheckoutInput): Promise<ServiceOutcome<StartWhopCheckoutResult>> {
    refusePhysical(input.productKind);
    const adapter = this.#adapter();
    if (!adapter) return this.#notConfigured();

    const order = await this.deps.repos.commerce.orders.byId(input.orderId);
    if (order.company_id !== input.companyId) {
      throw new ValidationError('Order does not belong to this company', { orderId: input.orderId });
    }
    if (order.payment_route !== 'whop_checkout') {
      throw new ValidationError(
        'Whop checkout cannot attach to a Stripe or Dodo order. Physical volume stays on stripe_direct; Dodo remains Merchant of Record for its own digital SKUs.',
        { orderId: order.id, paymentRoute: order.payment_route },
      );
    }

    let checkout: { id: string; url: string | null };
    try {
      checkout = await adapter.createCheckout({
        orderId: order.id,
        productKind: input.productKind,
        planId: input.planId,
        productId: input.productId,
        idempotencyKey: input.idempotencyKey,
        metadata: {
          order_id: order.id,
          internal_order_id: order.id,
          company_id: input.companyId,
        },
      });
    } catch (error) {
      return this.#blocked(error);
    }

    await this.deps.repos.commerce.orders.setExternalRef(order.id, 'whop_checkout_configuration', checkout.id);
    if (checkout.url) {
      await this.deps.repos.commerce.orders.setExternalRef(order.id, 'whop_purchase_url', checkout.url);
    }

    return {
      ok: true,
      data: {
        orderId: order.id,
        checkoutId: checkout.id,
        checkoutUrl: checkout.url,
      },
    };
  }

  #adapter(): WhopAdapter | undefined {
    return this.deps.providers.adapter('whop') as WhopAdapter | undefined;
  }

  #notConfigured(): ServiceOutcome<never> {
    return {
      ok: false,
      blockedOn: {
        capability: 'commerce.membership' satisfies Capability,
        reason: 'WHOP_API_KEY / WHOP_COMPANY_ID are not configured; Whop adapter is not registered',
      },
    };
  }

  #blocked(error: unknown): ServiceOutcome<never> {
    if (error instanceof CredentialsMissingError) {
      return {
        ok: false,
        blockedOn: {
          capability: 'commerce.membership' satisfies Capability,
          reason: error.message,
        },
      };
    }
    throw error;
  }
}
