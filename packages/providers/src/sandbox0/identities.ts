/**
 * sandbox0 identities — isolated exec per business function.
 * This is where untrusted / model-generated code runs. Not a Superserve VM.
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
        { name, token, plane: 'sandbox0' },
      );
    }
  }
}

export function assertSandbox0Workload(workload: ComputeWorkload): void {
  if (workload !== 'untrusted_model_code') {
    throw new ValidationError(
      'sandbox0 accepts untrusted/model-generated exec only. Persistent multi-hour jobs use Superserve; browser/GUI work uses Solari. Pause does not preserve processes.',
      { workload, plane: 'sandbox0' },
    );
  }
}

export interface IsolatedExecIdentity {
  readonly plane: 'sandbox0';
  readonly function: ComputeBusinessFunction;
  readonly companyId: string;
  readonly name: string;
  readonly metadata: {
    readonly foundry_plane: 'sandbox0';
    readonly foundry_function: ComputeBusinessFunction;
    readonly company_id: string;
    readonly isolation: 'untrusted_exec';
    readonly control_plane: false;
  };
}

function companyShort(companyId: string): string {
  return companyId.replace(/[^a-zA-Z0-9]/g, '').slice(-12).toLowerCase() || 'company';
}

export function isolatedExecIdentity(
  businessFunction: ComputeBusinessFunction,
  companyId: string,
): IsolatedExecIdentity {
  const name = `s0-exec-${businessFunction}-${companyShort(companyId)}`;
  assertIsolatedFromControlPlane(name);
  return {
    plane: 'sandbox0',
    function: businessFunction,
    companyId,
    name,
    metadata: {
      foundry_plane: 'sandbox0',
      foundry_function: businessFunction,
      company_id: companyId,
      isolation: 'untrusted_exec',
      control_plane: false,
    },
  };
}
