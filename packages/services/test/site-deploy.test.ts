/**
 * Storefront deploys go through the Render API. A Lovable preview is not a
 * deploy. Production is refused when evaluateReleaseGate blocks; preview and
 * staging must never write a production URL.
 */

import { describe, expect, it } from 'vitest';
import {
  CRITICAL_FLOWS,
  PRODUCTION_REQUIRED_RUN_KINDS,
  evaluateReleaseGate,
} from '@foundry/core';
import type { ServiceDeps } from '../src/deps.js';
import { SiteDeployService } from '../src/site/deploy.js';

const COMPANY = 'co_01M03F7RQW2M6540BY2GZHCFBW';
const SITE = 'site_01RENDERDEPLOY00000000000';
const SERVICE = 'srv-storefront-test';
const QA_RUN = 'qa_01RENDERGATE0000000000000';

function blockedProductionGate() {
  return evaluateReleaseGate({
    environment: 'production',
    runs: [],
    openDefects: [],
    requiredFlows: [...CRITICAL_FLOWS],
    requiredRunKinds: [...PRODUCTION_REQUIRED_RUN_KINDS],
  });
}

function passingProductionGate() {
  return evaluateReleaseGate({
    environment: 'production',
    runs: PRODUCTION_REQUIRED_RUN_KINDS.map((kind) => ({
      kind,
      status: 'completed' as const,
      flowsCovered: [...CRITICAL_FLOWS],
      unavailableReason: null,
    })),
    openDefects: [],
    requiredFlows: [...CRITICAL_FLOWS],
    requiredRunKinds: [...PRODUCTION_REQUIRED_RUN_KINDS],
  });
}

function siteRow(overrides: Record<string, unknown> = {}) {
  return {
    id: SITE,
    company_id: COMPANY,
    hosting_service_id: SERVICE,
    current_deployment_id: 'dpl_preview_existing',
    production_url: null,
    preview_url: null,
    status: 'generated',
    ...overrides,
  };
}

function deployRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'dpl_01RENDER0000000000000000',
    company_id: COMPANY,
    site_id: SITE,
    provider: 'render',
    environment: 'preview',
    status: 'queued',
    url: null,
    external_deploy_id: 'dep-render-1',
    ...overrides,
  };
}

interface Harness {
  triggerIds: string[];
  started: Array<{ environment: string; serviceId?: string | null; gatingQaRunId?: string | null }>;
  setUrls: Array<{ siteId: string; urls: { previewUrl?: string | null; productionUrl?: string | null; hostingServiceId?: string | null } }>;
  promotions: Array<{ url: string; deploymentId: string }>;
  adapter: {
    triggerDeploy: (serviceId: string) => Promise<{ id: string; status: string; commit?: { id: string } | null }>;
    getService: (serviceId: string) => Promise<{ id: string; name: string; type: string; serviceDetails: { url: string | null } }>;
    waitForDeploy?: (serviceId: string, deployId: string) => Promise<{ status: string }>;
  };
  deps: ServiceDeps;
}

function harness(options: {
  site?: Record<string, unknown>;
  renderStorefrontServiceId?: string;
  serviceUrl?: string | null;
  runsForSite?: unknown[];
  gate?: ReturnType<typeof evaluateReleaseGate>;
  triggerStatus?: string;
} = {}): Harness {
  const triggerIds: string[] = [];
  const started: Harness['started'] = [];
  const setUrls: Harness['setUrls'] = [];
  const promotions: Harness['promotions'] = [];
  const site = siteRow(options.site);
  let latest = deployRow();

  const adapter: Harness['adapter'] = {
    triggerDeploy: async (serviceId) => {
      triggerIds.push(serviceId);
      return { id: 'dep-render-1', status: options.triggerStatus ?? 'created', commit: { id: 'abc123' } };
    },
    getService: async () => ({
      id: SERVICE,
      name: 'storefront',
      type: 'web',
      serviceDetails: { url: options.serviceUrl === undefined ? 'https://storefront.onrender.com' : options.serviceUrl },
    }),
  };

  const deps = {
    renderStorefrontServiceId: options.renderStorefrontServiceId,
    providers: {
      forCapability: (capability: string) => ({
        adapter: capability === 'platform.deploy_control' ? adapter : undefined,
        status: {
          capability,
          provider: 'render',
          state: capability === 'platform.deploy_control' ? 'live_verified' : 'blocked_missing_credentials',
          usable: capability === 'platform.deploy_control',
          remediation: 'RENDER_API_KEY is not set',
          missingSecrets: [],
        },
      }),
    },
    repos: {
      idempotency: {
        claim: async () => ({ status: 'claimed' }),
        complete: async () => undefined,
        fail: async () => undefined,
      },
      build: {
        sites: {
          byId: async () => site,
          setStatus: async () => undefined,
          setUrls: async (
            siteId: string,
            urls: { previewUrl?: string | null; productionUrl?: string | null; hostingServiceId?: string | null },
          ) => {
            setUrls.push({ siteId, urls });
            if (urls.hostingServiceId) site.hosting_service_id = urls.hostingServiceId;
            if (urls.productionUrl) site.production_url = urls.productionUrl;
            if (urls.previewUrl) site.preview_url = urls.previewUrl;
          },
        },
        deployments: {
          start: async (input: {
            environment: string;
            serviceId?: string | null;
            gatingQaRunId?: string | null;
          }) => {
            started.push({
              environment: input.environment,
              serviceId: input.serviceId,
              gatingQaRunId: input.gatingQaRunId ?? null,
            });
            latest = deployRow({
              environment: input.environment,
              service_id: input.serviceId,
              gating_qa_run_id: input.gatingQaRunId ?? null,
            });
            return latest;
          },
          update: async (_id: string, patch: { status?: string; url?: string | null }) => {
            latest = { ...latest, ...patch, url: patch.url ?? latest.url };
            return latest;
          },
        },
        qa: {
          runsForSite: async () => options.runsForSite ?? [],
          evaluateGate: async () => options.gate ?? blockedProductionGate(),
          promoteToProduction: async (input: { url: string; deploymentId: string }) => {
            promotions.push({ url: input.url, deploymentId: input.deploymentId });
            return { promoted: true, gate: passingProductionGate() };
          },
        },
      },
    },
  } as unknown as ServiceDeps;

  return { triggerIds, started, setUrls, promotions, adapter, deps };
}

describe('SiteDeployService.deployPreview', () => {
  it('uses RENDER_STOREFRONT_SERVICE_ID when the site row has no hosting id', async () => {
    const h = harness({
      site: { hosting_service_id: null },
      renderStorefrontServiceId: SERVICE,
    });
    const result = await new SiteDeployService(h.deps).deployPreview({ siteId: SITE });
    expect(result.ok).toBe(true);
    expect(h.triggerIds).toEqual([SERVICE]);
    expect(h.started[0]?.serviceId).toBe(SERVICE);
    expect(h.setUrls).toContainEqual({ siteId: SITE, urls: { hostingServiceId: SERVICE } });
  });

  it('does not set a production URL', async () => {
    const h = harness();
    const result = await new SiteDeployService(h.deps).deployPreview({ siteId: SITE });
    expect(result.ok).toBe(true);
    expect(h.started[0]?.environment).toBe('preview');
    expect(h.promotions).toEqual([]);
    expect(h.setUrls.some((call) => typeof call.urls.productionUrl === 'string' && call.urls.productionUrl.length > 0)).toBe(
      false,
    );
    expect(result.data?.url === 'https://storefront.onrender.com' || result.data?.url == null).toBe(true);
  });
});

describe('SiteDeployService.deploy staging', () => {
  it('talks to Render and does not write a production URL', async () => {
    const h = harness();
    const service = new SiteDeployService(h.deps);
    const result =
      typeof service.deploy === 'function'
        ? await service.deploy({ siteId: SITE, environment: 'staging' })
        : await service.deployStaging({ siteId: SITE });
    expect(result.ok).toBe(true);
    expect(h.triggerIds).toEqual([SERVICE]);
    expect(h.started[0]?.environment).toBe('staging');
    expect(h.promotions).toEqual([]);
    expect(h.setUrls.some((call) => typeof call.urls.productionUrl === 'string')).toBe(false);
  });
});

describe('SiteDeployService.deployProduction', () => {
  it('returns blocked without a QA artefact and does not call Render', async () => {
    const gate = blockedProductionGate();
    expect(gate.verdict).toBe('block');

    const h = harness({ gate, runsForSite: [] });
    const result = await new SiteDeployService(h.deps).deployProduction({
      siteId: SITE,
      gatingQaRunId: QA_RUN,
    });

    expect(result.ok).toBe(false);
    expect(result.blockedOn?.capability).toBe('qa.release_gate');
    expect(h.triggerIds).toEqual([]);
    expect(h.promotions).toEqual([]);
    expect(result.data?.promoted ?? false).toBe(false);
  });

  it('refuses a localhost production URL even when the gate would pass', async () => {
    const h = harness({
      gate: passingProductionGate(),
      serviceUrl: 'http://localhost:5173',
      runsForSite: [
        {
          id: QA_RUN,
          status: 'completed',
          deployment_id: 'dpl_preview_existing',
        },
      ],
    });

    const result = await new SiteDeployService(h.deps).deployProduction({
      siteId: SITE,
      gatingQaRunId: QA_RUN,
    });

    expect(result.ok).toBe(false);
    expect(result.blockedOn?.reason).toMatch(/localhost/i);
    expect(h.promotions).toEqual([]);
  });
});
