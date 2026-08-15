#!/usr/bin/env node
/**
 * Migration CLI.
 *
 * Run as Render's `preDeployCommand` so the schema is current before any new
 * instance takes traffic, and available manually for `status` and `--dry-run`.
 */

import { describeError, loadBootstrapLogConfig, readDatabaseUrl } from '@foundry/core';
import { initLogger, getLogger } from '@foundry/obs';
import { createPool } from '../pool.js';
import { migrate, migrationStatus } from '../migrate.js';

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const command = args.find((a) => !a.startsWith('-')) ?? 'up';
  const dryRun = args.includes('--dry-run');
  const acceptDrift = args.includes('--accept-drift');

  const boot = loadBootstrapLogConfig();
  initLogger({
    level: boot.level,
    serviceName: boot.serviceName === 'unknown-service' ? 'migrate' : boot.serviceName,
    environment: boot.environment,
    instanceId: boot.instanceId,
    releaseSha: boot.releaseSha,
  });
  const log = getLogger();

  const connectionString = readDatabaseUrl();
  if (!connectionString) {
    log.error(
      'DATABASE_URL is not set. Bind it from the Render Postgres instance with ' +
        'fromDatabase: { name: <db>, property: connectionString }.',
    );
    return 2;
  }

  const pool = createPool({
    connectionString,
    applicationName: 'foundry-migrate',
    maxConnections: 2,
    // Some DDL (large index builds) legitimately runs long; the default 30s
    // statement timeout would abort a valid migration mid-deploy.
    statementTimeoutMs: 10 * 60_000,
  });

  try {
    if (command === 'status') {
      const status = await migrationStatus(pool);
      log.info(
        {
          applied: status.applied.length,
          pending: status.pending.map((m) => m.filename),
          drifted: status.drifted.map((d) => d.filename),
          missingFiles: status.missingFiles,
        },
        'migration status',
      );
      // Non-zero when the repository and the database disagree, so CI notices.
      return status.drifted.length > 0 || status.missingFiles.length > 0 ? 1 : 0;
    }

    const result = await migrate(pool, { dryRun, acceptDrift });
    log.info(
      { applied: result.applied, alreadyApplied: result.skipped, dryRun: result.dryRun },
      result.dryRun ? 'dry run complete' : 'migrations complete',
    );
    return 0;
  } catch (error) {
    log.error({ err: describeError(error) }, 'migration run failed');
    return 1;
  } finally {
    await pool.end();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
