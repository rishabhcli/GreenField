/**
 * Replay-backed QA orchestration.
 *
 * Replay's OpenAPI says POST /projects starts exploration and callers must
 * poll status — not kick off a second exploration. Unavailable and timed-out
 * runs are never recorded as completed.
 */

import { describe, expect, it } from 'vitest';
import {
  CRITICAL_FLOWS,
  PRODUCTION_REQUIRED_RUN_KINDS,
  ProviderUnavailableError,
  TimeoutError,
  evaluateReleaseGate,
} from '@foundry/core';
import type { ServiceDeps } from '@foundry/services';
import { QaOrchestrationService } from '@foundry/services';

const project = {
  id: 'proj_1',
  name: 'qa:site_1',
  target_url: 'https://shop.example.test',
  exploration_id: 'expl_1',
};

function paymentAndIntegrityRows() {
  const base = {
    company_id: 'co_1',
    site_id: 'site_1',
    deployment_id: 'dep_1',
    provider: 'in_process',
    external_project_id: null,
    external_run_id: null,
    target_url: 'https://shop.example.test',
    flows_covered: [] as string[],
    defect_counts: {},
    unavailable_reason: null as string | null,
    started_at: new Date(),
    finished_at: new Date(),
    evidence_url: null,
  };
  return {
    payment: {
      ...base,
      id: 'qa_payment_1',
      kind: 'payment_state',
      status: 'completed',
      flows_covered: ['checkout_initiation', 'payment_success_path', 'payment_failure_path'],
    },
    integrity: {
      ...base,
      id: 'qa_integrity_1',
      kind: 'data_integrity',
      provider: 'ledger',
      status: 'completed',
    },
  };
}

describe('Replay QA orchestration', () => {
  it('records provider_unavailable when Replay throws ProviderUnavailableError, never completed', async () => {
    const unavailable: Array<{ kind: string; status: string }> = [];
    const finished: Array<{ id: string; status: string }> = [];
    const { payment, integrity } = paymentAndIntegrityRows();
    const unavailableRow = {
      ...payment,
      id: 'qa_unavail_1',
      kind: 'autonomous_exploration',
      provider: 'replay',
      status: 'provider_unavailable',
      unavailable_reason: 'replay is unavailable: dns',
      flows_covered: [],
    };

    const deps = {
      providers: {
        forCapability: () => ({
          adapter: {
            createProject: async () => {
              throw new ProviderUnavailableError('replay', 'dns');
            },
            ensureProjectForTarget: async () => {
              throw new ProviderUnavailableError('replay', 'dns');
            },
          },
          status: { capability: 'qa.autonomous_exploration', provider: 'replay', state: 'live_verified', usable: true },
        }),
      },
      repos: {
        build: {
          qa: {
            startRun: async (input: { kind: string }) => {
              if (input.kind === 'autonomous_exploration') {
                throw new Error('startRun must not run when createProject cannot reach Replay');
              }
              if (input.kind === 'payment_state') return payment;
              return integrity;
            },
            markProviderUnavailable: async (input: { kind: string }) => {
              unavailable.push({ kind: input.kind, status: 'provider_unavailable' });
              return unavailableRow;
            },
            finishRun: async (id: string, outcome: { status: string }) => {
              finished.push({ id, status: outcome.status });
              return { ...unavailableRow, id, status: outcome.status };
            },
            recordDefect: async () => 'def_1',
            runsForDeployment: async () => [unavailableRow, payment, integrity],
            openDefects: async () => [],
          },
          sites: { setStatus: async () => undefined },
        },
        ledger: { findUnbalancedTransactions: async () => [] },
      },
    } as unknown as ServiceDeps;

    const result = await new QaOrchestrationService(deps).run({
      companyId: 'co_1',
      siteId: 'site_1',
      deploymentId: 'dep_1',
      targetUrl: 'https://shop.example.test',
      kinds: ['autonomous_exploration', 'payment_state', 'data_integrity'],
      blockingForRelease: true,
    });

    expect(unavailable).toEqual([{ kind: 'autonomous_exploration', status: 'provider_unavailable' }]);
    expect(finished.every((f) => f.status !== 'completed' || f.id !== 'qa_unavail_1')).toBe(true);
    expect(result.data?.gate.verdict).toBe('block');
    expect(result.data?.gate.blockers.some((b) => b.code === 'qa_provider_unavailable')).toBe(true);
  });

  it('does not POST /explorations after create — Replay starts QA itself', async () => {
    const calls: string[] = [];
    const { payment, integrity } = paymentAndIntegrityRows();
    const startedRow = {
      ...payment,
      id: 'qa_replay_1',
      kind: 'autonomous_exploration',
      provider: 'replay',
      status: 'running',
      external_project_id: 'proj_1',
      unavailable_reason: null,
      flows_covered: [],
    };
    const runs = [{ ...startedRow, status: 'failed' }, payment, integrity];

    const deps = {
      providers: {
        forCapability: () => ({
          adapter: {
            createProject: async () => {
              calls.push('createProject');
              return project;
            },
            ensureProjectForTarget: async () => {
              calls.push('ensureProjectForTarget');
              return project;
            },
            startExploration: async () => {
              calls.push('startExploration');
              return { id: 'expl_1', status: 'running' };
            },
            waitForExploration: async () => {
              calls.push('waitForExploration');
              return { id: 'expl_1', status: 'completed', project_id: 'proj_1' };
            },
            waitForProjectIdle: async () => {
              calls.push('waitForProjectIdle');
              return {
                started_at: '2026-08-15T11:00:00.000Z',
                finished_at: '2026-08-15T11:10:00.000Z',
              };
            },
            listBugs: async () => ({ items: [], page: 1, pageSize: 100, hasMore: false }),
            listJourneys: async () => ({
              items: [{ id: 'j1', name: 'Homepage', project_id: 'proj_1' }],
              page: 1,
              pageSize: 100,
              hasMore: false,
            }),
            listExplorations: async () => ({ items: [], page: 1, pageSize: 100, hasMore: false }),
            getExploration: async () => ({ id: 'expl_1', status: 'completed', project_id: 'proj_1' }),
          },
          status: { capability: 'qa.autonomous_exploration', provider: 'replay', state: 'live_verified', usable: true },
        }),
      },
      repos: {
        build: {
          qa: {
            startRun: async () => startedRow,
            markProviderUnavailable: async () => startedRow,
            finishRun: async (id: string, outcome: { status: string }) => {
              calls.push(`finish:${outcome.status}`);
              return { ...startedRow, id, status: outcome.status };
            },
            recordDefect: async () => 'def_1',
            runsForDeployment: async () => runs,
            openDefects: async () => [],
          },
          sites: { setStatus: async () => undefined },
        },
        ledger: { findUnbalancedTransactions: async () => [] },
      },
    } as unknown as ServiceDeps;

    await new QaOrchestrationService(deps).run({
      companyId: 'co_1',
      siteId: 'site_1',
      deploymentId: 'dep_1',
      targetUrl: 'https://shop.example.test',
      kinds: ['autonomous_exploration'],
      blockingForRelease: false,
    });

    expect(calls).not.toContain('startExploration');
    expect(calls).toContain('waitForProjectIdle');
    expect(calls).toContain('finish:completed');
  });

  it('finishes a timed-out Replay wait as failed, not completed', async () => {
    const finished: Array<{ status: string }> = [];
    const { payment, integrity } = paymentAndIntegrityRows();
    const startedRow = {
      ...payment,
      id: 'qa_replay_timeout',
      kind: 'autonomous_exploration',
      provider: 'replay',
      status: 'running',
      external_project_id: 'proj_1',
    };

    const deps = {
      providers: {
        forCapability: () => ({
          adapter: {
            createProject: async () => project,
            ensureProjectForTarget: async () => project,
            startExploration: async () => ({ id: 'expl_1', status: 'running' }),
            waitForExploration: async () => {
              throw new TimeoutError('replay exploration expl_1', 1_000);
            },
            waitForProjectIdle: async () => {
              throw new TimeoutError('replay project proj_1 idle', 1_000);
            },
            listBugs: async () => ({ items: [], page: 1, pageSize: 100, hasMore: false }),
            listJourneys: async () => ({ items: [], page: 1, pageSize: 100, hasMore: false }),
          },
          status: { capability: 'qa.autonomous_exploration', provider: 'replay', state: 'live_verified', usable: true },
        }),
      },
      repos: {
        build: {
          qa: {
            startRun: async () => startedRow,
            markProviderUnavailable: async () => {
              throw new Error('timeout is incomplete, not unavailable');
            },
            finishRun: async (_id: string, outcome: { status: string }) => {
              finished.push({ status: outcome.status });
              return { ...startedRow, status: outcome.status };
            },
            recordDefect: async () => 'def_1',
            runsForDeployment: async () => [
              { ...startedRow, status: 'failed' },
              payment,
              integrity,
            ],
            openDefects: async () => [],
          },
          sites: { setStatus: async () => undefined },
        },
        ledger: { findUnbalancedTransactions: async () => [] },
      },
    } as unknown as ServiceDeps;

    await new QaOrchestrationService(deps).run({
      companyId: 'co_1',
      siteId: 'site_1',
      deploymentId: 'dep_1',
      targetUrl: 'https://shop.example.test',
      kinds: ['autonomous_exploration'],
      blockingForRelease: true,
    });

    expect(finished).toEqual([{ status: 'failed' }]);
    const gate = evaluateReleaseGate({
      environment: 'production',
      runs: [
        {
          kind: 'autonomous_exploration',
          status: 'failed',
          flowsCovered: [],
          unavailableReason: null,
        },
      ],
      openDefects: [],
      requiredFlows: [...CRITICAL_FLOWS],
      requiredRunKinds: PRODUCTION_REQUIRED_RUN_KINDS,
    });
    expect(gate.verdict).toBe('block');
    expect(gate.blockers.some((b) => b.code === 'qa_run_incomplete')).toBe(true);
  });

  it('refuses localhost targets for production-gate runs and never creates a Replay project', async () => {
    const created: string[] = [];
    const finished: Array<{ status: string }> = [];
    const { payment, integrity } = paymentAndIntegrityRows();
    const startedRow = {
      ...payment,
      id: 'qa_replay_localhost',
      kind: 'autonomous_exploration',
      provider: 'replay',
      status: 'running',
      target_url: 'http://localhost:4173/',
    };

    const deps = {
      providers: {
        forCapability: () => ({
          adapter: {
            createProject: async () => {
              created.push('createProject');
              return project;
            },
            ensureProjectForTarget: async () => {
              created.push('ensureProjectForTarget');
              return project;
            },
            startExploration: async () => {
              created.push('startExploration');
              return { id: 'expl_1', status: 'running' };
            },
            waitForProjectIdle: async () => {
              created.push('waitForProjectIdle');
              return { started_at: '2026-08-15T11:00:00.000Z', finished_at: '2026-08-15T11:10:00.000Z' };
            },
            listBugs: async () => ({ items: [], page: 1, pageSize: 100, hasMore: false }),
          },
          status: { capability: 'qa.autonomous_exploration', provider: 'replay', state: 'live_verified', usable: true },
        }),
      },
      repos: {
        build: {
          qa: {
            startRun: async () => startedRow,
            markProviderUnavailable: async () => {
              throw new Error('localhost refusal is a failed run, not provider_unavailable');
            },
            finishRun: async (_id: string, outcome: { status: string }) => {
              finished.push({ status: outcome.status });
              return { ...startedRow, status: outcome.status };
            },
            recordDefect: async () => 'def_1',
            runsForDeployment: async () => [{ ...startedRow, status: 'failed' }, payment, integrity],
            openDefects: async () => [],
          },
          sites: { setStatus: async () => undefined },
        },
        ledger: { findUnbalancedTransactions: async () => [] },
      },
    } as unknown as ServiceDeps;

    const result = await new QaOrchestrationService(deps).run({
      companyId: 'co_1',
      siteId: 'site_1',
      deploymentId: 'dep_1',
      targetUrl: 'http://localhost:4173/',
      kinds: ['autonomous_exploration'],
      blockingForRelease: true,
    });

    expect(created).toEqual([]);
    expect(finished).toEqual([{ status: 'failed' }]);
    expect(result.data?.gate.verdict).toBe('block');
  });

  it('feeds Replay bug reports back as artefacts without inventing a suggested fix', async () => {
    const recorded: Array<{ title: string; suggestedFix: string | null; assignedRoleKey?: string | null }> = [];
    const { payment, integrity } = paymentAndIntegrityRows();
    const startedRow = {
      ...payment,
      id: 'qa_replay_bugs',
      kind: 'autonomous_exploration',
      provider: 'replay',
      status: 'running',
      external_project_id: 'proj_1',
    };
    const openDefect = {
      severity: 'high' as const,
      affected_flow: 'checkout_initiation',
      status: 'open' as const,
    };

    const deps = {
      providers: {
        forCapability: () => ({
          adapter: {
            createProject: async () => project,
            ensureProjectForTarget: async () => project,
            waitForProjectIdle: async () => ({
              started_at: '2026-08-15T11:00:00.000Z',
              finished_at: '2026-08-15T11:10:00.000Z',
            }),
            listBugs: async () => ({
              items: [
                {
                  id: 'bug_checkout_1',
                  project_id: 'proj_1',
                  title: 'Checkout button does nothing',
                  description: 'Clicking Pay never starts a session',
                  status: 'open',
                  url: '/checkout',
                  suggested_fix: null,
                  root_cause: 'form action is empty',
                  recording_url: 'https://qa.replay.io/recordings/rec_1',
                  reproduction_steps: ['Open /checkout', 'Click Pay'],
                },
              ],
              page: 1,
              pageSize: 100,
              hasMore: false,
            }),
            listJourneys: async () => ({
              items: [{ id: 'j1', name: 'Checkout flow', project_id: 'proj_1' }],
              page: 1,
              pageSize: 100,
              hasMore: false,
            }),
            listExplorations: async () => ({ items: [], page: 1, pageSize: 100, hasMore: false }),
            getExploration: async () => ({ id: 'expl_1', status: 'completed', project_id: 'proj_1' }),
            getProjectStatus: async () => ({ explorations: { completed: 1 }, test_runs: { passed: 3 } }),
          },
          status: { capability: 'qa.autonomous_exploration', provider: 'replay', state: 'live_verified', usable: true },
        }),
      },
      repos: {
        build: {
          qa: {
            startRun: async () => startedRow,
            markProviderUnavailable: async () => startedRow,
            finishRun: async (_id: string, outcome: { status: string }) => ({ ...startedRow, status: outcome.status }),
            recordDefect: async (input: { title: string; suggestedFix?: string | null }) => {
              recorded.push({ title: input.title, suggestedFix: input.suggestedFix ?? null });
              return 'def_checkout_1';
            },
            setDefectStatus: async (_id: string, _status: string, assignedRoleKey?: string | null) => {
              recorded[recorded.length - 1] = { ...recorded[recorded.length - 1]!, assignedRoleKey };
            },
            runsForDeployment: async () => [
              { ...startedRow, status: 'completed', flows_covered: ['checkout_initiation'] },
              payment,
              integrity,
            ],
            openDefects: async () => [openDefect],
          },
          sites: { setStatus: async () => undefined },
        },
        ledger: { findUnbalancedTransactions: async () => [] },
      },
    } as unknown as ServiceDeps;

    const result = await new QaOrchestrationService(deps).run({
      companyId: 'co_1',
      siteId: 'site_1',
      deploymentId: 'dep_1',
      targetUrl: 'https://shop.example.test',
      kinds: ['autonomous_exploration'],
      blockingForRelease: false,
    });

    expect(recorded).toEqual([
      { title: 'Checkout button does nothing', suggestedFix: null, assignedRoleKey: 'site_builder' },
    ]);
    expect(result.data?.artefacts).toEqual([
      expect.objectContaining({
        kind: 'qa_defect',
        title: 'Checkout button does nothing',
        suggestedFix: null,
        rootCause: 'form action is empty',
        affectedFlow: 'checkout_initiation',
        assignedRoleKey: 'site_builder',
      }),
    ]);
    expect(result.data?.gate.verdict).toBe('block');
    expect(result.data?.gate.blockers.some((b) => b.code === 'critical_flow_defect')).toBe(true);
  });
});
