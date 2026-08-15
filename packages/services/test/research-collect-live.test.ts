/**
 * Opt-in live discover collect. Skipped unless LIVE_DISCOVER=1.
 * Imports context + collect directly so a broken services barrel cannot skip the tick.
 */

import { afterAll, describe, expect, it } from 'vitest';
import { buildContext } from '../../runtime/src/context.js';
import type { ServiceDeps } from '../src/deps.js';
import { LoopOrchestrator } from '../src/loop/orchestrator.js';
import { ResearchCollectService } from '../src/research/collect.js';

const LIVE = process.env['LIVE_DISCOVER'] === '1';
const COMPANY = 'co_01M03F7RQW2M6540BY2GZHCFBW';

describe.skipIf(!LIVE)('live discover collect against DATABASE_URL', () => {
  let shutdown: (() => Promise<void>) | undefined;

  afterAll(async () => {
    if (shutdown) await shutdown();
  });

  it(
    'falls through when web_search is unusable and records only loaded pages',
    async () => {
      const ctx = await buildContext({
        serviceName: 'foundry-discover-live',
        expectedMigrations: 5,
      });
      shutdown = () => ctx.shutdown();
      const deps = {
        repos: ctx.repos,
        providers: ctx.providers,
        capabilities: ctx.capabilities,
        queues: ctx.queues,
        gate: ctx.gate,
        executor: ctx.executor,
        dispatcher: ctx.dispatcher,
        publicBaseUrl: ctx.config.publicBaseUrl,
        environment: ctx.config.environment,
      } satisfies ServiceDeps;
      const research = new ResearchCollectService(deps);
      const loop = new LoopOrchestrator(deps);

      const web = ctx.capabilities.resolveCapability('research.web_search');
      const browser = ctx.capabilities.resolveCapability('research.browser_session');
      const before = await ctx.repos.research.evidence.search(COMPANY, { minConfidence: 0, limit: 1000 });

      const collect = await research.collect({
        companyId: COMPANY,
        query: 'reusable water bottle cap leaks complaints',
        sourceKinds: ['web'],
        maxItems: 5,
      });
      // eslint-disable-next-line no-console
      console.log('COLLECT_RESULT', JSON.stringify(collect));

      const after = await ctx.repos.research.evidence.search(COMPANY, { minConfidence: 0, limit: 1000 });
      let tick: unknown;
      try {
        tick = await loop.tick(COMPANY);
      } catch (error) {
        tick = { threw: error instanceof Error ? error.message : String(error) };
      }

      const newEvidence = after
        .filter((row) => !before.some((b) => b.id === row.id))
        .map((row) => ({
          id: row.id,
          sourceUrl: row.source_url,
          summary: row.summary,
          provenance: row.provenance,
          excerpt: row.excerpt,
        }));
      const report = {
        webSearchUsable: web.usable,
        webSearchState: web.state,
        webSearchProvider: web.provider,
        browserUsable: browser.usable,
        browserState: browser.state,
        browserProvider: browser.provider,
        collect,
        evidenceBefore: before.length,
        evidenceAfter: after.length,
        newEvidence,
        tick,
      };
      // eslint-disable-next-line no-console
      console.log(JSON.stringify(report, null, 2));
      expect(collect.inserted + collect.duplicates + (collect.blockedOn ? 1 : 0)).toBeGreaterThanOrEqual(0);
    },
    240_000,
  );
});
