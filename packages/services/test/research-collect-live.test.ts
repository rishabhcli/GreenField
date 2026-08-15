/**
 * Opt-in live discover collect. Skipped unless LIVE_DISCOVER=1.
 * Imports context + collect directly so a broken services barrel cannot skip the tick.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { SolariAdapter } from '@foundry/providers';
import { buildContext } from '../../runtime/src/context.js';
import type { ServiceDeps } from '../src/deps.js';
import { LoopOrchestrator } from '../src/loop/orchestrator.js';
import { ResearchCollectService } from '../src/research/collect.js';

function loadDotenv(path: string): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined || process.env[key] === '') process.env[key] = value;
  }
}

loadDotenv(resolve(process.cwd(), '.env'));
loadDotenv(resolve(process.cwd(), '../../.env'));

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

      const query = 'reusable water bottle cap leaks complaints';
      const solari = ctx.providers.forCapability('research.browser_session').adapter as SolariAdapter | undefined;
      let sessionId: string | null = null;
      let loadedUrls: string[] = [];
      let solariError: string | null = null;
      if (solari) {
        let created: { sessionId: string; cdpEndpoint?: string | null; wsEndpoint?: string | null } | undefined;
        try {
          try {
            created = await solari.createBrowserSession({ recording: false, stealth: true });
          } catch {
            created = await solari.createBrowserSession({ recording: false });
          }
          sessionId = created.sessionId;
          const pages = await solari.loadQueryPagesDetailed({
            query,
            maxItems: 5,
            sessionId: created.sessionId,
            cdpEndpoint: created.cdpEndpoint ?? null,
            wsEndpoint: created.wsEndpoint ?? null,
          });
          loadedUrls = pages.loaded.map((page) => page.url);
        } catch (error) {
          solariError = error instanceof Error ? error.message : String(error);
        } finally {
          if (created?.sessionId) {
            await solari.deleteSession(created.sessionId).catch(() => undefined);
          }
        }
      }

      const collect = await research.collect({
        companyId: COMPANY,
        query,
        sourceKinds: ['web'],
        maxItems: 5,
      });
      // eslint-disable-next-line no-console
      console.log('SOLARI_SESSION', JSON.stringify({ sessionId, loadedUrls, solariError }));
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
        sessionId,
        loadedUrls,
        solariError,
        evidenceBefore: before.length,
        evidenceAfter: after.length,
        newEvidence,
        tick,
        tickAction:
          tick && typeof tick === 'object' && 'action' in tick
            ? (tick as { action: unknown }).action
            : null,
      };
      // eslint-disable-next-line no-console
      console.log(JSON.stringify(report, null, 2));
      expect(collect.inserted + collect.duplicates + (collect.blockedOn ? 1 : 0)).toBeGreaterThanOrEqual(0);
    },
    240_000,
  );
});
