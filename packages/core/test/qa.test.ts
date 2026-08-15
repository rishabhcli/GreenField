/**
 * Release gate: an unexecuted check is not a passing check.
 */

import { describe, expect, it } from 'vitest';
import {
  CRITICAL_FLOWS,
  PRODUCTION_REQUIRED_RUN_KINDS,
  evaluateReleaseGate,
  type ReleaseGateInput,
} from '@foundry/core';

function completedRuns(): ReleaseGateInput['runs'] {
  return PRODUCTION_REQUIRED_RUN_KINDS.map((kind) => ({
    kind,
    status: 'completed' as const,
    flowsCovered: [...CRITICAL_FLOWS],
    unavailableReason: null,
  }));
}

describe('evaluateReleaseGate', () => {
  it('blocks production when a required run was never executed', () => {
    const result = evaluateReleaseGate({
      environment: 'production',
      runs: [],
      openDefects: [],
      requiredFlows: CRITICAL_FLOWS,
      requiredRunKinds: PRODUCTION_REQUIRED_RUN_KINDS,
    });
    expect(result.verdict).toBe('block');
    expect(result.blockers.some((b) => b.code === 'qa_run_missing')).toBe(true);
  });

  it('treats provider_unavailable as a production blocker, not a pass', () => {
    const result = evaluateReleaseGate({
      environment: 'production',
      runs: PRODUCTION_REQUIRED_RUN_KINDS.map((kind) => ({
        kind,
        status: 'provider_unavailable' as const,
        flowsCovered: [],
        unavailableReason: 'Replay not activated',
      })),
      openDefects: [],
      requiredFlows: CRITICAL_FLOWS,
      requiredRunKinds: PRODUCTION_REQUIRED_RUN_KINDS,
    });
    expect(result.verdict).toBe('block');
    expect(result.blockers.some((b) => b.code === 'qa_provider_unavailable')).toBe(true);
    expect(result.blockers.some((b) => b.detail.includes('unexecuted check'))).toBe(true);
  });

  it('warns rather than blocks preview when a run is missing', () => {
    const result = evaluateReleaseGate({
      environment: 'preview',
      runs: [],
      openDefects: [],
      requiredFlows: CRITICAL_FLOWS,
      requiredRunKinds: PRODUCTION_REQUIRED_RUN_KINDS,
    });
    expect(result.verdict).toBe('pass');
    expect(result.warnings.some((w) => w.code === 'qa_run_missing')).toBe(true);
  });

  it('blocks on an open critical defect even in preview', () => {
    const result = evaluateReleaseGate({
      environment: 'preview',
      runs: completedRuns(),
      openDefects: [
        { severity: 'critical', affectedFlow: 'checkout_initiation', status: 'open' },
      ],
      requiredFlows: CRITICAL_FLOWS,
      requiredRunKinds: PRODUCTION_REQUIRED_RUN_KINDS,
    });
    expect(result.verdict).toBe('block');
    expect(result.blockers[0]?.code).toBe('critical_defect_open');
  });

  it('passes production when required runs completed, flows are covered, and no critical defects are open', () => {
    const result = evaluateReleaseGate({
      environment: 'production',
      runs: completedRuns(),
      openDefects: [],
      requiredFlows: CRITICAL_FLOWS,
      requiredRunKinds: PRODUCTION_REQUIRED_RUN_KINDS,
    });
    expect(result.verdict).toBe('pass');
    expect(result.blockers).toEqual([]);
    expect(result.uncoveredFlows).toEqual([]);
  });
});
