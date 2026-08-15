/**
 * Egoist Machines — AI Passport.
 *
 * ego.ist/developers is a request-access form. There is no published REST
 * host, auth scheme, or MCP server. This adapter is registered so the
 * capability shows up on readiness as `unverifiable_no_public_api` instead of
 * silently disappearing. Every method throws `VendorApprovalRequiredError`.
 * A present `EGOIST_API_KEY` does not change that — a key without a documented
 * endpoint would still be a fabricated integration.
 */

import { VendorApprovalRequiredError } from '@foundry/core';
import { ProviderAdapter, type AdapterContext, type ProbeResult } from '../http/adapter.js';
import { EGOIST_MANIFEST } from '../manifests.js';

const HOW =
  EGOIST_MANIFEST.vendorApproval?.how ??
  'Request developer access at https://ego.ist/developers. Do not call an invented URL.';

export class EgoistAdapter extends ProviderAdapter {
  override readonly manifest = EGOIST_MANIFEST;

  constructor(ctx: AdapterContext) {
    super(ctx);
  }

  override async probe(): Promise<ProbeResult> {
    throw new VendorApprovalRequiredError('egoist', 'AI Passport / developer API', HOW);
  }

  async readPassport(_subjectId: string): Promise<never> {
    throw new VendorApprovalRequiredError('egoist', 'reading a user Passport', HOW);
  }
}
