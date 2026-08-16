/**
 * Supplier, RFQ, quote and landed-cost domain.
 *
 * The defining constraint: `CostComponent.basis` distinguishes a number a
 * supplier actually quoted from a number the system assumed. Every downstream
 * margin figure carries the ratio of quoted-to-assumed inputs, so "38% margin"
 * from a real RFQ and "38% margin" from a model guess are never confused —
 * and the opportunity-selection gate refuses the second one.
 */

import { z } from 'zod';
import { Money, MODELLING_SCALE } from '../money.js';

/* -------------------------------------------------------------------------- */
/* Suppliers                                                                   */
/* -------------------------------------------------------------------------- */

export const SupplierKind = z.enum([
  'manufacturer',
  'trading_company',
  'contract_manufacturer',
  'private_label_specialist',
  'domestic_wholesaler',
  'print_on_demand',
  'contract_packer',
]);
export type SupplierKind = z.infer<typeof SupplierKind>;

export const Incoterm = z.enum(['EXW', 'FCA', 'FOB', 'CFR', 'CIF', 'CPT', 'CIP', 'DAP', 'DPU', 'DDP']);
export type Incoterm = z.infer<typeof Incoterm>;

/**
 * Delivery terms on a landed-cost model.
 *
 * Incoterms describe who bears freight, insurance and customs on a physical
 * shipment. A digital product has no shipment, so every Incoterm code is a
 * false statement about it — `not_applicable` says so explicitly rather than
 * picking the least-wrong code and letting a reader infer a shipment that does
 * not exist. RFQs and supplier quotes still take a real `Incoterm`, because
 * those only ever describe goods.
 */
export const LandedCostTerm = z.union([Incoterm, z.literal('not_applicable')]);
export type LandedCostTerm = z.infer<typeof LandedCostTerm>;

export const SupplierContactChannel = z.enum(['email', 'platform_message', 'phone', 'web_form', 'whatsapp', 'wechat']);
export type SupplierContactChannel = z.infer<typeof SupplierContactChannel>;

export const Supplier = z.object({
  id: z.string().min(1),
  companyId: z.string().min(1),
  /** Which adapter found them, e.g. `alibaba`. */
  sourceProvider: z.string().min(1),
  /** Provider's own id, so we can re-fetch and de-duplicate. */
  externalId: z.string().min(1),
  profileUrl: z.string().url().nullable(),
  legalName: z.string().min(1),
  displayName: z.string().min(1),
  kind: SupplierKind,
  countryCode: z.string().length(2),
  region: z.string().nullable(),
  yearsActive: z.number().int().nonnegative().nullable(),
  employeeCountBand: z.string().nullable(),
  /** Certifications the supplier claims. Claimed ≠ verified. */
  claimedCertifications: z.array(z.string()).default([]),
  /** Certifications for which we hold a document or third-party confirmation. */
  verifiedCertifications: z.array(z.string()).default([]),
  /** Provider trust indicators (verified badge, transaction volume, ratings). */
  platformSignals: z.record(z.string(), z.unknown()).default({}),
  supportsPrivateLabel: z.boolean().nullable(),
  supportsCustomPackaging: z.boolean().nullable(),
  contactChannels: z.array(SupplierContactChannel).default([]),
  /** Only populated where the platform exposes it and ToS permits storage. */
  contactHandle: z.string().nullable(),
  riskFlags: z.array(z.string()).default([]),
  /** Provenance of everything above. */
  discoveredVia: z.enum(['provider_api', 'browser_session', 'human_expert', 'manual_entry']),
  discoveredAt: z.string().datetime(),
  lastRefreshedAt: z.string().datetime(),
  createdAt: z.string().datetime(),
});
export type Supplier = z.infer<typeof Supplier>;

/* -------------------------------------------------------------------------- */
/* RFQ & quotes                                                                */
/* -------------------------------------------------------------------------- */

export const RfqStatus = z.enum([
  'draft',
  'pending_approval',
  'approved',
  'sending',
  'sent',
  'delivery_failed',
  'acknowledged',
  'quoted',
  'declined',
  'expired',
  'cancelled',
]);
export type RfqStatus = z.infer<typeof RfqStatus>;

export const RfqSpecification = z.object({
  productName: z.string().min(1),
  description: z.string().min(1),
  targetUnitCostCents: z.number().int().positive().nullable(),
  quantities: z.array(z.number().int().positive()).min(1),
  materials: z.array(z.string()).default([]),
  dimensions: z.string().nullable(),
  colours: z.array(z.string()).default([]),
  privateLabel: z.object({
    required: z.boolean(),
    logoPlacement: z.string().nullable(),
    printMethod: z.string().nullable(),
    artworkFormat: z.string().nullable(),
  }),
  packaging: z.object({
    required: z.boolean(),
    style: z.string().nullable(),
    printedInsert: z.boolean().default(false),
    retailReady: z.boolean().default(false),
  }),
  certificationsRequired: z.array(z.string()).default([]),
  destinationCountry: z.string().length(2),
  destinationPostalCode: z.string().nullable(),
  preferredIncoterm: Incoterm,
  sampleRequested: z.boolean().default(true),
  targetLeadTimeDays: z.number().int().positive().nullable(),
  complianceNotes: z.string().nullable(),
});
export type RfqSpecification = z.infer<typeof RfqSpecification>;

export const Rfq = z.object({
  id: z.string().min(1),
  companyId: z.string().min(1),
  opportunityId: z.string().min(1),
  supplierId: z.string().min(1),
  specification: RfqSpecification,
  /** Rendered outbound message. Stored verbatim for the audit trail. */
  messageBody: z.string().min(1),
  channel: SupplierContactChannel,
  status: RfqStatus,
  /** Populated only when a human approved outbound supplier contact. */
  approvalId: z.string().nullable().default(null),
  sentAt: z.string().datetime().nullable(),
  /** Provider message id / email message-id, proving the send happened. */
  externalMessageId: z.string().nullable(),
  deliveryError: z.string().nullable().default(null),
  respondedAt: z.string().datetime().nullable(),
  expiresAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Rfq = z.infer<typeof Rfq>;

export const PriceTier = z.object({
  minQuantity: z.number().int().positive(),
  maxQuantity: z.number().int().positive().nullable(),
  unitPriceMinor: z.number().int().nonnegative(),
  currency: z.string().length(3),
});
export type PriceTier = z.infer<typeof PriceTier>;

export const SupplierQuote = z.object({
  id: z.string().min(1),
  companyId: z.string().min(1),
  rfqId: z.string().min(1),
  supplierId: z.string().min(1),
  /** How the quote reached us — proves it is a real supplier response. */
  receivedVia: z.enum(['provider_api', 'email_inbound', 'browser_session', 'human_expert_relay', 'manual_entry']),
  /** Raw quote text/document reference for audit. */
  rawResponseRef: z.string().nullable(),
  receivedAt: z.string().datetime(),

  currency: z.string().length(3),
  priceTiers: z.array(PriceTier).min(1),
  moq: z.number().int().positive(),
  sampleCostMinor: z.number().int().nonnegative().nullable(),
  sampleLeadTimeDays: z.number().int().nonnegative().nullable(),
  toolingSetupCostMinor: z.number().int().nonnegative().default(0),
  customisationCostPerUnitMinor: z.number().int().nonnegative().default(0),
  packagingCostPerUnitMinor: z.number().int().nonnegative().default(0),
  productionLeadTimeDays: z.number().int().positive(),
  incoterm: Incoterm,
  originPort: z.string().nullable(),
  paymentTerms: z.string().nullable(),
  validUntil: z.string().datetime().nullable(),
  notes: z.string().nullable(),
  /** Set when a human expert or QC review validated the quote. */
  verifiedByEngagementId: z.string().nullable().default(null),
  createdAt: z.string().datetime(),
});
export type SupplierQuote = z.infer<typeof SupplierQuote>;

export function unitPriceForQuantity(quote: SupplierQuote, quantity: number): Money | null {
  const tier = quote.priceTiers
    .filter((t) => quantity >= t.minQuantity && (t.maxQuantity === null || quantity <= t.maxQuantity))
    .sort((a, b) => b.minQuantity - a.minQuantity)[0];
  if (!tier) return null;
  return Money.fromMinor(tier.unitPriceMinor, tier.currency).rescale(MODELLING_SCALE);
}

/* -------------------------------------------------------------------------- */
/* Landed cost                                                                 */
/* -------------------------------------------------------------------------- */

/** Where a cost number came from. Drives the grounded-vs-assumed ratio. */
export const CostBasis = z.enum([
  /** Taken from a supplier quote we received. */
  'supplier_quote',
  /** Returned by a freight/carrier/tax API. */
  'provider_api',
  /** Contractual rate we know (payment processor fee schedule, 3PL contract). */
  'contract_rate',
  /** Measured from our own historical data (return rate, support minutes). */
  'observed_actual',
  /** A model or operator estimate. Explicitly not a real number. */
  'assumption',
]);
export type CostBasis = z.infer<typeof CostBasis>;

export const GROUNDED_BASES: ReadonlySet<CostBasis> = new Set<CostBasis>([
  'supplier_quote',
  'provider_api',
  'contract_rate',
  'observed_actual',
]);

export const COST_COMPONENT_KINDS = [
  'unit_manufacturing',
  'customisation',
  'packaging',
  'tooling_setup_allocated',
  'inspection_qc',
  'origin_freight',
  'international_freight',
  'freight_insurance',
  'duties_tariffs',
  'customs_brokerage',
  'destination_freight',
  'fulfilment_receiving',
  'damage_loss_allowance',
  /* Digital lines: the marginal cost of delivering one more unit. There is no
     manufacturing, freight or duty, so those kinds simply never appear. */
  'inference_compute',
  'hosting_delivery',
] as const;
export const CostComponentKind = z.enum(COST_COMPONENT_KINDS);
export type CostComponentKind = z.infer<typeof CostComponentKind>;

/** Cost kinds that describe delivering a digital unit rather than making a physical one. */
export const DIGITAL_COST_COMPONENT_KINDS = ['inference_compute', 'hosting_delivery'] as const;

export const CostComponent = z.object({
  kind: CostComponentKind,
  /** Per-unit amount at modelling scale, as a decimal string. */
  amount: z.string(),
  currency: z.string().length(3),
  basis: CostBasis,
  /** Where the number came from: quote id, API response id, rate card name. */
  sourceRef: z.string().nullable(),
  note: z.string().nullable(),
});
export type CostComponent = z.infer<typeof CostComponent>;

export const LandedCostModel = z.object({
  id: z.string().min(1),
  companyId: z.string().min(1),
  opportunityId: z.string().min(1),
  quoteId: z.string().nullable(),
  /** Production run size the allocations are based on. */
  orderQuantity: z.number().int().positive(),
  currency: z.string().length(3),
  components: z.array(CostComponent).min(1),
  destinationCountry: z.string().length(2),
  /** `not_applicable` on a digital line: nothing is shipped, so no Incoterm applies. */
  incoterm: LandedCostTerm,
  /** HS code used for the duty rate, when one was determined. */
  hsCode: z.string().nullable(),
  computedAt: z.string().datetime(),
});
export type LandedCostModel = z.infer<typeof LandedCostModel>;

export interface LandedCostResult {
  readonly landedUnitCost: Money;
  readonly totalOrderCost: Money;
  readonly byComponent: ReadonlyArray<{ kind: CostComponentKind; amount: Money; basis: CostBasis }>;
  /** Share of landed cost backed by quotes/APIs rather than assumptions, 0..1. */
  readonly groundedRatio: number;
  readonly assumedComponents: readonly CostComponentKind[];
}

export function computeLandedCost(model: LandedCostModel): LandedCostResult {
  const byComponent = model.components.map((c) => ({
    kind: c.kind,
    amount: Money.of(c.amount, c.currency, MODELLING_SCALE),
    basis: c.basis,
  }));
  const landedUnitCost = Money.sum(
    byComponent.map((c) => c.amount),
    model.currency,
  ).rescale(MODELLING_SCALE);

  const total = byComponent.reduce((acc, c) => acc.add(c.amount), Money.zero(model.currency, MODELLING_SCALE));
  const groundedTotal = byComponent
    .filter((c) => GROUNDED_BASES.has(c.basis))
    .reduce((acc, c) => acc.add(c.amount), Money.zero(model.currency, MODELLING_SCALE));

  return {
    landedUnitCost,
    totalOrderCost: landedUnitCost.multiplyBy(model.orderQuantity),
    byComponent,
    groundedRatio: total.isZero ? 0 : Money.ratio(groundedTotal, total),
    assumedComponents: byComponent.filter((c) => !GROUNDED_BASES.has(c.basis)).map((c) => c.kind),
  };
}

/* -------------------------------------------------------------------------- */
/* Contribution margin                                                         */
/* -------------------------------------------------------------------------- */

export const VARIABLE_COST_KINDS = [
  'landed_unit_cost',
  'outbound_shipping_subsidy',
  'payment_processing_fee',
  'expected_refunds_returns',
  'ad_cac',
  'variable_support_cost',
  'platform_fees',
  'sales_tax_absorbed',
] as const;
export const VariableCostKind = z.enum(VARIABLE_COST_KINDS);
export type VariableCostKind = z.infer<typeof VariableCostKind>;

export const ContributionInput = z.object({
  /** Price the customer pays, excluding tax collected on their behalf. */
  netSellingPrice: z.string(),
  currency: z.string().length(3),
  components: z.array(
    z.object({
      kind: VariableCostKind,
      amount: z.string(),
      basis: CostBasis,
      sourceRef: z.string().nullable(),
      note: z.string().nullable().default(null),
    }),
  ),
});
export type ContributionInput = z.infer<typeof ContributionInput>;

export interface ContributionResult {
  readonly netSellingPrice: Money;
  readonly totalVariableCost: Money;
  readonly contributionMargin: Money;
  /** contributionMargin / netSellingPrice, -inf..1 */
  readonly contributionMarginRatio: number;
  readonly grossMargin: Money;
  readonly grossMarginRatio: number;
  readonly byComponent: ReadonlyArray<{ kind: VariableCostKind; amount: Money; basis: CostBasis }>;
  readonly groundedRatio: number;
  readonly assumedComponents: readonly VariableCostKind[];
  /** Max CAC that still leaves the business break-even on the first order. */
  readonly breakEvenCac: Money;
}

/**
 * Contribution margin per order.
 *
 * Gross margin excludes acquisition cost; contribution margin includes it.
 * The CEO agent optimises the second number — a product that looks great at
 * 70% gross margin and loses money after a $48 CAC is not a business.
 */
export function computeContribution(input: ContributionInput): ContributionResult {
  const currency = input.currency;
  const price = Money.of(input.netSellingPrice, currency, MODELLING_SCALE);
  const byComponent = input.components.map((c) => ({
    kind: c.kind,
    amount: Money.of(c.amount, currency, MODELLING_SCALE),
    basis: c.basis,
  }));

  const totalVariableCost = byComponent.reduce(
    (acc, c) => acc.add(c.amount),
    Money.zero(currency, MODELLING_SCALE),
  );
  const contributionMargin = price.subtract(totalVariableCost);

  // Gross margin: everything except acquisition and variable support.
  const grossExcluded = new Set<VariableCostKind>(['ad_cac', 'variable_support_cost']);
  const cogsLike = byComponent
    .filter((c) => !grossExcluded.has(c.kind))
    .reduce((acc, c) => acc.add(c.amount), Money.zero(currency, MODELLING_SCALE));
  const grossMargin = price.subtract(cogsLike);

  const groundedTotal = byComponent
    .filter((c) => GROUNDED_BASES.has(c.basis))
    .reduce((acc, c) => acc.add(c.amount), Money.zero(currency, MODELLING_SCALE));

  const cac = byComponent.find((c) => c.kind === 'ad_cac')?.amount ?? Money.zero(currency, MODELLING_SCALE);
  const breakEvenCac = contributionMargin.add(cac);

  return {
    netSellingPrice: price,
    totalVariableCost,
    contributionMargin,
    contributionMarginRatio: price.isZero ? 0 : Money.ratio(contributionMargin, price),
    grossMargin,
    grossMarginRatio: price.isZero ? 0 : Money.ratio(grossMargin, price),
    byComponent,
    groundedRatio: totalVariableCost.isZero ? 0 : Money.ratio(groundedTotal, totalVariableCost),
    assumedComponents: byComponent.filter((c) => !GROUNDED_BASES.has(c.basis)).map((c) => c.kind),
    breakEvenCac,
  };
}

/**
 * Given a target contribution-margin ratio, the price that achieves it.
 * Used by the pricing agent to work backwards from a required margin instead of
 * marking up cost by a habit multiple.
 */
export function priceForTargetMargin(
  fixedVariableCosts: Money,
  /** Costs that scale with price, e.g. payment fees at 2.9% + 30c. */
  priceLinkedRateBps: number,
  priceLinkedFlat: Money,
  targetMarginRatio: number,
): Money {
  if (targetMarginRatio >= 1) {
    throw new Error('Target contribution margin ratio must be below 1');
  }
  // price - (fixed + flat) - price*rate = price*target
  //   => price * (1 - rate - target) = fixed + flat
  const denominator = 1 - priceLinkedRateBps / 10_000 - targetMarginRatio;
  if (denominator <= 0) {
    throw new Error('Target margin is unreachable at the given fee rate');
  }
  const numerator = fixedVariableCosts.add(priceLinkedFlat);
  const scaled = Math.round(1e9 / denominator);
  return numerator.multiplyByRatio(BigInt(scaled), 1_000_000_000n).rescale(2, 'ceil');
}
