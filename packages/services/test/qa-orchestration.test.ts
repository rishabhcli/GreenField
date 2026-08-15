/**
 * An unexecuted QA check is not a passing check. Replay credentials missing
 * must be recorded as provider_unavailable and must fail the release gate.
 */

import { describe, expect, it } from 'vitest';
import { evaluateReleaseGate, PRODUCTION_REQUIRED_RUN_KINDS, CRITICAL_FLOWS } from '@foundry/core';
import type { ServiceDeps } from '../src/deps.js';
import { QaOrchestrationService } from '../src/qa/orchestration.js';

function blockedProviders(): ServiceDeps['providers'] {
  return {
    forCapability: (capability: string) => ({
      adapter: undefined,
      status: {
        capability,
        provider: 'replay',
        state: 'blocked_missing_credentials',
        usable: false,
        evidence: null,
        remediation: 'REPLAY_API_KEY is not set',
        missingSecrets: ['REPLAY_API_KEY'],
        lastVerifiedAt: null,
        alternatives: [],
      },
    }),
    adapter: () => undefined,
  } as unknown as ServiceDeps['providers'];
}

describe('QA unavailable is not a pass', () => {
  it('records provider_unavailable and never finishes the Replay run as completed', async () => {
    const unavailable: Array<{ kind: string; status: string; reason: string }> = [];
    const finished: Array<{ id: string; status: string }> = [];

    const unavailableRow = {
      id: 'qa_unavailable_1',
      company_id: 'co_1',
      site_id: 'site_1',
      deployment_id: 'dep_1',
      kind: 'autonomous_exploration',
      provider: 'replay',
      external_project_id: null,
      external_run_id: null,
      target_url: 'https://preview.example.test',
      status: 'provider_unavailable',
      flows_covered: [],
      defect_counts: {},
      unavailable_reason: 'REPLAY_API_KEY is not set',
      started_at: null,
      finished_at: new Date(),
      evidence_url: null,
    };

    const paymentRow = {
      ...unavailableRow,
      id: 'qa_payment_1',
      kind: 'payment_state',
      provider: 'in_process',
      status: 'completed',
      unavailable_reason: null,
      flows_covered: ['checkout_initiation', 'payment_success_path', 'payment_failure_path'],
    };

    const integrityRow = {
      ...unavailableRow,
      id: 'qa_integrity_1',
      kind: 'data_integrity',
      provider: 'ledger',
      status: 'completed',
      unavailable_reason: null,
      flows_covered: [],
    };

    const runs = [unavailableRow, paymentRow, integrityRow];

    const deps = {
      providers: blockedProviders(),
      repos: {
        build: {
          qa: {
            startRun: async (input: { kind: string }) => {
              if (input.kind === 'autonomous_exploration') {
                throw new Error('startRun must not run Replay when the provider is unavailable');
              }
              if (input.kind === 'payment_state') return paymentRow;
              return integrityRow;
            },
            markProviderUnavailable: async (input: { kind: string; reason: string }) => {
              unavailable.push({ kind: input.kind, status: 'provider_unavailable', reason: input.reason });
              return unavailableRow;
            },
            finishRun: async (id: string, outcome: { status: string }) => {
              finished.push({ id, status: outcome.status });
              return { ...paymentRow, id, status: outcome.status };
            },
            recordDefect: async () => 'def_1',
            evaluateGate: async () =>
              evaluateReleaseGate({
                environment: 'production',
                runs: runs.map((r) => ({
                  kind: r.kind as 'autonomous_exploration',
                  status: r.status as 'provider_unavailable',
                  flowsCovered: r.flows_covered as [],
                  unavailableReason: r.unavailable_reason,
                })),
                openDefects: [],
                requiredFlows: [...CRITICAL_FLOWS],
                requiredRunKinds: PRODUCTION_REQUIRED_RUN_KINDS,
              }),
            runsForDeployment: async () => runs,
            openDefects: async () => [],
          },
          sites: {
            setStatus: async () => undefined,
          },
        },
        ledger: {
          findUnbalancedTransactions: async () => [],
        },
      },
    } as unknown as ServiceDeps;

    const result = await new QaOrchestrationService(deps).run({
      companyId: 'co_1',
      siteId: 'site_1',
      deploymentId: 'dep_1',
      targetUrl: 'https://preview.example.test',
      kinds: ['autonomous_exploration', 'payment_state', 'data_integrity'],
      blockingForRelease: true,
    });

    expect(unavailable).toHaveLength(1);
    expect(unavailable[0]?.kind).toBe('autonomous_exploration');
    expect(unavailable[0]?.status).toBe('provider_unavailable');
    expect(unavailable[0]?.status).not.toBe('passed');
    expect(unavailable[0]?.status).not.toBe('completed');
    expect(finished.every((f) => f.id !== 'qa_unavailable_1' || f.status !== 'completed')).toBe(true);

    expect(result.data?.gate.verdict).toBe('block');
    expect(result.data?.gate.blockers.some((b) => b.code === 'qa_provider_unavailable')).toBe(true);

    const gate = evaluateReleaseGate({
      environment: 'production',
      runs: [
        {
          kind: 'autonomous_exploration',
          status: 'provider_unavailable',
          flowsCovered: [],
          unavailableReason: 'REPLAY_API_KEY is not set',
        },
      ],
      openDefects: [],
      requiredFlows: [...CRITICAL_FLOWS],
      requiredRunKinds: PRODUCTION_REQUIRED_RUN_KINDS,
    });
    expect(gate.verdict).toBe('block');
    expect(gate.blockers.some((b) => b.detail.includes('unexecuted check is not a passing check'))).toBe(true);
  });
});
