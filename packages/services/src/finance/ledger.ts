/**
 * Posting real money movements to the double-entry ledger.
 *
 * The ledger is the system's answer to "did this business actually make
 * money?", so every posting here is derived from a recorded fact — an order
 * row, a provider fee, a landed-cost model with a grounded basis — and never
 * from an estimate presented as an actual. Where a true figure is not yet
 * known (a processor fee that arrives days after the charge), the posting says
 * so explicitly rather than filling the gap with a plausible number.
 *
 * Every write is idempotent on a deterministic transaction id, because these
 * run as retryable jobs and a double-posted sale silently doubles reported
 * revenue.
 */

import {
  ValidationError,
  buildRefundTransaction,
  buildSaleTransaction,
  buildSpendTransaction,
  computeProfitAndLoss,
  type LedgerAccount,
} from '@foundry/core';
import { getLogger } from '@foundry/obs';
import type { ServiceDeps } from '../deps.js';

export interface PostSaleResult {
  readonly posted: boolean;
  readonly transactionId: string;
  /** Populated when part of the entry is not yet known from a provider. */
  readonly provisional: readonly string[];
}

export class LedgerService {
  constructor(private readonly deps: ServiceDeps) {}

  /**
   * Posts the sale for a paid order.
   *
   * Called from the `finance.reconcile` queue after a payment webhook lands.
   * The transaction id is `sale:<orderId>`, which makes a redelivered webhook a
   * no-op rather than a second revenue entry.
   */
  async postSale(orderId: string): Promise<PostSaleResult> {
    const log = getLogger();
    const order = await this.deps.repos.commerce.orders.byId(orderId);
    const transactionId = `sale:${order.id}`;

    if (order.amount_paid_minor <= 0) {
      throw new ValidationError(
        `Order ${order.order_number} has no captured payment, so there is no sale to post.`,
        { orderId, amountPaidMinor: order.amount_paid_minor },
      );
    }

    const items = await this.deps.repos.commerce.orders.lineItems(orderId);
    const provisional: string[] = [];

    /* ------------------------------------------------------------------ */
    /* Cost of goods                                                       */
    /* ------------------------------------------------------------------ */
    // Landed cost is snapshotted onto the line item at order time precisely so
    // that a later supplier price change cannot rewrite history. A line with no
    // snapshot contributes zero COGS and is flagged — reporting a 100% margin
    // because the cost is unknown would be the worst kind of wrong.
    let landedCogsMinor = 0;
    for (const line of items) {
      if (line.landed_unit_cost_minor === null) {
        provisional.push(`line ${line.sku}: no landed cost recorded, COGS understated`);
        continue;
      }
      landedCogsMinor += line.landed_unit_cost_minor * line.quantity;
    }

    /* ------------------------------------------------------------------ */
    /* Processor fee                                                       */
    /* ------------------------------------------------------------------ */
    // Stripe reports the fee on the balance transaction, which is not always
    // available at charge time. Zero here means "not yet known", recorded as
    // provisional, and the reconciliation sweep posts the correction later.
    const paymentRef =
      order.external_refs['stripe_payment_intent'] ?? order.external_refs['stripe_charge'] ?? null;
    const payment = paymentRef
      ? await this.deps.repos.commerce.payments.byExternalId('stripe', paymentRef)
      : undefined;
    const paymentFeeMinor = payment?.fee_minor ?? 0;
    if (payment?.fee_minor == null) {
      provisional.push('processor fee not yet reported by the provider');
    }

    const transaction = buildSaleTransaction({
      transactionId,
      currency: order.currency,
      productRevenueMinor: order.subtotal_minor,
      shippingRevenueMinor: order.shipping_minor,
      discountMinor: order.discount_minor,
      taxCollectedMinor: order.tax_minor,
      paymentFeeMinor,
      landedCogsMinor,
    });

    const result = await this.deps.repos.ledger.writeTransactionOnce({
      companyId: order.company_id,
      transaction,
      sourceType: 'order',
      sourceRefId: order.id,
      ...(order.paid_at ? { occurredAt: order.paid_at } : {}),
      // Not settled: the money is with the processor, not in the bank. Payout
      // reconciliation is what moves it to `cash_settled`.
      settled: false,
    });

    if (result.written) {
      log.info(
        { orderId, transactionId, landedCogsMinor, paymentFeeMinor, provisional },
        'sale posted to ledger',
      );
    }

    return { posted: result.written, transactionId, provisional };
  }

  /** Posts a confirmed refund. Idempotent on the provider's refund id. */
  async postRefund(input: {
    companyId: string;
    orderId: string;
    refundExternalId: string;
    refundAmountMinor: number;
    taxRefundedMinor: number;
    feeRetainedMinor: number;
    currency: string;
    occurredAt?: Date;
  }): Promise<{ posted: boolean; transactionId: string }> {
    const transactionId = `refund:${input.refundExternalId}`;
    const transaction = buildRefundTransaction({
      transactionId,
      currency: input.currency,
      refundAmountMinor: input.refundAmountMinor,
      taxRefundedMinor: input.taxRefundedMinor,
      feeRetainedMinor: input.feeRetainedMinor,
    });

    const result = await this.deps.repos.ledger.writeTransactionOnce({
      companyId: input.companyId,
      transaction,
      sourceType: 'refund',
      sourceRefId: input.refundExternalId,
      ...(input.occurredAt ? { occurredAt: input.occurredAt } : {}),
      settled: true,
    });
    return { posted: result.written, transactionId };
  }

  /**
   * Posts an operating expense the system actually incurred.
   *
   * Called after a spend completes — an ad charge, an expert-review fee, a
   * shipping label, model inference. The caller supplies the provider's own
   * reference so the entry can be traced back to an invoice.
   */
  async postSpend(input: {
    companyId: string;
    account: Extract<
      LedgerAccount,
      | 'advertising_spend'
      | 'expert_review_spend'
      | 'infrastructure_spend'
      | 'llm_inference_spend'
      | 'messaging_spend'
      | 'sampling_spend'
      | 'fulfilment_costs'
    >;
    amountMinor: number;
    currency: string;
    description: string;
    sourceType: string;
    sourceRefId: string;
    occurredAt?: Date;
  }): Promise<{ posted: boolean; transactionId: string }> {
    if (input.amountMinor <= 0) {
      throw new ValidationError('Spend amount must be positive', { amountMinor: input.amountMinor });
    }
    const transactionId = `spend:${input.sourceType}:${input.sourceRefId}`;
    const transaction = buildSpendTransaction({
      transactionId,
      currency: input.currency,
      account: input.account,
      amountMinor: input.amountMinor,
      description: input.description,
    });

    const result = await this.deps.repos.ledger.writeTransactionOnce({
      companyId: input.companyId,
      transaction,
      sourceType: input.sourceType,
      sourceRefId: input.sourceRefId,
      ...(input.occurredAt ? { occurredAt: input.occurredAt } : {}),
      settled: true,
    });
    return { posted: result.written, transactionId };
  }

  /**
   * Profit and loss over a window.
   *
   * Reads the ledger and nothing else. If the ledger has provisional entries
   * (unknown fees, missing COGS) the numbers are as good as the ledger, which
   * is why `postSale` records those gaps rather than papering over them.
   */
  async profitAndLoss(companyId: string, currency: string, from: Date, to: Date) {
    // `entries` already returns domain `LedgerEntry` objects, so no remapping
    // is needed — and doing one here would risk drifting from the schema.
    const entries = await this.deps.repos.ledger.entries(companyId, { since: from, until: to, currency });
    return computeProfitAndLoss(entries, currency);
  }
}
