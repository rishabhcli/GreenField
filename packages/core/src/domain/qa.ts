/**
 * QA domain and the release gate.
 *
 * The gate has veto power. `evaluateReleaseGate` is a pure function so the exact
 * conditions under which a storefront may reach production are reviewable in one
 * place, and so a passing gate always has an evidence trail behind it.
 */

import { z } from 'zod';

export const DefectSeverity = z.enum(['critical', 'high', 'medium', 'low', 'info']);
export type DefectSeverity = z.infer<typeof DefectSeverity>;

/**
 * Flows whose failure blocks a release outright. These are the paths between a
 * visitor and money; nothing else is worth shipping if one of them is broken.
 */
export const CRITICAL_FLOWS = [
  'homepage_loads',
  'product_page_loads',
  'add_to_cart',
  'checkout_initiation',
  'payment_success_path',
  'payment_failure_path',
  'order_confirmation',
  'support_contact_reachable',
  'policy_pages_reachable',
  'mobile_layout_usable',
] as const;
export const CriticalFlow = z.enum(CRITICAL_FLOWS);
export type CriticalFlow = z.infer<typeof CriticalFlow>;

export const QaRunKind = z.enum([
  'autonomous_exploration',
  'browser_e2e',
  'api_contract',
  'payment_state',
  'accessibility',
  'security_smoke',
  'data_integrity',
]);
export type QaRunKind = z.infer<typeof QaRunKind>;

export const QaRunStatus = z.enum(['queued', 'running', 'completed', 'failed', 'cancelled', 'provider_unavailable']);
export type QaRunStatus = z.infer<typeof QaRunStatus>;

export const Defect = z.object({
  id: z.string().min(1),
  companyId: z.string().min(1),
  qaRunId: z.string().min(1),
  provider: z.string().min(1),
  externalId: z.string().nullable(),
  title: z.string().min(1),
  description: z.string().min(1),
  severity: DefectSeverity,
  /** Which critical flow this breaks, when it maps to one. */
  affectedFlow: CriticalFlow.nullable(),
  reproductionSteps: z.array(z.string()).default([]),
  rootCause: z.string().nullable(),
  suggestedFix: z.string().nullable(),
  /** Recording/replay link — the evidence for the release record. */
  evidenceUrl: z.string().url().nullable(),
  status: z.enum(['open', 'assigned', 'fixed', 'wontfix', 'invalid', 'reopened']),
  assignedRoleKey: z.string().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Defect = z.infer<typeof Defect>;

export const QaRun = z.object({
  id: z.string().min(1),
  companyId: z.string().min(1),
  siteId: z.string().nullable(),
  deploymentId: z.string().nullable(),
  kind: QaRunKind,
  provider: z.string().min(1),
  externalProjectId: z.string().nullable(),
  externalRunId: z.string().nullable(),
  targetUrl: z.string().url(),
  status: QaRunStatus,
  /** Flows the run actually exercised — not the flows we hoped it would. */
  flowsCovered: z.array(CriticalFlow).default([]),
  defectCounts: z.partialRecord(DefectSeverity, z.number().int().nonnegative()).default({}),
  /** Why the run could not execute, e.g. provider not activated. */
  unavailableReason: z.string().nullable(),
  startedAt: z.string().datetime().nullable(),
  finishedAt: z.string().datetime().nullable(),
  evidenceUrl: z.string().url().nullable(),
  createdAt: z.string().datetime(),
});
export type QaRun = z.infer<typeof QaRun>;

export interface ReleaseGateInput {
  readonly environment: 'preview' | 'staging' | 'production';
  readonly runs: readonly Pick<QaRun, 'kind' | 'status' | 'flowsCovered' | 'unavailableReason'>[];
  readonly openDefects: readonly Pick<Defect, 'severity' | 'affectedFlow' | 'status'>[];
  /** Flows required for this release. Production requires all critical flows. */
  readonly requiredFlows: readonly CriticalFlow[];
  /** Run kinds that must have completed. */
  readonly requiredRunKinds: readonly QaRunKind[];
}

export type ReleaseGateVerdict = 'pass' | 'block';

export interface ReleaseGateResult {
  readonly verdict: ReleaseGateVerdict;
  readonly blockers: readonly { code: string; detail: string }[];
  readonly warnings: readonly { code: string; detail: string }[];
  readonly coveredFlows: readonly CriticalFlow[];
  readonly uncoveredFlows: readonly CriticalFlow[];
}

export const PRODUCTION_REQUIRED_RUN_KINDS: readonly QaRunKind[] = [
  'autonomous_exploration',
  'browser_e2e',
  'payment_state',
  'data_integrity',
];

/** Honest Replay prize-method blocker until a clean completed exploration exists. */
export const REPLAY_QA_BLOCKER =
  'Replay journeys recording-lost (infra-failed). 0 product bugs ≠ pass. No clean completed exploration.';

export function isQaInfraFailureReason(reason: string | null | undefined): boolean {
  if (!reason) return false;
  return /recording[-_ ]lost|infra[-_ ]failed/i.test(reason);
}

/**
 * The gate.
 *
 * A run that could not execute because its provider is not activated does not
 * silently pass — it becomes a blocker for production, because "we never
 * checked" and "we checked and it was fine" are different facts.
 */
export function evaluateReleaseGate(input: ReleaseGateInput): ReleaseGateResult {
  const blockers: { code: string; detail: string }[] = [];
  const warnings: { code: string; detail: string }[] = [];
  const isProduction = input.environment === 'production';

  // 1. Required run kinds must have completed.
  for (const kind of input.requiredRunKinds) {
    const run = input.runs.find((r) => r.kind === kind);
    if (!run) {
      const entry = { code: 'qa_run_missing', detail: `no ${kind} run was executed for this release` };
      isProduction ? blockers.push(entry) : warnings.push(entry);
      continue;
    }
    if (run.status === 'provider_unavailable') {
      const entry = {
        code: 'qa_provider_unavailable',
        detail:
          `${kind} could not run: ${run.unavailableReason ?? 'provider not activated'}. ` +
          `An unexecuted check is not a passing check.`,
      };
      isProduction ? blockers.push(entry) : warnings.push(entry);
      continue;
    }
    if (isQaInfraFailureReason(run.unavailableReason)) {
      blockers.push({
        code: 'qa_infra_failed',
        detail:
          `${kind} ended ${run.unavailableReason}. 0 product bugs after an infra-failed run is not a pass.`,
      });
      continue;
    }
    if (run.status === 'running') {
      blockers.push({
        code: 'qa_run_incomplete',
        detail: `${kind} is still running. An unexecuted check is not a passing check.`,
      });
      continue;
    }
    if (run.status !== 'completed') {
      const entry = { code: 'qa_run_incomplete', detail: `${kind} finished with status "${run.status}"` };
      isProduction ? blockers.push(entry) : warnings.push(entry);
    }
  }

  // 2. Critical flow coverage.
  const coveredFlows = [...new Set(input.runs.filter((r) => r.status === 'completed').flatMap((r) => r.flowsCovered))];
  const uncoveredFlows = input.requiredFlows.filter((f) => !coveredFlows.includes(f));
  if (uncoveredFlows.length > 0) {
    const entry = {
      code: 'critical_flow_uncovered',
      detail: `these required flows were never exercised: ${uncoveredFlows.join(', ')}`,
    };
    isProduction ? blockers.push(entry) : warnings.push(entry);
  }

  // 3. Open defects.
  const open = input.openDefects.filter((d) => d.status === 'open' || d.status === 'reopened' || d.status === 'assigned');
  const criticals = open.filter((d) => d.severity === 'critical');
  if (criticals.length > 0) {
    blockers.push({
      code: 'critical_defect_open',
      detail: `${criticals.length} critical defect(s) open`,
    });
  }
  const flowBreaking = open.filter((d) => d.affectedFlow !== null && d.severity === 'high');
  if (flowBreaking.length > 0) {
    blockers.push({
      code: 'critical_flow_defect',
      detail: `high-severity defects on commerce flows: ${[...new Set(flowBreaking.map((d) => d.affectedFlow))].join(', ')}`,
    });
  }
  const mediums = open.filter((d) => d.severity === 'medium');
  if (mediums.length > 0) {
    warnings.push({ code: 'medium_defects_open', detail: `${mediums.length} medium-severity defect(s) open` });
  }

  return {
    verdict: blockers.length === 0 ? 'pass' : 'block',
    blockers,
    warnings,
    coveredFlows,
    uncoveredFlows,
  };
}

/**
 * Loop `assess('qa')` should complete only when this is true. A failed,
 * running, or recording-lost Replay run is not a phase artefact.
 */
export function isReplayQaPhaseComplete(input: {
  readonly runs: ReleaseGateInput['runs'];
  readonly openDefects: ReleaseGateInput['openDefects'];
}): boolean {
  return (
    evaluateReleaseGate({
      environment: 'production',
      runs: input.runs,
      openDefects: input.openDefects,
      requiredFlows: CRITICAL_FLOWS,
      requiredRunKinds: PRODUCTION_REQUIRED_RUN_KINDS,
    }).verdict === 'pass'
  );
}
