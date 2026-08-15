/**
 * Platform-wide idempotency ledger.
 *
 * Several integrated providers publish no idempotency header — Dodo Payments,
 * Terac, Replay, Render and BAND all lack one. Without this table a retried job
 * would send a second RFQ to a real supplier, buy a second shipping label, or
 * create a second expert engagement that bills real money.
 *
 * The protocol is: claim the key, do the work, record the result. A claim is
 * leased rather than held forever, so a worker that dies mid-operation does not
 * wedge the key — but the lease is deliberately long relative to the operation,
 * because reclaiming too eagerly is how you get the duplicate you were
 * preventing.
 */

import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ConflictError } from '@foundry/core';
import { getLogger } from '@foundry/obs';
import { exec, mapPostgresError, qMaybe, type Queryable } from '../pool.js';

export type ClaimOutcome =
  /** This caller owns the key and must do the work. */
  | { status: 'claimed'; key: string }
  /** Another worker is doing it right now. Back off and retry later. */
  | { status: 'in_progress'; key: string; leaseExpiresAt: Date }
  /** Already done. Replay the stored result instead of repeating the effect. */
  | { status: 'completed'; key: string; result: unknown }
  /** Previously failed terminally. The caller decides whether to reset. */
  | { status: 'failed'; key: string; error: string };

const Row = z.object({
  key: z.string(),
  scope: z.string(),
  status: z.enum(['in_progress', 'completed', 'failed']),
  request_hash: z.string().nullable(),
  result: z.unknown().nullable(),
  error: z.string().nullable(),
  attempts: z.number(),
  lease_expires_at: z.date(),
});

export const DEFAULT_LEASE_MS = 10 * 60_000;

export function hashRequest(payload: unknown): string {
  return createHash('sha256').update(JSON.stringify(payload ?? null)).digest('hex');
}

export class IdempotencyRepository {
  constructor(private readonly db: Queryable) {}

  /**
   * Attempts to take ownership of `key`.
   *
   * The INSERT ... ON CONFLICT DO UPDATE is a single atomic statement: exactly
   * one concurrent caller can win the claim, and a stale lease is reclaimed in
   * the same round trip rather than in a read-then-write race.
   */
  async claim(
    key: string,
    scope: string,
    options: { requestPayload?: unknown; companyId?: string; leaseMs?: number } = {},
  ): Promise<ClaimOutcome> {
    const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
    const requestHash = options.requestPayload === undefined ? null : hashRequest(options.requestPayload);

    let row;
    try {
      const result = await this.db.query(
        `INSERT INTO idempotency_keys
           (key, scope, company_id, status, request_hash, claimed_at, lease_expires_at, attempts)
         VALUES ($1, $2, $3, 'in_progress', $4, now(), now() + ($5 || ' milliseconds')::interval, 1)
         ON CONFLICT (key) DO UPDATE
           SET status           = 'in_progress',
               claimed_at       = now(),
               lease_expires_at = now() + ($5 || ' milliseconds')::interval,
               attempts         = idempotency_keys.attempts + 1
           -- Only steal the claim when the previous holder's lease has expired.
           -- A completed or failed key is never re-claimed here.
           WHERE idempotency_keys.status = 'in_progress'
             AND idempotency_keys.lease_expires_at < now()
         RETURNING key, scope, status, request_hash, result, error, attempts, lease_expires_at`,
        [key, scope, options.companyId ?? null, requestHash, String(leaseMs)],
      );
      row = result.rows[0];
    } catch (error) {
      throw mapPostgresError(error, { key, scope });
    }

    if (row) {
      // We won the claim (fresh insert or reclaimed an expired lease).
      const parsed = Row.parse(row);
      if (parsed.attempts > 1) {
        getLogger().warn({ key, scope, attempts: parsed.attempts }, 'reclaimed an expired idempotency lease');
      }
      return { status: 'claimed', key };
    }

    // Conflict, and the WHERE clause declined the update: read why.
    const existing = await qMaybe(
      this.db,
      `SELECT key, scope, status, request_hash, result, error, attempts, lease_expires_at
         FROM idempotency_keys WHERE key = $1`,
      [key],
      Row,
    );
    if (!existing) {
      // Vanishingly rare: the row was deleted between our two statements.
      return this.claim(key, scope, options);
    }

    // A replay must be the same request. A different payload under the same key
    // means a bug in key construction, and replaying the old result would be
    // silently wrong.
    if (requestHash && existing.request_hash && existing.request_hash !== requestHash) {
      throw new ConflictError(
        `Idempotency key "${key}" was previously used with a different request payload. ` +
          `Replaying the stored result would return an answer to a different question.`,
        { key, scope },
      );
    }

    switch (existing.status) {
      case 'completed':
        return { status: 'completed', key, result: existing.result };
      case 'failed':
        return { status: 'failed', key, error: existing.error ?? 'unknown failure' };
      case 'in_progress':
        return { status: 'in_progress', key, leaseExpiresAt: existing.lease_expires_at };
    }
  }

  async complete(key: string, result: unknown): Promise<void> {
    const updated = await exec(
      this.db,
      `UPDATE idempotency_keys
          SET status = 'completed', result = $2::jsonb, completed_at = now(), error = NULL
        WHERE key = $1 AND status = 'in_progress'`,
      [key, JSON.stringify(result ?? null)],
    );
    if (updated === 0) {
      getLogger().warn({ key }, 'completing an idempotency key we no longer hold');
    }
  }

  async fail(key: string, error: string): Promise<void> {
    await exec(
      this.db,
      `UPDATE idempotency_keys
          SET status = 'failed', error = $2, completed_at = now()
        WHERE key = $1 AND status = 'in_progress'`,
      [key, error.slice(0, 4000)],
    );
  }

  /** Lets a caller retry after a terminal failure once the cause is fixed. */
  async reset(key: string): Promise<void> {
    await exec(this.db, `DELETE FROM idempotency_keys WHERE key = $1 AND status = 'failed'`, [key]);
  }

  async get(key: string): Promise<z.infer<typeof Row> | undefined> {
    return qMaybe(
      this.db,
      `SELECT key, scope, status, request_hash, result, error, attempts, lease_expires_at
         FROM idempotency_keys WHERE key = $1`,
      [key],
      Row,
    );
  }

  /**
   * Convenience wrapper implementing the whole protocol.
   *
   * Note the deliberate asymmetry: a completed key replays its stored result,
   * but an in-progress key throws a *retryable* conflict rather than waiting.
   * Blocking a worker on another worker's lease would tie up the queue slot.
   */
  async run<T>(
    key: string,
    scope: string,
    fn: () => Promise<T>,
    options: { requestPayload?: unknown; companyId?: string; leaseMs?: number } = {},
  ): Promise<{ result: T; replayed: boolean }> {
    const claim = await this.claim(key, scope, options);

    if (claim.status === 'completed') {
      return { result: claim.result as T, replayed: true };
    }
    if (claim.status === 'in_progress') {
      throw new ConflictError(
        `Operation "${scope}" is already in progress under idempotency key "${key}" ` +
          `(lease until ${claim.leaseExpiresAt.toISOString()})`,
        { key, scope, retryAfterSeconds: 30 },
      );
    }
    if (claim.status === 'failed') {
      throw new ConflictError(
        `Operation "${scope}" previously failed under idempotency key "${key}": ${claim.error}. ` +
          `Reset the key to retry.`,
        { key, scope },
      );
    }

    try {
      const result = await fn();
      await this.complete(key, result);
      return { result, replayed: false };
    } catch (error) {
      await this.fail(key, error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  /** Retention sweep. Completed keys stay long enough to absorb provider retries. */
  async purgeOlderThan(days: number): Promise<number> {
    return exec(
      this.db,
      `DELETE FROM idempotency_keys
        WHERE status IN ('completed','failed')
          AND completed_at < now() - ($1 || ' days')::interval`,
      [String(days)],
    );
  }
}
