/**
 * Inbound webhook persistence and deduplication.
 *
 * Every payment provider redelivers events — Stripe retries for three days,
 * Dodo eight times over 24 hours, Whop for three days. Recording the event
 * before processing it, keyed on (provider, external_event_id), is what turns
 * "at least once" delivery into "exactly once" effect.
 */

import { z } from 'zod';
import { newId } from '@foundry/core';
import { metrics } from '@foundry/obs';
import { exec, q, qMaybe, mapPostgresError, type Queryable } from '../pool.js';

const Row = z.object({
  id: z.string(),
  provider: z.string(),
  external_event_id: z.string(),
  event_type: z.string(),
  signature_verified: z.boolean(),
  payload: z.unknown(),
  headers: z.record(z.string(), z.unknown()),
  status: z.enum(['received', 'processing', 'processed', 'failed', 'ignored']),
  process_attempts: z.number(),
  last_error: z.string().nullable(),
  company_id: z.string().nullable(),
  received_at: z.date(),
  processed_at: z.date().nullable(),
});

export type WebhookEventRow = z.infer<typeof Row>;

const COLUMNS = `id, provider, external_event_id, event_type, signature_verified, payload, headers,
                 status, process_attempts, last_error, company_id, received_at, processed_at`;

export type RecordResult =
  | { isNew: true; event: WebhookEventRow }
  | { isNew: false; event: WebhookEventRow };

export class WebhookRepository {
  constructor(private readonly db: Queryable) {}

  /**
   * Records an inbound event, or reports that we already have it.
   *
   * `ON CONFLICT DO NOTHING` plus a follow-up read is deliberate: it means two
   * simultaneous redeliveries cannot both be treated as new, which a
   * read-then-insert would allow.
   */
  async recordIfNew(input: {
    provider: string;
    externalEventId: string;
    eventType: string;
    signatureVerified: boolean;
    payload: unknown;
    headers?: Record<string, unknown>;
    companyId?: string | null;
  }): Promise<RecordResult> {
    let inserted;
    try {
      const result = await this.db.query(
        `INSERT INTO webhook_events (id, provider, external_event_id, event_type, signature_verified,
                                     payload, headers, company_id)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8)
         ON CONFLICT (provider, external_event_id) DO NOTHING
         RETURNING ${COLUMNS}`,
        [
          newId('webhookEvent'),
          input.provider,
          input.externalEventId,
          input.eventType,
          input.signatureVerified,
          JSON.stringify(input.payload ?? null),
          JSON.stringify(redactHeaders(input.headers ?? {})),
          input.companyId ?? null,
        ],
      );
      inserted = result.rows[0];
    } catch (error) {
      throw mapPostgresError(error, { provider: input.provider, externalEventId: input.externalEventId });
    }

    if (inserted) {
      metrics.webhooksReceived.inc({ provider: input.provider, result: 'new', type: input.eventType });
      return { isNew: true, event: Row.parse(inserted) };
    }

    const existing = await qMaybe(
      this.db,
      `SELECT ${COLUMNS} FROM webhook_events WHERE provider=$1 AND external_event_id=$2`,
      [input.provider, input.externalEventId],
      Row,
    );
    metrics.webhooksReceived.inc({ provider: input.provider, result: 'duplicate', type: input.eventType });
    // The row must exist: the conflict means it did. If it somehow does not,
    // the insert raced with a delete and retrying is correct.
    if (!existing) return this.recordIfNew(input);
    return { isNew: false, event: existing };
  }

  /** Claims an event for processing so two workers cannot both handle it. */
  async claimForProcessing(id: string): Promise<boolean> {
    const updated = await exec(
      this.db,
      `UPDATE webhook_events
          SET status = 'processing', process_attempts = process_attempts + 1
        WHERE id = $1 AND status IN ('received','failed')`,
      [id],
    );
    return updated > 0;
  }

  async markProcessed(id: string, companyId?: string | null): Promise<void> {
    await exec(
      this.db,
      `UPDATE webhook_events
          SET status='processed', processed_at=now(), last_error=NULL,
              company_id = COALESCE($2, company_id)
        WHERE id=$1`,
      [id, companyId ?? null],
    );
  }

  /** Events we deliberately do not act on, distinguished from failures. */
  async markIgnored(id: string, reason: string): Promise<void> {
    await exec(
      this.db,
      `UPDATE webhook_events SET status='ignored', processed_at=now(), last_error=$2 WHERE id=$1`,
      [id, reason.slice(0, 2000)],
    );
  }

  async markFailed(id: string, error: string): Promise<void> {
    await exec(
      this.db,
      `UPDATE webhook_events SET status='failed', last_error=$2 WHERE id=$1`,
      [id, error.slice(0, 4000)],
    );
  }

  async listUnprocessed(provider?: string, limit = 100): Promise<readonly WebhookEventRow[]> {
    return q(
      this.db,
      `SELECT ${COLUMNS} FROM webhook_events
        WHERE status IN ('received','failed')
          AND ($1::text IS NULL OR provider = $1)
        ORDER BY received_at
        LIMIT $2`,
      [provider ?? null, limit],
      Row,
    );
  }

  async byId(id: string): Promise<WebhookEventRow | undefined> {
    return qMaybe(this.db, `SELECT ${COLUMNS} FROM webhook_events WHERE id=$1`, [id], Row);
  }

  /**
   * Events that have been failing long enough to need a human.
   * A webhook stuck in `failed` is unreconciled money.
   */
  async stuckEvents(olderThanMinutes = 30, minAttempts = 3): Promise<readonly WebhookEventRow[]> {
    return q(
      this.db,
      `SELECT ${COLUMNS} FROM webhook_events
        WHERE status = 'failed'
          AND process_attempts >= $2
          AND received_at < now() - ($1 || ' minutes')::interval
        ORDER BY received_at
        LIMIT 100`,
      [String(olderThanMinutes), minAttempts],
      Row,
    );
  }

  async purgeProcessedOlderThan(days: number): Promise<number> {
    return exec(
      this.db,
      `DELETE FROM webhook_events
        WHERE status IN ('processed','ignored') AND processed_at < now() - ($1 || ' days')::interval`,
      [String(days)],
    );
  }
}

/**
 * Signature headers are proof-of-authenticity, not payload. Storing them would
 * put an HMAC of our own secret into the database for no operational benefit.
 */
const SENSITIVE_HEADERS = new Set([
  'authorization',
  'cookie',
  'stripe-signature',
  'webhook-signature',
  'x-terac-request-signature',
  'x-lovable-signature',
  'x-sandbox0-signature',
  'x-api-key',
]);

function redactHeaders(headers: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(headers)) {
    out[key.toLowerCase()] = SENSITIVE_HEADERS.has(key.toLowerCase()) ? '[redacted]' : value;
  }
  return out;
}
