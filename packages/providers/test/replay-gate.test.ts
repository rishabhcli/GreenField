/**
 * Replay QA -> release gate bridge tests.
 *
 * Replay documents no built-in pass/fail check, so `toQaRunAndDefects` is the
 * entire gate computation for this provider. Fixtures are parsed through the
 * real `ReplayProject`/`ReplayExploration`/`ReplayBug`/`ReplayJourney` zod
 * schemas. The important cases are the disclosed heuristics — severity,
 * flow, and the two ambiguous bug statuses (`judge-rejected`, `pr-closed`) —
 * and a full round-trip into core's `evaluateReleaseGate`, so this test
 * proves the bridge's output is actually usable as gate input, not just
 * shaped like it.
 */

import { describe, expect, it } from 'vitest';
import { evaluateReleaseGate } from '@foundry/core';
import {
  flowFromBug,
  isExplorationFinished,
  isProjectIdle,
  isProjectWorkIdle,
  isTerminalExplorationStatus,
  severityFromBug,
  toQaRunAndDefects,
  toQaRunFromProject,
} from '../src/replay/gate.js';
import {
  ReplayBug,
  ReplayExploration,
  ReplayJourney,
  ReplayProject,
  ReplayProjectTiming,
} from '../src/replay/schemas.js';

function project(overrides: Record<string, unknown> = {}) {
  return ReplayProject.parse({
    id: 'proj_test_1',
    name: 'Storefront',
    target_url: 'https://example-store.test',
    url: 'https://loop-qa.replay.io/projects/proj_test_1',
    ...overrides,
  });
}

function exploration(overrides: Record<string, unknown> = {}) {
  return ReplayExploration.parse({
    id: 'expl_test_1',
    project_id: 'proj_test_1',
    status: 'completed',
    started_at: '2026-08-14T10:00:00.000Z',
    finished_at: '2026-08-14T10:20:00.000Z',
    ...overrides,
  });
}

function journey(overrides: Record<string, unknown> = {}) {
  return ReplayJourney.parse({
    id: 'jrn_test_1',
    project_id: 'proj_test_1',
    name: 'Checkout flow',
    ...overrides,
  });
}

function bug(overrides: Record<string, unknown> = {}) {
  return ReplayBug.parse({
    id: 'bug_test_1',
    project_id: 'proj_test_1',
    title: 'Something broke',
    status: 'open',
    ...overrides,
  });
}

/* -------------------------------------------------------------------------- */

describe('isTerminalExplorationStatus', () => {
  it('treats success, failure and cancellation words as terminal', () => {
    expect(isTerminalExplorationStatus('completed')).toBe(true);
    expect(isTerminalExplorationStatus('Failed')).toBe(true);
    expect(isTerminalExplorationStatus('CANCELLED')).toBe(true);
    expect(isTerminalExplorationStatus('canceled')).toBe(true);
  });

  it('treats in-progress words as non-terminal', () => {
    expect(isTerminalExplorationStatus('queued')).toBe(false);
    expect(isTerminalExplorationStatus('running')).toBe(false);
    expect(isTerminalExplorationStatus('in-progress')).toBe(false);
    expect(isTerminalExplorationStatus('in_progress')).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */

describe('flowFromBug', () => {
  it('matches the checkout flow from a URL path', () => {
    expect(flowFromBug(bug({ url: 'https://example-store.test/checkout' }))).toBe('checkout_initiation');
  });

  it('matches add-to-cart from a URL path', () => {
    expect(flowFromBug(bug({ url: 'https://example-store.test/cart' }))).toBe('add_to_cart');
  });

  it('prefers the more specific payment-failure match over the generic payment match', () => {
    expect(flowFromBug(bug({ title: 'Payment declined error not shown to user', url: null }))).toBe(
      'payment_failure_path',
    );
  });

  it('matches the homepage from a bare root path', () => {
    expect(flowFromBug(bug({ url: 'https://example-store.test/' }))).toBe('homepage_loads');
  });

  it('returns null, honestly, when nothing matches rather than guessing a flow', () => {
    expect(flowFromBug(bug({ title: 'Footer typo', description: 'Says "Copyright 2025"', url: null }))).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */

describe('severityFromBug', () => {
  it('uses an explicit severity field when present', () => {
    expect(severityFromBug(bug({ severity: 'critical' }))).toBe('critical');
  });

  it('normalises a priority field like P1 to high', () => {
    expect(severityFromBug(bug({ priority: 'P1' }))).toBe('high');
  });

  it('never rates a money-path bug below high, even with no severity field and mild wording', () => {
    const result = severityFromBug(bug({ title: 'Checkout total looks off by a cent', url: '/checkout' }));
    expect(['high', 'critical']).toContain(result);
  });

  it('escalates a money-path bug to critical when the wording indicates a hard failure', () => {
    const result = severityFromBug(
      bug({ title: 'Checkout page crashes and cannot complete purchase', url: '/checkout' }),
    );
    expect(result).toBe('critical');
  });

  it('escalates crash-like wording to critical even off the money path', () => {
    const result = severityFromBug(bug({ title: 'Blog page crashes on load', url: '/blog/post-1' }));
    expect(result).toBe('critical');
  });

  it('defaults an unremarkable, unclassified bug to medium rather than silently low', () => {
    const result = severityFromBug(bug({ title: 'Footer link colour is slightly off-brand', url: '/', description: null }));
    expect(result).toBe('medium');
  });
});

/* -------------------------------------------------------------------------- */

describe('toQaRunAndDefects', () => {
  it('derives flow coverage from journeys, not from bugs, when journeys are available', () => {
    const { run } = toQaRunAndDefects(
      project(),
      exploration({ journeys: [journey({ name: 'Checkout flow' }), journey({ id: 'jrn_2', name: 'Homepage' })] }),
      [],
    );
    expect(run.flowsCovered).toContain('checkout_initiation');
    expect(run.flowsCovered).toContain('homepage_loads');
  });

  it('falls back to bug-derived flow coverage when no inline journeys are present', () => {
    const { run } = toQaRunAndDefects(project(), exploration({ journeys: null, journey_ids: ['jrn_1'] }), [
      bug({ url: '/checkout' }),
    ]);
    expect(run.flowsCovered).toEqual(['checkout_initiation']);
  });

  it('maps kind, status, and identifiers straightforwardly from the source objects', () => {
    const { run } = toQaRunAndDefects(project(), exploration({ status: 'completed' }), []);
    expect(run.kind).toBe('autonomous_exploration');
    expect(run.status).toBe('completed');
    expect(run.externalProjectId).toBe('proj_test_1');
    expect(run.externalRunId).toBe('expl_test_1');
    expect(run.targetUrl).toBe('https://example-store.test');
    expect(run.unavailableReason).toBeNull();
  });

  it('maps a live in-progress exploration to running, never completed', () => {
    const { run } = toQaRunAndDefects(project(), exploration({ status: 'in-progress', finished_at: null }), []);
    expect(run.status).toBe('running');
    expect(run.status).not.toBe('completed');
  });

  it('uses completed_at from the live exploration payload as finishedAt', () => {
    const { run } = toQaRunAndDefects(
      project(),
      exploration({ status: 'completed', finished_at: null, completed_at: '2026-08-15T12:30:00.000Z' }),
      [],
    );
    expect(run.status).toBe('completed');
    expect(run.finishedAt).toBe('2026-08-15T12:30:00.000Z');
  });

  it('tallies defectCounts by the same severities reported per-defect', () => {
    const { run, defects } = toQaRunAndDefects(project(), exploration(), [
      bug({ id: 'b1', severity: 'critical' }),
      bug({ id: 'b2', severity: 'critical' }),
      bug({ id: 'b3', severity: 'low' }),
    ]);
    expect(run.defectCounts.critical).toBe(2);
    expect(run.defectCounts.low).toBe(1);
    expect(defects).toHaveLength(3);
  });

  it('treats judge-rejected and pr-closed conservatively as still-open, never as fixed', () => {
    const { defects } = toQaRunAndDefects(project(), exploration(), [
      bug({ id: 'b1', status: 'judge-rejected' }),
      bug({ id: 'b2', status: 'pr-closed' }),
    ]);
    expect(defects.find((d) => d.externalId === 'b1')?.status).toBe('open');
    expect(defects.find((d) => d.externalId === 'b2')?.status).toBe('open');
  });

  it('passes through an unambiguous fixed status as fixed', () => {
    const { defects } = toQaRunAndDefects(project(), exploration(), [bug({ status: 'fixed' })]);
    expect(defects[0]?.status).toBe('fixed');
  });

  it('does not fabricate reproduction steps that Replay never sent', () => {
    const { defects } = toQaRunAndDefects(project(), exploration(), [bug()]);
    expect(defects[0]?.reproductionSteps).toEqual([]);
  });

  /* ------------------------------------------------------------------------ */
  /* Round-trip into the actual release gate                                  */
  /* ------------------------------------------------------------------------ */

  it('a critical open defect on the checkout flow blocks a production release', () => {
    const { run, defects } = toQaRunAndDefects(
      project(),
      exploration({ journeys: [journey({ name: 'Checkout flow' })] }),
      [bug({ severity: 'critical', url: '/checkout', status: 'open' })],
    );

    const result = evaluateReleaseGate({
      environment: 'production',
      runs: [run],
      openDefects: defects,
      requiredFlows: ['checkout_initiation'],
      requiredRunKinds: ['autonomous_exploration'],
    });

    expect(result.verdict).toBe('block');
    expect(result.blockers.some((b) => b.code === 'critical_defect_open')).toBe(true);
  });

  it('full flow coverage with no open defects passes the gate', () => {
    const { run, defects } = toQaRunAndDefects(
      project(),
      exploration({ journeys: [journey({ name: 'Homepage' })] }),
      [bug({ status: 'fixed', severity: 'low' })],
    );

    const result = evaluateReleaseGate({
      environment: 'production',
      runs: [run],
      openDefects: defects,
      requiredFlows: ['homepage_loads'],
      requiredRunKinds: ['autonomous_exploration'],
    });

    expect(result.verdict).toBe('pass');
  });

  it('an uncovered required flow blocks production even with zero defects', () => {
    const { run, defects } = toQaRunAndDefects(project(), exploration({ journeys: [] }), []);

    const result = evaluateReleaseGate({
      environment: 'production',
      runs: [run],
      openDefects: defects,
      requiredFlows: ['checkout_initiation'],
      requiredRunKinds: ['autonomous_exploration'],
    });

    expect(result.verdict).toBe('block');
    expect(result.blockers.some((b) => b.code === 'critical_flow_uncovered')).toBe(true);
  });

  it('passes Replay reproduction_steps through when the API sent them', () => {
    const { defects } = toQaRunAndDefects(project(), exploration(), [
      bug({ reproduction_steps: ['Open /checkout', 'Submit the form'] }),
    ]);
    expect(defects[0]?.reproductionSteps).toEqual(['Open /checkout', 'Submit the form']);
  });
});

describe('isProjectIdle', () => {
  it('is idle only when finished_at is a non-empty timestamp', () => {
    expect(isProjectIdle(ReplayProjectTiming.parse({ finished_at: '2026-08-15T12:00:00.000Z' }))).toBe(true);
    expect(isProjectIdle(ReplayProjectTiming.parse({ finished_at: null, started_at: '2026-08-15T11:00:00.000Z' }))).toBe(
      false,
    );
  });

  it('treats live completed_at as finished even when finished_at is null', () => {
    expect(
      isExplorationFinished({ status: 'in-progress', finished_at: null, completed_at: '2026-08-15T12:30:00.000Z' }),
    ).toBe(true);
    expect(isExplorationFinished({ status: 'in-progress', finished_at: null, completed_at: null })).toBe(false);
  });

  it('does not treat a 90s poll timeout as idle or as a pass', () => {
    const { run } = toQaRunFromProject(
      project(),
      ReplayProjectTiming.parse({
        started_at: '2026-08-15T11:00:00.000Z',
        first_event_at: '2026-08-15T11:00:12.000Z',
        finished_at: null,
      }),
      [],
      [],
      exploration({ status: 'in-progress', finished_at: null }),
    );
    expect(run.status).toBe('running');
    expect(run.status).not.toBe('completed');
  });
});

describe('isProjectWorkIdle', () => {
  it('is not idle while explorations or test runs are in-progress', () => {
    expect(
      isProjectWorkIdle(
        { explorations: { 'in-progress': 1 }, test_runs: { 'in-progress': 6, incomplete: 1 } },
        { started_at: '2026-08-15T19:00:00.000Z', first_event_at: '2026-08-15T19:00:12.000Z', finished_at: null },
      ),
    ).toBe(false);
  });

  it('treats a terminal incomplete count as not in-flight', () => {
    expect(
      isProjectWorkIdle(
        { explorations: { completed: 1 }, test_runs: { incomplete: 1, 'infra-failed': 4 } },
        { started_at: '2026-08-15T19:00:00.000Z', first_event_at: '2026-08-15T19:00:12.000Z', finished_at: null },
      ),
    ).toBe(true);
  });

  it('is not idle at t=0 with empty counts and no start', () => {
    expect(isProjectWorkIdle({ explorations: {}, test_runs: {} }, { started_at: null, finished_at: null })).toBe(false);
  });
});

describe('toQaRunFromProject', () => {
  it('maps a still-running project to running, never completed', () => {
    const { run } = toQaRunFromProject(
      project(),
      ReplayProjectTiming.parse({ started_at: '2026-08-15T11:00:00.000Z', finished_at: null }),
      [],
      [],
    );
    expect(run.status).toBe('running');
    expect(run.status).not.toBe('completed');
  });

  it('maps idle-without-start to failed — unexecuted QA is not a pass', () => {
    const { run } = toQaRunFromProject(
      project(),
      ReplayProjectTiming.parse({ created_at: '2026-08-15T11:00:00.000Z', started_at: null, finished_at: '2026-08-15T11:00:01.000Z' }),
      [],
      [],
    );
    expect(run.status).toBe('failed');
    expect(run.status).not.toBe('completed');
  });

  it('maps idle after real work to completed so the gate can judge defects', () => {
    const { run } = toQaRunFromProject(
      project(),
      ReplayProjectTiming.parse({
        started_at: '2026-08-15T11:00:00.000Z',
        finished_at: '2026-08-15T11:20:00.000Z',
      }),
      [],
      [journey({ name: 'Homepage' })],
    );
    expect(run.status).toBe('completed');
    expect(run.flowsCovered).toContain('homepage_loads');
  });

  it('maps recording-lost journeys to failed, never completed — 0 bugs is not a pass', () => {
    const { run, defects } = toQaRunFromProject(
      project(),
      ReplayProjectTiming.parse({
        started_at: '2026-08-15T19:04:07.000Z',
        finished_at: '2026-08-15T19:20:00.000Z',
      }),
      [],
      [journey({ name: 'Homepage', status: 'recording-lost' }), journey({ id: 'jrn_2', name: 'Checkout flow', status: 'recording-lost' })],
    );
    expect(run.status).toBe('failed');
    expect(run.status).not.toBe('completed');
    expect(run.unavailableReason).toBe('recording-lost');
    expect(defects).toEqual([]);
    expect(run.flowsCovered).toEqual([]);

    const gate = evaluateReleaseGate({
      environment: 'production',
      runs: [run],
      openDefects: defects,
      requiredFlows: ['homepage_loads', 'checkout_initiation'],
      requiredRunKinds: ['autonomous_exploration'],
    });
    expect(gate.verdict).toBe('block');
    expect(gate.blockers.some((b) => b.code === 'qa_infra_failed' || b.code === 'qa_run_incomplete')).toBe(true);
  });

  it('maps infra-failed test_runs with zero passed runs to failed, even when idle', () => {
    const { run } = toQaRunFromProject(
      project(),
      ReplayProjectTiming.parse({
        started_at: '2026-08-15T19:04:07.000Z',
        first_event_at: '2026-08-15T19:04:19.000Z',
        finished_at: '2026-08-15T19:25:00.000Z',
      }),
      [],
      [journey({ name: 'Homepage' })],
      exploration({ status: 'completed' }),
      { explorations: { completed: 1 }, test_runs: { 'infra-failed': 4, passed: 0 } },
    );
    expect(run.status).toBe('failed');
    expect(run.status).not.toBe('completed');
    expect(run.unavailableReason).toBe('recording-lost');
  });
});
