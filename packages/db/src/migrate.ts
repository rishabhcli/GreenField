/**
 * Forward-only migration runner.
 *
 * Two Render instances booting at the same time must not both migrate, so the
 * whole run is wrapped in a Postgres advisory lock. Each migration is applied
 * inside its own transaction and its sha256 checksum recorded; if a file that
 * was already applied is later edited, the runner refuses to proceed rather
 * than leaving production and the repository silently disagreeing about what
 * the schema is.
 */

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { ConflictError, ValidationError } from '@foundry/core';
import { getLogger } from '@foundry/obs';
import { exec, q, withAdvisoryLock, type DbPool } from './pool.js';

const MIGRATION_LOCK_KEY = 'foundry:migrations';

export interface MigrationFile {
  readonly id: string;
  readonly filename: string;
  readonly sql: string;
  readonly checksum: string;
}

export interface AppliedMigration {
  readonly id: string;
  readonly filename: string;
  readonly checksum: string;
  readonly applied_at: Date;
  readonly duration_ms: number;
}

const AppliedRow = z.object({
  id: z.string(),
  filename: z.string(),
  checksum: z.string(),
  applied_at: z.date(),
  duration_ms: z.number(),
});

/**
 * Locates the SQL directory in both the compiled and the source layout.
 * `pnpm build` copies `src/migrations/*.sql` to `dist/migrations`, so the
 * deployed worker reads the same files the repository holds.
 */
export function migrationsDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [join(here, 'migrations'), join(here, '..', 'src', 'migrations')];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new ValidationError(
    `Could not locate the migrations directory. Looked in: ${candidates.join(', ')}. ` +
      `Run "pnpm --filter @foundry/db build" so the .sql files are copied into dist.`,
  );
}

export function loadMigrations(dir = migrationsDir()): readonly MigrationFile[] {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  if (files.length === 0) {
    throw new ValidationError(`No .sql migration files found in ${dir}`);
  }

  const seen = new Set<string>();
  return files.map((filename) => {
    const id = filename.split('_')[0] ?? filename;
    if (!/^\d{4}$/.test(id)) {
      throw new ValidationError(`Migration "${filename}" must start with a 4-digit id, e.g. 0007_thing.sql`);
    }
    if (seen.has(id)) {
      throw new ValidationError(`Duplicate migration id "${id}" — ids must be unique and ordered`);
    }
    seen.add(id);
    const sql = readFileSync(join(dir, filename), 'utf8');
    return { id, filename, sql, checksum: createHash('sha256').update(sql).digest('hex') };
  });
}

async function ensureMigrationTable(pool: DbPool): Promise<void> {
  await exec(
    pool,
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       id          TEXT PRIMARY KEY,
       filename    TEXT NOT NULL,
       checksum    TEXT NOT NULL,
       applied_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
       duration_ms INTEGER NOT NULL
     )`,
  );
}

export async function appliedMigrations(pool: DbPool): Promise<readonly AppliedMigration[]> {
  await ensureMigrationTable(pool);
  return q(
    pool,
    `SELECT id, filename, checksum, applied_at, duration_ms
       FROM schema_migrations ORDER BY id`,
    [],
    AppliedRow,
  );
}

export interface MigrationStatus {
  readonly applied: readonly AppliedMigration[];
  readonly pending: readonly MigrationFile[];
  readonly drifted: readonly { id: string; filename: string; expected: string; actual: string }[];
  readonly missingFiles: readonly string[];
}

export async function migrationStatus(pool: DbPool, dir?: string): Promise<MigrationStatus> {
  const onDisk = loadMigrations(dir);
  const applied = await appliedMigrations(pool);
  const appliedById = new Map(applied.map((a) => [a.id, a]));
  const onDiskById = new Map(onDisk.map((m) => [m.id, m]));

  const pending = onDisk.filter((m) => !appliedById.has(m.id));
  const drifted = onDisk
    .filter((m) => {
      const a = appliedById.get(m.id);
      return a !== undefined && a.checksum !== m.checksum;
    })
    .map((m) => ({
      id: m.id,
      filename: m.filename,
      expected: appliedById.get(m.id)!.checksum,
      actual: m.checksum,
    }));
  const missingFiles = applied.filter((a) => !onDiskById.has(a.id)).map((a) => a.filename);

  return { applied, pending, drifted, missingFiles };
}

export interface MigrateOptions {
  readonly dryRun?: boolean;
  readonly dir?: string;
  /** Allows a deliberate, reviewed edit to an applied migration to be adopted. */
  readonly acceptDrift?: boolean;
}

export interface MigrateResult {
  readonly applied: readonly string[];
  readonly skipped: number;
  readonly dryRun: boolean;
}

export async function migrate(pool: DbPool, options: MigrateOptions = {}): Promise<MigrateResult> {
  const log = getLogger();

  return withAdvisoryLock(pool, MIGRATION_LOCK_KEY, async () => {
    const status = await migrationStatus(pool, options.dir);

    if (status.drifted.length > 0 && !options.acceptDrift) {
      throw new ConflictError(
        `Migration checksum drift detected. These files changed after being applied: ` +
          status.drifted.map((d) => `${d.filename} (recorded ${d.expected.slice(0, 12)}, now ${d.actual.slice(0, 12)})`).join(', ') +
          `. Add a new forward migration instead of editing an applied one. ` +
          `If the edit is deliberate and the database already matches, re-run with --accept-drift.`,
        { drifted: status.drifted },
      );
    }

    if (status.missingFiles.length > 0) {
      // The database knows about migrations this build does not contain. That
      // means an older image is being deployed over a newer schema.
      log.error(
        { missingFiles: status.missingFiles },
        'database has applied migrations that are absent from this build — this deploy is older than the schema',
      );
      throw new ConflictError(
        `The database has ${status.missingFiles.length} applied migration(s) not present in this build ` +
          `(${status.missingFiles.join(', ')}). Deploying this image would run against a newer schema than it knows about.`,
        { missingFiles: status.missingFiles },
      );
    }

    if (status.pending.length === 0) {
      log.info({ applied: status.applied.length }, 'schema is up to date');
      return { applied: [], skipped: status.applied.length, dryRun: options.dryRun ?? false };
    }

    if (options.dryRun) {
      log.info({ pending: status.pending.map((m) => m.filename) }, 'dry run: migrations that would be applied');
      return { applied: status.pending.map((m) => m.filename), skipped: status.applied.length, dryRun: true };
    }

    const appliedNow: string[] = [];
    for (const migration of status.pending) {
      const startedAt = Date.now();
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(migration.sql);
        const durationMs = Date.now() - startedAt;
        await client.query(
          `INSERT INTO schema_migrations (id, filename, checksum, duration_ms) VALUES ($1, $2, $3, $4)`,
          [migration.id, migration.filename, migration.checksum, durationMs],
        );
        await client.query('COMMIT');
        appliedNow.push(migration.filename);
        log.info({ migration: migration.filename, durationMs }, 'migration applied');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        log.error({ migration: migration.filename, err: error }, 'migration failed; rolled back');
        throw error;
      } finally {
        client.release();
      }
    }

    // Adopt any reviewed drift now that everything else succeeded.
    if (options.acceptDrift) {
      for (const drift of status.drifted) {
        await exec(pool, `UPDATE schema_migrations SET checksum = $1 WHERE id = $2`, [drift.actual, drift.id]);
        log.warn({ migration: drift.filename }, 'accepted checksum drift for an already-applied migration');
      }
    }

    return { applied: appliedNow, skipped: status.applied.length, dryRun: false };
  });
}
