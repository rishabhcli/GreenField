/**
 * site.generate honesty: missing OAuth is blocked, a completed idempotency
 * claim replays, a Lovable preview URL is never a production host, and
 * spec_drafted is not a completed build.
 */

import { describe, expect, it } from 'vitest';
import { SecretStore, type SiteSpec } from '@foundry/core';
import { LOVABLE_MANIFEST, LovableAdapter, ProviderRegistry } from '@foundry/providers';
import type { ServiceDeps } from '../src/deps.js';
import { SITE_HOSTING_NOTE, SiteBuildService, siteBuildComplete } from '../src/site/build.js';

const COMPANY = 'co_01M03F7RQW2M6540BY2GZHCFBW';
const BRAND = 'br_01SITEGENERATE00000000000';
const SITE = 'site_01SITEGENERATE0000000000';
const PREVIEW = 'https://proj-1.lovable.app';

const spec: SiteSpec = {
  brandId: BRAND,
  productIds: ['prd_01SITEGENERATE0000000000'],
  pages: [{ kind: 'home', content: 'Welcome', required: true }],
  apiBaseUrl: 'https://api.example.test',
  publicConfig: {},
  analytics: { enabled: false, endpoint: null, consentRequired: true },
  designDirection: 'plain storefront',
};

interface GenerateCalls {
  createProject: unknown[];
  sendMessage: unknown[];
  listFiles: unknown[];
  readFile: unknown[];
  deployProject: unknown[];
  setStatus: string[];
  setGenerator: unknown[];
  setUrls: Array<{ previewUrl?: string | null; productionUrl?: string | null }>;
  finishBuild: Array<{ status: string; exportedFiles?: Record<string, string> | null }>;
  complete: unknown[];
  fail: unknown[];
}

function blockedOauthRegistry(): ProviderRegistry {
  return new ProviderRegistry({
    context: {
      secrets: new SecretStore({ get: () => undefined }),
      environment: 'preview',
      publicBaseUrl: 'https://example.test',
    },
    factories: { lovable: (ctx) => new LovableAdapter(ctx) },
    manifests: [LOVABLE_MANIFEST],
  });
}

function generateHarness(options: {
  readonly claim?: { status: 'claimed' | 'completed' | 'in_progress' | 'failed'; result?: unknown };
  readonly files?: string[];
  readonly fileContents?: Record<string, string>;
  readonly deployUrl?: string | null;
  readonly providers?: ServiceDeps['providers'];
  readonly siteStatus?: string;
  readonly generatorProjectId?: string | null;
}): {
  readonly service: SiteBuildService;
  readonly calls: GenerateCalls;
} {
  const calls: GenerateCalls = {
    createProject: [],
    sendMessage: [],
    listFiles: [],
    readFile: [],
    deployProject: [],
    setStatus: [],
    setGenerator: [],
    setUrls: [],
    finishBuild: [],
    complete: [],
    fail: [],
  };

  const paths = options.files ?? ['src/App.tsx'];
  const contents = options.fileContents ?? { 'src/App.tsx': 'export default function App() { return null; }' };

  const generator = {
    createProject: async (input: unknown) => {
      calls.createProject.push(input);
      return { projectId: 'proj_1' };
    },
    sendMessage: async (projectId: unknown, text: unknown) => {
      calls.sendMessage.push({ projectId, text });
    },
    listFiles: async (projectId: unknown) => {
      calls.listFiles.push(projectId);
      return paths;
    },
    readFile: async (projectId: unknown, path: unknown) => {
      calls.readFile.push({ projectId, path });
      return contents[String(path)] ?? `// ${String(path)}`;
    },
    deployProject: async (projectId: unknown) => {
      calls.deployProject.push(projectId);
      return { url: options.deployUrl === undefined ? PREVIEW : options.deployUrl };
    },
  };

  const site = {
    id: SITE,
    company_id: COMPANY,
    brand_id: BRAND,
    spec,
    status: options.siteStatus ?? 'spec_drafted',
    generator_project_id: options.generatorProjectId ?? null,
    generator_provider: null,
    hosting_service_id: null,
    preview_url: null,
    production_url: null,
  };

  const deps = {
    providers: options.providers ?? {
      forCapability: (capability: string) => {
        if (capability === 'site.generate' || capability === 'site.export_code') {
          return { adapter: generator, status: { state: 'configured_unverified', usable: true, remediation: null } };
        }
        return { adapter: undefined, status: { state: 'unimplemented', usable: false, remediation: `${capability} missing` } };
      },
    },
    repos: {
      companies: {
        setActive: async () => undefined,
      },
      build: {
        sites: {
          create: async () => ({ id: SITE, status: 'spec_drafted', hosting_service_id: null }),
          byId: async () => site,
          setStatus: async (_id: string, status: string) => {
            calls.setStatus.push(status);
            site.status = status;
          },
          setGenerator: async (_id: string, provider: string, projectId: string) => {
            calls.setGenerator.push({ provider, projectId });
            site.generator_project_id = projectId;
            site.generator_provider = provider;
          },
          setUrls: async (_id: string, urls: { previewUrl?: string | null; productionUrl?: string | null }) => {
            calls.setUrls.push(urls);
            if (urls.previewUrl !== undefined) site.preview_url = urls.previewUrl;
            if (urls.productionUrl !== undefined) site.production_url = urls.productionUrl;
          },
          recordBuild: async () => 'sbl_1',
          finishBuild: async (
            _id: string,
            outcome: { status: string; exportedFiles?: Record<string, string> | null },
          ) => {
            calls.finishBuild.push(outcome);
          },
        },
      },
      idempotency: {
        claim: async () => options.claim ?? { status: 'claimed' as const, key: `site.generate:${SITE}` },
        complete: async (key: string, result: unknown) => {
          calls.complete.push({ key, result });
        },
        fail: async (key: string, error: string) => {
          calls.fail.push({ key, error });
        },
        reset: async () => undefined,
      },
    },
  } as unknown as ServiceDeps;

  return { service: new SiteBuildService(deps), calls };
}

describe('siteBuildComplete', () => {
  it('treats spec_drafted as incomplete even when a site row exists', () => {
    expect(
      siteBuildComplete({
        status: 'spec_drafted',
        generatorProjectId: null,
        exportedFiles: null,
      }),
    ).toBe(false);
  });

  it('is complete only when a generator project id and retrieved files exist', () => {
    expect(
      siteBuildComplete({
        status: 'generated',
        generatorProjectId: 'proj_1',
        exportedFiles: { 'src/App.tsx': 'export default function App() { return null; }' },
      }),
    ).toBe(true);
    expect(
      siteBuildComplete({
        status: 'generated',
        generatorProjectId: 'proj_1',
        exportedFiles: {},
      }),
    ).toBe(false);
  });
});

describe('SiteBuildService.generate', () => {
  it('returns blocked_missing_credentials when LOVABLE_OAUTH_ACCESS_TOKEN is absent', async () => {
    const { service, calls } = generateHarness({
      providers: blockedOauthRegistry(),
    });
    const result = await service.generate({ siteId: SITE, instructions: 'Build the storefront' });
    expect(result.ok).toBe(false);
    expect(result.blockedOn?.capability).toBe('site.generate');
    expect(result.blockedOn?.reason).toMatch(/LOVABLE_OAUTH_ACCESS_TOKEN/);
    expect(result.blockedOn?.reason).toMatch(/OAuth/i);
    expect(calls.createProject).toEqual([]);
    expect(calls.setStatus).not.toContain('generated');
  });

  it('replays a completed site.generate:{siteId} claim and does not re-create', async () => {
    const { service, calls } = generateHarness({
      claim: {
        status: 'completed',
        result: {
          projectId: 'proj_replay',
          files: { 'src/App.tsx': 'replayed' },
        },
      },
    });
    const result = await service.generate({ siteId: SITE, instructions: 'Build the storefront' });
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({
      projectId: 'proj_replay',
      status: 'generated',
      hostingNote: SITE_HOSTING_NOTE,
    });
    expect(calls.createProject).toEqual([]);
    expect(calls.deployProject).toEqual([]);
    expect(calls.setGenerator).toEqual([{ provider: 'lovable', projectId: 'proj_replay' }]);
  });

  it('does not store a Lovable deploy URL as the production host', async () => {
    const { service, calls } = generateHarness({ deployUrl: PREVIEW });
    const result = await service.generate({ siteId: SITE, instructions: 'Add a product grid' });
    expect(result.ok).toBe(true);
    expect(result.data?.hostingNote).toBe(SITE_HOSTING_NOTE);
    expect(calls.deployProject).toEqual(['proj_1']);
    expect(calls.setUrls.some((u) => u.productionUrl === PREVIEW)).toBe(false);
    expect(calls.setUrls.some((u) => u.productionUrl?.includes('lovable.app'))).toBe(false);
  });

  it('does not mark generated until files were actually read', async () => {
    const { service, calls } = generateHarness({ files: [] });
    const result = await service.generate({ siteId: SITE, instructions: 'Build the storefront' });
    expect(result.ok).toBe(false);
    expect(calls.createProject).toHaveLength(1);
    expect(calls.listFiles).toEqual(['proj_1']);
    expect(calls.readFile).toEqual([]);
    expect(calls.setStatus).not.toContain('generated');
    expect(calls.finishBuild.some((b) => b.status === 'succeeded')).toBe(false);
    expect(calls.complete).toEqual([]);
    expect(siteBuildComplete({ status: 'spec_drafted', generatorProjectId: 'proj_1', exportedFiles: {} })).toBe(
      false,
    );
  });

  it('persists generator project id and retrieved files, then marks generated', async () => {
    const { service, calls } = generateHarness({
      files: ['src/App.tsx', 'index.html'],
      fileContents: {
        'src/App.tsx': 'export default function App() { return null; }',
        'index.html': '<html></html>',
      },
    });
    const result = await service.generate({ siteId: SITE, instructions: 'Add a product grid' });
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({
      projectId: 'proj_1',
      status: 'generated',
      hostingNote: SITE_HOSTING_NOTE,
      files: {
        'src/App.tsx': 'export default function App() { return null; }',
        'index.html': '<html></html>',
      },
    });
    expect(calls.listFiles).toEqual(['proj_1']);
    expect(calls.readFile).toEqual([
      { projectId: 'proj_1', path: 'src/App.tsx' },
      { projectId: 'proj_1', path: 'index.html' },
    ]);
    expect(calls.setGenerator).toEqual([{ provider: 'lovable', projectId: 'proj_1' }]);
    expect(calls.finishBuild).toContainEqual({
      status: 'succeeded',
      exportedFiles: {
        'src/App.tsx': 'export default function App() { return null; }',
        'index.html': '<html></html>',
      },
    });
    expect(calls.setStatus).toContain('generated');
    expect(calls.complete).toEqual([
      {
        key: `site.generate:${SITE}`,
        result: {
          projectId: 'proj_1',
          files: {
            'src/App.tsx': 'export default function App() { return null; }',
            'index.html': '<html></html>',
          },
        },
      },
    ]);
    expect(
      siteBuildComplete({
        status: 'generated',
        generatorProjectId: 'proj_1',
        exportedFiles: result.data?.files ?? null,
      }),
    ).toBe(true);
  });
});

describe('SiteBuildService.createSpec vs build complete', () => {
  it('leaves the site spec_drafted, which is not a completed build', async () => {
    const { service } = generateHarness({});
    const created = await service.createSpec({ companyId: COMPANY, brandId: BRAND, spec });
    expect(created.ok).toBe(true);
    expect(created.data?.status).toBe('spec_drafted');
    expect(siteBuildComplete({ status: created.data!.status, generatorProjectId: null, exportedFiles: null })).toBe(
      false,
    );
  });
});
