/**
 * Stripe adapter — payments for physical goods, with the operating company as
 * merchant of record.
 *
 * Written against the official `stripe` SDK pinned to API version
 * `2026-07-29.dahlia`. Every method here makes a real call; with no credentials
 * configured, `requireSecret` raises a typed `CredentialsMissingError` naming
 * `STRIPE_SECRET_KEY`. That error is the correct output, and nothing in this
 * file substitutes a stub for it.
 */

import Stripe from 'stripe';
import {
  CredentialsMissingError,
  Money,
  ProviderAuthError,
  ProviderContractError,
  ProviderUnavailableError,
  RateLimitError,
  ValidationError,
  assertModeMatchesEnvironment,
  type Secret,
} from '@foundry/core';

/**
 * Pinned explicitly rather than inherited from the SDK version.
 *
 * From stripe-node v12 onward the library sends the API version it shipped
 * with, so upgrading the npm package would silently move our effective API
 * version and could change response shapes mid-deploy. Verified current stable
 * on 2026-08-14.
 */
export const STRIPE_API_VERSION = '2026-07-29.dahlia' as Stripe.LatestApiVersion;
import { getLogger } from '@foundry/obs';
import { ProviderAdapter, type AdapterContext, type ProbeResult } from '../http/adapter.js';
import { verifyStripeSignature } from '../http/webhook-verify.js';
import { SECRETS, STRIPE_MANIFEST } from '../manifests.js';
import {
  StripeBalance,
  StripeCheckoutSession,
  StripeCharge,
  StripeDispute,
  StripeEventEnvelope,
  StripePaymentIntent,
  StripeRefund,
  refId,
} from './schemas.js';
import { mapStripeEventToOrderTransition, type MappingResult } from './events.js';

export interface CheckoutLineItemInput {
  readonly productId: string;
  readonly name: string;
  readonly description?: string;
  readonly unitPriceMinor: number;
  readonly quantity: number;
  /** Stripe tax code for the product, required when automatic tax is enabled. */
  readonly taxCode?: string;
  readonly imageUrl?: string;
}

export interface ShippingOptionInput {
  readonly displayName: string;
  readonly amountMinor: number;
  readonly minBusinessDays: number;
  readonly maxBusinessDays: number;
  /** `txcd_92010001` = Shipping, `txcd_00000000` = Nontaxable. */
  readonly taxCode?: string;
}

export interface CreateCheckoutSessionInput {
  readonly orderId: string;
  readonly currency: string;
  readonly lineItems: readonly CheckoutLineItemInput[];
  readonly successUrl: string;
  readonly cancelUrl: string;
  readonly allowedShippingCountries: readonly string[];
  readonly shippingOptions?: readonly ShippingOptionInput[];
  readonly automaticTax?: boolean;
  readonly customerEmail?: string;
  /** Click ids and experiment arm, so revenue attributes to the creative. */
  readonly attribution?: Readonly<Record<string, string>>;
  readonly idempotencyKey: string;
  readonly expiresInMinutes?: number;
}

export interface CheckoutSessionResult {
  readonly sessionId: string;
  readonly url: string;
  readonly paymentIntentId: string | null;
  readonly expiresAt: Date | null;
  readonly livemode: boolean;
}

export class StripeAdapter extends ProviderAdapter {
  override readonly manifest = STRIPE_MANIFEST;
  #client: Stripe | undefined;
  #secret: Secret | undefined;

  constructor(ctx: AdapterContext) {
    super(ctx);
  }

  /**
   * Lazily constructs the SDK client.
   *
   * `maxNetworkRetries: 0` is deliberate: retry, backoff and circuit breaking
   * are owned by the platform's own policy so behaviour is uniform across every
   * provider and testable in one place. Letting the SDK retry underneath would
   * multiply attempts and make the effective timeout unpredictable.
   */
  #stripe(): Stripe {
    if (this.#client) return this.#client;
    const secret = this.requireSecret(SECRETS.stripeSecretKey);
    this.#secret = secret;
    assertModeMatchesEnvironment('stripe', secret.mode, this.ctx.environment);

    this.#client = new Stripe(secret.reveal(), {
      apiVersion: STRIPE_API_VERSION,
      maxNetworkRetries: 0,
      timeout: 30_000,
      telemetry: false,
      appInfo: { name: 'foundry-autonomous-company', version: '0.1.0' },
    });
    return this.#client;
  }

  /** True when the loaded key is a live-mode key. */
  get isLiveMode(): boolean {
    const secret = this.#secret ?? this.optionalSecret(SECRETS.stripeSecretKey);
    return secret?.mode === 'live';
  }

  /* ---------------------------------------------------------------------- */
  /* Probe                                                                   */
  /* ---------------------------------------------------------------------- */

  override async probe(): Promise<ProbeResult> {
    const stripe = this.#stripe();
    const raw = await this.#call('balance.retrieve', () => stripe.balance.retrieve());
    const balance = StripeBalance.parse(raw);
    return {
      succeeded: true,
      detail: `GET /v1/balance succeeded in ${balance.livemode ? 'live' : 'test'} mode`,
      evidence: {
        endpoint: 'GET /v1/balance',
        livemode: balance.livemode,
        currencies: balance.available.map((a) => a.currency),
        apiVersion: STRIPE_API_VERSION,
      },
    };
  }

  /* ---------------------------------------------------------------------- */
  /* Checkout                                                                */
  /* ---------------------------------------------------------------------- */

  async createCheckoutSession(input: CreateCheckoutSessionInput): Promise<CheckoutSessionResult> {
    this.assertActivated();
    if (input.lineItems.length === 0) {
      throw new ValidationError('A checkout session needs at least one line item', { orderId: input.orderId });
    }
    if (input.allowedShippingCountries.length === 0) {
      throw new ValidationError(
        'Physical-goods checkout must declare the countries it ships to; Stripe requires allowed_countries when collecting a shipping address',
        { orderId: input.orderId },
      );
    }
    if (input.automaticTax && input.lineItems.some((li) => !li.taxCode)) {
      // Stripe Tax needs a tax code per line item; without it the calculation
      // silently falls back and the tax collected will be wrong.
      throw new ValidationError(
        'automatic_tax is enabled but at least one line item has no taxCode. Stripe Tax requires a tax_code per item.',
        { orderId: input.orderId },
      );
    }

    const stripe = this.#stripe();

    const params: Stripe.Checkout.SessionCreateParams = {
      mode: 'payment',
      // Reconciles the session back to our order without trusting metadata.
      client_reference_id: input.orderId,
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
      line_items: input.lineItems.map((li) => ({
        quantity: li.quantity,
        price_data: {
          currency: input.currency.toLowerCase(),
          unit_amount: li.unitPriceMinor,
          product_data: {
            name: li.name,
            ...(li.description ? { description: li.description } : {}),
            ...(li.imageUrl ? { images: [li.imageUrl] } : {}),
            metadata: { internal_product_id: li.productId },
          },
          ...(li.taxCode ? { tax_behavior: 'exclusive' as const } : {}),
        },
      })),
      shipping_address_collection: {
        allowed_countries: input.allowedShippingCountries as Stripe.Checkout.SessionCreateParams.ShippingAddressCollection.AllowedCountry[],
      },
      metadata: {
        internal_order_id: input.orderId,
        ...truncateMetadata(input.attribution ?? {}),
      },
      payment_intent_data: {
        metadata: { internal_order_id: input.orderId },
      },
      ...(input.customerEmail ? { customer_email: input.customerEmail } : {}),
      ...(input.automaticTax ? { automatic_tax: { enabled: true } } : {}),
      ...(input.expiresInMinutes
        ? { expires_at: Math.floor(Date.now() / 1000) + input.expiresInMinutes * 60 }
        : {}),
    };

    if (input.shippingOptions && input.shippingOptions.length > 0) {
      if (input.shippingOptions.length > 5) {
        throw new ValidationError('Stripe Checkout accepts at most 5 shipping options', {
          count: input.shippingOptions.length,
        });
      }
      params.shipping_options = input.shippingOptions.map((option) => ({
        shipping_rate_data: {
          type: 'fixed_amount',
          display_name: option.displayName,
          fixed_amount: { amount: option.amountMinor, currency: input.currency.toLowerCase() },
          delivery_estimate: {
            minimum: { unit: 'business_day', value: option.minBusinessDays },
            maximum: { unit: 'business_day', value: option.maxBusinessDays },
          },
          // Shipping taxability differs by jurisdiction, so the shipping rate
          // carries its own tax code rather than inheriting the product's.
          ...(input.automaticTax
            ? { tax_behavior: 'exclusive' as const, tax_code: option.taxCode ?? 'txcd_92010001' }
            : {}),
        },
      }));
    }

    const raw = await this.#call('checkout.sessions.create', () =>
      stripe.checkout.sessions.create(params, { idempotencyKey: input.idempotencyKey }),
    );
    const session = StripeCheckoutSession.parse(raw);

    if (!session.url) {
      throw new ProviderContractError('stripe', 'checkout session was created without a redirect URL', {
        sessionId: session.id,
      });
    }

    getLogger().info(
      { orderId: input.orderId, sessionId: session.id, livemode: session.livemode },
      'stripe checkout session created',
    );

    return {
      sessionId: session.id,
      url: session.url,
      paymentIntentId: refId(session.payment_intent),
      expiresAt: session.expires_at ? new Date(session.expires_at * 1000) : null,
      livemode: session.livemode ?? this.isLiveMode,
    };
  }

  async retrieveCheckoutSession(sessionId: string): Promise<StripeCheckoutSession> {
    this.assertActivated();
    const raw = await this.#call('checkout.sessions.retrieve', () =>
      this.#stripe().checkout.sessions.retrieve(sessionId),
    );
    return StripeCheckoutSession.parse(raw);
  }

  async retrievePaymentIntent(paymentIntentId: string): Promise<StripePaymentIntent> {
    this.assertActivated();
    const raw = await this.#call('paymentIntents.retrieve', () =>
      this.#stripe().paymentIntents.retrieve(paymentIntentId),
    );
    return StripePaymentIntent.parse(raw);
  }

  /** Charge with the balance transaction expanded, so the fee is populated. */
  async retrieveChargeWithFee(chargeId: string): Promise<StripeCharge> {
    this.assertActivated();
    const raw = await this.#call('charges.retrieve', () =>
      this.#stripe().charges.retrieve(chargeId, { expand: ['balance_transaction'] }),
    );
    return StripeCharge.parse(raw);
  }

  /* ---------------------------------------------------------------------- */
  /* Catalogue                                                               */
  /* ---------------------------------------------------------------------- */

  /**
   * Creates the Stripe Product and Price for one of our catalogue rows, reusing
   * them when they already exist. Keyed on our internal product id in metadata
   * so a retried build does not litter the account with duplicates.
   */
  async ensureProductAndPrice(input: {
    internalProductId: string;
    name: string;
    description: string;
    priceMinor: number;
    currency: string;
    taxCode?: string;
    idempotencyKey: string;
  }): Promise<{ productId: string; priceId: string; created: boolean }> {
    this.assertActivated();
    const stripe = this.#stripe();

    const existing = await this.#call('products.search', () =>
      stripe.products.search({
        query: `metadata['internal_product_id']:'${input.internalProductId}'`,
        limit: 1,
      }),
    );

    let productId = existing.data[0]?.id;
    let created = false;

    if (!productId) {
      const product = await this.#call('products.create', () =>
        stripe.products.create(
          {
            name: input.name,
            description: input.description,
            metadata: { internal_product_id: input.internalProductId },
            ...(input.taxCode ? { tax_code: input.taxCode } : {}),
          },
          { idempotencyKey: `${input.idempotencyKey}:product` },
        ),
      );
      productId = product.id;
      created = true;
    }

    const prices = await this.#call('prices.list', () =>
      stripe.prices.list({ product: productId, active: true, limit: 100 }),
    );
    const match = prices.data.find(
      (p) => p.unit_amount === input.priceMinor && p.currency === input.currency.toLowerCase(),
    );
    if (match) return { productId, priceId: match.id, created };

    const price = await this.#call('prices.create', () =>
      stripe.prices.create(
        {
          product: productId,
          unit_amount: input.priceMinor,
          currency: input.currency.toLowerCase(),
          ...(input.taxCode ? { tax_behavior: 'exclusive' as const } : {}),
        },
        { idempotencyKey: `${input.idempotencyKey}:price:${input.priceMinor}` },
      ),
    );
    return { productId, priceId: price.id, created: true };
  }

  /* ---------------------------------------------------------------------- */
  /* Refunds and disputes                                                    */
  /* ---------------------------------------------------------------------- */

  async createRefund(input: {
    paymentIntentId: string;
    amountMinor?: number;
    reason?: 'duplicate' | 'fraudulent' | 'requested_by_customer';
    metadata?: Record<string, string>;
    idempotencyKey: string;
  }): Promise<StripeRefund> {
    this.assertActivated();
    if (input.amountMinor !== undefined && input.amountMinor <= 0) {
      throw new ValidationError('Refund amount must be positive', { amountMinor: input.amountMinor });
    }
    const raw = await this.#call('refunds.create', () =>
      this.#stripe().refunds.create(
        {
          payment_intent: input.paymentIntentId,
          ...(input.amountMinor !== undefined ? { amount: input.amountMinor } : {}),
          ...(input.reason ? { reason: input.reason } : {}),
          ...(input.metadata ? { metadata: input.metadata } : {}),
        },
        { idempotencyKey: input.idempotencyKey },
      ),
    );
    return StripeRefund.parse(raw);
  }

  async listDisputes(limit = 50): Promise<readonly StripeDispute[]> {
    this.assertActivated();
    const raw = await this.#call('disputes.list', () => this.#stripe().disputes.list({ limit }));
    return raw.data.map((d) => StripeDispute.parse(d));
  }

  async retrieveDispute(disputeId: string): Promise<StripeDispute> {
    this.assertActivated();
    const raw = await this.#call('disputes.retrieve', () => this.#stripe().disputes.retrieve(disputeId));
    return StripeDispute.parse(raw);
  }

  /**
   * Submits dispute evidence.
   *
   * Stripe treats every update as a resubmission of the whole evidence hash, so
   * callers must pass the complete set they want on record, not a patch.
   */
  async submitDisputeEvidence(
    disputeId: string,
    evidence: {
      shippingCarrier?: string;
      shippingTrackingNumber?: string;
      shippingDate?: string;
      shippingDocumentation?: string;
      customerCommunication?: string;
      customerEmailAddress?: string;
      customerName?: string;
      customerPurchaseIp?: string;
      billingAddress?: string;
      shippingAddress?: string;
      productDescription?: string;
      receipt?: string;
      refundPolicy?: string;
      refundPolicyDisclosure?: string;
      serviceDate?: string;
      uncategorizedText?: string;
    },
    idempotencyKey: string,
  ): Promise<StripeDispute> {
    this.assertActivated();
    const raw = await this.#call('disputes.update', () =>
      this.#stripe().disputes.update(
        disputeId,
        {
          evidence: {
            ...(evidence.shippingCarrier ? { shipping_carrier: evidence.shippingCarrier } : {}),
            ...(evidence.shippingTrackingNumber ? { shipping_tracking_number: evidence.shippingTrackingNumber } : {}),
            ...(evidence.shippingDate ? { shipping_date: evidence.shippingDate } : {}),
            ...(evidence.shippingDocumentation ? { shipping_documentation: evidence.shippingDocumentation } : {}),
            ...(evidence.customerCommunication ? { customer_communication: evidence.customerCommunication } : {}),
            ...(evidence.customerEmailAddress ? { customer_email_address: evidence.customerEmailAddress } : {}),
            ...(evidence.customerName ? { customer_name: evidence.customerName } : {}),
            ...(evidence.customerPurchaseIp ? { customer_purchase_ip: evidence.customerPurchaseIp } : {}),
            ...(evidence.billingAddress ? { billing_address: evidence.billingAddress } : {}),
            ...(evidence.shippingAddress ? { shipping_address: evidence.shippingAddress } : {}),
            ...(evidence.productDescription ? { product_description: evidence.productDescription } : {}),
            ...(evidence.receipt ? { receipt: evidence.receipt } : {}),
            ...(evidence.refundPolicy ? { refund_policy: evidence.refundPolicy } : {}),
            ...(evidence.refundPolicyDisclosure ? { refund_policy_disclosure: evidence.refundPolicyDisclosure } : {}),
            ...(evidence.serviceDate ? { service_date: evidence.serviceDate } : {}),
            ...(evidence.uncategorizedText ? { uncategorized_text: evidence.uncategorizedText } : {}),
          },
        },
        { idempotencyKey },
      ),
    );
    return StripeDispute.parse(raw);
  }

  async closeDispute(disputeId: string, idempotencyKey: string): Promise<StripeDispute> {
    this.assertActivated();
    // `disputes.close` takes no body, so the idempotency key goes in the
    // request options slot rather than the params slot.
    const raw = await this.#call('disputes.close', () =>
      this.#stripe().disputes.close(disputeId, {}, { idempotencyKey }),
    );
    return StripeDispute.parse(raw);
  }

  /* ---------------------------------------------------------------------- */
  /* Reconciliation                                                          */
  /* ---------------------------------------------------------------------- */

  /**
   * Every charge since a point in time, with fees resolved.
   *
   * Used by the finance reconciler to compare Stripe's record against ours.
   * Paginates fully rather than taking the first page, because a partial list
   * would report phantom "missing locally" discrepancies.
   */
  async listChargesSince(since: Date, maxPages = 20): Promise<readonly StripeCharge[]> {
    this.assertActivated();
    const stripe = this.#stripe();
    const out: StripeCharge[] = [];
    let startingAfter: string | undefined;

    for (let page = 0; page < maxPages; page += 1) {
      const batch = await this.#call('charges.list', () =>
        stripe.charges.list({
          created: { gte: Math.floor(since.getTime() / 1000) },
          limit: 100,
          expand: ['data.balance_transaction'],
          ...(startingAfter ? { starting_after: startingAfter } : {}),
        }),
      );
      for (const charge of batch.data) out.push(StripeCharge.parse(charge));
      if (!batch.has_more || batch.data.length === 0) return out;
      startingAfter = batch.data[batch.data.length - 1]?.id;
    }

    getLogger().warn(
      { pages: maxPages, collected: out.length },
      'stripe charge pagination hit the page cap; reconciliation may be incomplete',
    );
    return out;
  }

  /* ---------------------------------------------------------------------- */
  /* Webhooks                                                                */
  /* ---------------------------------------------------------------------- */

  /**
   * Verifies and parses an inbound webhook.
   *
   * Uses the shared verifier rather than `stripe.webhooks.constructEvent` so
   * every provider's signature handling behaves identically, is unit-tested in
   * one place, and enforces the same replay window and v1-only rule.
   */
  verifyWebhook(
    rawBody: Buffer | string,
    headers: Record<string, string | string[] | undefined>,
  ): { event: StripeEventEnvelope; timestampSeconds: number } {
    const secret = this.requireSecret(SECRETS.stripeWebhookSecret);
    const verification = verifyStripeSignature({ rawBody, headers, secret });

    const parsed = StripeEventEnvelope.safeParse(
      JSON.parse(typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8')),
    );
    if (!parsed.success) {
      throw new ProviderContractError('stripe', `webhook body did not match the event envelope: ${parsed.error.message}`);
    }

    // A live-mode event arriving at a non-production deployment means the
    // webhook endpoint is misconfigured, and processing it would move real
    // money state in the wrong environment.
    if (parsed.data.livemode && this.ctx.environment !== 'production') {
      throw new ValidationError(
        `Refusing a livemode Stripe event in the ${this.ctx.environment} environment. ` +
          `Point the live webhook endpoint at the production deployment.`,
        { eventId: parsed.data.id, eventType: parsed.data.type },
      );
    }

    return { event: parsed.data, timestampSeconds: verification.timestampSeconds };
  }

  /** Maps a verified event to an order transition intent. */
  interpretEvent(event: StripeEventEnvelope): MappingResult {
    return mapStripeEventToOrderTransition(event.type, event.data.object);
  }

  /* ---------------------------------------------------------------------- */
  /* Error translation                                                       */
  /* ---------------------------------------------------------------------- */

  /**
   * Runs an SDK call and converts Stripe's error taxonomy into ours, so retry
   * policy and HTTP status mapping work the same for Stripe as for every other
   * provider.
   */
  async #call<T>(operation: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      throw this.#translate(operation, error);
    }
  }

  #translate(operation: string, error: unknown): Error {
    if (!(error instanceof Stripe.errors.StripeError)) {
      return new ProviderUnavailableError('stripe', `${operation}: ${String(error)}`, { operation });
    }
    const context = {
      operation,
      stripeType: error.type,
      stripeCode: error.code,
      requestId: error.requestId,
      statusCode: error.statusCode,
    };

    if (error instanceof Stripe.errors.StripeAuthenticationError) {
      return new ProviderAuthError('stripe', error.message, context);
    }
    if (error instanceof Stripe.errors.StripePermissionError) {
      return new ProviderAuthError('stripe', `insufficient permissions: ${error.message}`, context);
    }
    if (error instanceof Stripe.errors.StripeRateLimitError) {
      return new RateLimitError('stripe', undefined, context);
    }
    if (
      error instanceof Stripe.errors.StripeConnectionError ||
      error instanceof Stripe.errors.StripeAPIError ||
      (error.statusCode !== undefined && error.statusCode >= 500)
    ) {
      return new ProviderUnavailableError('stripe', error.message, context);
    }
    if (
      error instanceof Stripe.errors.StripeCardError ||
      error instanceof Stripe.errors.StripeInvalidRequestError ||
      error instanceof Stripe.errors.StripeIdempotencyError
    ) {
      // Terminal: retrying a declined card or a malformed request cannot help,
      // and an idempotency-key reuse with different parameters is our bug.
      return new ValidationError(`Stripe rejected ${operation}: ${error.message}`, context);
    }
    return new ProviderContractError('stripe', `${operation}: ${error.message}`, context);
  }
}

/** Stripe metadata values are capped at 500 characters and 50 keys. */
function truncateMetadata(input: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  let count = 0;
  for (const [key, value] of Object.entries(input)) {
    if (count >= 45) break; // leave headroom for our own keys
    out[key.slice(0, 40)] = value.slice(0, 500);
    count += 1;
  }
  return out;
}

export { mapStripeEventToOrderTransition, HANDLED_STRIPE_EVENTS } from './events.js';
export type { MappingResult, OrderTransitionIntent } from './events.js';
export * from './schemas.js';
export { Money, CredentialsMissingError };
