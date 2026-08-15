/**
 * Alibaba.com Open Platform adapter for supplier sourcing.
 *
 * `docs/research/SPONSOR_API_RESEARCH.md` does not cover Alibaba at all — it
 * only documents the twelve sponsors. Per this build's instructions, that
 * means verifying Alibaba independently via WebFetch of official docs before
 * writing a single line that calls a real endpoint. Here is exactly what was
 * verified, and when:
 *
 *  - 2026-08-15, `https://openapi.alibaba.com/doc/doc.htm` (the URL already
 *    cited in this package's `ALIBABA_MANIFEST.docs`): fetched successfully
 *    at the HTTP level, but the page is a client-side-rendered app shell with
 *    no server-rendered documentation content — WebFetch (static HTML → text,
 *    no JS execution) could not recover any endpoint, parameter or response
 *    detail from it.
 *  - 2026-08-15, web search across `openapi.alibaba.com` / `developer.alibaba.com`
 *    turned up the platform's own onboarding description: register a
 *    developer account, sign up as a **GGS (Global Gold Supplier) developer**,
 *    submit an application for admin review, and only *after* that manual
 *    approval are an App Key/App Secret issued; a further "Request API
 *    Permissions" step is required per application before any endpoint can be
 *    called at all. Source: developer.alibaba.com "Open Platform-Resources" /
 *    "Open Platform Development Manual" (titles surfaced by search; the doc
 *    bodies themselves sit behind an authenticated developer console and were
 *    not independently fetchable).
 *  - No product-search, supplier-detail, or RFQ method name, request field,
 *    or response shape was recoverable from any source reachable in this
 *    pass — despite `ALIBABA_MANIFEST` (written before this file, not by this
 *    pass) already asserting `documented_api` evidence for search/profile.
 *    This adapter does not rely on that earlier, unverified-by-this-pass
 *    claim: per the instruction "do NOT fabricate a client for an API you
 *    could not verify," every method below refuses rather than guesses.
 *
 * The GGS program is also, on its face, the wrong program for this business:
 * it onboards *sellers* building apps on top of Alibaba.com, not third-party
 * buyers automating outbound sourcing. Combined with the mandatory manual
 * approval step, no supplier-search, RFQ or quote capability is obtainable
 * here without a partner agreement — so every method reports
 * `blocked_vendor_approval` via a `VendorApprovalRequiredError` and makes no
 * network call whatsoever. There is nothing to poll, sign or retry, because
 * there is no confirmed endpoint to poll, sign or retry against.
 */

import { VendorApprovalRequiredError, type ProviderId } from '@foundry/core';
import { ProviderAdapter, type AdapterContext, type ProbeResult } from '../http/adapter.js';
import { ALIBABA_MANIFEST } from '../manifests.js';
import type {
  QuoteResult,
  RfqSubmissionInput,
  RfqSubmissionResult,
  SourcedSupplierProfile,
  SourcingMethod,
  SupplierSourcingProvider,
} from './interface.js';

const VERIFICATION_NOTE =
  'Verified 2026-08-15: openapi.alibaba.com/doc/doc.htm renders no usable content to automated fetch (JS app ' +
  'shell), and the platform\'s own onboarding documentation (developer.alibaba.com) describes access as gated ' +
  'behind GGS (Global Gold Supplier) developer registration plus manual admin approval of the application, with ' +
  'App Key/Secret issued only after that approval and a further per-application "Request API Permissions" step. ' +
  'No product-search, supplier-detail or RFQ endpoint contract was recoverable independently of that gate.';

function vendorApprovalError(operation: string): VendorApprovalRequiredError {
  return new VendorApprovalRequiredError(
    'alibaba',
    operation,
    `${ALIBABA_MANIFEST.vendorApproval?.how ?? 'An approved Alibaba.com Open Platform application is required.'} ` +
      VERIFICATION_NOTE,
  );
}

export class AlibabaSourcingAdapter extends ProviderAdapter implements SupplierSourcingProvider {
  override readonly manifest = ALIBABA_MANIFEST;
  readonly providerId: ProviderId = 'alibaba';

  constructor(ctx: AdapterContext) {
    super(ctx);
  }

  supports(_method: SourcingMethod): boolean {
    return false;
  }

  /**
   * No confirmed non-destructive read exists to probe (see the header note),
   * so this reports the honest "unverifiable" result rather than guessing at
   * a signed request against an unconfirmed method name. This never makes a
   * network call — a guessed HMAC-signed request against an invented method
   * name would provide no real signal either way, only the appearance of one.
   */
  override async probe(): Promise<ProbeResult> {
    return {
      succeeded: false,
      detail:
        'No Alibaba.com Open Platform endpoint could be verified against live official documentation, so no ' +
        'probe call is made. ' + VERIFICATION_NOTE,
      evidence: { reason: 'unverifiable_no_public_api', checkedOn: '2026-08-15' },
    };
  }

  async searchSuppliers(_query: { readonly query: string; readonly limit?: number }): Promise<readonly SourcedSupplierProfile[]> {
    throw vendorApprovalError('sourcing.supplier_search');
  }

  async getSupplierDetail(_externalId: string): Promise<SourcedSupplierProfile> {
    throw vendorApprovalError('sourcing.supplier_profile');
  }

  /**
   * RFQ submission is the single hardest prohibition in this project: never
   * generate a fake supplier quote. With no verified endpoint, the only
   * honest behaviour is to refuse before ever constructing a request body —
   * not to send something to a guessed path and risk silently degrading into
   * treating a 404 page as "sent."
   */
  async submitRfq(_input: RfqSubmissionInput): Promise<RfqSubmissionResult> {
    throw vendorApprovalError('sourcing.rfq_submit');
  }

  async retrieveQuotes(_query: { readonly rfqExternalRef: string }): Promise<QuoteResult> {
    throw vendorApprovalError('sourcing.quote_retrieve');
  }
}
