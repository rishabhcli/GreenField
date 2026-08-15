/**
 * Dodo Payments adapter — Merchant of Record for eligible digital products.
 *
 * Written against the documented REST surface (live.dodopayments.com /
 * test.dodopayments.com). The official `dodopayments` SDK wraps the same
 * endpoints; this adapter uses the platform HTTP client so retry, breaker and
 * rate-limit behaviour stay uniform with every other provider.
 *
 * Physical goods are refused by `assertPaymentRoute` before any network call.
 * Dodo's merchant-acceptance policy enumerates them as prohibited; routing a
 * bottle through this adapter would misstate who bears tax and transaction
 * liability.
 *
 * Dodo publishes no general Idempotency-Key header. Checkout and refund POSTs
 * are not retried here; callers key the local idempotency ledger
 * (`refund:${orderId}:${amount}`).
 */

import {
  ConflictError,
  ProviderAuthError,
  ProviderContractError,
  ValidationError,
  assertPaymentRoute,
  toFoundryError,
} from '@foundry/core';
import { ProviderAdapter, type AdapterContext, type ProbeResult } from '../http/adapter.js';
import { bearerAuth, type ProviderHttpClient } from '../http/client.js';
import { verifyStandardWebhook, type VerificationInput, type VerificationResult } from '../http/webhook-verify.js';
import { DODO_MANIFEST, SECRETS } from '../manifests.js';
import { DodoCheckoutSession, DodoProduct, DodoProductList, DodoRefund } from './schemas.js';

export { mapDodoEventToOrderTransition, HANDLED_DODO_EVENTS, dodoRefundLedgerId } from './events.js';

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
  readonly #fetchImpl: typeof fetch | undefined;

  constructor(ctx: AdapterContext, overrides?: { readonly fetchImpl?: typeof fetch }) {
    super(ctx);
    this.#fetchImpl = overrides?.fetchImpl;
  }

  #http(): ProviderHttpClient {
    if (!this.#client) {
      this.requireSecret(SECRETS.dodoApiKey);
      this.#client = this.http(bearerAuth(this.requireSecret(SECRETS.dodoApiKey)), {
        // Dodo has no Idempotency-Key header. Do not send one and pretend it
        // is honouring a key it ignores. Local ledger is the retry guard.
        ...(this.#fetchImpl ? { fetchImpl: this.#fetchImpl } : {}),
      });
    }
    return this.#client;
  }

  override async probe(): Promise<ProbeResult> {
    try {
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
    } catch (error) {
      const foundry = toFoundryError(error);
      if (!(foundry instanceof ProviderAuthError)) throw error;
      const status = foundry.context['status'];
      const body = foundry.context['body'];
      const bodyText = typeof body === 'string' ? body : JSON.stringify(body);
      return {
        succeeded: false,
        detail: `GET /products HTTP ${String(status ?? 401)} body=${bodyText}`,
        evidence: {
          endpoint: 'GET /products',
          host: this.baseUrl(),
          status: status ?? 401,
          body,
        },
      };
    }
  }

  async createCheckout(input: DodoCheckoutInput): Promise<DodoCheckoutResult> {
    assertPaymentRoute(input.productKind, 'dodo_merchant_of_record');
    this.assertActivated();
    if (input.productCart.length === 0) {
      throw new ValidationError('Dodo checkout requires a non-empty product_cart');
    }

    const response = await this.#http().request(
      {
        method: 'POST',
        path: '/checkouts',
        operation: 'checkouts.create',
        retryable: false,
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
    assertPaymentRoute(input.productKind, 'dodo_merchant_of_record');
    this.assertActivated();
    const response = await this.#http().request(
      {
        method: 'POST',
        path: '/products',
        operation: 'products.create',
        retryable: false,
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
  }): Promise<{ refundId: string | null; paymentId: string; status?: string; amountMinor?: number }> {
    this.assertActivated();
    const response = await this.#http().request(
      {
        method: 'POST',
        path: '/refunds',
        operation: 'refunds.create',
        retryable: false,
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
      ...(response.body.status !== undefined ? { status: response.body.status } : {}),
      ...(response.body.amount !== undefined ? { amountMinor: response.body.amount } : {}),
    };
  }

  /**
   * RefundService facade. The refund id (`re_*`) is the ledger key; the
   * payment id is only the provider argument, never the stored refund external id.
   */
  async refund(input: {
    paymentExternalId: string;
    amountMinor: number;
    reason: string;
    idempotencyKey: string;
  }): Promise<{ refundId: string; status: string; amountMinor: number }> {
    const created = await this.refundPayment({
      paymentId: input.paymentExternalId,
      amountMinor: input.amountMinor,
      reason: input.reason,
      idempotencyKey: input.idempotencyKey,
    });
    if (!created.refundId) {
      throw new ProviderContractError('dodo', 'refund was created without an id', {
        paymentId: input.paymentExternalId,
      });
    }
    return {
      refundId: created.refundId,
      status: created.status ?? 'pending',
      amountMinor: created.amountMinor ?? input.amountMinor,
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
  assertPaymentRoute('physical_good', 'dodo_merchant_of_record');
  throw new ConflictError(
    'Dodo Payments is documented as Merchant of Record for digital products and SaaS. ' +
      'Routing a physical good through it would misstate who bears transaction and tax liability. ' +
      'Use stripe_direct for physical goods.',
    { kind: 'physical_good', route: 'dodo_merchant_of_record' },
  );
}
