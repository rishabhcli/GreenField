/**
 * Loop tick cron.
 *
 * When Render Workflows are configured this starts `tickCompanyLoop` on the
 * workflow service (the prize-track execution path). Otherwise it ticks the
 * orchestrator in-process. Missing workflow slug is not a fake success — it
 * is the documented Blueprint beta limitation, and the in-process tick is
 * the honest fallback so the company still moves.
 */

import { describeError } from '@foundry/core';
import { getLogger } from '@foundry/obs';
import { RenderAdapter } from '@foundry/providers';
import { buildContext, wireRuntime } from '@foundry/runtime';

const EXPECTED_MIGRATIONS = 5;

async function main(): Promise<void> {
  const ctx = await buildContext({
    serviceName: 'foundry-loop-tick',
    expectedMigrations: EXPECTED_MIGRATIONS,
  });
  const log = getLogger();
  try {
    const services = wireRuntime(ctx);
    const companies = await ctx.repos.companies.list();
    if (companies.length === 0) {
      log.info('loop tick cron: no companies yet');
      return;
    }

    const render = ctx.providers.adapter('render');
    const workflowsUsable = ctx.capabilities.isUsable('platform.workflows');

    for (const company of companies) {
      if (workflowsUsable && render instanceof RenderAdapter) {
        try {
          const run = await render.startTaskRun('tickCompanyLoop', [{ companyId: company.id }]);
          log.info({ companyId: company.id, taskRunId: run.id }, 'loop tick dispatched to Render Workflows');
          continue;
        } catch (error) {
          log.warn(
            { companyId: company.id, err: describeError(error) },
            'Render Workflows trigger failed; ticking in-process',
          );
        }
      }
      const tick = await services.loop.tick(company.id);
      log.info({ companyId: company.id, ...tick }, 'loop tick (in-process)');
    }
  } finally {
    await ctx.shutdown();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
