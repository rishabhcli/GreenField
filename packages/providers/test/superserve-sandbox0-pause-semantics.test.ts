/**
 * Pause is not a shared primitive. Superserve checkpoints VM state (memory,
 * processes, filesystem). sandbox0 does not keep processes. Collapsing the
 * two would let a caller treat an HTTP 200 pause as a live workspace.
 */

import { describe, expect, it } from 'vitest';
import { SANDBOX0_PAUSE_PRESERVES_PROCESSES } from '../src/sandbox0/index.js';
import { SUPERSERVE_PAUSE_PRESERVES_VM_STATE } from '../src/superserve/index.js';

describe('pause semantics differ across compute planes', () => {
  it('Superserve pause preserves VM state; sandbox0 pause does not', () => {
    expect(SUPERSERVE_PAUSE_PRESERVES_VM_STATE).toBe(true);
    expect(SANDBOX0_PAUSE_PRESERVES_PROCESSES).toBe(false);
    expect(SUPERSERVE_PAUSE_PRESERVES_VM_STATE).not.toBe(SANDBOX0_PAUSE_PRESERVES_PROCESSES);
  });
});
