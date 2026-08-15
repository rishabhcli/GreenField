/**
 * Whop adapter — digital/membership commerce primitives.
 *
 * REST against `https://api.whop.com/api/v1` (sandbox host in non-production),
 * with `Api-Version-Date: 2026-07-23` pinned. Unpinned requests fall back to
 * 2025-01-01 behaviour, which is a silent contract change we refuse to take.
 *
 * Physical private-label goods are refused before any network call. Whop is
 * not a manufacturer, freight broker, or landed-cost source.
 */

import { ConflictError, ValidationError, assertPaymentRoute } from '@foundry/core';
import { ProviderAdapter, type AdapterContext, type ProbeResult } from '../http/adapter.js';
import { bearerAuth, type ProviderHttpClient } from '../http/client.js';
import { verifyStandardWebhook, type VerificationInput, type VerificationResult } from '../http/webhook-verify.js';
import { SECRETS, WHOP_MANIFEST } from '../manifests.js';
import {
  WHOP_API_VERSION_DATE,
  WhopAccount,
  WhopCheckoutConfiguration,
  WhopProduct,
  WhopRefund,
} from './schemas.js';
import { mapWhopEventToOrderTransition } from './events.js';

export { mapWhopEventToOrderTransition } from './events.js';
export { WHOP_API_VERSION_DATE } from './schemas.js';

export interface WhopProductInput {
  readonly title: string;
  readonly description?: string;
  readonly visibility?: 'visible' | 'hidden' | 'archived';
  readonly metadata?: Readonly<Record<string, string>>;
  readonly idempotencyKey: string;
}

export interface WhopCheckoutInput {
  readonly orderId: string;
  readonly productKind: 'digital_good' | 'subscription' | 'service' | 'membership';
  readonly planId: string;
  readonly metadata?: Readonly<Record<string, string>>;
  readonly idempotencyKey: string;
}

export class WhopAdapter extends ProviderAdapter {
  override readonly manifest = WHOP_MANIFEST;
  #client: ProviderHttpClient | undefined;

  constructor(ctx: AdapterContext) {
    super(ctx);
  }

  #companyId(): string {
    return this.requireSecret(SECRETS.whopCompanyId).reveal();
  }

  #http(): ProviderHttpClient {
    if (!this.#client) {
      const secret = this.requireSecret(SECRETS.whopApiKey);
      this.#client = this.http(bearerAuth(secret), {
        defaultHeaders: { 'api-version-date': WHOP_API_VERSION_DATE },
        idempotencyHeader: 'Idempotency-Key',
      });
    }
    return this.#client;
  }

  override async probe(): Promise<ProbeResult> {
    const response = await this.#http().request(
      { method: 'GET', path: '/accounts/me', operation: 'accounts.me' },
      WhopAccount,
    );
    const expected = this.#companyId();
    const matches = response.body.id === expected;
    return {
      succeeded: matches,
      detail: matches
        ? `GET /accounts/me returned ${response.body.id}`
        : `GET /accounts/me returned ${response.body.id} but WHOP_COMPANY_ID is ${expected}`,
      evidence: {
        endpoint: 'GET /accounts/me',
        accountId: response.body.id,
        configuredCompanyId: expected,
        apiVersionDate: WHOP_API_VERSION_DATE,
        host: this.baseUrl(),
      },
    };
  }

  async createProduct(input: WhopProductInput): Promise<{ id: string }> {
    this.assertActivated();
    const response = await this.#http().request(
      {
        method: 'POST',
        path: '/products',
        operation: 'products.create',
        idempotencyKey: input.idempotencyKey,
        retryable: true,
        body: {
          company_id: this.#companyId(),
          title: input.title,
          description: input.description,
          visibility: input.visibility ?? 'hidden',
          metadata: input.metadata,
        },
      },
      WhopProduct,
    );
    return { id: response.body.id };
  }

  async createCheckout(input: WhopCheckoutInput): Promise<{ id: string; url: string | null }> {
    this.assertActivated();
    assertPaymentRoute(input.productKind === 'membership' ? 'membership' : input.productKind, 'whop_checkout');
    if (!input.planId) throw new ValidationError('Whop checkout requires a plan_id');

    const response = await this.#http().request(
      {
        method: 'POST',
        path: '/checkout-configurations',
        operation: 'checkout_configurations.create',
        idempotencyKey: input.idempotencyKey,
        retryable: true,
        body: {
          plan_id: input.planId,
          metadata: { internal_order_id: input.orderId, ...input.metadata },
        },
      },
      WhopCheckoutConfiguration,
    );
    return { id: response.body.id, url: response.body.purchase_url ?? response.body.url ?? null };
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
        body: input.amountMinor !== undefined ? { amount: input.amountMinor } : {},
      },
      WhopRefund,
    );
    return { id: response.body.id };
  }

  verifyWebhook(input: VerificationInput): VerificationResult {
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
