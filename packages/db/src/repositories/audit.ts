/**
 * Append-only audit log with a tamper-evident hash chain.
 *
 * Each row's hash covers the previous row's hash, so altering any historical
 * event breaks every hash after it and `verifyChain` reports exactly where.
 * Combined with the database-level trigger that refuses UPDATE and DELETE, an
 * auditor can establish that the recorded history is the history that happened.
 */

import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  canonicalAuditPayload,
  newId,
  type AuditEvent,
  type AuditEventKind,
  type ActorKind,
} from '@foundry/core';
import { q, qMaybe, withTransaction, type DbPool, type DbClient, type Queryable } from '../pool.js';

/**
 * Advisory-lock namespace for audit appends. Postgres advisory locks share one
 * global space, so a named namespace keeps this from colliding with the
 * migration lock or anything else that takes one.
 */
const AUDIT_LOCK_NAMESPACE = 4_071_001;

const Row = z.object({
  id: z.string(),
  company_id: z.string(),
  kind: z.string(),
  actor_id: z.string(),
  actor_kind: z.string(),
  action: z.string(),
  subject_type: z.string().nullable(),
  subject_ref_id: z.string().nullable(),
  outcome: z.enum(['success', 'failure', 'denied', 'pending']),
  detail: z.record(z.string(), z.unknown()),
  amount_minor: z.number().nullable(),
  currency: z.string().nullable(),
  previous_hash: z.string().nullable(),
  hash: z.string(),
  occurred_at: z.date(),
  chain_position: z.number(),
});

export type AuditRow = z.infer<typeof Row>;

export interface AuditEventInput {
  readonly companyId: string;
  readonly kind: AuditEventKind;
  readonly actorId: string;
  readonly actorKind: ActorKind;
  readonly action: string;
  readonly subjectType?: string | null;
  readonly subjectRefId?: string | null;
  readonly outcome: 'success' | 'failure' | 'denied' | 'pending';
  /** Must never contain secret material; `Secret` refuses to serialise anyway. */
  readonly detail?: Record<string, unknown>;
  readonly amountMinor?: number | null;
  readonly currency?: string | null;
  readonly occurredAt?: Date;
}

function computeHash(payload: string): string {
  return createHash('sha256').update(payload).digest('hex');
}

export class AuditRepository {
  constructor(private readonly pool: DbPool) {}

  /**
   * Appends one event.
   *
   * The chain head must be read and extended atomically, but SERIALIZABLE is
   * the wrong tool: the conflict is over a predicate (`MAX(chain_position)`
   * for this company) with no row to lock, so every concurrent appender aborts
   * with 40001 the moment one commits. Since the audit log sits on *every*
   * write path in the system, that turns ordinary concurrency into a storm of
   * serialization failures.
   *
   * A transaction-scoped advisory lock keyed on the company gives the same
   * guarantee with queueing instead of aborting: waiters block, take the lock
   * in turn, and read the freshly committed head. The lock releases
   * automatically at commit or rollback, so a crashed appender cannot wedge
   * the company's audit log.
   */
  async append(input: AuditEventInput): Promise<AuditRow> {
    return withTransaction(this.pool, async (client) => this.appendIn(client, input));
  }

  /** Same, but inside a caller-managed transaction so the event commits with the change it describes. */
  async appendIn(client: DbClient, input: AuditEventInput): Promise<AuditRow> {
    // Serialises appends for this company only; other companies proceed freely.
    await client.query('SELECT pg_advisory_xact_lock($1, hashtext($2))', [
      AUDIT_LOCK_NAMESPACE,
      input.companyId,
    ]);

    const head = await qMaybe(
      client,
      `SELECT hash, chain_position FROM audit_events
        WHERE company_id = $1 ORDER BY chain_position DESC LIMIT 1`,
      [input.companyId],
      z.object({ hash: z.string(), chain_position: z.number() }),
    );

    const id = newId('auditEvent');
    const occurredAt = input.occurredAt ?? new Date();
    const previousHash = head?.hash ?? null;
    const chainPosition = (head?.chain_position ?? 0) + 1;

    const canonical = canonicalAuditPayload({
      id,
      companyId: input.companyId,
      kind: input.kind,
      actorId: input.actorId,
      actorKind: input.actorKind,
      action: input.action,
      subjectType: input.subjectType ?? null,
      subjectRefId: input.subjectRefId ?? null,
      outcome: input.outcome,
      detail: input.detail ?? {},
      amountMinor: input.amountMinor ?? null,
      currency: input.currency ?? null,
      previousHash,
      occurredAt: occurredAt.toISOString(),
    } as Omit<AuditEvent, 'hash'>);

    const rows = await q(
      client,
      `INSERT INTO audit_events
         (id, company_id, kind, actor_id, actor_kind, action, subject_type, subject_ref_id,
          outcome, detail, amount_minor, currency, previous_hash, hash, occurred_at, chain_position)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13,$14,$15,$16)
       RETURNING id, company_id, kind, actor_id, actor_kind, action, subject_type, subject_ref_id,
                 outcome, detail, amount_minor, currency, previous_hash, hash, occurred_at, chain_position`,
      [
        id,
        input.companyId,
        input.kind,
        input.actorId,
        input.actorKind,
        input.action,
        input.subjectType ?? null,
        input.subjectRefId ?? null,
        input.outcome,
        JSON.stringify(input.detail ?? {}),
        input.amountMinor ?? null,
        input.currency ?? null,
        previousHash,
        computeHash(canonical),
        occurredAt,
        chainPosition,
      ],
      Row,
    );
    return rows[0]!;
  }

  async list(
    companyId: string,
    options: { kind?: AuditEventKind; subjectRefId?: string; since?: Date; limit?: number } = {},
  ): Promise<readonly AuditRow[]> {
    const conditions: string[] = ['company_id = $1'];
    const params: unknown[] = [companyId];
    if (options.kind) {
      params.push(options.kind);
      conditions.push(`kind = $${params.length}`);
    }
    if (options.subjectRefId) {
      params.push(options.subjectRefId);
      conditions.push(`subject_ref_id = $${params.length}`);
    }
    if (options.since) {
      params.push(options.since);
      conditions.push(`occurred_at >= $${params.length}`);
    }
    params.push(Math.min(options.limit ?? 100, 1000));

    return q(
      this.pool,
      `SELECT id, company_id, kind, actor_id, actor_kind, action, subject_type, subject_ref_id,
              outcome, detail, amount_minor, currency, previous_hash, hash, occurred_at, chain_position
         FROM audit_events
        WHERE ${conditions.join(' AND ')}
        ORDER BY chain_position DESC
        LIMIT $${params.length}`,
      params,
      Row,
    );
  }

  /**
   * Walks the chain and reports the first break.
   *
   * Run by the data-integrity checker. A clean result is a real statement about
   * the log's integrity, not a formality — which is why the check recomputes
   * every hash rather than trusting the stored value.
   */
  async verifyChain(
    companyId: string,
    options: { batchSize?: number } = {},
  ): Promise<{ valid: boolean; checked: number; firstBreakAt?: { id: string; position: number; reason: string } }> {
    const batchSize = options.batchSize ?? 1000;
    let position = 0;
    let checked = 0;
    let expectedPreviousHash: string | null = null;

    for (;;) {
      const batch = await q(
        this.pool,
        `SELECT id, company_id, kind, actor_id, actor_kind, action, subject_type, subject_ref_id,
                outcome, detail, amount_minor, currency, previous_hash, hash, occurred_at, chain_position
           FROM audit_events
          WHERE company_id = $1 AND chain_position > $2
          ORDER BY chain_position
          LIMIT $3`,
        [companyId, position, batchSize],
        Row,
      );
      if (batch.length === 0) break;

      for (const row of batch) {
        if (row.chain_position !== checked + 1) {
          return {
            valid: false,
            checked,
            firstBreakAt: {
              id: row.id,
              position: row.chain_position,
              reason: `chain position gap: expected ${checked + 1}, found ${row.chain_position}`,
            },
          };
        }
        if (row.previous_hash !== expectedPreviousHash) {
          return {
            valid: false,
            checked,
            firstBreakAt: {
              id: row.id,
              position: row.chain_position,
              reason: `previous_hash mismatch: expected ${expectedPreviousHash ?? 'null'}, found ${row.previous_hash ?? 'null'}`,
            },
          };
        }
        const recomputed = computeHash(
          canonicalAuditPayload({
            id: row.id,
            companyId: row.company_id,
            kind: row.kind as AuditEventKind,
            actorId: row.actor_id,
            actorKind: row.actor_kind as ActorKind,
            action: row.action,
            subjectType: row.subject_type,
            subjectRefId: row.subject_ref_id,
            outcome: row.outcome,
            detail: row.detail,
            amountMinor: row.amount_minor,
            currency: row.currency,
            previousHash: row.previous_hash,
            occurredAt: row.occurred_at.toISOString(),
          } as Omit<AuditEvent, 'hash'>),
        );
        if (recomputed !== row.hash) {
          return {
            valid: false,
            checked,
            firstBreakAt: {
              id: row.id,
              position: row.chain_position,
              reason: 'stored hash does not match the recomputed hash — this row was altered',
            },
          };
        }
        expectedPreviousHash = row.hash;
        checked += 1;
        position = row.chain_position;
      }
    }

    return { valid: true, checked };
  }
}

/** Read-only helper for services that only need to append through a transaction. */
export function auditIn(client: Queryable): { append: (input: AuditEventInput) => Promise<AuditRow> } {
  return {
    append: async (input) => {
      const repo = new AuditRepository(client as DbPool);
      return repo.appendIn(client as DbClient, input);
    },
  };
}
