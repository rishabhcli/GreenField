/**
 * Pioneer-backed PII scan and prompt guard.
 *
 * Support transcripts and legal drafts go through GLiNER2-PII before they
 * are stored or sent. Inbound tool arguments that look like jailbreaks go
 * through GLiGuard. Missing Pioneer keys return blockedOn, never a fake
 * "no PII found".
 */

import { CredentialsMissingError, type Capability } from '@foundry/core';
import { PioneerAdapter, type PioneerPiiSpan } from '@foundry/providers';
import { requireCapability, type ServiceDeps, type ServiceOutcome } from '../deps.js';

export class ComplianceScanService {
  constructor(private readonly deps: ServiceDeps) {}

  async scanPii(text: string): Promise<ServiceOutcome<{ spans: readonly PioneerPiiSpan[]; modelId: string }>> {
    let pioneer: PioneerAdapter;
    try {
      pioneer = requireCapability<PioneerAdapter>(this.deps, 'compliance.pii_scan').adapter;
    } catch (error) {
      if (error instanceof CredentialsMissingError) {
        return blocked('compliance.pii_scan', error.message);
      }
      throw error;
    }
    const result = await pioneer.scanPii(text);
    return { ok: true, data: { spans: result.spans, modelId: result.modelId } };
  }

  async guardPrompt(text: string): Promise<ServiceOutcome<{ modelId: string; raw: unknown }>> {
    let pioneer: PioneerAdapter;
    try {
      pioneer = requireCapability<PioneerAdapter>(this.deps, 'compliance.prompt_guard').adapter;
    } catch (error) {
      if (error instanceof CredentialsMissingError) {
        return blocked('compliance.prompt_guard', error.message);
      }
      throw error;
    }
    const result = await pioneer.guardPrompt(text);
    return { ok: true, data: result };
  }
}

function blocked<T>(capability: Capability, reason: string): ServiceOutcome<T> {
  return { ok: false, blockedOn: { capability, reason } };
}
