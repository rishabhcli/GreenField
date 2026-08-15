/**
 * Solari identities — browser/GUI sessions per business function.
 * Not a sandbox0 exec plane and not a Superserve persistent VM.
 */

import { ValidationError } from '@foundry/core';

export const COMPUTE_BUSINESS_FUNCTIONS = [
  'research',
  'sourcing',
  'brand',
  'commerce',
  'marketing',
  'support',
  'qa',
  'engineering',
  'finance',
  'ops',
] as const;

export type ComputeBusinessFunction = (typeof COMPUTE_BUSINESS_FUNCTIONS)[number];

export type ComputeWorkload = 'untrusted_model_code' | 'persistent_multi_hour' | 'browser_or_gui';

const CONTROL_PLANE_TOKENS = ['foundry-api', 'foundry-worker', 'foundry-agents', 'foundry-loop'] as const;

export function assertIsolatedFromControlPlane(name: string): void {
  const lowered = name.toLowerCase();
  for (const token of CONTROL_PLANE_TOKENS) {
    if (lowered.includes(token)) {
      throw new ValidationError(
        `Sandbox identity "${name}" collides with the control plane process "${token}"; a crash must not share fate with foundry-api/worker`,
        { name, token, plane: 'solari' },
      );
    }
  }
}

export function assertSolariWorkload(workload: ComputeWorkload): void {
  if (workload !== 'browser_or_gui') {
    throw new ValidationError(
      'Solari accepts browser/GUI sessions only. Untrusted/model-generated code runs in sandbox0; persistent multi-hour jobs use Superserve.',
      { workload, plane: 'solari' },
    );
  }
}

export interface BrowserSessionIdentity {
  readonly plane: 'solari';
  readonly function: ComputeBusinessFunction;
  readonly companyId: string;
  readonly name: string;
  readonly metadata: {
    readonly foundry_plane: 'solari';
    readonly foundry_function: ComputeBusinessFunction;
    readonly company_id: string;
    readonly isolation: 'browser_session';
    readonly control_plane: false;
  };
}

function companyShort(companyId: string): string {
  return companyId.replace(/[^a-zA-Z0-9]/g, '').slice(-12).toLowerCase() || 'company';
}

export function browserSessionIdentity(
  businessFunction: ComputeBusinessFunction,
  companyId: string,
): BrowserSessionIdentity {
  const name = `slr-browse-${businessFunction}-${companyShort(companyId)}`;
  assertIsolatedFromControlPlane(name);
  return {
    plane: 'solari',
    function: businessFunction,
    companyId,
    name,
    metadata: {
      foundry_plane: 'solari',
      foundry_function: businessFunction,
      company_id: companyId,
      isolation: 'browser_session',
      control_plane: false,
    },
  };
}
