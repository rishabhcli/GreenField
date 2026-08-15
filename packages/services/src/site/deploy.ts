/**
 * Render-hosted storefront deploys.
 *
 * Preview and production both go through Render. A Lovable preview is not a
 * deploy. Production additionally re-evaluates the QA release gate and will
 * not promote without a pass — `promoteToProduction` is the write that
 * enforces it.
 */

import {
  CapabilityUnsupportedError,
  CredentialsMissingError,
  type Capability,
} from '@foundry/core';
import { RenderAdapter, mapDeployStatus } from '@foundry/providers';
import { optionalCapability, type ServiceDeps, type ServiceOutcome } from '../deps.js';

export const RENDER_SERVICE_NEEDED =
  'Site has no hosting_service_id. Set RENDER_STOREFRONT_SERVICE_ID and persist it on the site, or create a Render service first.';

export class SiteDeployService {
  constructor(private readonly deps: ServiceDeps) {}

  async deployPreview(input: { siteId: string }): Promise<ServiceOutcome<{
    deploymentId: string;
    externalDeployId: string;
    status: string;
    url: string | null;
  }>> {
    const site = await this.deps.repos.build.sites.byId(input.siteId);
    if (!site.hosting_service_id) {
      return blocked('platform.deploy_control', RENDER_SERVICE_NEEDED);
    }
    const adapter = optionalCapability<RenderAdapter>(this.deps, 'platform.deploy_control');
    if (!adapter || typeof adapter.triggerDeploy !== 'function') {
      return blocked('platform.deploy_control', this.#reason('platform.deploy_control'));
    }

    const idempotencyKey = `site.preview:${input.siteId}:${site.hosting_service_id}`;
    const claimed = await this.deps.repos.idempotency.claim(idempotencyKey, 'site.deploy_preview', {
      companyId: site.company_id,
    });
    if (claimed.status === 'in_progress') {
      return blocked('platform.deploy_control', 'a preview deploy is already in progress');
    }

    try {
      const render = await adapter.triggerDeploy(site.hosting_service_id);
      const row = await this.deps.repos.build.deployments.start({
        companyId: site.company_id,
        siteId: site.id,
        provider: 'render',
        environment: 'preview',
        serviceId: site.hosting_service_id,
        externalDeployId: render.id,
        commitSha: render.commit?.id ?? null,
      });
      const mapped = mapDeployStatus(render.status);
      const updated = await this.deps.repos.build.deployments.update(row.id, {
        status: mapped,
        externalDeployId: render.id,
      });
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

  async deployProduction(input: {
    siteId: string;
    gatingQaRunId: string;
  }): Promise<ServiceOutcome<{ promoted: boolean; deploymentId: string; gate: unknown }>> {
    const site = await this.deps.repos.build.sites.byId(input.siteId);
    if (!site.hosting_service_id) {
      return blocked('platform.deploy_control', RENDER_SERVICE_NEEDED);
    }

    const adapter = optionalCapability<RenderAdapter>(this.deps, 'platform.deploy_control');
    if (!adapter || typeof adapter.triggerDeploy !== 'function') {
      return blocked('platform.deploy_control', this.#reason('platform.deploy_control'));
    }

    const runs = await this.deps.repos.build.qa.runsForSite(site.id, 50);
    const gating = runs.find((r) => r.id === input.gatingQaRunId);
    if (!gating) {
      return {
        ok: false,
        blockedOn: {
          capability: 'qa.release_gate',
          reason: `gating QA run ${input.gatingQaRunId} was not found for site ${site.id}`,
        },
      };
    }
    if (gating.status === 'provider_unavailable' || gating.status !== 'completed') {
      await this.deps.repos.build.sites.setStatus(site.id, 'release_blocked');
      return {
        ok: false,
        blockedOn: {
          capability: 'qa.release_gate',
          reason: `gating QA run ${input.gatingQaRunId} has status "${gating.status}", not completed. An unexecuted or failed check cannot gate production.`,
        },
      };
    }

    const gatedDeploymentId = gating.deployment_id ?? site.current_deployment_id;
    if (!gatedDeploymentId) {
      return {
        ok: false,
        blockedOn: {
          capability: 'qa.release_gate',
          reason: 'gating QA run is not attached to a deployment; refusing to promote without that evidence trail',
        },
      };
    }

    const gate = await this.deps.repos.build.qa.evaluateGate(
      site.company_id,
      site.id,
      gatedDeploymentId,
      'production',
    );
    if (gate.verdict === 'block') {
      await this.deps.repos.build.sites.setStatus(site.id, 'release_blocked');
      return { ok: false, data: { promoted: false, deploymentId: gatedDeploymentId, gate } };
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
        return { ok: false, data: { promoted: false, deploymentId: gatedDeploymentId, gate: promotion.gate } };
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
    const site = await this.deps.repos.build.sites.byId(input.siteId);
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

function blocked<T>(capability: Capability, reason: string): ServiceOutcome<T> {
  return { ok: false, blockedOn: { capability, reason } };
}
