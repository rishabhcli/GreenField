/**
 * Finance domain: a double-entry ledger and reconciliation.
 *
 * Double entry rather than a running total, because the question the CEO asks
 * ("are we actually making money?") is only answerable if every movement has a
 * matching counter-entry and the books balance.
 */

import { z } from 'zod';
import { ValidationError } from '../errors.js';

export const LedgerAccount = z.enum([
  // Assets
  'cash_in_transit',
  'cash_settled',
  'inventory',
  'prepaid_supplier',
  // Liabilities
  'refunds_payable',
  'tax_payable',
  'disputes_reserved',
  // Revenue
  'product_revenue',
  'shipping_revenue',
  'discounts',
  'refunds_issued',
  // Costs
  'cogs_landed',
  'payment_fees',
  'fulfilment_costs',
  'advertising_spend',
  'expert_review_spend',
  'infrastructure_spend',
  'llm_inference_spend',
  'messaging_spend',
  'sampling_spend',
]);
export type LedgerAccount = z.infer<typeof LedgerAccount>;

export const ACCOUNT_TYPE: Readonly<Record<LedgerAccount, 'asset' | 'liability' | 'revenue' | 'expense'>> = {
  cash_in_transit: 'asset',
  cash_settled: 'asset',
  inventory: 'asset',
  prepaid_supplier: 'asset',
  refunds_payable: 'liability',
  tax_payable: 'liability',
  disputes_reserved: 'liability',
  product_revenue: 'revenue',
  shipping_revenue: 'revenue',
  discounts: 'revenue',
  refunds_issued: 'revenue',
  cogs_landed: 'expense',
  payment_fees: 'expense',
  fulfilment_costs: 'expense',
  advertising_spend: 'expense',
  expert_review_spend: 'expense',
  infrastructure_spend: 'expense',
  llm_inference_spend: 'expense',
  messaging_spend: 'expense',
  sampling_spend: 'expense',
};

export const LedgerEntry = z.object({
  id: z.string().min(1),
  companyId: z.string().min(1),
  /** Groups the debit and credit legs of one economic event. */
  transactionId: z.string().min(1),
  account: LedgerAccount,
  /** Positive = debit, negative = credit. A transaction must sum to zero. */
  amountMinor: z.number().int(),
  currency: z.string().length(3),
  description: z.string().min(1),
  /** What caused this: order id, payment id, campaign id, invoice id. */
  sourceType: z.string().min(1),
  sourceRefId: z.string().min(1),
  /** Set once the movement is confirmed by the provider, not just expected. */
  settled: z.boolean().default(false),
  occurredAt: z.string().datetime(),
  createdAt: z.string().datetime(),
});
export type LedgerEntry = z.infer<typeof LedgerEntry>;

export interface LedgerTransaction {
  readonly transactionId: string;
  readonly entries: readonly Pick<LedgerEntry, 'account' | 'amountMinor' | 'currency' | 'description'>[];
}

/** A transaction whose legs do not net to zero is rejected before it is written. */
export function assertBalanced(tx: LedgerTransaction): void {
  const byCurrency = new Map<string, number>();
  for (const e of tx.entries) {
    byCurrency.set(e.currency, (byCurrency.get(e.currency) ?? 0) + e.amountMinor);
  }
  const unbalanced = [...byCurrency.entries()].filter(([, sum]) => sum !== 0);
  if (unbalanced.length > 0) {
    throw new ValidationError(
      `Ledger transaction ${tx.transactionId} does not balance: ${unbalanced
        .map(([cur, sum]) => `${cur} ${sum}`)
        .join(', ')}`,
      { transactionId: tx.transactionId, unbalanced },
    );
  }
  if (tx.entries.length < 2) {
    throw new ValidationError(`Ledger transaction ${tx.transactionId} needs at least two legs`);
  }
}

/* -------------------------------------------------------------------------- */
/* Standard transactions                                                       */
/* -------------------------------------------------------------------------- */

export interface SaleInput {
  readonly transactionId: string;
  readonly currency: string;
  readonly productRevenueMinor: number;
  readonly shippingRevenueMinor: number;
  readonly discountMinor: number;
  readonly taxCollectedMinor: number;
  readonly paymentFeeMinor: number;
  readonly landedCogsMinor: number;
}

/**
 * The canonical sale entry. Tax collected is a liability, never revenue —
 * getting that wrong overstates margin and understates what is owed.
 */
export function buildSaleTransaction(input: SaleInput): LedgerTransaction {
  const c = input.currency;
  const grossToUs =
    input.productRevenueMinor + input.shippingRevenueMinor - input.discountMinor + input.taxCollectedMinor;
  const entries: LedgerEntry['account'] extends never ? never : Pick<LedgerEntry, 'account' | 'amountMinor' | 'currency' | 'description'>[] = [
    { account: 'cash_in_transit', amountMinor: grossToUs - input.paymentFeeMinor, currency: c, description: 'net proceeds' },
    { account: 'payment_fees', amountMinor: input.paymentFeeMinor, currency: c, description: 'processor fee' },
    { account: 'product_revenue', amountMinor: -input.productRevenueMinor, currency: c, description: 'product revenue' },
    { account: 'shipping_revenue', amountMinor: -input.shippingRevenueMinor, currency: c, description: 'shipping revenue' },
    { account: 'discounts', amountMinor: input.discountMinor, currency: c, description: 'discount given' },
    { account: 'tax_payable', amountMinor: -input.taxCollectedMinor, currency: c, description: 'sales tax collected' },
    { account: 'cogs_landed', amountMinor: input.landedCogsMinor, currency: c, description: 'landed cost of goods' },
    { account: 'inventory', amountMinor: -input.landedCogsMinor, currency: c, description: 'inventory relieved' },
  ];
  const tx = { transactionId: input.transactionId, entries: entries.filter((e) => e.amountMinor !== 0) };
  assertBalanced(tx);
  return tx;
}

export function buildRefundTransaction(input: {
  transactionId: string;
  currency: string;
  refundAmountMinor: number;
  taxRefundedMinor: number;
  feeRetainedMinor: number;
}): LedgerTransaction {
  const c = input.currency;
  const entries = [
    { account: 'refunds_issued' as const, amountMinor: input.refundAmountMinor - input.taxRefundedMinor, currency: c, description: 'refund to customer' },
    { account: 'tax_payable' as const, amountMinor: input.taxRefundedMinor, currency: c, description: 'tax refunded' },
    { account: 'payment_fees' as const, amountMinor: input.feeRetainedMinor, currency: c, description: 'processor fee retained on refund' },
    { account: 'cash_settled' as const, amountMinor: -(input.refundAmountMinor + input.feeRetainedMinor), currency: c, description: 'cash out' },
  ].filter((e) => e.amountMinor !== 0);
  const tx = { transactionId: input.transactionId, entries };
  assertBalanced(tx);
  return tx;
}

export function buildSpendTransaction(input: {
  transactionId: string;
  currency: string;
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
  description: string;
}): LedgerTransaction {
  const tx = {
    transactionId: input.transactionId,
    entries: [
      { account: input.account, amountMinor: input.amountMinor, currency: input.currency, description: input.description },
      { account: 'cash_settled' as const, amountMinor: -input.amountMinor, currency: input.currency, description: input.description },
    ],
  };
  assertBalanced(tx);
  return tx;
}

/* -------------------------------------------------------------------------- */
/* Reporting                                                                   */
/* -------------------------------------------------------------------------- */

export interface ProfitAndLoss {
  readonly currency: string;
  readonly revenueMinor: number;
  readonly discountsMinor: number;
  readonly refundsMinor: number;
  readonly netRevenueMinor: number;
  readonly cogsMinor: number;
  readonly grossProfitMinor: number;
  readonly variableCostsMinor: number;
  readonly contributionMinor: number;
  readonly contributionRatio: number;
  readonly byAccountMinor: Readonly<Record<string, number>>;
}

const VARIABLE_COST_ACCOUNTS: readonly LedgerAccount[] = [
  'payment_fees',
  'fulfilment_costs',
  'advertising_spend',
  'messaging_spend',
];

export function computeProfitAndLoss(entries: readonly LedgerEntry[], currency: string): ProfitAndLoss {
  const scoped = entries.filter((e) => e.currency === currency);
  const byAccount: Record<string, number> = {};
  for (const e of scoped) byAccount[e.account] = (byAccount[e.account] ?? 0) + e.amountMinor;

  const get = (a: LedgerAccount): number => byAccount[a] ?? 0;
  // Revenue accounts are credited (negative), so negate to present positively.
  const revenueMinor = -(get('product_revenue') + get('shipping_revenue'));
  const discountsMinor = get('discounts');
  const refundsMinor = get('refunds_issued');
  const netRevenueMinor = revenueMinor - discountsMinor - refundsMinor;
  const cogsMinor = get('cogs_landed');
  const grossProfitMinor = netRevenueMinor - cogsMinor;
  const variableCostsMinor = VARIABLE_COST_ACCOUNTS.reduce((acc, a) => acc + get(a), 0);
  const contributionMinor = grossProfitMinor - variableCostsMinor;

  return {
    currency,
    revenueMinor,
    discountsMinor,
    refundsMinor,
    netRevenueMinor,
    cogsMinor,
    grossProfitMinor,
    variableCostsMinor,
    contributionMinor,
    contributionRatio: netRevenueMinor === 0 ? 0 : contributionMinor / netRevenueMinor,
    byAccountMinor: byAccount,
  };
}

/* -------------------------------------------------------------------------- */
/* Reconciliation                                                              */
/* -------------------------------------------------------------------------- */

export interface ReconciliationInput {
  /** Payments as the provider reports them. */
  readonly providerPayments: readonly { externalId: string; amountMinor: number; currency: string; status: string }[];
  /** Payments as we have them. */
  readonly localPayments: readonly { externalId: string; amountMinor: number; currency: string; status: string; orderId: string }[];
}

export interface ReconciliationResult {
  readonly matched: number;
  /** At the provider but not in our database — money we may not have booked. */
  readonly missingLocally: readonly { externalId: string; amountMinor: number; currency: string }[];
  /** In our database but not at the provider — possibly fabricated or stale. */
  readonly missingAtProvider: readonly { externalId: string; orderId: string }[];
  readonly amountMismatches: readonly {
    externalId: string;
    providerAmountMinor: number;
    localAmountMinor: number;
  }[];
  readonly statusMismatches: readonly { externalId: string; providerStatus: string; localStatus: string }[];
  readonly clean: boolean;
}

/**
 * Reconciliation never "fixes" a discrepancy silently — it reports it. A local
 * payment with no provider counterpart is the exact signature of fabricated
 * data, and the finance manager is required to surface it.
 */
export function reconcile(input: ReconciliationInput): ReconciliationResult {
  const providerById = new Map(input.providerPayments.map((p) => [p.externalId, p]));
  const localById = new Map(input.localPayments.map((p) => [p.externalId, p]));

  const missingLocally = input.providerPayments
    .filter((p) => !localById.has(p.externalId))
    .map((p) => ({ externalId: p.externalId, amountMinor: p.amountMinor, currency: p.currency }));

  const missingAtProvider = input.localPayments
    .filter((p) => !providerById.has(p.externalId))
    .map((p) => ({ externalId: p.externalId, orderId: p.orderId }));

  const amountMismatches: { externalId: string; providerAmountMinor: number; localAmountMinor: number }[] = [];
  const statusMismatches: { externalId: string; providerStatus: string; localStatus: string }[] = [];
  let matched = 0;

  for (const local of input.localPayments) {
    const provider = providerById.get(local.externalId);
    if (!provider) continue;
    matched += 1;
    if (provider.amountMinor !== local.amountMinor) {
      amountMismatches.push({
        externalId: local.externalId,
        providerAmountMinor: provider.amountMinor,
        localAmountMinor: local.amountMinor,
      });
    }
    if (provider.status !== local.status) {
      statusMismatches.push({ externalId: local.externalId, providerStatus: provider.status, localStatus: local.status });
    }
  }

  return {
    matched,
    missingLocally,
    missingAtProvider,
    amountMismatches,
    statusMismatches,
    clean:
      missingLocally.length === 0 &&
      missingAtProvider.length === 0 &&
      amountMismatches.length === 0 &&
      statusMismatches.length === 0,
  };
}
