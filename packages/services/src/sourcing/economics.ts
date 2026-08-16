/**
 * Landed-cost and contribution models.
 *
 * Every line carries a `CostBasis`. Manufacturing comes from a real quote tier
 * or the build refuses. Freight is tagged `assumption` with note
 * "freight API not quoted" until a freight API actually returns a rate — never
 * presented as a supplier quote. Incomplete economics (no selling price) or a
 * failed margin gate refuse the build rather than returning a model that looks
 * like a pass.
 *
 * A digital line has no supplier and therefore no quote, but it still has real
 * marginal cost, and `buildDigital` models it under exactly the same rules:
 * inference comes from inference actually charged to this company
 * (`observed_actual`), per-unit hosting is tagged `assumption` because no
 * measured per-unit rate exists, and the payment fee is Stripe's published
 * schedule (`contract_rate`). Nothing is promoted to a grounded basis it did
 * not earn, and a digital model with no measured inference refuses to build
 * rather than guessing a compute cost.
 */

import {
  DEFAULT_SELECTION_GATES,
  GROUNDED_BASES,
  Incoterm,
  MODELLING_SCALE,
  Money,
  NotFoundError,
  PriceTier,
  ValidationError,
  computeContribution,
  computeLandedCost,
  unitPriceForQuantity,
  type CostComponent,
  type CostComponentKind,
  type ContributionResult,
  type LandedCostResult,
  type SupplierQuote,
} from '@foundry/core';
import { type LandedCostRow, type QuoteRow } from '@foundry/db';
import { getLogger } from '@foundry/obs';
import type { ServiceDeps } from '../deps.js';

/**
 * Stripe's published US commercial card-not-present blended rate
 * (2.9% + $0.30). This is a contractual schedule, not a supplier quote and
 * not a guess. Applied only to USD prices; other currencies are omitted
 * unless the caller passes an explicit assumed payment-fee component via
 * contribution (we do not invent a local acquirer rate).
 */
export const STRIPE_US_CARD_FEE_SCHEDULE = {
  rate: '0.029',
  flat: '0.30',
  sourceRef: 'stripe_us_card_published_schedule',
  basis: 'contract_rate' as const,
  note: '2.9% + $0.30 — Stripe published US card-not-present fee schedule',
};

/**
 * Window over which inference already charged to the company is measured.
 *
 * 30 days is long enough that a handful of runs produce a stable mean and short
 * enough that a model or prompt change from last quarter is not still setting
 * today's unit cost. The number is a measurement window, not a cost estimate —
 * nothing is invented if the window turns out to be empty; the build refuses.
 */
export const DIGITAL_INFERENCE_WINDOW_DAYS = 30;

/**
 * Per-unit hosting/bandwidth on a digital line.
 *
 * Render bills per service per month, not per download, and nothing in this
 * system measures bytes served per order — so there is no honest per-unit rate
 * to state. The component is carried at zero and tagged `assumption` for the
 * same reason freight is on the physical path: omitting it entirely would make
 * the model look fully grounded on a cost nobody has actually measured.
 */
export const DIGITAL_HOSTING_UNMEASURED_NOTE =
  'no measured per-unit hosting or bandwidth rate; the hosting plan is billed per month, not per delivered unit';

export interface EconomicsGateInput {
  readonly groundedRatio: number;
  readonly contributionMarginRatio: number | null;
  readonly sellingPricePresent: boolean;
}

export interface EconomicsGateResult {
  readonly passesMarginGate: boolean;
  readonly complete: boolean;
  readonly reason: string;
}

/**
 * Launch gate: grounded_ratio >= 0.4 AND contribution_margin_ratio >= 0.25.
 * A missing selling price is incomplete economics, not a failed model.
 */
export function evaluateEconomicsGate(input: EconomicsGateInput): EconomicsGateResult {
  if (!input.sellingPricePresent || input.contributionMarginRatio === null) {
    return {
      passesMarginGate: false,
      complete: false,
      reason:
        'Economics are incomplete: selling price was not provided, so contribution margin cannot be modelled.',
    };
  }
  const groundedOk = input.groundedRatio >= DEFAULT_SELECTION_GATES.minGroundedWeightRatio;
  const marginOk = input.contributionMarginRatio >= DEFAULT_SELECTION_GATES.minContributionMarginRatio;
  if (groundedOk && marginOk) {
    return {
      passesMarginGate: true,
      complete: true,
      reason: 'Grounded ratio and contribution margin both meet the gate.',
    };
  }
  if (!groundedOk) {
    return {
      passesMarginGate: false,
      complete: true,
      reason: `Grounded ratio ${input.groundedRatio} < required ${DEFAULT_SELECTION_GATES.minGroundedWeightRatio}.`,
    };
  }
  return {
    passesMarginGate: false,
    complete: true,
    reason: `Contribution margin ${input.contributionMarginRatio} < required ${DEFAULT_SELECTION_GATES.minContributionMarginRatio}.`,
  };
}

/**
 * Unit contribution from the latest landed-cost model and an active SKU (or the
 * selected opportunity's assumed price). Returns null when the inputs do not
 * exist — never 0 as a stand-in, because a zero contribution is not modelled.
 */
export async function resolveUnitContributionMinor(
  deps: ServiceDeps,
  companyId: string,
): Promise<number | null> {
  const company = await deps.repos.companies.byId(companyId);
  const products = await deps.repos.commerce.products.listActive(companyId);
  const sku =
    products.find((p) => p.opportunity_id && p.opportunity_id === company.selected_opportunity_id) ??
    products.find((p) => p.landed_cost_model_id) ??
    products[0];

  let landed: LandedCostRow | undefined;
  if (sku?.landed_cost_model_id) {
    try {
      landed = await deps.repos.sourcing.landedCosts.byId(sku.landed_cost_model_id);
    } catch (error) {
      if (!(error instanceof NotFoundError)) throw error;
    }
  }
  if (!landed && company.selected_opportunity_id) {
    landed = await deps.repos.sourcing.landedCosts.latestForOpportunity(company.selected_opportunity_id);
  }
  if (!landed) {
    landed = (await deps.repos.sourcing.landedCosts.listForCompany(companyId, 1))[0];
  }
  if (!landed) return null;

  let sellingPriceMinor = sku?.price_minor ?? 0;
  let currency = sku?.currency ?? landed.currency;
  if (sellingPriceMinor <= 0 && company.selected_opportunity_id) {
    const opportunity = await deps.repos.research.opportunities.byId(company.selected_opportunity_id);
    sellingPriceMinor = opportunity.assumed_selling_price_cents ?? 0;
    currency = opportunity.currency || currency;
  }
  if (sellingPriceMinor <= 0) return null;
  if (currency !== landed.currency) return null;

  const contribution = contributionFromLandedRow(landed, sellingPriceMinor);
  if (!contribution || !contribution.contributionMargin.isPositive) return null;
  return contribution.contributionMargin.toProviderMinorUnits();
}

/** Contribution from a persisted landed-cost row and a stated selling price. Never invents a quote. */
export function contributionFromLandedRow(
  landed: Pick<LandedCostRow, 'landed_unit_cost' | 'currency' | 'quote_id'> & {
    readonly assumed_components?: readonly string[] | null;
  },
  sellingPriceMinor: number,
): ContributionResult | null {
  if (sellingPriceMinor <= 0) return null;
  const price = Money.fromMinor(sellingPriceMinor, landed.currency).rescale(MODELLING_SCALE);
  const assumed = landed.assumed_components ?? [];
  const components: {
    kind: 'landed_unit_cost' | 'payment_processing_fee';
    amount: string;
    basis: CostComponent['basis'];
    sourceRef: string | null;
    note: string | null;
  }[] = [
    {
      kind: 'landed_unit_cost',
      amount: landed.landed_unit_cost,
      basis: assumed.length > 0 ? 'assumption' : 'supplier_quote',
      sourceRef: landed.quote_id,
      note: assumed.length > 0 ? `includes assumed: ${assumed.join(', ')}` : null,
    },
  ];
  if (landed.currency === 'USD') {
    const percent = price.multiplyByDecimal(STRIPE_US_CARD_FEE_SCHEDULE.rate);
    const flat = Money.of(STRIPE_US_CARD_FEE_SCHEDULE.flat, 'USD', MODELLING_SCALE);
    components.push({
      kind: 'payment_processing_fee',
      amount: percent.add(flat).rescale(MODELLING_SCALE).toString(),
      basis: STRIPE_US_CARD_FEE_SCHEDULE.basis,
      sourceRef: STRIPE_US_CARD_FEE_SCHEDULE.sourceRef,
      note: STRIPE_US_CARD_FEE_SCHEDULE.note,
    });
  }
  return computeContribution({
    netSellingPrice: price.toString(),
    currency: landed.currency,
    components,
  });
}

export interface LandedCostBuildInput {
  readonly companyId: string;
  readonly opportunityId: string;
  readonly quoteId: string;
  readonly orderQuantity: number;
  readonly destinationCountry: string;
  /** Stated selling price in minor units. Absent means contribution cannot be modelled. */
  readonly sellingPriceMinor?: number | null;
  /** Caller-supplied assumptions. Must already be tagged `assumption`. */
  readonly assumedComponents?: readonly CostComponent[];
}

export interface DigitalUnitCostBuildInput {
  readonly companyId: string;
  readonly opportunityId: string;
  /** Base currency of the business. The fee schedule only applies to USD. */
  readonly currency: string;
  /** Where the buyer is, for the record. No duty is computed — nothing crosses a border. */
  readonly destinationCountry: string;
  /** Stated selling price in minor units. Absent means contribution cannot be modelled. */
  readonly sellingPriceMinor?: number | null;
  /** Caller-supplied assumptions. Must already be tagged non-quoted. */
  readonly assumedComponents?: readonly CostComponent[];
  /** Measurement window for recorded inference spend. */
  readonly inferenceWindowDays?: number;
}

export interface LandedCostBuildResult {
  readonly landedCost: LandedCostRow;
  readonly landed: LandedCostResult;
  readonly contribution: ContributionResult | null;
  readonly groundedRatio: number;
  readonly contributionMarginRatio: number | null;
  readonly passesMarginGate: boolean;
  readonly complete: boolean;
  readonly assumedComponents: readonly CostComponentKind[];
  readonly notes: readonly string[];
}

export class LandedCostService {
  constructor(private readonly deps: ServiceDeps) {}

  /**
   * Modelled unit contribution in minor units, or null when economics are unknown.
   * Callers must not substitute 0 — that collapses the arm-kill threshold to 3¢.
   */
  async unitContributionMinor(companyId: string): Promise<number | null> {
    return resolveUnitContributionMinor(this.deps, companyId);
  }

  async buildFromQuote(input: LandedCostBuildInput): Promise<LandedCostBuildResult> {
    return this.build(input);
  }

  /**
   * Unit economics for a digital product line.
   *
   * There is no supplier, no RFQ and no quote — so this does not go looking for
   * one, and it does not manufacture one either. The cost of delivering one more
   * unit is built from two lines and nothing else:
   *
   *   - `inference_compute`, from inference this company has actually been
   *     charged (`agent_runs.cost_minor_usd`). That is `observed_actual` in the
   *     sense the basis enum already means it — measured from our own history,
   *     the same footing as an observed return rate on the physical path. The
   *     note states exactly what was measured and over what window, including
   *     the one modelling step (one delivered unit is modelled as one agent
   *     run), so nobody reads the number as a per-unit meter reading.
   *   - `hosting_delivery`, carried at zero and tagged `assumption`, because no
   *     per-unit hosting rate is measured anywhere in this system.
   *
   * With no priced runs on record there is no measurement, so this refuses
   * rather than estimating compute — an invented COGS is exactly the failure
   * mode the basis enum exists to prevent. Payment processing is added at the
   * contribution layer from Stripe's published schedule; Dodo is not used, and
   * a digital line routed through Stripe direct needs no MoR assumption here.
   */
  async buildDigital(input: DigitalUnitCostBuildInput): Promise<LandedCostBuildResult> {
    const log = getLogger();
    const currency = input.currency.toUpperCase();
    const windowDays = input.inferenceWindowDays ?? DIGITAL_INFERENCE_WINDOW_DAYS;
    const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);

    const observed = await this.deps.repos.agents.runs.observedInferenceCost(input.companyId, since);
    if (observed.pricedRuns === 0 || observed.costMinorUsd <= 0) {
      throw new ValidationError(
        `No inference cost has been recorded for this company in the last ${windowDays} days, so the ` +
          `marginal cost of delivering a digital unit cannot be measured. Refusing to estimate one.`,
        { companyId: input.companyId, windowDays },
      );
    }
    if (currency !== 'USD') {
      // agent_runs.cost_minor_usd is USD by construction. Converting it without
      // a real FX rate would state a cost in a currency nobody quoted.
      throw new ValidationError(
        `Recorded inference cost is denominated in USD; modelling a ${currency} digital unit cost would ` +
          `require an FX rate this system does not hold. Refusing to convert.`,
        { companyId: input.companyId, currency },
      );
    }

    // Rescale before dividing: at transactional scale 219¢ over 6 runs rounds to
    // 36¢, quietly discarding half a cent per unit. Modelling scale keeps the
    // 36.5¢ the runs actually cost.
    const perUnitInference = Money.fromMinor(observed.costMinorUsd, 'USD')
      .rescale(MODELLING_SCALE)
      .divideBy(observed.pricedRuns);

    const components: CostComponent[] = [
      {
        kind: 'inference_compute',
        amount: perUnitInference.toString(),
        currency: 'USD',
        basis: 'observed_actual',
        sourceRef: 'agent_runs.cost_minor_usd',
        note:
          `mean of ${observed.costMinorUsd} minor USD actually charged across ${observed.pricedRuns} priced ` +
          `agent runs since ${since.toISOString()}; one delivered unit is modelled as one agent run`,
      },
      {
        kind: 'hosting_delivery',
        amount: '0.000000',
        currency: 'USD',
        basis: 'assumption',
        sourceRef: null,
        note: DIGITAL_HOSTING_UNMEASURED_NOTE,
      },
    ];

    const adopted = adoptAssumedComponents(input.assumedComponents ?? [], null);
    components.push(...adopted);
    assertHonestCostComponents(components);

    const landed = computeLandedCost({
      id: 'cost_draft',
      companyId: input.companyId,
      opportunityId: input.opportunityId,
      quoteId: null,
      // One unit. There is no MOQ and no production run to allocate setup over,
      // so a larger quantity would only scale both sides of the same number.
      orderQuantity: 1,
      currency: 'USD',
      components,
      destinationCountry: input.destinationCountry,
      incoterm: 'not_applicable',
      hsCode: null,
      computedAt: new Date().toISOString(),
    });

    const sellingPricePresent = input.sellingPriceMinor != null && input.sellingPriceMinor > 0;
    const contribution = sellingPricePresent
      ? contributionFrom(landed, input.sellingPriceMinor as number, 'USD', 'agent_runs.cost_minor_usd')
      : null;
    const gate = evaluateEconomicsGate({
      groundedRatio: landed.groundedRatio,
      contributionMarginRatio: contribution?.contributionMarginRatio ?? null,
      sellingPricePresent,
    });

    if (!gate.complete || !gate.passesMarginGate) {
      throw new ValidationError(gate.reason, {
        opportunityId: input.opportunityId,
        productLine: 'digital',
        complete: gate.complete,
        passesMarginGate: gate.passesMarginGate,
      });
    }

    const persisted = await this.deps.repos.sourcing.landedCosts.write({
      companyId: input.companyId,
      opportunityId: input.opportunityId,
      quoteId: null,
      orderQuantity: 1,
      currency: 'USD',
      components,
      destinationCountry: input.destinationCountry,
      incoterm: 'not_applicable',
      hsCode: null,
    });

    const notes = [
      `inference measured from ${observed.pricedRuns} priced agent runs over the last ${windowDays} days`,
      `hosting per unit is assumed, not measured: ${DIGITAL_HOSTING_UNMEASURED_NOTE}`,
      'no supplier quote exists or is required: a digital product has no supplier',
    ];

    log.info(
      {
        opportunityId: input.opportunityId,
        productLine: 'digital',
        groundedRatio: landed.groundedRatio,
        passesMarginGate: gate.passesMarginGate,
        assumedComponents: landed.assumedComponents,
      },
      'digital unit-cost model built',
    );

    return {
      landedCost: persisted,
      landed,
      contribution,
      groundedRatio: landed.groundedRatio,
      contributionMarginRatio: contribution?.contributionMarginRatio ?? null,
      passesMarginGate: gate.passesMarginGate,
      complete: gate.complete,
      assumedComponents: landed.assumedComponents,
      notes,
    };
  }

  async build(input: LandedCostBuildInput): Promise<LandedCostBuildResult> {
    const log = getLogger();
    const quoteRow = await this.deps.repos.sourcing.quotes.byId(input.quoteId);
    const quote = quoteFromRow(quoteRow);

    const unit = unitPriceForQuantity(quote, input.orderQuantity);
    if (unit == null) {
      throw new ValidationError(
        `Order quantity ${input.orderQuantity} is outside the quoted price tiers (MOQ ${quote.moq}). ` +
          `Refusing to invent a unit manufacturing cost.`,
        { quoteId: input.quoteId, orderQuantity: input.orderQuantity },
      );
    }

    const components: CostComponent[] = [
      {
        kind: 'unit_manufacturing',
        amount: unit.rescale(MODELLING_SCALE).toString(),
        currency: unit.currency,
        basis: 'supplier_quote',
        sourceRef: quote.id,
        note: null,
      },
    ];

    if (quote.customisationCostPerUnitMinor > 0) {
      components.push(
        perUnitFromMinor('customisation', quote.customisationCostPerUnitMinor, quote.currency, quote.id),
      );
    }
    if (quote.packagingCostPerUnitMinor > 0) {
      components.push(perUnitFromMinor('packaging', quote.packagingCostPerUnitMinor, quote.currency, quote.id));
    }
    if (quote.toolingSetupCostMinor > 0) {
      const allocated = Money.fromMinor(quote.toolingSetupCostMinor, quote.currency)
        .divideBy(input.orderQuantity)
        .rescale(MODELLING_SCALE);
      components.push({
        kind: 'tooling_setup_allocated',
        amount: allocated.toString(),
        currency: quote.currency,
        basis: 'supplier_quote',
        sourceRef: quote.id,
        note: `${quote.toolingSetupCostMinor} minor / ${input.orderQuantity} units`,
      });
    }

    const adoptedAssumed = adoptAssumedComponents(input.assumedComponents ?? [], quote.id);
    const assumedKinds = new Set(adoptedAssumed.map((c) => c.kind));
    components.push(...adoptedAssumed);

    const notes: string[] = [];
    if (
      !assumedKinds.has('international_freight') &&
      !assumedKinds.has('origin_freight') &&
      !assumedKinds.has('destination_freight')
    ) {
      // Amount 0 is not a carrier rate. The line exists so freight is tagged
      // `assumption` rather than silently omitted (which would inflate grounded_ratio).
      components.push({
        kind: 'international_freight',
        amount: '0.000000',
        currency: quote.currency,
        basis: 'assumption',
        sourceRef: null,
        note: 'freight API not quoted',
      });
      notes.push('freight API not quoted; no freight amount is estimated.');
    }
    if (!assumedKinds.has('duties_tariffs')) {
      notes.push('Duties/tariffs omitted: no HS-confirmed rate and no assumed duty was supplied.');
    }

    assertHonestCostComponents(components);

    const landed = computeLandedCost({
      id: 'cost_draft',
      companyId: input.companyId,
      opportunityId: input.opportunityId,
      quoteId: quote.id,
      orderQuantity: input.orderQuantity,
      currency: quote.currency,
      components,
      destinationCountry: input.destinationCountry,
      incoterm: quote.incoterm,
      hsCode: null,
      computedAt: new Date().toISOString(),
    });

    const sellingPricePresent = input.sellingPriceMinor != null && input.sellingPriceMinor > 0;
    const contribution = sellingPricePresent
      ? contributionFrom(landed, input.sellingPriceMinor as number, quote.currency, input.quoteId)
      : null;
    const gate = evaluateEconomicsGate({
      groundedRatio: landed.groundedRatio,
      contributionMarginRatio: contribution?.contributionMarginRatio ?? null,
      sellingPricePresent,
    });

    if (!gate.complete || !gate.passesMarginGate) {
      throw new ValidationError(gate.reason, {
        quoteId: quote.id,
        complete: gate.complete,
        passesMarginGate: gate.passesMarginGate,
      });
    }

    const persisted = await this.deps.repos.sourcing.landedCosts.write({
      companyId: input.companyId,
      opportunityId: input.opportunityId,
      quoteId: quote.id,
      orderQuantity: input.orderQuantity,
      currency: quote.currency,
      components,
      destinationCountry: input.destinationCountry,
      incoterm: quote.incoterm,
      hsCode: null,
    });

    log.info(
      {
        quoteId: quote.id,
        groundedRatio: landed.groundedRatio,
        passesMarginGate: gate.passesMarginGate,
        complete: gate.complete,
        assumedComponents: landed.assumedComponents,
      },
      'landed-cost model built',
    );

    return {
      landedCost: persisted,
      landed,
      contribution,
      groundedRatio: landed.groundedRatio,
      contributionMarginRatio: contribution?.contributionMarginRatio ?? null,
      passesMarginGate: gate.passesMarginGate,
      complete: gate.complete,
      assumedComponents: landed.assumedComponents,
      notes,
    };
  }

}

/**
 * Contribution from a freshly computed landed cost and a stated selling price.
 *
 * Shared by the quoted (physical) and measured (digital) paths so both carry
 * the same payment-fee treatment and the same basis demotion: if any landed
 * component was assumed, the whole landed line is `assumption` at the
 * contribution layer. `sourceRef` is the quote id on a physical model and the
 * measurement source on a digital one; it is never invented.
 */
function contributionFrom(
  landed: LandedCostResult,
  sellingPriceMinor: number,
  currency: string,
  sourceRef: string | null,
): ContributionResult | null {
  if (sellingPriceMinor <= 0) return null;

  const netSellingPrice = Money.fromMinor(sellingPriceMinor, currency).rescale(MODELLING_SCALE);
  const components: {
    kind: 'landed_unit_cost' | 'payment_processing_fee';
    amount: string;
    basis: CostComponent['basis'];
    sourceRef: string | null;
    note: string | null;
  }[] = [
    {
      kind: 'landed_unit_cost',
      amount: landed.landedUnitCost.toString(),
      basis: landedCostContributionBasis(landed),
      sourceRef,
      note: landed.assumedComponents.length > 0 ? `includes assumed: ${landed.assumedComponents.join(', ')}` : null,
    },
  ];

  if (netSellingPrice.currency === 'USD') {
    const percent = netSellingPrice.multiplyByDecimal(STRIPE_US_CARD_FEE_SCHEDULE.rate);
    const flat = Money.of(STRIPE_US_CARD_FEE_SCHEDULE.flat, 'USD', MODELLING_SCALE);
    const fee = percent.add(flat).rescale(MODELLING_SCALE);
    components.push({
      kind: 'payment_processing_fee',
      amount: fee.toString(),
      basis: STRIPE_US_CARD_FEE_SCHEDULE.basis,
      sourceRef: STRIPE_US_CARD_FEE_SCHEDULE.sourceRef,
      note: STRIPE_US_CARD_FEE_SCHEDULE.note,
    });
  }

  return computeContribution({
    netSellingPrice: netSellingPrice.toString(),
    currency: netSellingPrice.currency,
    components,
  });
}

function perUnitFromMinor(
  kind: 'customisation' | 'packaging',
  minor: number,
  currency: string,
  quoteId: string,
): CostComponent {
  return {
    kind,
    amount: Money.fromMinor(minor, currency).rescale(MODELLING_SCALE).toString(),
    currency,
    basis: 'supplier_quote',
    sourceRef: quoteId,
    note: null,
  };
}

function adoptAssumedComponents(caller: readonly CostComponent[], quoteId: string | null): CostComponent[] {
  const out: CostComponent[] = [];
  for (const component of caller) {
    if (component.kind === 'unit_manufacturing') {
      throw new ValidationError(
        'unit_manufacturing comes from the supplier quote via unitPriceForQuantity; it cannot be supplied as an assumedComponent.',
        { quoteId },
      );
    }
    if (component.basis === 'supplier_quote' || component.basis === 'provider_api') {
      throw new ValidationError(
        `assumedComponents cannot carry basis "${component.basis}" for ${component.kind}. Tag it assumption, or obtain a real quote/API rate.`,
      );
    }
    if (component.basis !== 'assumption' && component.basis !== 'contract_rate' && component.basis !== 'observed_actual') {
      throw new ValidationError(`Unexpected cost basis ${component.basis} on assumed component ${component.kind}`);
    }
    out.push({ ...component, basis: component.basis === 'assumption' ? 'assumption' : component.basis });
  }
  return out;
}

/**
 * Unit manufacturing tagged `supplier_quote` must cite a quote. An assumed
 * unit cost stays an assumption — promoting it would invent a supplier quote.
 */
export function assertHonestCostComponents(components: readonly CostComponent[]): void {
  for (const component of components) {
    if (component.kind === 'unit_manufacturing' && component.basis === 'supplier_quote' && !component.sourceRef) {
      throw new ValidationError(
        'Unit manufacturing tagged supplier_quote must cite a quote id. An assumed unit cost is not a supplier quote.',
      );
    }
  }
}

/**
 * Refuses to relabel an assumed (or otherwise unquoted) cost as a supplier quote.
 */
export function asSupplierQuoteComponent(component: CostComponent, quoteId: string): CostComponent {
  if (component.basis !== 'supplier_quote') {
    throw new ValidationError(
      `Cannot treat a ${component.basis} ${component.kind} cost as supplier_quote. The supplier did not quote this figure.`,
    );
  }
  if (component.sourceRef !== quoteId) {
    throw new ValidationError('supplier_quote components must cite the quote they came from.');
  }
  return component;
}

function landedCostContributionBasis(landed: LandedCostResult): CostComponent['basis'] {
  if (landed.assumedComponents.length > 0) return 'assumption';
  const bases = new Set(landed.byComponent.map((c) => c.basis));
  if (bases.size === 1 && bases.has('supplier_quote')) return 'supplier_quote';
  if ([...bases].every((b) => GROUNDED_BASES.has(b))) return 'provider_api';
  return 'assumption';
}

function quoteFromRow(row: QuoteRow): SupplierQuote {
  const tiers = row.price_tiers.map((tier) => {
    const parsed = PriceTier.safeParse(tier);
    if (!parsed.success) {
      throw new ValidationError('Stored quote price tier is not a stated PriceTier shape; refusing to guess.', {
        quoteId: row.id,
        issues: parsed.error.issues.map((i) => i.message),
      });
    }
    return parsed.data;
  });
  if (tiers.length === 0) {
    throw new ValidationError('Stored quote has no price tiers.', { quoteId: row.id });
  }
  const incoterm = Incoterm.parse(row.incoterm);
  return {
    id: row.id,
    companyId: row.company_id,
    rfqId: row.rfq_id,
    supplierId: row.supplier_id,
    receivedVia: row.received_via as SupplierQuote['receivedVia'],
    rawResponseRef: row.raw_response_ref,
    receivedAt: row.received_at.toISOString(),
    currency: row.currency,
    priceTiers: tiers,
    moq: row.moq,
    sampleCostMinor: row.sample_cost_minor,
    sampleLeadTimeDays: row.sample_lead_time_days,
    toolingSetupCostMinor: row.tooling_setup_cost_minor,
    customisationCostPerUnitMinor: row.customisation_cost_per_unit_minor,
    packagingCostPerUnitMinor: row.packaging_cost_per_unit_minor,
    productionLeadTimeDays: row.production_lead_time_days,
    incoterm,
    originPort: row.origin_port,
    paymentTerms: row.payment_terms,
    validUntil: row.valid_until ? row.valid_until.toISOString() : null,
    notes: row.notes,
    verifiedByEngagementId: row.verified_by_engagement_id,
    createdAt: row.received_at.toISOString(),
  };
}
