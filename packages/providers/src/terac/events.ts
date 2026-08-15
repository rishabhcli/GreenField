/**
 * Terac webhook → refresh-intent mapping.
 *
 * The event *names* (`submission.status.change`, `submission.approved`) and
 * the header/signature contract (`X-Terac-Request-Signature`,
 * `X-Terac-Request-Timestamp`, `X-Event-ID`) are verified against Terac's own
 * docs. The JSON body shape of an actual delivery is NOT — no sample payload
 * is published anywhere in the reference docs. Rather than fabricate a
 * submission schema from field names we have never observed, this module
 * treats every webhook as a "something changed" signal: it extracts only an
 * opportunity/submission identifier using a best-effort, defensively optional
 * envelope, and tells the caller which opportunity to re-fetch via the
 * documented, verified `GET /opportunities/{id}/submissions` endpoint
 * (`schemas.ts`'s `TeracSubmission`, exercised by `listSubmissions`). That
 * endpoint's response is the source of truth; the webhook is only ever the
 * reason to look, the same "polling is authoritative" posture the Replay
 * adapter takes for its own undocumented webhook payloads.
 */

import { z } from 'zod';

/**
 * UNVERIFIED envelope: we do not know whether Terac calls the event-type field
 * `event_type` or `type`, or whether the identifiers travel at the top level or
 * nested under `data`. Both conventions are accepted defensively via
 * `.passthrough()` plus optional aliases, so a real delivery in either shape
 * still parses instead of throwing a contract error on the first live call.
 */
export const TeracWebhookEnvelope = z
  .object({
    event_type: z.string().optional(),
    type: z.string().optional(),
    opportunity_id: z.string().optional(),
    data: z
      .object({
        opportunity_id: z.string().optional(),
        submission_id: z.string().optional(),
        id: z.string().optional(),
      })
      .partial()
      .optional(),
  })
  .passthrough();
export type TeracWebhookEnvelope = z.infer<typeof TeracWebhookEnvelope>;

/** Event names verified to exist. Full catalogue UNVERIFIED (`listWebhookEventTypes` exists but was not enumerated). */
export const HANDLED_TERAC_EVENTS = ['submission.status.change', 'submission.approved'] as const;

export interface TeracRefreshSignal {
  readonly eventType: string;
  readonly opportunityId: string | null;
  readonly submissionId: string | null;
}

export type TeracWebhookResult =
  | { readonly action: 'refresh_submissions'; readonly signal: TeracRefreshSignal }
  /** Recognised event name, but the envelope carried no identifier we could use. */
  | { readonly action: 'ignored_no_identifier'; readonly reason: string }
  /** Not in our handled set. Recorded and surfaced, never silently dropped. */
  | { readonly action: 'unhandled'; readonly reason: string };

export function interpretTeracWebhookEvent(envelope: TeracWebhookEnvelope): TeracWebhookResult {
  const eventType = envelope.event_type ?? envelope.type;
  if (!eventType || !HANDLED_TERAC_EVENTS.includes(eventType as (typeof HANDLED_TERAC_EVENTS)[number])) {
    return {
      action: 'unhandled',
      reason: `Terac event "${eventType ?? 'unknown'}" has no mapping; the delivery is stored and surfaced rather than acted on.`,
    };
  }

  const opportunityId = envelope.opportunity_id ?? envelope.data?.opportunity_id ?? null;
  const submissionId = envelope.data?.submission_id ?? envelope.data?.id ?? null;

  if (!opportunityId && !submissionId) {
    return {
      action: 'ignored_no_identifier',
      reason:
        `Terac event "${eventType}" carried no opportunity_id or submission_id under any of the aliases this ` +
        `adapter checks; nothing to refresh.`,
    };
  }

  return { action: 'refresh_submissions', signal: { eventType, opportunityId, submissionId } };
}
