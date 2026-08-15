/**
 * Integration verification records.
 *
 * This repository is the sole writer of the evidence that lets the capability
 * registry report `live_verified`. Nothing else in the system may insert here,
 * and there is deliberately no method that writes `succeeded = true` without a
 * `detail` and `evidence` payload describing the real call that was made.
 */

import { z } from 'zod';
import {
  newId,
  type DeploymentEnvironment,
  type ProviderId,
  type VerificationLookup,
  type VerificationRecord,
} from '@foundry/core';
import { q, type Queryable } from '../pool.js';

const Row = z.object({
  id: z.string(),
  provider: z.string(),
  capability: z.string().nullable(),
  succeeded: z.boolean(),
  detail: z.string(),
  evidence: z.record(z.string(), z.unknown()),
  environment: z.string(),
  checked_at: z.date(),
});

export type VerificationRow = z.infer<typeof Row>;

const COLUMNS = `id, provider, capability, succeeded, detail, evidence, environment, checked_at`;

export class VerificationRepository {
  constructor(private readonly db: Queryable) {}

  async record(input: {
    provider: ProviderId;
    capability?: string | null;
    succeeded: boolean;
    detail: string;
    evidence: Record<string, unknown>;
    environment: DeploymentEnvironment;
    checkedAt?: Date;
  }): Promise<VerificationRow> {
    const rows = await q(
      this.db,
      `INSERT INTO integration_verifications
         (id, provider, capability, succeeded, detail, evidence, environment, checked_at)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8)
       RETURNING ${COLUMNS}`,
      [
        newId('verification'),
        input.provider,
        input.capability ?? null,
        input.succeeded,
        input.detail,
        JSON.stringify(input.evidence),
        input.environment,
        input.checkedAt ?? new Date(),
      ],
      Row,
    );
    return rows[0]!;
  }

  async recordMany(
    records: readonly VerificationRecord[],
    environment: DeploymentEnvironment,
  ): Promise<number> {
    for (const record of records) {
      await this.record({
        provider: record.provider,
        capability: record.capability,
        succeeded: record.succeeded,
        detail: record.detail,
        evidence: record.evidence as Record<string, unknown>,
        environment,
        checkedAt: record.checkedAt,
      });
    }
    return records.length;
  }

  /**
   * Most recent probe per provider for this environment.
   *
   * Scoped by environment on purpose: a successful probe against a provider's
   * test host says nothing about whether the production credential works, and
   * conflating them is exactly the kind of false "integration complete" signal
   * the registry exists to prevent.
   */
  async latestByProvider(environment: DeploymentEnvironment): Promise<Map<ProviderId, VerificationRecord>> {
    const rows = await q(
      this.db,
      `SELECT DISTINCT ON (provider) ${COLUMNS}
         FROM integration_verifications
        WHERE environment = $1
        ORDER BY provider, checked_at DESC`,
      [environment],
      Row,
    );

    return new Map(
      rows.map((row) => [
        row.provider as ProviderId,
        {
          provider: row.provider as ProviderId,
          capability: row.capability as VerificationRecord['capability'],
          succeeded: row.succeeded,
          checkedAt: row.checked_at,
          detail: row.detail,
          evidence: row.evidence,
        },
      ]),
    );
  }

  async history(provider: ProviderId, limit = 20): Promise<readonly VerificationRow[]> {
    return q(
      this.db,
      `SELECT ${COLUMNS} FROM integration_verifications
        WHERE provider = $1 ORDER BY checked_at DESC LIMIT $2`,
      [provider, limit],
      Row,
    );
  }

  /** Providers whose last successful probe is older than the freshness window. */
  async staleProviders(environment: DeploymentEnvironment, maxAgeHours: number): Promise<readonly string[]> {
    const rows = await q(
      this.db,
      `SELECT DISTINCT ON (provider) provider, succeeded, checked_at
         FROM integration_verifications
        WHERE environment = $1
        ORDER BY provider, checked_at DESC`,
      [environment],
      z.object({ provider: z.string(), succeeded: z.boolean(), checked_at: z.date() }),
    );
    const cutoff = Date.now() - maxAgeHours * 3_600_000;
    return rows.filter((r) => !r.succeeded || r.checked_at.getTime() < cutoff).map((r) => r.provider);
  }
}

/** Adapter from persisted rows to the registry's `VerificationLookup` port. */
export class DbVerificationLookup implements VerificationLookup {
  constructor(private readonly records: Map<ProviderId, VerificationRecord>) {}

  latest(provider: ProviderId): VerificationRecord | undefined {
    return this.records.get(provider);
  }

  static async load(
    repo: VerificationRepository,
    environment: DeploymentEnvironment,
  ): Promise<DbVerificationLookup> {
    return new DbVerificationLookup(await repo.latestByProvider(environment));
  }
}
