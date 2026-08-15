#!/usr/bin/env node
/**
 * One-shot verification CLI.
 *
 * Distinct from the Render cron (`index.ts`): the cron always exits 0 because
 * a missing key is a true statement about the world, not a job failure. This
 * CLI is what a human runs. It exits non-zero only when a probe actually ran
 * and failed. Missing credentials print as BLOCKED with remediation and do
 * not fail the process.
 *
 * A successful probe is reported as PROBE OK — not as a verified integration.
 * `live_verified` is a dated row written by this sweep, and only that row.
 */

import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { describeError, serviceNameFromEnv } from '@foundry/core';
import { buildContext } from '@foundry/runtime';
import { classifyProbe } from './classify.js';
import { renderReport, runSweep } from './index.js';

const EXPECTED_MIGRATIONS = 6;

async function main(): Promise<number> {
  const ctx = await buildContext({
    serviceName: serviceNameFromEnv('foundry-verifier'),
    expectedMigrations: EXPECTED_MIGRATIONS,
    installSchedules: false,
  });

  try {
    const results = await runSweep(ctx);
    const classified = results.map((r) => {
      const status = ctx.capabilities.providerStatus(r.provider);
      const kind = classifyProbe(status.state, r.succeeded);
      return { ...r, kind, state: status.state, remediation: status.remediation };
    });

    const blocked = classified.filter((r) => r.kind === 'blocked');
    const failed = classified.filter((r) => r.kind === 'failed');
    const ok = classified.filter((r) => r.kind === 'probe_ok');

    const lines = [
      'VERIFICATION CLI',
      '='.repeat(78),
      `Run at: ${new Date().toISOString()}`,
      `Probed: ${classified.length}   PROBE OK: ${ok.length}   BLOCKED: ${blocked.length}   FAILED: ${failed.length}`,
      '',
    ];

    for (const r of classified) {
      const mark = r.kind === 'probe_ok' ? 'PROBE OK' : r.kind === 'blocked' ? 'BLOCKED' : 'FAILED';
      lines.push(`${r.provider.padEnd(18)}  ${mark.padEnd(10)}  ${r.state}  ${r.detail}`);
      if (r.kind === 'blocked' && r.remediation) {
        for (const rem of r.remediation.split('\n')) lines.push(`  ${rem}`);
      }
    }

    lines.push('');
    lines.push(
      'PROBE OK means a non-destructive live call succeeded just now. It is not a prize-method pass.',
    );
    lines.push(
      'BLOCKED means the provider cannot run (missing/malformed credentials, vendor approval, unsupported). That is a correct state.',
    );
    lines.push('FAILED means the probe ran against a live API and did not succeed.');
    process.stdout.write(`${lines.join('\n')}\n\n`);
    process.stdout.write(`${renderReport(results)}\n`);

    return failed.length > 0 ? 1 : 0;
  } catch (error) {
    process.stderr.write(`${describeError(error).message ?? String(error)}\n`);
    return 2;
  } finally {
    await ctx.shutdown();
  }
}

function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(resolve(entry)).href;
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(error);
      process.exit(2);
    });
}

export { main };
