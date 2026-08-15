/**
 * Zod schemas for the Terac objects we consume.
 *
 * Terac's API is self-labelled "v2 beta". Some shapes below are directly
 * confirmed against the vendor's reference docs (projects, feasibility
 * requests, the pagination envelope, the error envelope); others — chiefly the
 * fine-grained field names on an opportunity or a submission — were never
 * shown in a sample payload. For those we keep the schema narrow (only the
 * fields this system actually reads, per the same philosophy as the Stripe
 * adapter) and model uncertain fields as optional/nullish with a comment
 * naming exactly what is unconfirmed, rather than guessing a rigid shape that
 * would throw a contract error on the first real response.
 */

import { z } from 'zod';

/* -------------------------------------------------------------------------- */
/* Envelopes                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Cursor pagination envelope — directly documented:
 * `{ data[], pagination: { next_cursor, has_more } }`.
 */
export function teracPage<T extends z.ZodTypeAny>(item: T) {
  return z.object({
    data: z.array(item),
    pagination: z.object({
      next_cursor: z.string().nullable(),
      has_more: z.boolean(),
    }),
  });
}
export type TeracPage<T> = { data: T[]; pagination: { next_cursor: string | null; has_more: boolean } };

/** Documented error body: `{ error: { code, message, details[] } }`. */
export const TeracErrorEnvelope = z.object({
  error: z.object({
    code: z.enum(['BAD_REQUEST', 'UNAUTHORIZED', 'NOT_FOUND', 'CONFLICT', 'RATE_LIMITED', 'INTERNAL_SERVER_ERROR']),
    message: z.string(),
    details: z.array(z.object({ field: z.string().optional(), message: z.string() })).optional(),
  }),
});
export type TeracErrorEnvelope = z.infer<typeof TeracErrorEnvelope>;

/* -------------------------------------------------------------------------- */
/* Projects                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * `GET /projects` is documented as cursor paginated; the project object's own
 * field list beyond `id` was never shown. `name` is modelled optimistically
 * since the secret spec for TERAC_PROJECT_ID implies projects are
 * human-identifiable in the dashboard.
 */
export const TeracProject = z
  .object({
    id: z.string(),
    name: z.string().nullish(),
    created_at: z.string().nullish(),
  })
  .passthrough();
export type TeracProject = z.infer<typeof TeracProject>;

/* -------------------------------------------------------------------------- */
/* Feasibility requests                                                       */
/* -------------------------------------------------------------------------- */

/**
 * `POST /feasibility/requests` is documented in full for the request body
 * (`taskDescription`, `panelDescription` required; `submissionCount`,
 * `timelineHours`, `requestorEmail` optional — note the camelCase, which is
 * inconsistent with the snake_case used by `/opportunities`; that
 * inconsistency is in the vendor's own docs, not a transcription error here).
 * The response is documented only as "immediately `status: 'RECEIVED'`, null
 * pricing until `'RESPONDED'`" — the exact shape of `pricing` once populated
 * is UNVERIFIED, so it is modelled as an open record rather than typed fields.
 */
export const TeracFeasibilityRequest = z
  .object({
    id: z.string(),
    status: z.enum(['RECEIVED', 'RESPONDED']),
    taskDescription: z.string().nullish(),
    panelDescription: z.string().nullish(),
    submissionCount: z.number().int().nonnegative().nullish(),
    timelineHours: z.number().nonnegative().nullish(),
    requestorEmail: z.string().nullish(),
    // UNVERIFIED: shape of a populated pricing object. Left as an open record
    // rather than typed fields (e.g. amount/currency) so we do not fabricate a
    // schema for data we have never observed.
    pricing: z.record(z.string(), z.unknown()).nullable().optional(),
    createdAt: z.string().nullish(),
    updatedAt: z.string().nullish(),
  })
  .passthrough();
export type TeracFeasibilityRequest = z.infer<typeof TeracFeasibilityRequest>;

/* -------------------------------------------------------------------------- */
/* Opportunities                                                              */
/* -------------------------------------------------------------------------- */

/** Echo of one `tasks[]` entry from the documented `POST /opportunities` body. */
export const TeracOpportunityTask = z
  .object({
    sequence: z.number().int().nonnegative(),
    // task_type / review_type enum values are not published; kept as open
    // strings so a value the server accepted still round-trips on read.
    task_type: z.string(),
    review_type: z.string(),
    task_url: z.string().nullish(),
    duration_minutes: z.number().int().positive(),
  })
  .passthrough();
export type TeracOpportunityTask = z.infer<typeof TeracOpportunityTask>;

/**
 * `POST /opportunities` is documented in full for its required/optional
 * request fields (see `CreateOpportunityInput` in index.ts). The *response*
 * object was never shown in a sample payload; we model the fields we know
 * must exist because we supplied them (they are echoed back), plus `id` and
 * `status`, which every REST resource of this kind exposes. `status`'s exact
 * vocabulary is UNVERIFIED — see `mapOpportunityStatus` in index.ts, which
 * treats it as an opaque, keyword-matched string rather than a fixed enum.
 */
export const TeracOpportunity = z
  .object({
    id: z.string(),
    project_id: z.string().nullish(),
    title: z.string().nullish(),
    description: z.string().nullish(),
    business_type: z.enum(['b2c', 'b2b']).nullish(),
    num_participants: z.number().int().positive().nullish(),
    status: z.string().nullish(),
    tasks: z.array(TeracOpportunityTask).nullish(),
    feasibility_request_id: z.string().nullish(),
    // UNVERIFIED: field name for per-participant cost. Not shown in any
    // sample response; several plausible aliases are accepted defensively.
    cost_per_participant_minor: z.number().int().nonnegative().nullish(),
    currency: z.string().nullish(),
    created_at: z.string().nullish(),
    updated_at: z.string().nullish(),
  })
  .passthrough();
export type TeracOpportunity = z.infer<typeof TeracOpportunity>;

/* -------------------------------------------------------------------------- */
/* Submissions                                                                */
/* -------------------------------------------------------------------------- */

/**
 * `GET /opportunities/{opportunityId}/submissions` is documented as cursor
 * paginated with a `status` filter. The manifest's own capability evidence
 * ("returns expert submissions with attestations") is the strongest signal we
 * have about the object's contents, confirming an `attestations` concept
 * exists. Beyond that, field names are UNVERIFIED: this schema accepts the
 * most plausible aliases (e.g. `expert_ref` vs `worker_id`) so a real payload
 * that uses a slightly different name than our best guess still parses,
 * rather than throwing a contract error on the first live call. The mapping
 * from these aliases onto core's `ExpertReview.submissions` shape — including
 * the deliberate choice to fail loudly instead of fabricating a missing
 * critique or expert identity — lives in `index.ts` (`submissionToReviewEntry`).
 */
export const TeracSubmission = z
  .object({
    id: z.string(),
    opportunity_id: z.string().nullish(),
    expert_ref: z.string().nullish(),
    worker_id: z.string().nullish(),
    respondent_id: z.string().nullish(),
    attestations: z.array(z.string()).default([]),
    scores: z.record(z.string(), z.number()).default({}),
    critique: z.string().nullish(),
    feedback: z.string().nullish(),
    // Exact recommendation vocabulary UNVERIFIED; normalised defensively by
    // `normaliseRecommendation` in index.ts rather than constrained here.
    recommendation: z.string().nullish(),
    suggested_changes: z.array(z.string()).default([]),
    suggestedChanges: z.array(z.string()).nullish(),
    // Whether this submission passed Terac's own review/quality gate. The
    // manifest documents "pay-per-verified-completion billing... submissions
    // that fail review do not bill", which implies this concept exists on the
    // wire; the exact field name is UNVERIFIED.
    approved: z.boolean().nullish(),
    status: z.string().nullish(),
    submitted_at: z.string().nullish(),
    created_at: z.string().nullish(),
  })
  .passthrough();
export type TeracSubmission = z.infer<typeof TeracSubmission>;

/* -------------------------------------------------------------------------- */
/* Webhook subscriptions                                                      */
/* -------------------------------------------------------------------------- */

/**
 * `POST /hooks/subscriptions` (`{ target_url, event_types[] }`) and
 * `POST /hooks/subscriptions/{id}` (confirm, empty body) are both documented
 * paths. The response shape of the subscription resource itself was not shown;
 * `secret` is deliberately NOT modelled here because the manifest's own
 * `obtainFrom` note for `TERAC_WEBHOOK_SECRET` says it is read back via a
 * separate (unverified-path) `getWebhookSubscriptionSecret` operation, which
 * this adapter does not implement (out of the scope given to this pass).
 */
export const TeracWebhookSubscription = z
  .object({
    id: z.string(),
    target_url: z.string().nullish(),
    event_types: z.array(z.string()).nullish(),
    status: z.string().nullish(),
    created_at: z.string().nullish(),
  })
  .passthrough();
export type TeracWebhookSubscription = z.infer<typeof TeracWebhookSubscription>;
