/**
 * Dodo Merchant-of-Record collect, refund, and ledger helpers.
 *
 * Stripe owns physical checkout (`collect.ts`, `/api/checkout` stripe_direct).
 * This module is the Dodo rail: eligible digital add-ons, memberships, data
 * products, and subscriptions. Physical private-label goods are refused by
 * `assertPaymentRoute` — Dodo's terms put them on the prohibited list, and
 * claiming MoR for a bottle would misstate tax liability.
 *
 * Dodo publishes no Idempotency-Key header. Refunds are keyed on the local
 * ledger as `refund:${orderId}:${amount}` and stored under the provider
 * refund id (`re_*`), never the payment id.
 *
 * Wire-up that would collide with Stripe-owned files lives in PATCH.md.
 */

import {
  ConflictError,
  CredentialsMissingError,
  ProviderAuthError,
  ValidationError,
  assertPaymentRoute,
  statusAfterRefund,
  type ProductKind,
} from '@foundry/core';
import { DodoAdapter, dodoRefundLedgerId } from '@foundry/providers';
import type { OrderTransitionIntent } from '@foundry/providers';
import { optionalCapability, requireCapability, type ServiceDeps, type ServiceOutcome } from '../deps.js';

export { dodoRefundLedgerId };

export interface DodoCheckoutRequest {
  readonly companyId: string;
  readonly orderId: string;
  readonly returnUrl: string;
  readonly cancelUrl?: string;
  readonly customerEmail?: string;
  readonly idempotencyKey: string;
}

export interface DodoCheckoutData {
  readonly orderId: string;
  readonly sessionId: string;
  readonly checkoutUrl: string | null;
  readonly paymentId: string | null;
}

export interface DodoRefundRequest {
  readonly companyId: string;
  readonly orderId: string;
  readonly amountMinor: number;
  readonly reason: string;
  readonly actorId: string;
}

export interface DodoRefundData {
  readonly refundId: string;
  readonly amountMinor: number;
}

const DIGITAL_MOR: 'payments.checkout.digital_mor' = 'payments.checkout.digital_mor';

export class DodoCommerceService {
  constructor(private readonly deps: ServiceDeps) {}

  async startDigitalCheckout(input: DodoCheckoutRequest): Promise<ServiceOutcome<DodoCheckoutData>> {
    const order = await this.deps.repos.commerce.orders.byId(input.orderId);
    if (order.company_id !== input.companyId) {
      throw new ValidationError('Order does not belong to this company', { orderId: input.orderId });
    }
    if (order.payment_route !== 'dodo_merchant_of_record') {
      throw new ValidationError(
        `DodoCommerceService only collects dodo_merchant_of_record orders, not ${order.payment_route}`,
        { orderId: order.id, paymentRoute: order.payment_route },
      );
    }

    const lines = await this.deps.repos.commerce.orders.lineItems(order.id);
    if (lines.length === 0) {
      throw new ValidationError('Order has no line items to charge', { orderId: order.id });
    }

    const cart: { productId: string; quantity: number }[] = [];
    let productKind: ProductKind = 'digital_good';
    for (const line of lines) {
      const product = await this.deps.repos.commerce.products.byId(line.product_id);
      assertPaymentRoute(product.kind as ProductKind, 'dodo_merchant_of_record');
      if (product.payment_route !== 'dodo_merchant_of_record') {
        throw new ValidationError(
          `Product ${product.sku} is not on the Dodo rail`,
          { productId: product.id, paymentRoute: product.payment_route },
        );
      }
      productKind = product.kind as ProductKind;
      let dodoProductId = product.external_refs['dodo_product'];
      if (!dodoProductId) {
        const listed = await this.#withDodo(DIGITAL_MOR, (adapter) =>
          adapter.createProduct({
            name: product.name,
            productKind,
            taxCategory: taxCategoryFor(productKind),
            priceMinor: product.price_minor,
            currency: product.currency,
          }),
        );
        if (!listed.ok) {
          return { ok: false, ...(listed.blockedOn ? { blockedOn: listed.blockedOn } : {}) };
        }
        dodoProductId = listed.data?.productId ?? undefined;
        if (dodoProductId) {
          await this.deps.repos.commerce.products.setExternalRef(product.id, 'dodo_product', dodoProductId);
        }
      }
      if (!dodoProductId) {
        throw new ValidationError('Dodo product id missing after create', { productId: product.id });
      }
      cart.push({ productId: dodoProductId, quantity: line.quantity });
    }

    const created = await this.#withDodo(DIGITAL_MOR, async (adapter) => {
      const { result } = await this.deps.repos.idempotency.run(
        input.idempotencyKey,
        'dodo.checkout',
        () =>
          adapter.createCheckout({
            orderId: order.id,
            productKind,
            productCart: cart,
            returnUrl: input.returnUrl,
            ...(input.cancelUrl ? { cancelUrl: input.cancelUrl } : {}),
            ...(input.customerEmail ? { customerEmail: input.customerEmail } : {}),
            idempotencyKey: input.idempotencyKey,
          }),
        { companyId: input.companyId },
      );
      return result;
    });
    if (!created.ok) {
      return { ok: false, ...(created.blockedOn ? { blockedOn: created.blockedOn } : {}) };
    }

    const session = created.data;
    if (!session) {
      return {
        ok: false,
        blockedOn: { capability: DIGITAL_MOR, reason: 'Dodo checkout returned no session' },
      };
    }
    await this.deps.repos.commerce.orders.setExternalRef(order.id, 'dodo_checkout_session', session.sessionId);
    await this.deps.repos.commerce.orders.setExternalRef(order.id, 'dodo_checkout_session_id', session.sessionId);
    if (session.paymentId) {
      await this.deps.repos.commerce.orders.setExternalRef(order.id, 'dodo_payment_id', session.paymentId);
    }

    return {
      ok: true,
      data: {
        orderId: order.id,
        sessionId: session.sessionId,
        checkoutUrl: session.checkoutUrl,
        paymentId: session.paymentId,
      },
    };
  }

  async issueRefund(input: DodoRefundRequest): Promise<ServiceOutcome<DodoRefundData>> {
    const order = await this.deps.repos.commerce.orders.byId(input.orderId);
    if (order.company_id !== input.companyId) {
      throw new ValidationError('Order does not belong to this company', { orderId: input.orderId });
    }
    if (input.amountMinor <= 0) {
      throw new ValidationError('Refund amount must be positive', { amountMinor: input.amountMinor });
    }

    const paymentExternalId = order.external_refs['dodo_payment_id'] ?? order.external_refs['dodo_payment'];
    if (!paymentExternalId) {
      return {
        ok: false,
        blockedOn: {
          capability: 'payments.refund',
          reason: `Order ${order.order_number} has no Dodo payment reference to refund against.`,
        },
      };
    }

    const payment = await this.deps.repos.commerce.payments.byExternalId('dodo', paymentExternalId);
    if (!payment) {
      return {
        ok: false,
        blockedOn: {
          capability: 'payments.refund',
          reason: `No Dodo payment record exists for ${paymentExternalId}. The charge webhook has not been reconciled yet.`,
        },
      };
    }

    const key = `refund:${order.id}:${input.amountMinor}`;
    const executed = await this.#withDodo('payments.refund', async (adapter) => {
      const { result } = await this.deps.repos.idempotency.run(
        key,
        'dodo.refund',
        async () => {
          const refund = await adapter.refund({
            paymentExternalId,
            amountMinor: input.amountMinor,
            reason: input.reason,
            idempotencyKey: key,
          });
          const refundId = dodoRefundLedgerId({ refund_id: refund.refundId, payment_id: paymentExternalId });
          if (!refundId) {
            throw new ValidationError('Dodo refund id missing or collided with payment id', {
              refundId: refund.refundId,
              paymentId: paymentExternalId,
            });
          }
          await this.deps.repos.commerce.orders.applyEvent({
            orderId: order.id,
            kind: 'refund_issued',
            toStatus: statusAfterRefund(
              { amountPaidMinor: order.amount_paid_minor, amountRefundedMinor: order.amount_refunded_minor },
              refund.amountMinor,
            ),
            actor: input.actorId,
            externalEventId: `refund:${refundId}`,
            amountRefundedDeltaMinor: refund.amountMinor,
            payload: { refundId, reason: input.reason, providerStatus: refund.status },
          });
          await this.deps.repos.commerce.payments.recordRefund({
            companyId: order.company_id,
            orderId: order.id,
            paymentId: payment.id,
            provider: 'dodo',
            externalId: refundId,
            amountMinor: refund.amountMinor,
            currency: order.currency,
            reason: input.reason,
            status: refund.status,
            authorisedBy: input.actorId,
          });
          await this.deps.repos.commerce.orders.setExternalRef(order.id, 'dodo_refund_id', refundId);
          await this.deps.queues.enqueue('finance.reconcile', {
            companyId: order.company_id,
            traceId: order.id,
            originRunId: null,
            idempotencyKey: `ledger:refund:${refundId}`,
            sinceIso: null,
            scope: 'refund',
            orderId: order.id,
            refundExternalId: refundId,
          });
          return { refundId, amountMinor: refund.amountMinor };
        },
        { companyId: input.companyId },
      );
      return result;
    });
    if (!executed.ok) {
      return { ok: false, ...(executed.blockedOn ? { blockedOn: executed.blockedOn } : {}) };
    }
    if (!executed.data) {
      return {
        ok: false,
        blockedOn: { capability: 'payments.refund', reason: 'Dodo refund returned no id' },
      };
    }
    return { ok: true, data: { refundId: executed.data.refundId, amountMinor: executed.data.amountMinor } };
  }

  /**
   * Webhook-processor splice: persist a Dodo capture against the payment id.
   * Called from PATCH.md `#onApplied` when provider === 'dodo' and status is PAID.
   */
  async recordCapturedPayment(
    order: {
      id: string;
      company_id: string;
      amount_paid_minor: number;
      currency: string;
      paid_at: Date | null;
      external_refs: Record<string, string>;
    },
    intent: OrderTransitionIntent,
  ): Promise<void> {
    if (order.amount_paid_minor <= 0) return;
    const externalId =
      intent.externalIds['payment_id'] ??
      order.external_refs['dodo_payment_id'] ??
      order.external_refs['dodo_payment'];
    if (!externalId) return;
    await this.deps.repos.commerce.payments.upsert({
      companyId: order.company_id,
      orderId: order.id,
      provider: 'dodo',
      externalId,
      status: 'succeeded',
      amountMinor: order.amount_paid_minor,
      currency: order.currency,
      capturedAt: order.paid_at ?? new Date(),
    });
  }

  /**
   * Webhook-processor splice: book a Dodo refund by `re_*` / `refund_id`.
   * Never uses the payment id as the refund external id.
   */
  async recordWebhookRefund(
    order: {
      id: string;
      company_id: string;
      currency: string;
      external_refs: Record<string, string>;
    },
    intent: OrderTransitionIntent,
  ): Promise<void> {
    const refundExternalId = dodoRefundLedgerId(intent.externalIds);
    const amountMinor = intent.amountRefundedDeltaMinor;
    if (!refundExternalId || !amountMinor || amountMinor <= 0) return;

    const paymentExternalId =
      intent.externalIds['payment_id'] ??
      order.external_refs['dodo_payment_id'] ??
      order.external_refs['dodo_payment'];
    if (!paymentExternalId) return;
    const payment = await this.deps.repos.commerce.payments.byExternalId('dodo', paymentExternalId);
    if (!payment) return;

    await this.deps.repos.commerce.payments.recordRefund({
      companyId: order.company_id,
      orderId: order.id,
      paymentId: payment.id,
      provider: 'dodo',
      externalId: refundExternalId,
      amountMinor,
      currency: order.currency,
      reason: typeof intent.detail['reason'] === 'string' ? intent.detail['reason'] : null,
      status: typeof intent.detail['status'] === 'string' ? intent.detail['status'] : 'succeeded',
      authorisedBy: 'webhook',
    });

    await this.deps.queues.enqueue('finance.reconcile', {
      companyId: order.company_id,
      traceId: order.id,
      originRunId: null,
      idempotencyKey: `ledger:refund:${refundExternalId}`,
      sinceIso: null,
      scope: 'refund',
      orderId: order.id,
      refundExternalId,
    });
  }

  async #withDodo<T>(
    capability: 'payments.checkout.digital_mor' | 'payments.refund',
    fn: (adapter: DodoAdapter) => Promise<T>,
  ): Promise<ServiceOutcome<T>> {
    let adapter: DodoAdapter;
    try {
      adapter =
        optionalCapability<DodoAdapter>(this.deps, capability) ??
        requireCapability<DodoAdapter>(this.deps, capability).adapter;
    } catch (error) {
      if (error instanceof CredentialsMissingError) {
        return { ok: false, blockedOn: { capability, reason: error.message } };
      }
      throw error;
    }
    if (!adapter) {
      return {
        ok: false,
        blockedOn: {
          capability,
          reason: 'Dodo adapter is not bound to this capability',
        },
      };
    }
    try {
      return { ok: true, data: await fn(adapter) };
    } catch (error) {
      if (error instanceof CredentialsMissingError || error instanceof ProviderAuthError) {
        return { ok: false, blockedOn: { capability, reason: error.message } };
      }
      if (error instanceof ConflictError && error.message.includes('Merchant of Record')) {
        throw error;
      }
      throw error;
    }
  }
}

function taxCategoryFor(kind: ProductKind): string {
  if (kind === 'subscription' || kind === 'membership') return 'saas';
  return 'digital_products';
}
