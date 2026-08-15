/**
 * Superserve identities — one persistent workspace per business function.
 * A crash in research must not share a VM with sourcing or with foundry-api/worker.
 */

import { ValidationError } from '@foundry/core';

/** Live-proven: pause checkpoints memory, processes, and filesystem. sandbox0 pause does not. */
export const SUPERSERVE_PAUSE_PRESERVES_VM_STATE = true;

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
        { name, token, plane: 'superserve' },
      );
    }
  }
}

export function assertSuperserveWorkload(workload: ComputeWorkload): void {
  if (workload !== 'persistent_multi_hour') {
    throw new ValidationError(
      'Superserve accepts persistent multi-hour workspaces only. Untrusted/model-generated code runs in sandbox0; browser/GUI work runs in Solari.',
      { workload, plane: 'superserve' },
    );
  }
}

export interface PersistentWorkspaceIdentity {
  readonly plane: 'superserve';
  readonly function: ComputeBusinessFunction;
  readonly companyId: string;
  readonly name: string;
  readonly metadata: {
    readonly foundry_plane: 'superserve';
    readonly foundry_function: ComputeBusinessFunction;
    readonly company_id: string;
    readonly isolation: 'persistent_workspace';
    readonly control_plane: false;
  };
}

function companyShort(companyId: string): string {
  return companyId.replace(/[^a-zA-Z0-9]/g, '').slice(-12).toLowerCase() || 'company';
}

export function persistentWorkspaceIdentity(
  businessFunction: ComputeBusinessFunction,
  companyId: string,
): PersistentWorkspaceIdentity {
  const name = `ss-ws-${businessFunction}-${companyShort(companyId)}`;
  assertIsolatedFromControlPlane(name);
  return {
    plane: 'superserve',
    function: businessFunction,
    companyId,
    name,
    metadata: {
      foundry_plane: 'superserve',
      foundry_function: businessFunction,
      company_id: companyId,
      isolation: 'persistent_workspace',
      control_plane: false,
    },
  };
}
