/**
 * Render-hosted storefront deploys.
 *
 * Preview, staging, and production all go through the Render API. A Lovable
 * preview is not a deploy and is never recorded as a production URL.
 * Production additionally re-evaluates `evaluateReleaseGate` and will not
 * trigger a Render deploy or promote when the gate blocks. Replay owns the
 * gate implementation; this service only refuses.
 */

import {
  CapabilityUnsupportedError,
  CredentialsMissingError,
  CRITICAL_FLOWS,
  PRODUCTION_REQUIRED_RUN_KINDS,
  evaluateReleaseGate,
  type Capability,
} from '@foundry/core';
import { RenderAdapter, mapDeployStatus } from '@foundry/providers';
import { optionalCapability, type ServiceDeps, type ServiceOutcome } from '../deps.js';

export const RENDER_SERVICE_NEEDED =
  'Site has no hosting_service_id. Set RENDER_STOREFRONT_SERVICE_ID and persist it on the site, or create a Render service first.';

export const LOCAL_PRODUCTION_URL_REFUSED =
  'Render returned a localhost URL; refusing to record it as a production storefront. Lovable preview is never production.';

export class SiteDeployService {
  constructor(private readonly deps: ServiceDeps) {}

  async deploy(input: {
    siteId: string;
    environment: 'preview' | 'staging' | 'production';
    gatingQaRunId?: string | null;
  }): Promise<
    ServiceOutcome<
      | { deploymentId: string; externalDeployId: string; status: string; url: string | null }
      | { promoted: boolean; deploymentId: string; gate: unknown }
    >
  > {
    if (input.environment === 'production') {
      if (!input.gatingQaRunId) {
        return blocked('qa.release_gate', 'Production deploy requires gatingQaRunId from a completed QA run.');
      }
      return this.deployProduction({ siteId: input.siteId, gatingQaRunId: input.gatingQaRunId });
    }
    return this.#deployNonProduction({ siteId: input.siteId, environment: input.environment });
  }

  async deployPreview(input: { siteId: string }): Promise<ServiceOutcome<{
    deploymentId: string;
    externalDeployId: string;
    status: string;
    url: string | null;
  }>> {
    return this.#deployNonProduction({ siteId: input.siteId, environment: 'preview' });
  }

  async deployStaging(input: { siteId: string }): Promise<ServiceOutcome<{
    deploymentId: string;
    externalDeployId: string;
    status: string;
    url: string | null;
  }>> {
    return this.#deployNonProduction({ siteId: input.siteId, environment: 'staging' });
  }

  async deployProduction(input: {
    siteId: string;
    gatingQaRunId: string;
  }): Promise<ServiceOutcome<{ promoted: boolean; deploymentId: string; gate: unknown }>> {
    const site = await this.#siteWithHosting(input.siteId);
    if (!site.hosting_service_id) {
      return blocked('platform.deploy_control', RENDER_SERVICE_NEEDED);
    }

    const adapter = optionalCapability<RenderAdapter>(this.deps, 'platform.deploy_control');
    if (!adapter || typeof adapter.triggerDeploy !== 'function') {
      return blocked('platform.deploy_control', this.#reason('platform.deploy_control'));
    }

    const runs = await this.deps.repos.build.qa.runsForSite(site.id, 50);
    const gating = runs.find((r) => r.id === input.gatingQaRunId);
    const gatedDeploymentId = gating?.deployment_id ?? site.current_deployment_id;

    const gate = gatedDeploymentId
      ? await this.deps.repos.build.qa.evaluateGate(site.company_id, site.id, gatedDeploymentId, 'production')
      : evaluateReleaseGate({
          environment: 'production',
          runs: [],
          openDefects: [],
          requiredFlows: [...CRITICAL_FLOWS],
          requiredRunKinds: [...PRODUCTION_REQUIRED_RUN_KINDS],
        });

    if (!gating || gate.verdict === 'block') {
      await this.deps.repos.build.sites.setStatus(site.id, 'release_blocked');
      return {
        ok: false,
        blockedOn: {
          capability: 'qa.release_gate',
          reason:
            gate.verdict === 'block'
              ? gate.blockers.map((b) => b.detail).join('; ') || 'evaluateReleaseGate blocked production deploy'
              : `gating QA run ${input.gatingQaRunId} was not found for site ${site.id}`,
        },
        data: { promoted: false, deploymentId: gatedDeploymentId ?? '', gate },
      };
    }

    // Past the gate, a deployment id is guaranteed: a null id yields an
    // empty-run gate that always blocks and returns above. This guard narrows
    // the type for the promotion path and documents that invariant.
    if (!gatedDeploymentId) {
      return blocked('qa.release_gate', 'No gated deployment id is available to promote to production.');
    }

    if (typeof adapter.getService === 'function') {
      const service = await adapter.getService(site.hosting_service_id);
      const previewed = service.serviceDetails?.url ?? null;
      if (previewed && isLocalPublicUrl(previewed)) {
        return {
          ok: false,
          blockedOn: { capability: 'platform.deploy_control', reason: LOCAL_PRODUCTION_URL_REFUSED },
          data: { promoted: false, deploymentId: gatedDeploymentId, gate },
        };
      }
    }

    try {
      const render = await adapter.triggerDeploy(site.hosting_service_id);
      const productionRow = await this.deps.repos.build.deployments.start({
        companyId: site.company_id,
        siteId: site.id,
        provider: 'render',
        environment: 'production',
        serviceId: site.hosting_service_id,
        externalDeployId: render.id,
        commitSha: render.commit?.id ?? null,
        gatingQaRunId: input.gatingQaRunId,
      });
      await this.deps.repos.build.deployments.update(productionRow.id, {
        status: mapDeployStatus(render.status),
        externalDeployId: render.id,
      });

      let url: string | null = null;
      if (typeof adapter.getService === 'function') {
        const service = await adapter.getService(site.hosting_service_id);
        url = service.serviceDetails?.url ?? null;
      }

      if (url && isLocalPublicUrl(url)) {
        await this.deps.repos.build.deployments.update(productionRow.id, {
          status: 'failed',
          error: LOCAL_PRODUCTION_URL_REFUSED,
          externalDeployId: render.id,
        });
        return {
          ok: false,
          blockedOn: { capability: 'platform.deploy_control', reason: LOCAL_PRODUCTION_URL_REFUSED },
          data: { promoted: false, deploymentId: productionRow.id, gate },
        };
      }

      if (render.status !== 'live' && typeof adapter.waitForDeploy === 'function') {
        const waited = await adapter.waitForDeploy(site.hosting_service_id, render.id, { timeoutMs: 10 * 60_000 });
        if (waited.status !== 'live') {
          await this.deps.repos.build.deployments.update(productionRow.id, {
            status: waited.status === 'timed_out' ? 'building' : 'failed',
            error: `Render deploy ended ${waited.status}`,
            externalDeployId: render.id,
          });
          return {
            ok: false,
            data: { promoted: false, deploymentId: productionRow.id, gate },
            blockedOn: {
              capability: 'platform.deploy_control',
              reason: `Render deploy ${render.id} is ${waited.status}, not live. Production was not promoted.`,
            },
          };
        }
      }

      if (!url) {
        return {
          ok: false,
          data: { promoted: false, deploymentId: productionRow.id, gate },
          blockedOn: {
            capability: 'platform.deploy_control',
            reason: 'Render did not return a service URL; refusing to record a production URL we do not have.',
          },
        };
      }

      // Promote the deployment that actually has QA evidence. A new production
      // row has no runs, and promoteToProduction would refuse it — correctly.
      const promotion = await this.deps.repos.build.qa.promoteToProduction({
        companyId: site.company_id,
        siteId: site.id,
        deploymentId: gatedDeploymentId,
        url,
      });
      if (!promotion.promoted) {
        await this.deps.repos.build.sites.setStatus(site.id, 'release_blocked');
        await this.deps.repos.build.deployments.update(productionRow.id, {
          status: 'failed',
          error: 'release gate blocked at promoteToProduction',
        });
        return {
          ok: false,
          blockedOn: {
            capability: 'qa.release_gate',
            reason: promotion.gate.blockers.map((b) => b.detail).join('; ') || 'evaluateReleaseGate blocked promotion',
          },
          data: { promoted: false, deploymentId: gatedDeploymentId, gate: promotion.gate },
        };
      }
      await this.deps.repos.build.deployments.update(productionRow.id, { status: 'live', url });
      return { ok: true, data: { promoted: true, deploymentId: gatedDeploymentId, gate: promotion.gate } };
    } catch (error) {
      return this.#fromProviderError('platform.deploy_control', error);
    }
  }

  async rollback(input: { siteId: string; deploymentId: string }): Promise<ServiceOutcome<{
    rolledBackTo: string;
    renderDeployId: string;
  }>> {
    const site = await this.#siteWithHosting(input.siteId);
    if (!site.hosting_service_id) {
      return blocked('platform.deploy_control', RENDER_SERVICE_NEEDED);
    }
    const adapter = optionalCapability<RenderAdapter>(this.deps, 'platform.deploy_control');
    if (!adapter || typeof adapter.rollbackDeploy !== 'function') {
      return blocked('platform.deploy_control', this.#reason('platform.deploy_control'));
    }

    const current = await this.deps.repos.build.deployments.byId(input.deploymentId);
    const target = await this.deps.repos.build.deployments.rollbackTarget(input.deploymentId);
    const renderDeployId = target?.external_deploy_id ?? current.external_deploy_id;
    if (!renderDeployId) {
      return blocked('platform.deploy_control', `deployment ${input.deploymentId} has no Render deploy id to roll back to`);
    }

    try {
      const rolled = await adapter.rollbackDeploy(site.hosting_service_id, renderDeployId);
      await this.deps.repos.build.deployments.update(input.deploymentId, { status: 'rolled_back' });
      if (target) {
        await this.deps.repos.build.deployments.update(target.id, { status: 'live' });
      }
      await this.deps.repos.build.sites.setStatus(site.id, 'rolled_back');
      return { ok: true, data: { rolledBackTo: target?.id ?? input.deploymentId, renderDeployId: rolled.id } };
    } catch (error) {
      return this.#fromProviderError('platform.deploy_control', error);
    }
  }

  async #deployNonProduction(input: {
    siteId: string;
    environment: 'preview' | 'staging';
  }): Promise<ServiceOutcome<{
    deploymentId: string;
    externalDeployId: string;
    status: string;
    url: string | null;
  }>> {
    const site = await this.#siteWithHosting(input.siteId);
    if (!site.hosting_service_id) {
      return blocked('platform.deploy_control', RENDER_SERVICE_NEEDED);
    }
    const adapter = optionalCapability<RenderAdapter>(this.deps, 'platform.deploy_control');
    if (!adapter || typeof adapter.triggerDeploy !== 'function') {
      return blocked('platform.deploy_control', this.#reason('platform.deploy_control'));
    }

    const idempotencyKey = `site.${input.environment}:${input.siteId}:${site.hosting_service_id}`;
    const claimed = await this.deps.repos.idempotency.claim(idempotencyKey, `site.deploy_${input.environment}`, {
      companyId: site.company_id,
    });
    if (claimed.status === 'in_progress') {
      return blocked('platform.deploy_control', `a ${input.environment} deploy is already in progress`);
    }

    try {
      const render = await adapter.triggerDeploy(site.hosting_service_id);
      const row = await this.deps.repos.build.deployments.start({
        companyId: site.company_id,
        siteId: site.id,
        provider: 'render',
        environment: input.environment,
        serviceId: site.hosting_service_id,
        externalDeployId: render.id,
        commitSha: render.commit?.id ?? null,
      });
      const mapped = mapDeployStatus(render.status);
      let previewUrl: string | null = null;
      if (typeof adapter.getService === 'function') {
        const service = await adapter.getService(site.hosting_service_id);
        previewUrl = service.serviceDetails?.url ?? null;
        if (previewUrl && isLocalPublicUrl(previewUrl)) {
          previewUrl = null;
        }
      }
      const updated = await this.deps.repos.build.deployments.update(row.id, {
        status: mapped,
        externalDeployId: render.id,
        ...(previewUrl ? { url: previewUrl } : {}),
      });
      if (previewUrl) {
        await this.deps.repos.build.sites.setUrls(site.id, { previewUrl });
      }
      if (mapped === 'live') {
        await this.deps.repos.build.sites.setStatus(site.id, 'preview_deployed');
      } else {
        await this.deps.repos.build.sites.setStatus(site.id, 'building');
      }
      await this.deps.repos.idempotency.complete(idempotencyKey, { deploymentId: updated.id, deployId: render.id });
      return {
        ok: true,
        data: {
          deploymentId: updated.id,
          externalDeployId: render.id,
          status: updated.status,
          url: updated.url,
        },
      };
    } catch (error) {
      await this.deps.repos.idempotency.fail(idempotencyKey, error instanceof Error ? error.message : String(error));
      return this.#fromProviderError('platform.deploy_control', error);
    }
  }

  async #siteWithHosting(siteId: string) {
    const site = await this.deps.repos.build.sites.byId(siteId);
    const hostingServiceId = await persistConfiguredHostingServiceId(
      this.deps,
      site.id,
      site.hosting_service_id,
    );
    return hostingServiceId && hostingServiceId !== site.hosting_service_id
      ? { ...site, hosting_service_id: hostingServiceId }
      : site;
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
 * `createSpec` also copies this id; deploy persists it only as a fallback.
 */
async function persistConfiguredHostingServiceId(
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

export function isLocalPublicUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.local');
  } catch {
    return /localhost|127\.0\.0\.1|::1/i.test(url);
  }
}

function blocked<T>(capability: Capability, reason: string): ServiceOutcome<T> {
  return { ok: false, blockedOn: { capability, reason } };
}
