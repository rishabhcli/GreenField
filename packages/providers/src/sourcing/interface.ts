/**
 * Provider-neutral sourcing layer.
 *
 * No sponsor provides physical-goods sourcing, so this is a clean interface
 * plus real adapters, per PLAN.md section 7. `SupplierSourcingProvider`
 * methods are all optional: a provider only implements what it can actually
 * do, and `supports(method)` is the honesty mechanism — a caller must ask
 * before calling, and an unimplemented method yields a typed
 * `CapabilityUnsupportedError` rather than a silent no-op or an invented
 * empty result.
 *
 * Every DTO returned here carries its own provenance (`sourceProvider`,
 * `sourceUrl`, `retrievedAt`, `discoveredVia`) rather than the full core
 * `Supplier`/`Rfq`/`SupplierQuote` domain shape. Those domain records also
 * need an id, a `companyId` and audit timestamps that only our own system
 * assigns — a provider adapter cannot honestly populate them, so it returns
 * the raw ingredients and a repository/service one layer up assembles the
 * full domain record.
 */

import { CapabilityUnsupportedError, type Incoterm, type PriceTier, type SupplierKind } from '@foundry/core';

/* -------------------------------------------------------------------------- */
/* Provenance                                                                  */
/* -------------------------------------------------------------------------- */

export interface SourcedProvenance {
  /** Manifest provider id, e.g. `alibaba`, or a browser-sourcing provider's own id. */
  readonly sourceProvider: string;
  /** Page this data was actually read from, when there is one (an API response has none). */
  readonly sourceUrl: string | null;
  readonly retrievedAt: string;
  readonly discoveredVia: 'provider_api' | 'browser_session' | 'human_expert' | 'manual_entry';
}

/* -------------------------------------------------------------------------- */
/* DTOs                                                                        */
/* -------------------------------------------------------------------------- */

export interface ProductSearchHit extends SourcedProvenance {
  readonly externalId: string;
  readonly title: string;
  readonly supplierExternalId: string | null;
  readonly minOrderQuantity: number | null;
  readonly unitPriceMinor: number | null;
  readonly currency: string | null;
  readonly imageUrls: readonly string[];
}

export interface SourcedSupplierProfile extends SourcedProvenance {
  readonly externalId: string;
  readonly legalName: string | null;
  readonly displayName: string;
  readonly kind: SupplierKind | null;
  readonly countryCode: string | null;
  readonly region: string | null;
  readonly yearsActive: number | null;
  readonly claimedCertifications: readonly string[];
  readonly platformSignals: Readonly<Record<string, unknown>>;
  readonly supportsPrivateLabel: boolean | null;
  readonly supportsCustomPackaging: boolean | null;
  readonly contactHandle: string | null;
  readonly riskFlags: readonly string[];
}

export interface ProductDetails extends SourcedProvenance {
  readonly externalId: string;
  readonly title: string;
  readonly description: string | null;
  readonly moq: number | null;
  readonly priceTiers: readonly PriceTier[];
  readonly imageUrls: readonly string[];
}

export interface PrivateLabelCapability extends SourcedProvenance {
  readonly supplierExternalId: string;
  readonly supportsPrivateLabel: boolean;
  readonly logoPlacementOptions: readonly string[];
  readonly printMethods: readonly string[];
  readonly minOrderQuantityForPrivateLabel: number | null;
  readonly notes: string | null;
}

export interface SampleTerms extends SourcedProvenance {
  readonly productExternalId: string;
  readonly sampleAvailable: boolean;
  readonly sampleCostMinor: number | null;
  readonly currency: string | null;
  readonly sampleLeadTimeDays: number | null;
  readonly notes: string | null;
}

export interface PackagingOption extends SourcedProvenance {
  readonly productExternalId: string;
  readonly style: string;
  readonly retailReady: boolean;
  readonly printedInsertAvailable: boolean;
  readonly additionalCostPerUnitMinor: number | null;
  readonly currency: string | null;
}

export interface LeadTimeEstimate extends SourcedProvenance {
  readonly productExternalId: string;
  readonly quantity: number;
  readonly productionLeadTimeDays: number;
  readonly notes: string | null;
}

export interface ShippingQuoteInput {
  readonly productExternalId: string;
  readonly quantity: number;
  readonly destinationCountry: string;
  readonly incoterm: Incoterm;
}

export interface ShippingQuoteResult extends SourcedProvenance {
  readonly incoterm: Incoterm;
  readonly amountMinor: number;
  readonly currency: string;
  readonly transitDays: number | null;
  readonly originPort: string | null;
}

export interface RfqSubmissionInput {
  readonly supplierExternalId: string;
  readonly productExternalId: string | null;
  readonly messageBody: string;
  readonly targetQuantities: readonly number[];
}

export interface RfqSubmissionResult extends SourcedProvenance {
  readonly externalRfqRef: string;
  readonly channel: 'email' | 'platform_message' | 'web_form' | 'phone' | 'whatsapp' | 'wechat';
}

export interface QuoteResult extends SourcedProvenance {
  readonly rfqExternalRef: string;
  readonly currency: string;
  readonly priceTiers: readonly PriceTier[];
  readonly moq: number | null;
  readonly productionLeadTimeDays: number | null;
  readonly incoterm: Incoterm | null;
  readonly rawResponseRef: string | null;
}

/* -------------------------------------------------------------------------- */
/* Provider interface                                                          */
/* -------------------------------------------------------------------------- */

export const SOURCING_METHODS = [
  'searchProducts',
  'searchSuppliers',
  'getSupplierProfile',
  'getProductDetails',
  'getPrivateLabelCapability',
  'getPriceTiers',
  'getSampleTerms',
  'getPackagingOptions',
  'getLeadTime',
  'getShippingQuote',
  'submitRfq',
  'getQuote',
] as const;
export type SourcingMethod = (typeof SOURCING_METHODS)[number];

export interface SupplierSourcingProvider {
  readonly providerId: string;

  /** Whether this provider actually implements `method` right now. The only honest way to ask. */
  supports(method: SourcingMethod): boolean;

  searchProducts?(input: { readonly query: string; readonly limit?: number }): Promise<readonly ProductSearchHit[]>;
  searchSuppliers?(input: { readonly query: string; readonly limit?: number }): Promise<readonly SourcedSupplierProfile[]>;
  getSupplierProfile?(input: { readonly externalId: string }): Promise<SourcedSupplierProfile>;
  getProductDetails?(input: { readonly externalId: string }): Promise<ProductDetails>;
  getPrivateLabelCapability?(input: { readonly supplierExternalId: string }): Promise<PrivateLabelCapability>;
  getPriceTiers?(input: { readonly productExternalId: string; readonly quantities?: readonly number[] }): Promise<readonly PriceTier[]>;
  getSampleTerms?(input: { readonly productExternalId: string }): Promise<SampleTerms>;
  getPackagingOptions?(input: { readonly productExternalId: string }): Promise<readonly PackagingOption[]>;
  getLeadTime?(input: { readonly productExternalId: string; readonly quantity: number }): Promise<LeadTimeEstimate>;
  getShippingQuote?(input: ShippingQuoteInput): Promise<ShippingQuoteResult>;
  submitRfq?(input: RfqSubmissionInput): Promise<RfqSubmissionResult>;
  getQuote?(input: { readonly rfqExternalRef: string }): Promise<QuoteResult>;
}

/** Throws the same typed error every call site would otherwise hand-roll, so "unsupported" always looks the same. */
export function assertSupports(provider: SupplierSourcingProvider, method: SourcingMethod, reason?: string): void {
  if (provider.supports(method)) return;
  throw new CapabilityUnsupportedError(
    provider.providerId,
    method,
    reason ?? `"${provider.providerId}" does not implement "${method}".`,
  );
}
