/**
 * `SourcingRouter` — dispatches each `SupplierSourcingProvider` capability to
 * the first registered provider that supports it, and reports honestly (a
 * typed `CapabilityUnsupportedError`, never a silent empty result or an
 * invented answer) when none do. This is the file the rest of the system
 * depends on; callers never need to know whether a given call ends up served
 * by Alibaba, a browser session, or nothing at all — they ask the router,
 * and the router is honest about which.
 */

import type { PriceTier } from '@foundry/core';
import { assertSupports } from './interface.js';
import type {
  LeadTimeEstimate,
  PackagingOption,
  PrivateLabelCapability,
  ProductDetails,
  ProductSearchHit,
  QuoteResult,
  RfqSubmissionInput,
  RfqSubmissionResult,
  SampleTerms,
  ShippingQuoteInput,
  ShippingQuoteResult,
  SourcedSupplierProfile,
  SourcingMethod,
  SupplierSourcingProvider,
} from './interface.js';

export class SourcingRouter implements SupplierSourcingProvider {
  readonly providerId = 'sourcing_router';
  readonly #providers: readonly SupplierSourcingProvider[];

  constructor(providers: readonly SupplierSourcingProvider[]) {
    this.#providers = providers;
  }

  supports(method: SourcingMethod): boolean {
    return this.#providers.some((p) => p.supports(method));
  }

  /** Every registered provider and whether it currently supports `method` — diagnostics, not dispatch. */
  providersFor(method: SourcingMethod): readonly { readonly providerId: string; readonly supports: boolean }[] {
    return this.#providers.map((p) => ({ providerId: p.providerId, supports: p.supports(method) }));
  }

  /**
   * The first registered provider that supports `method`, in registration
   * order — "first" is a deliberate, simple priority rule (earlier
   * registration wins), not a quality ranking. `assertSupports` on `this`
   * throws the same typed error the interface defines when nothing supports
   * it, naming every provider that was actually checked.
   */
  #resolve(method: SourcingMethod): SupplierSourcingProvider {
    const found = this.#providers.find((p) => p.supports(method));
    if (found) return found;
    assertSupports(
      this,
      method,
      `No registered sourcing provider supports "${method}". Registered: ${
        this.#providers.map((p) => p.providerId).join(', ') || 'none'
      }.`,
    );
    // assertSupports always throws when it reaches this point (this.supports(method) is false,
    // since no provider in #providers supports it) — unreachable in practice, present only to satisfy the return type.
    throw new Error('unreachable');
  }

  // Each method below resolves the provider, then calls straight through.
  // The `!` is safe by contract, not by static proof: `#resolve` only ever
  // returns a provider whose `supports(method)` was true, and every real
  // `SupplierSourcingProvider` implementation defines the matching optional
  // method whenever it reports supporting it.

  async searchProducts(input: { readonly query: string; readonly limit?: number }): Promise<readonly ProductSearchHit[]> {
    return this.#resolve('searchProducts').searchProducts!(input);
  }

  async searchSuppliers(input: { readonly query: string; readonly limit?: number }): Promise<readonly SourcedSupplierProfile[]> {
    return this.#resolve('searchSuppliers').searchSuppliers!(input);
  }

  async getSupplierProfile(input: { readonly externalId: string }): Promise<SourcedSupplierProfile> {
    return this.#resolve('getSupplierProfile').getSupplierProfile!(input);
  }

  async getProductDetails(input: { readonly externalId: string }): Promise<ProductDetails> {
    return this.#resolve('getProductDetails').getProductDetails!(input);
  }

  async getPrivateLabelCapability(input: { readonly supplierExternalId: string }): Promise<PrivateLabelCapability> {
    return this.#resolve('getPrivateLabelCapability').getPrivateLabelCapability!(input);
  }

  async getPriceTiers(input: { readonly productExternalId: string; readonly quantities?: readonly number[] }): Promise<readonly PriceTier[]> {
    return this.#resolve('getPriceTiers').getPriceTiers!(input);
  }

  async getSampleTerms(input: { readonly productExternalId: string }): Promise<SampleTerms> {
    return this.#resolve('getSampleTerms').getSampleTerms!(input);
  }

  async getPackagingOptions(input: { readonly productExternalId: string }): Promise<readonly PackagingOption[]> {
    return this.#resolve('getPackagingOptions').getPackagingOptions!(input);
  }

  async getLeadTime(input: { readonly productExternalId: string; readonly quantity: number }): Promise<LeadTimeEstimate> {
    return this.#resolve('getLeadTime').getLeadTime!(input);
  }

  async getShippingQuote(input: ShippingQuoteInput): Promise<ShippingQuoteResult> {
    return this.#resolve('getShippingQuote').getShippingQuote!(input);
  }

  async submitRfq(input: RfqSubmissionInput): Promise<RfqSubmissionResult> {
    return this.#resolve('submitRfq').submitRfq!(input);
  }

  async getQuote(input: { readonly rfqExternalRef: string }): Promise<QuoteResult> {
    return this.#resolve('getQuote').getQuote!(input);
  }
}

export * from './interface.js';
export * from './alibaba-schemas.js';
export { AlibabaSourcingAdapter } from './alibaba.js';
export * from './browser-sourcing.js';
