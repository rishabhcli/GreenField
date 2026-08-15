/**
 * Storefront spec and code generation via Lovable.
 *
 * Production hosting is Render, not Lovable. A Lovable preview URL is never
 * recorded as a live production site. Code is retrieved with listFiles/readFile
 * so we have the files we claim to have generated.
 */

import {
  CapabilityUnsupportedError,
  CredentialsMissingError,
  type Capability,
  type SiteSpec,
  type SiteStatus,
} from '@foundry/core';
import { optionalCapability, type ServiceDeps, type ServiceOutcome } from '../deps.js';

/**
 * Structural generator surface. Production wiring uses LovableAdapter
 * (object-argument methods); tests may pass this positional shape.
 * `asSiteGenerator` adapts both.
 */
export interface SiteGenerator {
  createProject(prompt: string): Promise<{ projectId: string }>;
  sendMessage(projectId: string, text: string): Promise<void>;
  listFiles(projectId: string): Promise<string[]>;
  readFile(projectId: string, path: string): Promise<string>;
  deployProject(projectId: string): Promise<{ url: string | null }>;
}

export const SITE_HOSTING_NOTE =
  'Production storefront hosting is Render (`platform.deploy_control`), not Lovable preview URLs. A Lovable deploy URL is a generator preview only.';

/**
 * Build-phase honesty: a drafted spec is not a storefront. Complete only when
 * Lovable returned a project id *and* we actually read files.
 */
export function siteBuildComplete(input: {
  status: string;
  generatorProjectId?: string | null;
  exportedFiles?: Record<string, string> | null;
}): boolean {
  if (
    input.status === 'spec_drafted' ||
    input.status === 'generating' ||
    input.status === 'building' ||
    input.status === 'build_failed'
  ) {
    return false;
  }
  const files = input.exportedFiles;
  return Boolean(input.generatorProjectId) && files != null && Object.keys(files).length > 0;
}

export class SiteBuildService {
  constructor(private readonly deps: ServiceDeps) {}

  async createSpec(input: {
    companyId: string;
    brandId: string;
    spec: SiteSpec;
  }): Promise<ServiceOutcome<{ siteId: string; status: string }>> {
    const site = await this.deps.repos.build.sites.create({
      companyId: input.companyId,
      brandId: input.brandId,
      spec: input.spec,
    });
    await this.deps.repos.companies.setActive(input.companyId, { siteId: site.id });
    await persistConfiguredHostingServiceId(this.deps, site.id, site.hosting_service_id);
    return { ok: true, data: { siteId: site.id, status: site.status } };
  }

  async generate(input: { siteId: string; instructions: string }): Promise<ServiceOutcome<{
    projectId: string;
    status: SiteStatus;
    hostingNote: typeof SITE_HOSTING_NOTE;
    files: Record<string, string>;
    previewUrl: string | null;
  }>> {
    const raw = optionalCapability<unknown>(this.deps, 'site.generate');
    if (!asSiteGenerator(raw)) return blocked('site.generate', this.#reason('site.generate'));

    const site = await this.deps.repos.build.sites.byId(input.siteId);
    const idempotencyKey = `site.generate:${input.siteId}`;
    const generator = asSiteGenerator(raw, idempotencyKey)!;
    let claimed = await this.deps.repos.idempotency.claim(idempotencyKey, 'site.generate', {
      companyId: site.company_id,
      requestPayload: { siteId: input.siteId, instructions: input.instructions },
    });
    if (claimed.status === 'failed') {
      await this.deps.repos.idempotency.reset?.(idempotencyKey);
      claimed = await this.deps.repos.idempotency.claim(idempotencyKey, 'site.generate', {
        companyId: site.company_id,
        requestPayload: { siteId: input.siteId, instructions: input.instructions },
      });
    }
    if (claimed.status === 'in_progress') {
      return blocked('site.generate', `site generation for ${input.siteId} is already in progress`);
    }
    if (claimed.status === 'completed' && isRecord(claimed.result) && typeof claimed.result.projectId === 'string') {
      const files = filesOf(claimed.result.files);
      await this.deps.repos.build.sites.setGenerator(input.siteId, 'lovable', claimed.result.projectId);
      await this.deps.repos.build.sites.setStatus(input.siteId, 'generated');
      return {
        ok: true,
        data: {
          projectId: claimed.result.projectId,
          status: 'generated',
          hostingNote: SITE_HOSTING_NOTE,
          files,
          previewUrl: typeof claimed.result.previewUrl === 'string' ? claimed.result.previewUrl : null,
        },
      };
    }

    await this.deps.repos.build.sites.setStatus(input.siteId, 'generating');

    const prompt = [
      `Generate a storefront from this spec:\n${JSON.stringify(site.spec)}`,
      input.instructions,
      SITE_HOSTING_NOTE,
    ].join('\n\n');

    const buildId = await this.deps.repos.build.sites.recordBuild({
      siteId: input.siteId,
      reason: site.generator_project_id ? 'iteration' : 'initial',
      provider: 'lovable',
      instructions: input.instructions,
    });

    try {
      const created = await generator.createProject(prompt);
      if (input.instructions.trim()) {
        await generator.sendMessage(created.projectId, input.instructions);
      }

      const files = await readGeneratedFiles(generator, created.projectId);
      if (Object.keys(files).length === 0) {
        await this.deps.repos.build.sites.setStatus(input.siteId, 'spec_drafted');
        await this.deps.repos.build.sites.finishBuild(buildId, {
          status: 'failed',
          error: 'Lovable returned no files; spec_drafted is not a completed build',
        });
        await this.deps.repos.idempotency.fail?.(
          idempotencyKey,
          'Lovable returned no files; spec_drafted is not a completed build',
        );
        return blocked(
          'site.generate',
          'Lovable returned no files; spec_drafted is not a completed build. A generator project without retrieved files is not generated.',
        );
      }

      await this.deps.repos.build.sites.setGenerator(input.siteId, 'lovable', created.projectId);
      await this.deps.repos.build.sites.finishBuild(buildId, { status: 'succeeded', exportedFiles: files });
      await this.deps.repos.build.sites.setStatus(input.siteId, 'generated');

      const previewUrl = await previewDeployOnly(generator, created.projectId);
      if (previewUrl) {
        await this.deps.repos.build.sites.setUrls(input.siteId, { previewUrl });
      }

      await this.deps.repos.idempotency.complete(idempotencyKey, { projectId: created.projectId, files });
      return {
        ok: true,
        data: {
          projectId: created.projectId,
          status: 'generated',
          hostingNote: SITE_HOSTING_NOTE,
          files,
          previewUrl,
        },
      };
    } catch (error) {
      await this.deps.repos.build.sites.setStatus(input.siteId, 'spec_drafted');
      await this.deps.repos.build.sites.finishBuild(buildId, {
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      });
      await this.deps.repos.idempotency.fail?.(idempotencyKey, error instanceof Error ? error.message : String(error));
      return this.#fromProviderError('site.generate', error);
    }
  }

  /**
   * Pulls generated files. If a GitHub URL appears in the project, it is stored
   * as `repository_url`. This does not deploy, and a Lovable preview is not live.
   */
  async exportCode(input: { siteId: string }): Promise<ServiceOutcome<{
    files: Record<string, string>;
    repositoryUrl: string | null;
    hostingNote: typeof SITE_HOSTING_NOTE;
  }>> {
    const raw = optionalCapability<unknown>(this.deps, 'site.export_code')
      ?? optionalCapability<unknown>(this.deps, 'site.generate');
    const generator = asSiteGenerator(raw);
    if (!generator) {
      return blocked('site.export_code', this.#reason('site.export_code'));
    }

    const site = await this.deps.repos.build.sites.byId(input.siteId);
    if (!site.generator_project_id) {
      return {
        ok: false,
        blockedOn: { capability: 'site.export_code', reason: `site ${input.siteId} has no generator project id` },
      };
    }

    try {
      const paths = await generator.listFiles(site.generator_project_id);
      const files: Record<string, string> = {};
      let repositoryUrl: string | null = null;
      for (const path of paths) {
        const text = await generator.readFile(site.generator_project_id, path);
        files[path] = text;
        const found = text.match(/https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+/);
        if (found && !repositoryUrl) repositoryUrl = found[0];
      }

      const buildId = await this.deps.repos.build.sites.recordBuild({
        siteId: input.siteId,
        reason: 'content_update',
        provider: 'lovable',
        instructions: 'exportCode',
        externalRef: site.generator_project_id,
      });
      await this.deps.repos.build.sites.finishBuild(buildId, { status: 'succeeded', exportedFiles: files });
      await this.deps.repos.build.sites.setGenerator(
        input.siteId,
        site.generator_provider ?? 'lovable',
        site.generator_project_id,
        repositoryUrl,
      );
      await this.deps.repos.build.sites.setStatus(input.siteId, 'code_exported');
      return { ok: true, data: { files, repositoryUrl, hostingNote: SITE_HOSTING_NOTE } };
    } catch (error) {
      return this.#fromProviderError('site.export_code', error);
    }
  }

  #reason(capability: Capability): string {
    const status = this.deps.providers.forCapability(capability).status;
    return status.remediation ?? `capability state is ${status.state}`;
  }

  #fromProviderError<T>(capability: Capability, error: unknown): ServiceOutcome<T> {
    if (error instanceof CredentialsMissingError || error instanceof CapabilityUnsupportedError) {
      return blocked(capability, error.message);
    }
    throw error;
  }
}

/**
 * Copies `RENDER_STOREFRONT_SERVICE_ID` onto the site when the row has none.
 * Does not invent an id: absent config leaves hosting_service_id null.
 */
export async function persistConfiguredHostingServiceId(
  deps: Pick<ServiceDeps, 'repos' | 'renderStorefrontServiceId'>,
  siteId: string,
  currentHostingServiceId: string | null,
): Promise<string | null> {
  if (currentHostingServiceId) return currentHostingServiceId;
  const configured = deps.renderStorefrontServiceId;
  if (!configured) return null;
  await deps.repos.build.sites.setUrls(siteId, { hostingServiceId: configured });
  return configured;
}

function blocked<T>(capability: Capability, reason: string): ServiceOutcome<T> {
  return { ok: false, blockedOn: { capability, reason } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function asSiteGenerator(adapter: unknown, idempotencyKey?: string): SiteGenerator | undefined {
  if (!adapter || typeof adapter !== 'object') return undefined;
  const raw = adapter as Record<string, unknown>;
  if (typeof raw.createProject !== 'function') return undefined;

  const createProject = raw.createProject as (arg: unknown) => Promise<unknown>;
  const sendMessage = raw.sendMessage as ((a: unknown, b?: unknown) => Promise<unknown>) | undefined;
  const listFiles = raw.listFiles as ((a: unknown, b?: unknown) => Promise<unknown>) | undefined;
  const readFile = raw.readFile as ((a: unknown, b?: unknown, c?: unknown) => Promise<unknown>) | undefined;
  const deployProject = raw.deployProject as ((a: unknown, b?: unknown) => Promise<unknown>) | undefined;
  const real = 'manifest' in raw;

  return {
    async createProject(prompt: string) {
      const result = real
        ? await createProject({
            initialMessage: prompt,
            idempotencyKey: idempotencyKey ?? `lovable:${prompt.slice(0, 40)}`,
            wait: true,
          })
        : await createProject(prompt);
      const id = projectIdOf(result);
      if (!id) throw new Error('site generator did not return a project id');
      return { projectId: id };
    },
    async sendMessage(projectId: string, text: string) {
      if (!sendMessage) return;
      if (real) await sendMessage({ projectId, message: text, wait: true });
      else await sendMessage(projectId, text);
    },
    async listFiles(projectId: string) {
      if (!listFiles) return [];
      const listed = await listFiles(projectId);
      return pathsOf(listed);
    },
    async readFile(projectId: string, path: string) {
      if (!readFile) return '';
      const contents = real ? await readFile(projectId, path, 'HEAD') : await readFile(projectId, path);
      if (typeof contents === 'string') return contents;
      if (isRecord(contents) && typeof contents.text === 'string') return contents.text;
      return String(contents ?? '');
    },
    async deployProject(projectId: string) {
      if (!deployProject) return { url: null };
      const deployed = await deployProject(projectId);
      if (isRecord(deployed)) {
        const url =
          (typeof deployed.url === 'string' && deployed.url) ||
          (typeof deployed.live_url === 'string' && deployed.live_url) ||
          (typeof deployed.liveUrl === 'string' && deployed.liveUrl) ||
          null;
        return { url };
      }
      return { url: null };
    },
  };
}

async function readGeneratedFiles(generator: SiteGenerator, projectId: string): Promise<Record<string, string>> {
  const paths = await generator.listFiles(projectId);
  const files: Record<string, string> = {};
  for (const path of paths) {
    files[path] = await generator.readFile(projectId, path);
  }
  return files;
}

/** Lovable deploy_project is a generator preview. Callers must never persist this as production_url. */
async function previewDeployOnly(generator: SiteGenerator, projectId: string): Promise<string | null> {
  try {
    const deployed = await generator.deployProject(projectId);
    return deployed.url;
  } catch {
    return null;
  }
}

function filesOf(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  const files: Record<string, string> = {};
  for (const [path, text] of Object.entries(value)) {
    if (typeof text === 'string') files[path] = text;
  }
  return files;
}

function projectIdOf(result: unknown): string | undefined {
  if (typeof result === 'string' && result.length > 0) return result;
  if (!isRecord(result)) return undefined;
  for (const key of ['projectId', 'project_id', 'id'] as const) {
    const value = result[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

function pathsOf(listed: unknown): string[] {
  if (!listed) return [];
  if (Array.isArray(listed)) {
    return listed
      .map((item) => {
        if (typeof item === 'string') return item;
        if (isRecord(item) && typeof item.path === 'string') return item.path;
        if (isRecord(item) && typeof item.name === 'string') return item.name;
        return null;
      })
      .filter((p): p is string => typeof p === 'string' && p.length > 0);
  }
  if (isRecord(listed) && Array.isArray(listed.files)) return pathsOf(listed.files);
  return [];
}
