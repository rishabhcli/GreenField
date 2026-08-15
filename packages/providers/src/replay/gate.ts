/**
 * Replay QA → release gate bridge.
 *
 * Replay documents no built-in pass/fail CI check (`REPLAY_MANIFEST.capabilities`
 * records this explicitly). The gate is therefore computed entirely on our
 * side: this module turns a project + exploration + its bugs into the shape
 * `evaluateReleaseGate` (in `@foundry/core`'s `domain/qa.ts`) consumes.
 *
 * Every mapping here that is not directly documented is a heuristic, and each
 * one says so at the point it is applied, rather than presenting a guess as a
 * confirmed fact. None of it is guesswork about *whether* a bug is real —
 * every bug and every status comes from a real Replay API response. The
 * heuristics are only about which bucket (severity, flow) a real, observed bug
 * falls into.
 */

import type { CriticalFlow, Defect, DefectSeverity, QaRunKind, QaRunStatus } from '@foundry/core';
import type { ReplayBug, ReplayExploration, ReplayJourney, ReplayProject, ReplayProjectTiming } from './schemas.js';

/* -------------------------------------------------------------------------- */
/* Exploration status                                                         */
/* -------------------------------------------------------------------------- */

const TERMINAL_SUCCESS_WORDS = /^(complete|completed|done|finished|succeeded|success)$/i;
const TERMINAL_FAILURE_WORDS = /^(failed|error|errored)$/i;
const TERMINAL_CANCELLED_WORDS = /^(cancelled|canceled|aborted)$/i;

/**
 * UNVERIFIED: Replay's exact exploration status strings were never published.
 * `waitForExploration` (in `index.ts`) polls until this returns true, and this
 * function alone decides the gate's `completed`/`failed`/`cancelled`/`running`
 * classification below — matching keyword families rather than an exact enum
 * so the poller does not spin forever on a real terminal status spelled
 * slightly differently than guessed.
 */
export function isTerminalExplorationStatus(status: string): boolean {
  const s = status.trim();
  return TERMINAL_SUCCESS_WORDS.test(s) || TERMINAL_FAILURE_WORDS.test(s) || TERMINAL_CANCELLED_WORDS.test(s);
}

/** Replay documents `finished_at` on project timing as the idle signal. */
export function isProjectIdle(timing: Pick<ReplayProjectTiming, 'finished_at'>): boolean {
  return typeof timing.finished_at === 'string' && timing.finished_at.trim().length > 0;
}

/** Live explorations use `completed_at` and `in-progress`; either timestamp or a terminal status means done. */
export function isExplorationFinished(
  exploration: Pick<ReplayExploration, 'status' | 'finished_at'> & { readonly completed_at?: string | null },
): boolean {
  if (isTerminalExplorationStatus(exploration.status)) return true;
  if (typeof exploration.finished_at === 'string' && exploration.finished_at.trim().length > 0) return true;
  if (typeof exploration.completed_at === 'string' && exploration.completed_at.trim().length > 0) return true;
  return false;
}

function countField(raw: unknown, keys: readonly string[]): number {
  if (!raw || typeof raw !== 'object') return 0;
  const rec = raw as Record<string, unknown>;
  let total = 0;
  for (const key of keys) {
    const n = rec[key];
    if (typeof n === 'number' && n > 0) total += n;
  }
  return total;
}

/**
 * Live `GET /projects/{id}/status` nests counts under `explorations` / `test_runs`.
 * Zero in-flight after work has started is idle even when `finished_at` lags.
 */
export function isProjectWorkIdle(
  status: { readonly explorations?: unknown; readonly test_runs?: unknown },
  timing: Pick<ReplayProjectTiming, 'started_at' | 'first_event_at' | 'finished_at'>,
): boolean {
  if (isProjectIdle(timing)) return true;
  const started = Boolean(timing.started_at) || Boolean(timing.first_event_at);
  if (!started) return false;
  const inflightKeys = ['in-progress', 'in_progress', 'inProgress', 'queued'] as const;
  return countField(status.explorations, inflightKeys) === 0 && countField(status.test_runs, inflightKeys) === 0;
}

function normalizeReproductionSteps(raw: ReplayBug['reproduction_steps']): readonly string[] {
  if (Array.isArray(raw)) return raw.filter((step) => step.trim().length > 0);
  if (typeof raw === 'string' && raw.trim().length > 0) return [raw.trim()];
  return [];
}

function qaRunStatusFromExplorationStatus(status: string): QaRunStatus {
  const s = status.trim();
  if (TERMINAL_FAILURE_WORDS.test(s)) return 'failed';
  if (TERMINAL_CANCELLED_WORDS.test(s)) return 'cancelled';
  if (TERMINAL_SUCCESS_WORDS.test(s)) return 'completed';
  return 'running';
}

/* -------------------------------------------------------------------------- */
/* Flow heuristic                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Keyword families matched against a URL path and/or free text (bug title,
 * description, journey name) to guess which `CriticalFlow` was involved.
 * Ordered so more specific matches (checkout/payment) are tried before
 * generic ones (homepage `/`), since a payment failure page's URL often also
 * contains generic words. This is a heuristic, not a confirmed mapping —
 * Replay does not tag bugs or journeys with one of our `CriticalFlow` values.
 */
const FLOW_KEYWORDS: readonly { readonly flow: CriticalFlow; readonly patterns: readonly RegExp[] }[] = [
  { flow: 'payment_failure_path', patterns: [/payment.*(fail|decline|error)/i, /(fail|decline).*payment/i] },
  { flow: 'payment_success_path', patterns: [/payment/i, /\/pay(\/|$)/i] },
  { flow: 'checkout_initiation', patterns: [/checkout/i, /\/cart\/checkout/i] },
  { flow: 'order_confirmation', patterns: [/order.?confirm/i, /thank.?you/i, /\/orders?\/[\w-]+/i, /receipt/i] },
  { flow: 'add_to_cart', patterns: [/add.?to.?cart/i, /\/cart(\/|$|\?)/i, /basket/i] },
  { flow: 'support_contact_reachable', patterns: [/support/i, /contact/i, /help.?center/i] },
  { flow: 'policy_pages_reachable', patterns: [/privacy/i, /terms/i, /refund.?policy/i, /shipping.?policy/i] },
  { flow: 'mobile_layout_usable', patterns: [/mobile/i, /small.?viewport/i, /responsive/i] },
  { flow: 'product_page_loads', patterns: [/\/products?\/[\w-]+/i, /product.?page/i, /\/p\/[\w-]+/i] },
  // `url` may be a bare path ("/") or a full absolute URL ("https://host/");
  // both forms of "nothing after the root" must match, but an empty string
  // (e.g. a blank title on some other flow's bug) must not.
  { flow: 'homepage_loads', patterns: [/^\/$/, /^https?:\/\/[^/]+\/?$/, /home.?page/i] },
];

function matchFlow(...texts: readonly (string | null | undefined)[]): CriticalFlow | null {
  for (const { flow, patterns } of FLOW_KEYWORDS) {
    for (const text of texts) {
      if (!text) continue;
      if (patterns.some((p) => p.test(text))) return flow;
    }
  }
  return null;
}

/**
 * Heuristic: guesses which critical commerce flow a bug affects from its URL,
 * title and description. Replay does not tag bugs with one of our
 * `CriticalFlow` values, so a `null` result (no keyword matched) is a real,
 * honest outcome — it means "this bug's flow could not be determined from the
 * available text", not "this bug affects no flow".
 */
export function flowFromBug(bug: ReplayBug): CriticalFlow | null {
  return matchFlow(bug.url, bug.title, bug.description);
}

/** Same heuristic applied to a journey, used to estimate flow *coverage* (see `toQaRunAndDefects`). */
function flowFromJourney(journey: ReplayJourney): CriticalFlow | null {
  return matchFlow(journey.name, journey.description);
}

/* -------------------------------------------------------------------------- */
/* Severity heuristic                                                         */
/* -------------------------------------------------------------------------- */

const SEVERITY_WORD_MAP: Readonly<Record<string, DefectSeverity>> = {
  blocker: 'critical',
  critical: 'critical',
  p0: 'critical',
  sev0: 'critical',
  sev1: 'critical',
  high: 'high',
  p1: 'high',
  major: 'high',
  medium: 'medium',
  moderate: 'medium',
  p2: 'medium',
  low: 'low',
  minor: 'low',
  p3: 'low',
  trivial: 'info',
  cosmetic: 'info',
  info: 'info',
};

const CRASH_KEYWORDS = /crash|cannot\s|unable to|does not work|doesn'?t work|500 error|unhandled|blocks?\s|broken/i;

/** Flows where a bug is never allowed to be classified below `high`, regardless of wording. */
const MONEY_PATH_FLOWS: ReadonlySet<CriticalFlow> = new Set([
  'checkout_initiation',
  'payment_success_path',
  'payment_failure_path',
  'order_confirmation',
]);

/**
 * Heuristic, in two layers, because Replay's docs show a `status` vocabulary
 * for bugs but no `severity`/`priority` field at all:
 *
 *  1. If the bug carries a `severity` or `priority` string, map recognised
 *     words onto `DefectSeverity`.
 *  2. Otherwise, infer from context: a bug on a money-moving flow (cart,
 *     checkout, payment, order confirmation) is never rated below `high`,
 *     and crash-like language in the title/description pushes it to
 *     `critical`. Everything else defaults to `medium` — never silently
 *     defaulted to `low`, which would risk a real defect being invisible to
 *     the gate's severity-based blockers.
 */
export function severityFromBug(bug: ReplayBug): DefectSeverity {
  const raw = (bug.severity ?? bug.priority ?? '').toLowerCase().trim();
  const mapped = SEVERITY_WORD_MAP[raw];
  if (mapped) return mapped;

  const flow = flowFromBug(bug);
  const looksLikeCrash = CRASH_KEYWORDS.test(`${bug.title} ${bug.description ?? ''}`);

  if (flow && MONEY_PATH_FLOWS.has(flow)) {
    return looksLikeCrash ? 'critical' : 'high';
  }
  if (looksLikeCrash) return 'critical';
  return 'medium';
}

/* -------------------------------------------------------------------------- */
/* Defect status                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Heuristic for the two Replay bug statuses with no clean equivalent in core's
 * `Defect.status` enum:
 *
 *  - `judge-rejected` — an automated judge rejected a proposed fix. The
 *    underlying defect is therefore still unresolved, so it is treated as
 *    `open`, not `invalid`.
 *  - `pr-closed` — a linked pull request was closed. This is ambiguous (merged
 *    and shipped, vs. abandoned) and Replay's docs do not disambiguate it. For
 *    a release gate, a false "fixed" is far more dangerous than a false
 *    "open": shipping on the belief that a payment-path bug is fixed when the
 *    PR was actually abandoned would ship the bug. It is therefore also
 *    treated conservatively as `open` until Replay reports the unambiguous
 *    `fixed` status.
 */
function defectStatusFromBugStatus(status: ReplayBug['status']): Defect['status'] {
  switch (status) {
    case 'open':
      return 'open';
    case 'reopened':
      return 'reopened';
    case 'fixed':
      return 'fixed';
    case 'wontfix':
      return 'wontfix';
    case 'invalid':
      return 'invalid';
    case 'judge-rejected':
    case 'pr-closed':
      return 'open';
  }
}

/* -------------------------------------------------------------------------- */
/* Bridge                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The Replay-derived slice of a `QaRun`. A structural superset of
 * `Pick<QaRun, 'kind' | 'status' | 'flowsCovered' | 'unavailableReason'>`, so
 * it can be passed directly into `evaluateReleaseGate`'s `runs` array, plus
 * enough extra fields (`externalProjectId`, `externalRunId`, `targetUrl`,
 * `defectCounts`, timestamps, `evidenceUrl`) that a persistence layer can
 * build the full row by adding only what it alone knows: `id`, `companyId`,
 * `siteId`/`deploymentId`, `provider`, `createdAt`.
 */
export interface ReplayDerivedQaRun {
  readonly kind: QaRunKind;
  readonly status: QaRunStatus;
  readonly flowsCovered: readonly CriticalFlow[];
  readonly unavailableReason: string | null;
  readonly externalProjectId: string;
  readonly externalRunId: string;
  readonly targetUrl: string;
  readonly defectCounts: Partial<Record<DefectSeverity, number>>;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly evidenceUrl: string | null;
}

/**
 * The Replay-derived slice of a `Defect`. A structural superset of
 * `Pick<Defect, 'severity' | 'affectedFlow' | 'status'>` for the same reason.
 */
export interface ReplayDerivedDefect {
  readonly severity: DefectSeverity;
  readonly affectedFlow: CriticalFlow | null;
  readonly status: Defect['status'];
  readonly externalId: string;
  readonly title: string;
  readonly description: string;
  readonly reproductionSteps: readonly string[];
  readonly rootCause: string | null;
  readonly suggestedFix: string | null;
  readonly evidenceUrl: string | null;
}

/**
 * Turns a project + exploration + its bugs into inputs for
 * `evaluateReleaseGate`. Flow coverage is derived from the exploration's
 * *journeys* (a journey is, by definition, a user flow that was actually
 * exercised) rather than from bugs — a flow can be tested and pass with zero
 * bugs found, so deriving coverage from bugs alone would understate it. When
 * the exploration response carries only `journey_ids` (no inline journey
 * objects, e.g. because the caller did not also fetch full journeys), flow
 * coverage falls back to whatever `flowFromBug` can infer from the bugs that
 * did occur — a documented, disclosed lower bound, not a silent gap.
 */
export function toQaRunAndDefects(
  project: ReplayProject,
  exploration: ReplayExploration,
  bugs: readonly ReplayBug[],
): { readonly run: ReplayDerivedQaRun; readonly defects: readonly ReplayDerivedDefect[] } {
  const defects: ReplayDerivedDefect[] = bugs.map((bug) => ({
    severity: severityFromBug(bug),
    affectedFlow: flowFromBug(bug),
    status: defectStatusFromBugStatus(bug.status),
    externalId: bug.id,
    title: bug.title,
    description: bug.description ?? bug.title,
    reproductionSteps: [...normalizeReproductionSteps(bug.reproduction_steps)],
    rootCause: bug.root_cause ?? null,
    suggestedFix: bug.suggested_fix ?? null,
    evidenceUrl: bug.recording_url ?? null,
  }));

  const defectCounts: Partial<Record<DefectSeverity, number>> = {};
  for (const defect of defects) {
    defectCounts[defect.severity] = (defectCounts[defect.severity] ?? 0) + 1;
  }

  const journeys = exploration.journeys ?? [];
  const flowsFromJourneys = journeys.map((j) => flowFromJourney(j)).filter((f): f is CriticalFlow => f !== null);
  const flowsFromBugs = defects.map((d) => d.affectedFlow).filter((f): f is CriticalFlow => f !== null);
  // Prefer journey-derived coverage (it reflects what was actually exercised,
  // pass or fail); only fall back to bug-derived coverage when we have no
  // inline journey objects to look at at all.
  const flowsCovered = [...new Set(journeys.length > 0 ? flowsFromJourneys : flowsFromBugs)];

  const run: ReplayDerivedQaRun = {
    kind: 'autonomous_exploration',
    status: qaRunStatusFromExplorationStatus(exploration.status),
    flowsCovered,
    // This bridge only ever runs on a successful API response, so there is no
    // "provider unavailable" case to report here — that state is set by the
    // caller before this function is ever reached (e.g. when the adapter
    // itself throws `CredentialsMissingError`).
    unavailableReason: null,
    externalProjectId: project.id,
    externalRunId: exploration.id,
    targetUrl: project.target_url,
    defectCounts,
    startedAt: exploration.started_at ?? null,
    finishedAt: exploration.finished_at ?? exploration.completed_at ?? null,
    evidenceUrl: project.url ?? null,
  };

  return { run, defects };
}

/**
 * Project-level bridge used after `POST /projects` (which starts QA itself).
 * An idle project that never started work is `failed`, not `completed` —
 * unexecuted QA is not a pass.
 */
export function toQaRunFromProject(
  project: ReplayProject,
  timing: Pick<ReplayProjectTiming, 'started_at' | 'finished_at'>,
  bugs: readonly ReplayBug[],
  journeys: readonly ReplayJourney[] = [],
  exploration?: ReplayExploration | null,
): { readonly run: ReplayDerivedQaRun; readonly defects: readonly ReplayDerivedDefect[] } {
  const executed =
    Boolean(timing.started_at) ||
    journeys.length > 0 ||
    bugs.length > 0 ||
    Boolean(exploration && (exploration.started_at || (exploration.journeys?.length ?? 0) > 0));

  const explorationDone = Boolean(exploration && isExplorationFinished(exploration));
  let status: string;
  if (!isProjectIdle(timing) && !explorationDone) {
    status = exploration?.status ?? 'running';
  } else if (!executed) {
    status = 'failed';
  } else {
    status =
      exploration?.status && isTerminalExplorationStatus(exploration.status) ? exploration.status : 'completed';
  }

  const resolved: ReplayExploration = {
    id: exploration?.id ?? project.exploration_id ?? `project:${project.id}`,
    project_id: exploration?.project_id ?? project.id,
    status,
    prompt: exploration?.prompt,
    journeys:
      exploration?.journeys && exploration.journeys.length > 0 ? exploration.journeys : [...journeys],
    journey_ids: exploration?.journey_ids,
    bugs: exploration?.bugs,
    bug_ids: exploration?.bug_ids,
    started_at: exploration?.started_at ?? timing.started_at ?? null,
    finished_at: exploration?.finished_at ?? exploration?.completed_at ?? timing.finished_at ?? null,
    completed_at: exploration?.completed_at ?? null,
    created_at: exploration?.created_at,
  };

  return toQaRunAndDefects(project, resolved, bugs);
}
