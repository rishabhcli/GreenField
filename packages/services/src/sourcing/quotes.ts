/**
 * Supplier quote intake.
 *
 * A quote is a thing a supplier said. This service copies stated fields and
 * leaves the rest null. Polling a capability that is down, or an API that
 * returns nothing, is not a quote — it is waiting.
 */

import {
  Incoterm,
  PriceTier,
  ValidationError,
  type Incoterm as IncotermType,
  type PriceTier as PriceTierType,
} from '@foundry/core';
import type { QuoteRow } from '@foundry/db';
import { getLogger } from '@foundry/obs';
import { optionalCapability, type ServiceDeps } from '../deps.js';

const RECEIVED_VIA = [
  'provider_api',
  'email_inbound',
  'browser_session',
  'human_expert_relay',
  'manual_entry',
] as const;
export type QuoteReceivedVia = (typeof RECEIVED_VIA)[number];

export interface RecordQuoteInput {
  readonly rfqId: string;
  readonly payload: unknown;
}

export interface RecordedQuote {
  readonly quote: QuoteRow;
  readonly missingFields: readonly string[];
}

export type PollQuoteResult =
  | { readonly waiting: true }
  | { readonly waiting: false; readonly quote: QuoteRow };

interface QuoteRetrieveAdapter {
  readonly providerId?: string;
  supports?(method: string): boolean;
  getQuote?(input: { readonly rfqExternalRef: string }): Promise<unknown>;
  retrieveQuotes?(query: { readonly rfqExternalRef?: string; readonly rfqId?: string }): Promise<unknown>;
}

export class SourcingQuoteService {
  constructor(private readonly deps: ServiceDeps) {}

  /**
   * Persists only fields the supplier/provider actually stated.
   * Required columns (currency, tiers, MOQ, lead time, incoterm) must be
   * present — we refuse rather than fill them in.
   */
  async recordFromProvider(input: RecordQuoteInput): Promise<RecordedQuote> {
    const rfq = await this.deps.repos.sourcing.rfqs.byId(input.rfqId);
    const parsed = parseStatedQuote(input.payload);
    if (parsed.missingRequired.length > 0) {
      throw new ValidationError(
        `Supplier quote is missing required stated fields (${parsed.missingRequired.join(', ')}). ` +
          `Refusing to invent them.`,
        { rfqId: input.rfqId, missing: parsed.missingRequired },
      );
    }

    const quote = await this.deps.repos.sourcing.quotes.create({
      companyId: rfq.company_id,
      rfqId: rfq.id,
      supplierId: rfq.supplier_id,
      receivedVia: parsed.receivedVia,
      rawResponseRef: parsed.rawResponseRef,
      receivedAt: parsed.receivedAt,
      currency: parsed.currency!,
      priceTiers: parsed.priceTiers,
      moq: parsed.moq!,
      productionLeadTimeDays: parsed.productionLeadTimeDays!,
      incoterm: parsed.incoterm!,
      sampleCostMinor: parsed.sampleCostMinor,
      sampleLeadTimeDays: parsed.sampleLeadTimeDays,
      toolingSetupCostMinor: parsed.toolingSetupCostMinor ?? undefined,
      customisationCostPerUnitMinor: parsed.customisationCostPerUnitMinor ?? undefined,
      packagingCostPerUnitMinor: parsed.packagingCostPerUnitMinor ?? undefined,
      originPort: parsed.originPort,
      paymentTerms: parsed.paymentTerms,
      validUntil: parsed.validUntil,
      notes: parsed.notes,
    });

    await this.deps.repos.sourcing.rfqs.markResponded(rfq.id, 'quoted');
    getLogger().info({ rfqId: rfq.id, quoteId: quote.id, receivedVia: parsed.receivedVia }, 'supplier quote recorded');
    return { quote, missingFields: parsed.missingOptional };
  }

  /**
   * Fetches a quote only when `sourcing.quote_retrieve` is usable.
   * An empty fetch is waiting, not a zero-dollar quote.
   */
  async poll(rfqId: string): Promise<PollQuoteResult> {
    const rfq = await this.deps.repos.sourcing.rfqs.byId(rfqId);
    const adapter = optionalCapability<QuoteRetrieveAdapter>(this.deps, 'sourcing.quote_retrieve');
    if (!adapter || !implementsQuoteRetrieve(adapter)) {
      return { waiting: true };
    }

    const ref = rfq.external_message_id;
    if (!ref) return { waiting: true };

    let fetched: unknown;
    try {
      fetched =
        typeof adapter.getQuote === 'function'
          ? await adapter.getQuote({ rfqExternalRef: ref })
          : await adapter.retrieveQuotes!({ rfqExternalRef: ref, rfqId: rfq.id });
    } catch {
      // A failed retrieve is not a quote. Stay in waiting rather than
      // synthesising a decline or a zero price.
      return { waiting: true };
    }

    if (isEmptyFetch(fetched)) return { waiting: true };

    const parsed = parseStatedQuote(fetched);
    if (parsed.missingRequired.length > 0) return { waiting: true };

    const recorded = await this.recordFromProvider({
      rfqId: rfq.id,
      payload: withReceivedVia(fetched, 'provider_api'),
    });
    return { waiting: false, quote: recorded.quote };
  }
}

function implementsQuoteRetrieve(adapter: QuoteRetrieveAdapter): boolean {
  const method = typeof adapter.getQuote === 'function' ? 'getQuote' : typeof adapter.retrieveQuotes === 'function' ? 'retrieveQuotes' : null;
  if (!method) return false;
  if (typeof adapter.supports === 'function') {
    if (method === 'getQuote' && !adapter.supports('getQuote')) return false;
    if (method === 'retrieveQuotes' && !adapter.supports('retrieveQuotes') && !adapter.supports('getQuote')) return false;
  }
  return true;
}

function isEmptyFetch(fetched: unknown): boolean {
  if (fetched == null) return true;
  if (Array.isArray(fetched)) return fetched.length === 0;
  if (typeof fetched === 'object') {
    const rec = fetched as Record<string, unknown>;
    if (Array.isArray(rec.quotes) && rec.quotes.length === 0) return true;
    if (Array.isArray(rec.items) && rec.items.length === 0) return true;
    return Object.keys(rec).length === 0;
  }
  return true;
}

function withReceivedVia(payload: unknown, fallback: QuoteReceivedVia): unknown {
  if (payload !== null && typeof payload === 'object' && !Array.isArray(payload)) {
    return { receivedVia: fallback, ...(payload as Record<string, unknown>) };
  }
  return payload;
}

interface ParsedQuote {
  readonly receivedVia: QuoteReceivedVia;
  readonly rawResponseRef: string | null;
  readonly receivedAt?: Date;
  readonly currency: string | null;
  readonly priceTiers: PriceTierType[];
  readonly moq: number | null;
  readonly productionLeadTimeDays: number | null;
  readonly incoterm: IncotermType | null;
  readonly sampleCostMinor: number | null;
  readonly sampleLeadTimeDays: number | null;
  readonly toolingSetupCostMinor: number | null;
  readonly customisationCostPerUnitMinor: number | null;
  readonly packagingCostPerUnitMinor: number | null;
  readonly originPort: string | null;
  readonly paymentTerms: string | null;
  readonly validUntil: Date | null;
  readonly notes: string | null;
  readonly missingRequired: readonly string[];
  readonly missingOptional: readonly string[];
}

function parseStatedQuote(payload: unknown): ParsedQuote {
  const rec = unwrapQuote(payload);

  const currency = statedCurrency(rec.currency);
  const priceTiers = parseTiers(rec.priceTiers ?? rec.price_tiers, currency);
  const moq = statedPositiveInt(rec.moq);
  const productionLeadTimeDays = statedPositiveInt(
    rec.productionLeadTimeDays ?? rec.production_lead_time_days ?? rec.leadTimeDays,
  );
  const incotermParsed = Incoterm.safeParse(rec.incoterm);
  const incoterm = incotermParsed.success ? incotermParsed.data : null;

  const missingRequired: string[] = [];
  if (!currency) missingRequired.push('currency');
  if (priceTiers.length === 0) missingRequired.push('priceTiers');
  if (moq == null) missingRequired.push('moq');
  if (productionLeadTimeDays == null) missingRequired.push('productionLeadTimeDays');
  if (!incoterm) missingRequired.push('incoterm');

  const sampleCostMinor = statedNonNegativeInt(rec.sampleCostMinor ?? rec.sample_cost_minor);
  const sampleLeadTimeDays = statedNonNegativeInt(rec.sampleLeadTimeDays ?? rec.sample_lead_time_days);
  const toolingSetupCostMinor = statedNonNegativeInt(rec.toolingSetupCostMinor ?? rec.tooling_setup_cost_minor);
  const customisationCostPerUnitMinor = statedNonNegativeInt(
    rec.customisationCostPerUnitMinor ?? rec.customisation_cost_per_unit_minor,
  );
  const packagingCostPerUnitMinor = statedNonNegativeInt(
    rec.packagingCostPerUnitMinor ?? rec.packaging_cost_per_unit_minor,
  );

  const missingOptional: string[] = [];
  if (sampleCostMinor == null) missingOptional.push('sampleCostMinor');
  if (sampleLeadTimeDays == null) missingOptional.push('sampleLeadTimeDays');
  if (toolingSetupCostMinor == null) missingOptional.push('toolingSetupCostMinor');
  if (customisationCostPerUnitMinor == null) missingOptional.push('customisationCostPerUnitMinor');
  if (packagingCostPerUnitMinor == null) missingOptional.push('packagingCostPerUnitMinor');
  if (statedString(rec.originPort ?? rec.origin_port) == null) missingOptional.push('originPort');
  if (statedString(rec.paymentTerms ?? rec.payment_terms) == null) missingOptional.push('paymentTerms');

  return {
    receivedVia: parseReceivedVia(rec.receivedVia ?? rec.received_via ?? rec.discoveredVia) ?? 'provider_api',
    rawResponseRef: statedString(rec.rawResponseRef ?? rec.raw_response_ref) ?? null,
    receivedAt: statedDate(rec.receivedAt ?? rec.received_at) ?? undefined,
    currency,
    priceTiers,
    moq,
    productionLeadTimeDays,
    incoterm,
    sampleCostMinor,
    sampleLeadTimeDays,
    toolingSetupCostMinor,
    customisationCostPerUnitMinor,
    packagingCostPerUnitMinor,
    originPort: statedString(rec.originPort ?? rec.origin_port),
    paymentTerms: statedString(rec.paymentTerms ?? rec.payment_terms),
    validUntil: statedDate(rec.validUntil ?? rec.valid_until),
    notes: statedString(rec.notes),
    missingRequired,
    missingOptional,
  };
}

function unwrapQuote(payload: unknown): Record<string, unknown> {
  if (payload == null || typeof payload !== 'object') return {};
  if (Array.isArray(payload)) {
    const first = payload[0];
    return first !== null && typeof first === 'object' && !Array.isArray(first) ? (first as Record<string, unknown>) : {};
  }
  const rec = payload as Record<string, unknown>;
  if (rec.quotes && Array.isArray(rec.quotes) && rec.quotes[0] && typeof rec.quotes[0] === 'object') {
    return rec.quotes[0] as Record<string, unknown>;
  }
  return rec;
}

function parseTiers(raw: unknown, fallbackCurrency: string | null): PriceTierType[] {
  if (!Array.isArray(raw)) return [];
  const out: PriceTierType[] = [];
  for (const item of raw) {
    if (item == null || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const parsed = PriceTier.safeParse({
      minQuantity: rec.minQuantity ?? rec.min_quantity,
      maxQuantity: rec.maxQuantity === undefined ? (rec.max_quantity ?? null) : rec.maxQuantity,
      unitPriceMinor: rec.unitPriceMinor ?? rec.unit_price_minor,
      currency: rec.currency ?? fallbackCurrency,
    });
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

function parseReceivedVia(value: unknown): QuoteReceivedVia | null {
  if (value === 'human_expert') return 'human_expert_relay';
  return typeof value === 'string' && (RECEIVED_VIA as readonly string[]).includes(value)
    ? (value as QuoteReceivedVia)
    : null;
}

function statedString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function statedCurrency(value: unknown): string | null {
  const text = statedString(value);
  return text && /^[A-Z]{3}$/i.test(text) ? text.toUpperCase() : null;
}

function statedPositiveInt(value: unknown): number | null {
  const n = asInt(value);
  return n != null && n > 0 ? n : null;
}

function statedNonNegativeInt(value: unknown): number | null {
  const n = asInt(value);
  return n != null && n >= 0 ? n : null;
}

function asInt(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) return Number(value.trim());
  return null;
}

function statedDate(value: unknown): Date | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (typeof value === 'string' && value.trim().length > 0) {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}
