/**
 * Nightly finance reconciliation cron.
 */

import { describeError } from '@foundry/core';
import { getLogger } from '@foundry/obs';
import { buildContext, wireRuntime } from '@foundry/runtime';

const EXPECTED_MIGRATIONS = 6;

async function main(): Promise<void> {
  const ctx = await buildContext({
    serviceName: 'foundry-reconcile',
    expectedMigrations: EXPECTED_MIGRATIONS,
  });
  const log = getLogger();
  try {
    const services = wireRuntime(ctx);

    // Agent runs that blew past their deadline (process kill, OOM, a
    // deploy) otherwise sit in `running` until a parent waits forever.
    // `reapOverdueRuns` uses `deadline_at`, which was set from the role's
    // `runBudgetSeconds` at dispatch — that is the honest timeout, not a
    // second invented threshold. Daily is a backstop; `loop.tick` (every
    // 10 minutes) also reaps, so a stranded run does not wait 24 hours.
    const reaped = await ctx.dispatcher.reapOverdueRuns();
    if (reaped > 0) {
      log.info({ reaped }, 'reaped overdue agent runs');
    }

    const companies = await ctx.repos.companies.list();
    if (companies.length === 0) {
      log.info('reconcile cron: no companies yet');
      return;
    }
    for (const company of companies) {
      try {
        const report = await services.reconciliation.run(company.id, 'stripe', 14);
        const integrity = await services.reconciliation.verifyLedgerIntegrity(company.id);
        log.info(
          {
            companyId: company.id,
            clean: report.result.clean && integrity.balanced,
            skippedReason: report.skippedReason,
            ledgerBalanced: integrity.balanced,
          },
          'nightly reconciliation',
        );
      } catch (error) {
        log.error({ companyId: company.id, err: describeError(error) }, 'nightly reconciliation failed');
      }
    }
  } finally {
    await ctx.shutdown();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
