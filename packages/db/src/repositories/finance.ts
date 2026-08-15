/**
 * Double-entry ledger persistence and reconciliation queries.
 *
 * `writeTransaction` is the only insert path and it calls `assertBalanced`
 * before touching the database, so an unbalanced transaction is impossible to
 * persist. The books being provably balanced is what makes "are we making
 * money?" an answerable question rather than an estimate.
 */

import { z } from 'zod';
import {
  assertBalanced,
  computeProfitAndLoss,
  newId,
  type LedgerAccount,
  type LedgerEntry,
  type LedgerTransaction,
  type ProfitAndLoss,
} from '@foundry/core';
import { exec, q, withTransaction, type DbPool, type Queryable } from '../pool.js';

const Row = z.object({
  id: z.string(),
  company_id: z.string(),
  transaction_id: z.string(),
  account: z.string(),
  amount_minor: z.number(),
  currency: z.string(),
  description: z.string(),
  source_type: z.string(),
  source_ref_id: z.string(),
  settled: z.boolean(),
  occurred_at: z.date(),
  created_at: z.date(),
});

export type LedgerRow = z.infer<typeof Row>;

const COLUMNS = `id, company_id, transaction_id, account, amount_minor, currency, description,
                 source_type, source_ref_id, settled, occurred_at, created_at`;

export class LedgerRepository {
  constructor(private readonly pool: DbPool) {}

  /**
   * Writes one balanced transaction. All legs commit together or none do —
   * a half-written transaction would leave the books permanently out.
   */
  async writeTransaction(input: {
    companyId: string;
    transaction: LedgerTransaction;
    sourceType: string;
    sourceRefId: string;
    occurredAt?: Date;
    settled?: boolean;
  }): Promise<readonly LedgerRow[]> {
    assertBalanced(input.transaction);
    const occurredAt = input.occurredAt ?? new Date();

    return withTransaction(this.pool, async (client) => {
      const written: LedgerRow[] = [];
      for (const leg of input.transaction.entries) {
        const rows = await q(
          client,
          `INSERT INTO ledger_entries (id, company_id, transaction_id, account, amount_minor, currency,
                                       description, source_type, source_ref_id, settled, occurred_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
           RETURNING ${COLUMNS}`,
          [
            newId('ledgerEntry'),
            input.companyId,
            input.transaction.transactionId,
            leg.account,
            leg.amountMinor,
            leg.currency,
            leg.description,
            input.sourceType,
            input.sourceRefId,
            input.settled ?? false,
            occurredAt,
          ],
          Row,
        );
        written.push(rows[0]!);
      }
      return written;
    });
  }

  /** Idempotent write: skips if this source already produced a transaction. */
  async writeTransactionOnce(input: {
    companyId: string;
    transaction: LedgerTransaction;
    sourceType: string;
    sourceRefId: string;
    occurredAt?: Date;
    settled?: boolean;
  }): Promise<{ written: boolean; entries: readonly LedgerRow[] }> {
    const existing = await q(
      this.pool,
      `SELECT ${COLUMNS} FROM ledger_entries WHERE transaction_id = $1`,
      [input.transaction.transactionId],
      Row,
    );
    if (existing.length > 0) return { written: false, entries: existing };
    return { written: true, entries: await this.writeTransaction(input) };
  }

  async markSettled(transactionId: string): Promise<number> {
    return exec(this.pool, `UPDATE ledger_entries SET settled = TRUE WHERE transaction_id = $1`, [transactionId]);
  }

  async entries(
    companyId: string,
    options: { since?: Date; until?: Date; account?: LedgerAccount; currency?: string } = {},
  ): Promise<readonly LedgerEntry[]> {
    const conditions = ['company_id = $1'];
    const params: unknown[] = [companyId];
    if (options.since) {
      params.push(options.since);
      conditions.push(`occurred_at >= $${params.length}`);
    }
    if (options.until) {
      params.push(options.until);
      conditions.push(`occurred_at < $${params.length}`);
    }
    if (options.account) {
      params.push(options.account);
      conditions.push(`account = $${params.length}`);
    }
    if (options.currency) {
      params.push(options.currency);
      conditions.push(`currency = $${params.length}`);
    }

    const rows = await q(
      this.pool,
      `SELECT ${COLUMNS} FROM ledger_entries WHERE ${conditions.join(' AND ')} ORDER BY occurred_at, id`,
      params,
      Row,
    );
    return rows.map(toDomain);
  }

  async profitAndLoss(
    companyId: string,
    currency: string,
    options: { since?: Date; until?: Date } = {},
  ): Promise<ProfitAndLoss> {
    const entries = await this.entries(companyId, { ...options, currency });
    return computeProfitAndLoss(entries, currency);
  }

  /**
   * Proves every transaction still balances.
   *
   * Run by the data-integrity checker. A non-empty result is a serious finding:
   * it means something wrote legs outside `writeTransaction`, and the reported
   * margin cannot be trusted until it is explained.
   */
  async findUnbalancedTransactions(
    companyId: string,
  ): Promise<readonly { transactionId: string; currency: string; netMinor: number; legCount: number }[]> {
    const rows = await q(
      this.pool,
      `SELECT transaction_id, currency, net_minor, leg_count
         FROM ledger_transaction_balance
        WHERE company_id = $1 AND net_minor <> 0
        ORDER BY occurred_at DESC
        LIMIT 200`,
      [companyId],
      z.object({
        transaction_id: z.string(),
        currency: z.string(),
        net_minor: z.number(),
        leg_count: z.number(),
      }),
    );
    return rows.map((r) => ({
      transactionId: r.transaction_id,
      currency: r.currency,
      netMinor: r.net_minor,
      legCount: r.leg_count,
    }));
  }

  /** Account balances as of now, for the CEO's finance report. */
  async balances(companyId: string, currency: string): Promise<Readonly<Record<string, number>>> {
    const rows = await q(
      this.pool,
      `SELECT account, SUM(amount_minor)::bigint AS balance_minor
         FROM ledger_entries
        WHERE company_id = $1 AND currency = $2
        GROUP BY account`,
      [companyId, currency],
      z.object({ account: z.string(), balance_minor: z.number() }),
    );
    return Object.fromEntries(rows.map((r) => [r.account, r.balance_minor]));
  }

  /** Spend by scope over a window, for budget tracking and CAC attribution. */
  async spendByAccount(
    companyId: string,
    accounts: readonly LedgerAccount[],
    since: Date,
    currency: string,
  ): Promise<Readonly<Record<string, number>>> {
    const rows = await q(
      this.pool,
      `SELECT account, SUM(amount_minor)::bigint AS total_minor
         FROM ledger_entries
        WHERE company_id = $1 AND currency = $2 AND occurred_at >= $3 AND account = ANY($4)
        GROUP BY account`,
      [companyId, currency, since, accounts],
      z.object({ account: z.string(), total_minor: z.number() }),
    );
    return Object.fromEntries(rows.map((r) => [r.account, r.total_minor]));
  }
}

function toDomain(row: LedgerRow): LedgerEntry {
  return {
    id: row.id,
    companyId: row.company_id,
    transactionId: row.transaction_id,
    account: row.account as LedgerAccount,
    amountMinor: row.amount_minor,
    currency: row.currency,
    description: row.description,
    sourceType: row.source_type,
    sourceRefId: row.source_ref_id,
    settled: row.settled,
    occurredAt: row.occurred_at.toISOString(),
    createdAt: row.created_at.toISOString(),
  };
}

export { type Queryable };
