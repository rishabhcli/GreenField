/**
 * Render Workflows task definitions.
 *
 * Prize track "Best use of Render" requires Render Workflows. Blueprints
 * cannot declare `type: workflow` during the public beta (Render docs,
 * 2026-08-15). Create this service in the Dashboard from this entrypoint,
 * set RENDER_WORKFLOW_SLUG, and the control plane triggers runs with
 * POST /v1/task-runs.
 */

import { task } from '@renderinc/sdk/workflows';
import { buildContext, wireRuntime } from '@foundry/runtime';

const EXPECTED_MIGRATIONS = 5;

async function withServices<T>(
  fn: (services: ReturnType<typeof wireRuntime>) => Promise<T>,
): Promise<T> {
  const ctx = await buildContext({
    serviceName: 'foundry-workflows',
    expectedMigrations: EXPECTED_MIGRATIONS,
  });
  try {
    return await fn(wireRuntime(ctx));
  } finally {
    await ctx.shutdown();
  }
}

export const tickCompanyLoop = task(
  { name: 'tickCompanyLoop', timeoutSeconds: 600 },
  async function tickCompanyLoop(input: { companyId: string }) {
    return withServices((services) => services.loop.tick(input.companyId));
  },
);

export const runQaGate = task(
  { name: 'runQaGate', timeoutSeconds: 1800 },
  async function runQaGate(input: {
    companyId: string;
    siteId: string;
    deploymentId: string;
    targetUrl: string;
  }) {
    return withServices((services) =>
      services.qa.run({
        companyId: input.companyId,
        siteId: input.siteId,
        deploymentId: input.deploymentId,
        targetUrl: input.targetUrl,
        kinds: ['autonomous_exploration', 'payment_state', 'data_integrity'],
        blockingForRelease: true,
      }),
    );
  },
);

export const collectResearch = task(
  { name: 'collectResearch', timeoutSeconds: 900 },
  async function collectResearch(input: { companyId: string; query: string }) {
    return withServices((services) =>
      services.research.collect({ companyId: input.companyId, query: input.query }),
    );
  },
);

export const reconcilePayments = task(
  { name: 'reconcilePayments', timeoutSeconds: 900 },
  async function reconcilePayments(input: { companyId: string }) {
    return withServices(async (services) => {
      const report = await services.reconciliation.run(input.companyId, 'stripe', 14);
      const integrity = await services.reconciliation.verifyLedgerIntegrity(input.companyId);
      return { report, integrity };
    });
  },
);

/** Chained root used by the loop cron when workflows are live. */
export const operateCompany = task(
  { name: 'operateCompany', timeoutSeconds: 2400 },
  async function operateCompany(input: { companyId: string; query?: string }) {
    const tick = await tickCompanyLoop({ companyId: input.companyId });
    const research = input.query
      ? await collectResearch({ companyId: input.companyId, query: input.query })
      : null;
    return { tick, research };
  },
);
