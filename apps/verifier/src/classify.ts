/**
 * Classify a verification probe so a missing key is not a failed run.
 *
 * `blocked_missing_credentials` is a correct state. Exiting non-zero for it
 * would page an operator every six hours for a key that is simply not issued.
 * A probe that actually ran against a live API and failed is a different fact.
 */

import type { ActivationState } from '@foundry/core';

export type ProbeClass = 'blocked' | 'failed' | 'probe_ok';

const BLOCKED_STATES: ReadonlySet<ActivationState> = new Set([
  'blocked_missing_credentials',
  'blocked_malformed_credentials',
  'blocked_vendor_approval',
  'disabled_by_policy',
  'unsupported_by_provider',
  'unverifiable_no_public_api',
]);

export function classifyProbe(state: ActivationState, succeeded: boolean): ProbeClass {
  if (BLOCKED_STATES.has(state)) return 'blocked';
  if (succeeded) return 'probe_ok';
  return 'failed';
}
