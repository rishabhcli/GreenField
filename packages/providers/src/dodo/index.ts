/**
 * Dodo Payments adapter — Merchant of Record for eligible digital products.
 *
 * Written against the documented REST surface (live.dodopayments.com /
 * test.dodopayments.com). The official `dodopayments` SDK wraps the same
 * endpoints; this adapter uses the platform HTTP client so retry, breaker and
 * rate-limit behaviour stay uniform with every other provider.
 *
 * Physical goods are refused before any network call. Dodo's merchant-
 * acceptance policy enumerates them as prohibited; routing a bottle through
 * this adapter would be a false compliance claim.
 */

import { ConflictError, ValidationError, assertPaymentRoute } from '@foundry/core';
import { ProviderAdapter, type AdapterContext, type ProbeResult } from '../http/adapter.js';
import { bearerAuth, type ProviderHttpClient } from '../http/client.js';
import { verifyStandardWebhook, type VerificationInput, type VerificationResult } from '../http/webhook-verify.js';
import { DODO_MANIFEST, SECRETS } from '../manifests.js';
import { DodoCheckoutSession, DodoProduct, DodoProductList, DodoRefund } from './schemas.js';
import { mapDodoEventToOrderTransition } from './events.js';

export { mapDodoEventToOrderTransition, HANDLED_DODO_EVENTS } from './events.js';

export interface DodoCheckoutInput {
  readonly orderId: string;
  readonly productKind: 'digital_good' | 'subscription' | 'service' | 'membership' | 'physical_good';
  readonly productCart: readonly { productId: string; quantity: number }[];
  readonly returnUrl: string;
  readonly cancelUrl?: string;
  readonly customerEmail?: string;
  readonly metadata?: Readonly<Record<string, string>>;
  readonly idempotencyKey: string;
}

export interface DodoCheckoutResult {
  readonly sessionId: string;
  readonly checkoutUrl: string | null;
  readonly paymentId: string | null;
}

export class DodoAdapter extends ProviderAdapter {
  override readonly manifest = DODO_MANIFEST;
  #client: ProviderHttpClient | undefined;

  constructor(ctx: AdapterContext) {
    super(ctx);
  }

  #http(): ProviderHttpClient {
    if (!this.#client) {
      this.requireSecret(SECRETS.dodoApiKey);
      this.#client = this.http(bearerAuth(this.requireSecret(SECRETS.dodoApiKey)), {
        idempotencyHeader: 'Idempotency-Key',
      });
    }
    return this.#client;
  }

  override async probe(): Promise<ProbeResult> {
    const response = await this.#http().request(
      { method: 'GET', path: '/products', query: { page_size: 1, page_number: 0 }, operation: 'products.list' },
      DodoProductList,
    );
    return {
      succeeded: true,
      detail: `GET /products succeeded (${this.ctx.environment === 'production' ? 'live' : 'test'} host)`,
      evidence: {
        endpoint: 'GET /products',
        host: this.baseUrl(),
        itemCount: response.body.items?.length ?? 0,
        status: response.status,
      },
    };
  }

  async createCheckout(input: DodoCheckoutInput): Promise<DodoCheckoutResult> {
    refuseIfPhysical(input.productKind, 'Dodo');
    this.assertActivated();
    assertPaymentRoute(input.productKind === 'membership' ? 'membership' : input.productKind, 'dodo_merchant_of_record');
    if (input.productCart.length === 0) {
      throw new ValidationError('Dodo checkout requires a non-empty product_cart');
    }

    const response = await this.#http().request(
      {
        method: 'POST',
        path: '/checkouts',
        operation: 'checkouts.create',
        idempotencyKey: input.idempotencyKey,
        retryable: true,
        body: {
          product_cart: input.productCart.map((item) => ({ product_id: item.productId, quantity: item.quantity })),
          return_url: input.returnUrl,
          cancel_url: input.cancelUrl,
          metadata: { internal_order_id: input.orderId, ...input.metadata },
          ...(input.customerEmail ? { customer: { email: input.customerEmail } } : {}),
        },
      },
      DodoCheckoutSession,
    );

    return {
      sessionId: response.body.session_id,
      checkoutUrl: response.body.checkout_url ?? null,
      paymentId: response.body.payment_id ?? null,
    };
  }

  /** Alias kept so checkout, tests, and commerce routing share one physical-goods guard. */
  async createCheckoutSession(input: DodoCheckoutInput): Promise<DodoCheckoutResult> {
    return this.createCheckout(input);
  }

  async createProduct(input: {
    name: string;
    productKind: DodoCheckoutInput['productKind'];
    taxCategory: string;
    priceMinor: number;
    currency: string;
    idempotencyKey?: string;
  }): Promise<{ productId: string | null }> {
    refuseIfPhysical(input.productKind, 'Dodo');
    this.assertActivated();
    const response = await this.#http().request(
      {
        method: 'POST',
        path: '/products',
        operation: 'products.create',
        idempotencyKey: input.idempotencyKey,
        retryable: true,
        body: {
          name: input.name,
          tax_category: input.taxCategory,
          price: input.priceMinor,
          currency: input.currency,
        },
      },
      DodoProduct,
    );
    return { productId: response.body.product_id ?? response.body.id ?? null };
  }

  async refundPayment(input: {
    paymentId: string;
    amountMinor?: number;
    reason?: string;
    idempotencyKey: string;
  }): Promise<{ refundId: string | null; paymentId: string }> {
    this.assertActivated();
    const response = await this.#http().request(
      {
        method: 'POST',
        path: '/refunds',
        operation: 'refunds.create',
        idempotencyKey: input.idempotencyKey,
        retryable: true,
        body: {
          payment_id: input.paymentId,
          ...(input.amountMinor !== undefined ? { amount: input.amountMinor } : {}),
          ...(input.reason ? { reason: input.reason } : {}),
        },
      },
      DodoRefund,
    );
    return {
      refundId: response.body.refund_id ?? response.body.id ?? null,
      paymentId: response.body.payment_id,
    };
  }

  verifyWebhook(input: VerificationInput): VerificationResult {
    const secret = this.optionalSecret(SECRETS.dodoWebhookSecret);
    if (!secret) {
      throw new ConflictError(
        'DODO_WEBHOOK_SECRET is not configured; refusing to accept an unsigned Dodo webhook',
        { provider: 'dodo' },
      );
    }
    return verifyStandardWebhook('dodo', { ...input, secret });
  }
}

/** Structural refusal used by commerce routing tests without constructing a client. */
export function refusePhysicalGoods(): never {
  throw new ValidationError(
    'Dodo cannot collect payment for physical goods. Use Stripe as merchant of record for physical products.',
  );
}

function refuseIfPhysical(kind: string, vendor: string): void {
  if (kind === 'physical_good') {
    throw new ValidationError(
      `${vendor} cannot collect payment for physical goods. Use Stripe as merchant of record for physical products.`,
    );
  }
}
