/**
 * Whop adapter — digital/membership commerce primitives.
 *
 * REST against `https://api.whop.com/api/v1` (sandbox host in non-production),
 * with `Api-Version-Date: 2026-07-23` pinned. Unpinned requests fall back to
 * 2025-01-01 behaviour, which is a silent contract change we refuse to take.
 *
 * Physical private-label goods are refused before any network call. Whop is
 * not a manufacturer, freight broker, or landed-cost source. GET /accounts/me
 * is an identity probe, not a checkout pass.
 */

import { ConflictError, ValidationError, assertPaymentRoute, type ProductKind } from '@foundry/core';
import { ProviderAdapter, type AdapterContext, type ProbeResult } from '../http/adapter.js';
import { bearerAuth, type ProviderHttpClient } from '../http/client.js';
import { verifyStandardWebhook, type VerificationInput, type VerificationResult } from '../http/webhook-verify.js';
import { SECRETS, WHOP_MANIFEST } from '../manifests.js';
import {
  WHOP_API_VERSION_DATE,
  WhopAccount,
  WhopCheckoutConfiguration,
  WhopPayment,
  WhopPlan,
  WhopProduct,
  asMajorUnits,
} from './schemas.js';

export { mapWhopEventToOrderTransition, HANDLED_WHOP_EVENTS } from './events.js';
export { WHOP_API_VERSION_DATE } from './constants.js';

export interface WhopProductInput {
  readonly title: string;
  readonly description?: string;
  readonly visibility?: 'visible' | 'hidden' | 'archived';
  readonly metadata?: Readonly<Record<string, string>>;
  readonly idempotencyKey: string;
  readonly kind?: ProductKind;
  readonly currency?: string;
  readonly initialPriceMinor?: number;
  readonly planType?: 'one_time' | 'renewal';
}

export interface WhopPlanInput {
  readonly productId: string;
  readonly currency: string;
  readonly initialPriceMinor: number;
  readonly planType: 'one_time' | 'renewal';
  readonly renewalPriceMinor?: number;
  readonly idempotencyKey: string;
}

export interface WhopCheckoutInput {
  readonly orderId: string;
  readonly productKind: ProductKind;
  readonly planId?: string;
  readonly productId?: string;
  readonly currency?: string;
  readonly initialPriceMinor?: number;
  readonly planType?: 'one_time' | 'renewal';
  readonly metadata?: Readonly<Record<string, string>>;
  readonly idempotencyKey: string;
}

const PHYSICAL_REFUSAL =
  'Whop cannot sell physical goods. Use Stripe as merchant of record for physical products.';

function refusePhysical(kind: ProductKind | undefined): void {
  if (kind === 'physical_good') {
    throw new ValidationError(PHYSICAL_REFUSAL, { kind, route: 'whop_checkout' });
  }
}

function assertWhopKind(kind: ProductKind | undefined): void {
  refusePhysical(kind);
  if (kind) assertPaymentRoute(kind, 'whop_checkout');
}

export class WhopAdapter extends ProviderAdapter {
  override readonly manifest = WHOP_MANIFEST;
  #client: ProviderHttpClient | undefined;

  constructor(ctx: AdapterContext) {
    super(ctx);
  }

  #accountId(): string {
    return this.requireSecret(SECRETS.whopCompanyId).reveal();
  }

  #http(): ProviderHttpClient {
    if (!this.#client) {
      const secret = this.requireSecret(SECRETS.whopApiKey);
      this.#client = this.http(bearerAuth(secret), {
        defaultHeaders: { 'Api-Version-Date': WHOP_API_VERSION_DATE },
        idempotencyHeader: 'Idempotency-Key',
      });
    }
    return this.#client;
  }

  override async probe(): Promise<ProbeResult> {
    this.assertActivated();
    const response = await this.#http().request(
      { method: 'GET', path: '/accounts/me', operation: 'accounts.me' },
      WhopAccount,
    );
    const expected = this.#accountId();
    const matches = response.body.id === expected;
    return {
      succeeded: matches,
      detail: matches
        ? `GET /accounts/me returned ${response.body.id} (identity only)`
        : `GET /accounts/me returned ${response.body.id} but WHOP_COMPANY_ID is ${expected}`,
      evidence: {
        endpoint: 'GET /accounts/me',
        accountId: response.body.id,
        configuredCompanyId: expected,
        apiVersionDate: WHOP_API_VERSION_DATE,
        host: this.baseUrl(),
        notACheckoutPass: true,
      },
    };
  }

  async createProduct(input: WhopProductInput): Promise<{ id: string; planId?: string }> {
    assertWhopKind(input.kind);
    this.assertActivated();
    const response = await this.#http().request(
      {
        method: 'POST',
        path: '/products',
        operation: 'products.create',
        idempotencyKey: input.idempotencyKey,
        retryable: true,
        body: {
          account_id: this.#accountId(),
          title: input.title,
          description: input.description,
          visibility: input.visibility ?? 'hidden',
          metadata: input.metadata,
          ...(input.initialPriceMinor !== undefined
            ? {
                plan_options: {
                  base_currency: input.currency ?? 'usd',
                  initial_price: asMajorUnits(input.initialPriceMinor),
                  plan_type: input.planType ?? (input.kind === 'subscription' ? 'renewal' : 'one_time'),
                  visibility: 'hidden',
                },
              }
            : {}),
        },
      },
      WhopProduct,
    );
    return { id: response.body.id, planId: response.body.plans?.[0]?.id };
  }

  async createPlan(input: WhopPlanInput): Promise<{ id: string }> {
    this.assertActivated();
    const response = await this.#http().request(
      {
        method: 'POST',
        path: '/plans',
        operation: 'plans.create',
        idempotencyKey: input.idempotencyKey,
        retryable: true,
        body: {
          account_id: this.#accountId(),
          product_id: input.productId,
          currency: input.currency,
          initial_price: asMajorUnits(input.initialPriceMinor),
          plan_type: input.planType,
          ...(input.renewalPriceMinor !== undefined ? { renewal_price: asMajorUnits(input.renewalPriceMinor) } : {}),
          visibility: 'hidden',
        },
      },
      WhopPlan,
    );
    return { id: response.body.id };
  }

  async createCheckout(input: WhopCheckoutInput): Promise<{ id: string; url: string | null }> {
    assertWhopKind(input.productKind);
    this.assertActivated();
    if (!input.planId && !input.productId) {
      throw new ValidationError('Whop checkout requires a plan_id or product_id for an inline plan');
    }

    const response = await this.#http().request(
      {
        method: 'POST',
        path: '/checkout-configurations',
        operation: 'checkout_configurations.create',
        idempotencyKey: input.idempotencyKey,
        retryable: true,
        body: {
          account_id: this.#accountId(),
          ...(input.planId
            ? { plan_id: input.planId }
            : {
                plan: {
                  account_id: this.#accountId(),
                  product_id: input.productId,
                  currency: input.currency ?? 'usd',
                  initial_price: asMajorUnits(input.initialPriceMinor ?? 0),
                  plan_type: input.planType ?? (input.productKind === 'subscription' ? 'renewal' : 'one_time'),
                },
              }),
          metadata: {
            internal_order_id: input.orderId,
            order_id: input.orderId,
            ...input.metadata,
          },
        },
      },
      WhopCheckoutConfiguration,
    );
    return { id: response.body.id, url: response.body.purchase_url ?? response.body.url ?? null };
  }

  async createCheckoutConfiguration(input: {
    kind: WhopProductInput['kind'];
    currency: string;
    initialPriceMinor: number;
    planType: string;
    idempotencyKey: string;
    orderId?: string;
    planId?: string;
    productId?: string;
  }): Promise<{ id: string; url: string | null }> {
    assertWhopKind(input.kind);
    return this.createCheckout({
      orderId: input.orderId ?? 'unbound',
      productKind: input.kind ?? 'digital_good',
      planId: input.planId,
      productId: input.productId,
      currency: input.currency,
      initialPriceMinor: input.initialPriceMinor,
      planType: input.planType === 'renewal' ? 'renewal' : 'one_time',
      idempotencyKey: input.idempotencyKey,
      metadata: {
        currency: input.currency,
        plan_type: input.planType,
        initial_price_minor: String(input.initialPriceMinor),
      },
    });
  }

  async refundPayment(input: {
    paymentId: string;
    amountMinor?: number;
    idempotencyKey: string;
  }): Promise<{ id: string }> {
    this.assertActivated();
    const response = await this.#http().request(
      {
        method: 'POST',
        path: `/payments/${input.paymentId}/refund`,
        operation: 'payments.refund',
        idempotencyKey: input.idempotencyKey,
        retryable: true,
        body: input.amountMinor !== undefined ? { partial_amount: asMajorUnits(input.amountMinor) } : {},
      },
      WhopPayment,
    );
    return { id: response.body.refunds?.[0]?.id ?? response.body.id };
  }

  verifyWebhook(input: Omit<VerificationInput, 'secret'>): VerificationResult {
    const secret = this.optionalSecret(SECRETS.whopWebhookSecret);
    if (!secret) {
      throw new ConflictError(
        'WHOP_WEBHOOK_SECRET is not configured; refusing to accept an unsigned Whop webhook',
        { provider: 'whop' },
      );
    }
    return verifyStandardWebhook('whop', { ...input, secret });
  }
}
