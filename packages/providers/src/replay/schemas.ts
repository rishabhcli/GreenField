/**
 * Zod schemas for the Replay QA objects we consume.
 *
 * These are intentionally narrow, per the same philosophy as the Stripe
 * adapter: only the fields this system actually reads. Two things are
 * genuinely uncertain in the published docs and are called out at the point
 * of use rather than modelled as if confirmed:
 *
 *  - The canonical API host (`loop-qa.replay.io` vs `qa.replay.io`) — handled
 *    by `resolveBaseUrl()` in `index.ts`, not by anything here.
 *  - Exploration status vocabulary and the bugs/journeys list envelope shape:
 *    the research pass confirmed the *query parameters* (`page`, `page_size`)
 *    but never a sample response body for a list endpoint, and confirmed no
 *    bug `severity` field at all. Both are modelled defensively below with a
 *    comment at each uncertain field.
 */

import { z } from 'zod';

/* -------------------------------------------------------------------------- */
/* OpenAPI discovery document                                                 */
/* -------------------------------------------------------------------------- */

/** Only `servers[0].url` is read; everything else in the document is ignored. */
export const ReplayOpenApiDocument = z
  .object({
    servers: z.array(z.object({ url: z.string().min(1) }).passthrough()).min(1),
  })
  .passthrough();
export type ReplayOpenApiDocument = z.infer<typeof ReplayOpenApiDocument>;

/* -------------------------------------------------------------------------- */
/* List envelope                                                              */
/* -------------------------------------------------------------------------- */

/**
 * UNVERIFIED: the response envelope for a paginated list (bugs, journeys) was
 * never shown — only the `page`/`page_size` query parameters are documented.
 * We accept the conventional `{items, page, page_size, ...}` object shape and
 * also a bare JSON array, so a real delivery in either shape still parses
 * instead of throwing a contract error on the first live call. A bare array is
 * treated as a single, complete page (no further pages), which is the
 * conservative reading — it under-claims pagination rather than guessing at
 * fields (`has_more`, `total`) that may not exist.
 */
export function replayListEnvelope<T extends z.ZodTypeAny>(item: T) {
  return z.union([
    z
      .object({
        items: z.array(item).optional(),
        data: z.array(item).optional(),
        results: z.array(item).optional(),
        page: z.number().int().positive().nullish(),
        page_size: z.number().int().positive().nullish(),
        total: z.number().int().nonnegative().nullish(),
        total_count: z.number().int().nonnegative().nullish(),
        has_more: z.boolean().nullish(),
      })
      .passthrough(),
    z.array(item),
  ]);
}

export interface ReplayListPage<T> {
  readonly items: readonly T[];
  readonly page: number;
  readonly pageSize: number;
  readonly hasMore: boolean;
}

/** Normalises the two accepted envelope shapes from `replayListEnvelope`. */
export function normaliseReplayList<T>(
  raw: readonly T[] | { items?: T[]; data?: T[]; results?: T[]; page?: number | null; page_size?: number | null; total?: number | null; total_count?: number | null; has_more?: boolean | null },
  requestedPage: number,
  requestedPageSize: number,
): ReplayListPage<T> {
  if (Array.isArray(raw)) {
    return { items: raw as readonly T[], page: requestedPage, pageSize: requestedPageSize, hasMore: false };
  }
  // `Array.isArray` does not narrow away a `readonly T[]` union member, so the
  // envelope branch is named explicitly rather than relying on inference.
  const envelope = raw as Exclude<typeof raw, readonly T[]>;
  const items = envelope.items ?? envelope.data ?? envelope.results ?? [];
  const page = envelope.page ?? requestedPage;
  const pageSize = envelope.page_size ?? requestedPageSize;
  const hasMore =
    envelope.has_more ??
    (envelope.total != null
      ? page * pageSize < envelope.total
      : envelope.total_count != null
        ? page * pageSize < envelope.total_count
        : items.length >= pageSize);
  return { items, page, pageSize, hasMore };
}

/* -------------------------------------------------------------------------- */
/* Projects                                                                    */
/* -------------------------------------------------------------------------- */

export const ReplayProject = z
  .object({
    id: z.string(),
    name: z.string(),
    target_url: z.string(),
    url: z.string().nullish(),
    exploration_id: z.string().nullish(),
    webhook_url: z.string().nullish(),
    finished_webhook_url: z.string().nullish(),
    status: z.string().nullish(),
    created_at: z.string().nullish(),
  })
  .passthrough();
export type ReplayProject = z.infer<typeof ReplayProject>;

/** `GET /projects/{id}/status`. Exact field set beyond `status` UNVERIFIED. */
/** `GET /projects/{id}/status`. Field set beyond a status string is UNVERIFIED. */
export const ReplayProjectStatus = z
  .object({
    status: z.string().nullish(),
    finished_at: z.string().nullish(),
    started_at: z.string().nullish(),
    project: z.unknown().optional(),
    bugs: z.unknown().optional(),
    journeys: z.unknown().optional(),
    test_runs: z.unknown().optional(),
    explorations: z.unknown().optional(),
  })
  .passthrough();
export type ReplayProjectStatus = z.infer<typeof ReplayProjectStatus>;

/**
 * `GET /projects/{id}/timing`. Documented idle signal: `finished_at` is set
 * when QA last went idle and is null while work is still running.
 */
export const ReplayProjectTiming = z
  .object({
    created_at: z.string().nullish(),
    started_at: z.string().nullish(),
    first_event_at: z.string().nullish(),
    finished_at: z.string().nullish(),
    time_to_first_event_ms: z.number().nullish(),
    time_to_complete_ms: z.number().nullish(),
  })
  .passthrough();
export type ReplayProjectTiming = z.infer<typeof ReplayProjectTiming>;

/* -------------------------------------------------------------------------- */
/* Journeys                                                                    */
/* -------------------------------------------------------------------------- */

export const ReplayJourney = z
  .object({
    id: z.string(),
    project_id: z.string().nullish(),
    name: z.string(),
    description: z.string().nullish(),
    // Step schema UNVERIFIED; kept opaque rather than typed.
    steps: z.array(z.unknown()).nullish(),
    created_at: z.string().nullish(),
  })
  .passthrough();
export type ReplayJourney = z.infer<typeof ReplayJourney>;

/* -------------------------------------------------------------------------- */
/* Bugs                                                                        */
/* -------------------------------------------------------------------------- */

/** Documented status vocabulary for `PATCH /bugs/{id}`. */
export const ReplayBugStatus = z.enum(['open', 'reopened', 'fixed', 'wontfix', 'invalid', 'judge-rejected', 'pr-closed']);
export type ReplayBugStatus = z.infer<typeof ReplayBugStatus>;

/**
 * `status` is documented. `severity`/`priority` are NOT — no such field was
 * shown anywhere in the research pass. Both plausible names are modelled as
 * optional so a real value is used if the API does send one; `severityFromBug`
 * in `gate.ts` falls back to a keyword heuristic when neither is present,
 * rather than defaulting every bug to the same severity.
 */
export const ReplayBug = z
  .object({
    id: z.string(),
    project_id: z.string().nullish(),
    journey_id: z.string().nullish(),
    title: z.string(),
    description: z.string().nullish(),
    status: ReplayBugStatus,
    severity: z.string().nullish(),
    priority: z.string().nullish(),
    url: z.string().nullish(),
    recording_url: z.string().nullish(),
    root_cause: z.string().nullish(),
    suggested_fix: z.string().nullish(),
    reproduction_steps: z.union([z.array(z.string()), z.string()]).nullish(),
    expected_behavior: z.string().nullish(),
    actual_behavior: z.string().nullish(),
    analysis: z.string().nullish(),
    created_at: z.string().nullish(),
    updated_at: z.string().nullish(),
  })
  .passthrough();
export type ReplayBug = z.infer<typeof ReplayBug>;

/* -------------------------------------------------------------------------- */
/* Explorations                                                                */
/* -------------------------------------------------------------------------- */

/**
 * `POST /projects/{id}/explorations` and `GET /explorations/{id}` are
 * documented paths; the exact `status` vocabulary is UNVERIFIED (the manifest
 * only says explorations are "asynchronous and polled with backoff until
 * terminal", implying running/terminal states exist, not their spelling).
 * `isTerminalExplorationStatus` in `index.ts` treats this defensively.
 */
export const ReplayExploration = z
  .object({
    id: z.string(),
    project_id: z.string().nullish(),
    status: z.string(),
    prompt: z.string().nullish(),
    journeys: z.array(ReplayJourney).nullish(),
    journey_ids: z.array(z.string()).nullish(),
    bugs: z.array(ReplayBug).nullish(),
    bug_ids: z.array(z.string()).nullish(),
    started_at: z.string().nullish(),
    finished_at: z.string().nullish(),
    completed_at: z.string().nullish(),
    created_at: z.string().nullish(),
  })
  .passthrough();
export type ReplayExploration = z.infer<typeof ReplayExploration>;

/* -------------------------------------------------------------------------- */
/* Versions                                                                    */
/* -------------------------------------------------------------------------- */

export const ReplayVersion = z
  .object({
    id: z.string(),
    project_id: z.string().nullish(),
    git_sha: z.string(),
    branch_name: z.string(),
    deployed_url: z.string().nullish(),
    timestamp: z.string().nullish(),
    change_description: z.string().nullish(),
  })
  .passthrough();
export type ReplayVersion = z.infer<typeof ReplayVersion>;
