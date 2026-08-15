/**
 * Nightly finance reconciliation cron.
 */

import { describeError } from '@foundry/core';
import { getLogger } from '@foundry/obs';
import { buildContext, wireRuntime } from '@foundry/runtime';

const EXPECTED_MIGRATIONS = 5;

async function main(): Promise<void> {
  const ctx = await buildContext({
    serviceName: 'foundry-reconcile',
    expectedMigrations: EXPECTED_MIGRATIONS,
  });
  const log = getLogger();
  try {
    const services = wireRuntime(ctx);
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
