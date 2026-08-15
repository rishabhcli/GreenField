/**
 * Render adapter — production hosting, deploys, logs and rollback.
 *
 * Two behaviours here are load-bearing for safety:
 *
 *  - `triggerDeploy` is never retried blindly. A duplicate deploy wastes a
 *    build and can flap traffic, so the caller supplies an operation key and
 *    the platform's idempotency ledger decides whether it already ran.
 *  - Environment variable values are never logged, returned in bulk, or placed
 *    in an audit payload. Only key names travel.
 *
 * Verified against Render's API reference on 2026-08-14.
 */

import { z } from 'zod';
import {
  ProviderAuthError,
  ProviderContractError,
  RateLimitError,
  ValidationError,
  type Deployment,
} from '@foundry/core';
import { getLogger } from '@foundry/obs';
import { ProviderAdapter, type AdapterContext, type ProbeResult } from '../http/adapter.js';
import { bearerAuth, type ProviderHttpClient } from '../http/client.js';
import { RENDER_MANIFEST, SECRETS } from '../manifests.js';

/* -------------------------------------------------------------------------- */
/* Schemas                                                                     */
/* -------------------------------------------------------------------------- */

const RenderService = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string(),
  repo: z.string().nullish(),
  branch: z.string().nullish(),
  suspended: z.string().nullish(),
  serviceDetails: z
    .object({
      url: z.string().nullish(),
      healthCheckPath: z.string().nullish(),
      numInstances: z.number().nullish(),
      region: z.string().nullish(),
    })
    .nullish(),
  createdAt: z.string().nullish(),
  updatedAt: z.string().nullish(),
});
export type RenderService = z.infer<typeof RenderService>;

/** List endpoints wrap each item in a `{ cursor, <resource> }` envelope. */
const ServiceListItem = z.object({ cursor: z.string().nullish(), service: RenderService });
const ServiceList = z.array(ServiceListItem);

/**
 * Terminal deploy statuses. `live` is the only success; everything else here
 * means the release did not happen and must not be recorded as though it did.
 */
export const TERMINAL_DEPLOY_STATUSES = [
  'live',
  'build_failed',
  'update_failed',
  'canceled',
  'deactivated',
  'pre_deploy_failed',
] as const;
export type TerminalDeployStatus = (typeof TERMINAL_DEPLOY_STATUSES)[number];

const RenderDeploy = z.object({
  id: z.string(),
  commit: z.object({ id: z.string().nullish(), message: z.string().nullish(), createdAt: z.string().nullish() }).nullish(),
  status: z.string(),
  trigger: z.string().nullish(),
  startedAt: z.string().nullish(),
  finishedAt: z.string().nullish(),
  createdAt: z.string().nullish(),
  updatedAt: z.string().nullish(),
});
export type RenderDeploy = z.infer<typeof RenderDeploy>;

const DeployListItem = z.object({ cursor: z.string().nullish(), deploy: RenderDeploy });
const DeployList = z.array(DeployListItem);

const EnvVar = z.object({ key: z.string(), value: z.string().nullish() });
const EnvVarListItem = z.object({ cursor: z.string().nullish(), envVar: EnvVar });
const EnvVarList = z.array(EnvVarListItem);

const RenderEvent = z.object({
  id: z.string(),
  type: z.string(),
  timestamp: z.string().nullish(),
  details: z.record(z.string(), z.unknown()).nullish(),
});
const EventListItem = z.object({ cursor: z.string().nullish(), event: RenderEvent });
const EventList = z.array(EventListItem);

const LogEntry = z.object({
  id: z.string().nullish(),
  timestamp: z.string(),
  message: z.string(),
  labels: z.array(z.object({ name: z.string(), value: z.string() })).nullish(),
});
const LogsResponse = z.object({
  logs: z.array(LogEntry),
  hasMore: z.boolean().nullish(),
  nextStartTime: z.string().nullish(),
  nextEndTime: z.string().nullish(),
});

/* -------------------------------------------------------------------------- */
/* Adapter                                                                     */
/* -------------------------------------------------------------------------- */

export class RenderAdapter extends ProviderAdapter {
  override readonly manifest = RENDER_MANIFEST;

  constructor(ctx: AdapterContext) {
    super(ctx);
  }

  #client(): ProviderHttpClient {
    return this.http(bearerAuth(this.requireSecret(SECRETS.renderApiKey)), {
      requestIdHeader: 'x-request-id',
      defaultHeaders: { accept: 'application/json' },
      classifyError: (status, body) => {
        if (status === 401 || status === 403) {
          return new ProviderAuthError('render', `HTTP ${status}`, { body: summarise(body) });
        }
        if (status === 429) return new RateLimitError('render');
        return undefined;
      },
    });
  }

  override async probe(): Promise<ProbeResult> {
    const response = await this.#client().request(
      { method: 'GET', path: '/services', query: { limit: 1 }, operation: 'listServices' },
      ServiceList,
    );
    return {
      succeeded: true,
      detail: `GET /v1/services returned ${response.body.length} service(s)`,
      evidence: {
        endpoint: 'GET /v1/services?limit=1',
        status: response.status,
        serviceCount: response.body.length,
        requestId: response.requestId,
      },
    };
  }

  /* ---------------------------------------------------------------------- */
  /* Services                                                                */
  /* ---------------------------------------------------------------------- */

  async listServices(limit = 50): Promise<readonly RenderService[]> {
    this.assertActivated();
    const response = await this.#client().request(
      { method: 'GET', path: '/services', query: { limit }, operation: 'listServices' },
      ServiceList,
    );
    return response.body.map((item) => item.service);
  }

  async getService(serviceId: string): Promise<RenderService> {
    this.assertActivated();
    const response = await this.#client().request(
      { method: 'GET', path: `/services/${serviceId}`, operation: 'getService' },
      RenderService,
    );
    return response.body;
  }

  /* ---------------------------------------------------------------------- */
  /* Deploys                                                                 */
  /* ---------------------------------------------------------------------- */

  /**
   * Triggers a deploy.
   *
   * `retryable: false` is deliberate. Render publishes no idempotency header,
   * so an automatic retry after a timeout could start a second build of the
   * same commit — burning build minutes and, worse, racing two rollouts. The
   * caller reserves an operation key in the platform idempotency ledger first;
   * a genuine retry replays that ledger entry instead of calling again.
   */
  async triggerDeploy(
    serviceId: string,
    options: { commitId?: string; clearCache?: boolean } = {},
  ): Promise<RenderDeploy> {
    this.assertActivated();
    const response = await this.#client().request(
      {
        method: 'POST',
        path: `/services/${serviceId}/deploys`,
        body: {
          ...(options.commitId ? { commitId: options.commitId } : {}),
          ...(options.clearCache ? { clearCache: 'clear' } : {}),
        },
        retryable: false,
        operation: 'createDeploy',
      },
      RenderDeploy,
    );
    getLogger().info({ serviceId, deployId: response.body.id }, 'render deploy triggered');
    return response.body;
  }

  async listDeploys(serviceId: string, limit = 20): Promise<readonly RenderDeploy[]> {
    this.assertActivated();
    const response = await this.#client().request(
      { method: 'GET', path: `/services/${serviceId}/deploys`, query: { limit }, operation: 'listDeploys' },
      DeployList,
    );
    return response.body.map((item) => item.deploy);
  }

  async getDeploy(serviceId: string, deployId: string): Promise<RenderDeploy> {
    this.assertActivated();
    const response = await this.#client().request(
      { method: 'GET', path: `/services/${serviceId}/deploys/${deployId}`, operation: 'getDeploy' },
      RenderDeploy,
    );
    return response.body;
  }

  async cancelDeploy(serviceId: string, deployId: string): Promise<RenderDeploy> {
    this.assertActivated();
    const response = await this.#client().request(
      { method: 'POST', path: `/services/${serviceId}/deploys/${deployId}/cancel`, retryable: false, operation: 'cancelDeploy' },
      RenderDeploy,
    );
    return response.body;
  }

  /** Restores a previous deploy. The single call the rollback runbook depends on. */
  async rollbackDeploy(serviceId: string, deployId: string): Promise<RenderDeploy> {
    this.assertActivated();
    const response = await this.#client().request(
      {
        method: 'POST',
        path: `/services/${serviceId}/rollback`,
        body: { deployId },
        retryable: false,
        operation: 'rollbackDeploy',
      },
      RenderDeploy,
    );
    getLogger().warn({ serviceId, deployId }, 'render rollback triggered');
    return response.body;
  }

  /**
   * Polls a deploy to a terminal status.
   *
   * Backs off from 5s to 30s: a Render build routinely takes minutes, and
   * hammering the API adds nothing. Returns the terminal status rather than
   * throwing on failure, because a failed build is a normal outcome the
   * deployment record must capture, not an exception.
   */
  async waitForDeploy(
    serviceId: string,
    deployId: string,
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<{ status: TerminalDeployStatus | 'timed_out'; deploy: RenderDeploy | null; waitedMs: number }> {
    const timeoutMs = options.timeoutMs ?? 30 * 60_000;
    const startedAt = Date.now();
    let intervalMs = 5_000;
    let last: RenderDeploy | null = null;

    while (Date.now() - startedAt < timeoutMs) {
      if (options.signal?.aborted) {
        return { status: 'timed_out', deploy: last, waitedMs: Date.now() - startedAt };
      }
      last = await this.getDeploy(serviceId, deployId);
      if ((TERMINAL_DEPLOY_STATUSES as readonly string[]).includes(last.status)) {
        return { status: last.status as TerminalDeployStatus, deploy: last, waitedMs: Date.now() - startedAt };
      }
      await sleep(intervalMs, options.signal);
      intervalMs = Math.min(30_000, Math.round(intervalMs * 1.5));
    }

    getLogger().error({ serviceId, deployId, timeoutMs }, 'deploy did not reach a terminal status in time');
    return { status: 'timed_out', deploy: last, waitedMs: Date.now() - startedAt };
  }

  /* ---------------------------------------------------------------------- */
  /* Environment variables                                                   */
  /* ---------------------------------------------------------------------- */

  /** Key names only — values are never returned to callers or logged. */
  async listEnvVarKeys(serviceId: string): Promise<readonly string[]> {
    this.assertActivated();
    const response = await this.#client().request(
      { method: 'GET', path: `/services/${serviceId}/env-vars`, query: { limit: 100 }, operation: 'listEnvVars' },
      EnvVarList,
    );
    return response.body.map((item) => item.envVar.key);
  }

  /**
   * Sets one variable.
   *
   * Uses the single-key PUT rather than the bulk replace, because the bulk form
   * silently deletes any key not included — a whole-service outage one typo
   * away.
   */
  async setEnvVar(serviceId: string, key: string, value: string): Promise<void> {
    this.assertActivated();
    if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) {
      throw new ValidationError(`Invalid environment variable name "${key}"`, { key });
    }
    await this.#client().request(
      {
        method: 'PUT',
        path: `/services/${serviceId}/env-vars/${encodeURIComponent(key)}`,
        body: { value },
        operation: 'updateEnvVar',
      },
      EnvVar,
    );
    // Key name only. The value never reaches a log line.
    getLogger().info({ serviceId, key }, 'render env var set');
  }

  async deleteEnvVar(serviceId: string, key: string): Promise<void> {
    this.assertActivated();
    await this.#client().raw({
      method: 'DELETE',
      path: `/services/${serviceId}/env-vars/${encodeURIComponent(key)}`,
      operation: 'deleteEnvVar',
    });
    getLogger().info({ serviceId, key }, 'render env var deleted');
  }

  /* ---------------------------------------------------------------------- */
  /* Observability                                                           */
  /* ---------------------------------------------------------------------- */

  async listEvents(serviceId: string, limit = 20): Promise<readonly z.infer<typeof RenderEvent>[]> {
    this.assertActivated();
    const response = await this.#client().request(
      { method: 'GET', path: `/services/${serviceId}/events`, query: { limit }, operation: 'listEvents' },
      EventList,
    );
    return response.body.map((item) => item.event);
  }

  async readLogs(input: {
    ownerId: string;
    resourceIds: readonly string[];
    startTime?: Date;
    endTime?: Date;
    text?: string;
    limit?: number;
  }): Promise<{ logs: readonly z.infer<typeof LogEntry>[]; hasMore: boolean }> {
    this.assertActivated();
    const response = await this.#client().request(
      {
        method: 'GET',
        path: '/logs',
        query: {
          ownerId: input.ownerId,
          resource: [...input.resourceIds],
          ...(input.startTime ? { startTime: input.startTime.toISOString() } : {}),
          ...(input.endTime ? { endTime: input.endTime.toISOString() } : {}),
          ...(input.text ? { text: input.text } : {}),
          limit: input.limit ?? 100,
        },
        operation: 'readLogs',
      },
      LogsResponse,
    );
    return { logs: response.body.logs, hasMore: response.body.hasMore ?? false };
  }

  /* ---------------------------------------------------------------------- */
  /* Domain mapping                                                          */
  /* ---------------------------------------------------------------------- */

  /**
   * Maps a Render deploy onto the platform's `Deployment` record, resolving the
   * deploy this one replaced so rollback is always one call away.
   */
  async toDeploymentRecord(input: {
    companyId: string;
    siteId: string | null;
    serviceId: string;
    deploy: RenderDeploy;
    environment: 'preview' | 'staging' | 'production';
    url: string | null;
    gatingQaRunId: string | null;
  }): Promise<Omit<Deployment, 'id'>> {
    const previous = await this.#findPreviousLiveDeploy(input.serviceId, input.deploy.id);

    return {
      companyId: input.companyId,
      siteId: input.siteId,
      provider: 'render',
      externalDeployId: input.deploy.id,
      serviceId: input.serviceId,
      environment: input.environment,
      commitSha: input.deploy.commit?.id ?? null,
      status: mapDeployStatus(input.deploy.status),
      url: input.url,
      previousDeploymentId: previous?.id ?? null,
      gatingQaRunId: input.gatingQaRunId,
      startedAt: input.deploy.startedAt ?? input.deploy.createdAt ?? new Date().toISOString(),
      finishedAt: input.deploy.finishedAt ?? null,
      logsUrl: null,
      error: isFailedStatus(input.deploy.status) ? `Render deploy ${input.deploy.status}` : null,
    };
  }

  async #findPreviousLiveDeploy(serviceId: string, currentDeployId: string): Promise<RenderDeploy | null> {
    const deploys = await this.listDeploys(serviceId, 20);
    const index = deploys.findIndex((d) => d.id === currentDeployId);
    const candidates = index >= 0 ? deploys.slice(index + 1) : deploys;
    return candidates.find((d) => d.status === 'live') ?? null;
  }
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

export function mapDeployStatus(status: string): Deployment['status'] {
  switch (status) {
    case 'live':
      return 'live';
    case 'created':
    case 'queued':
      return 'queued';
    case 'build_in_progress':
    case 'update_in_progress':
    case 'pre_deploy_in_progress':
      return 'building';
    case 'canceled':
      return 'canceled';
    case 'deactivated':
      return 'rolled_back';
    default:
      // build_failed, update_failed, pre_deploy_failed and anything new.
      return 'failed';
  }
}

export function isFailedStatus(status: string): boolean {
  return status.endsWith('_failed');
}

function summarise(body: unknown): string {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return text ? text.slice(0, 300) : '';
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
      },
      { once: true },
    );
  });
}

export { ProviderContractError };
