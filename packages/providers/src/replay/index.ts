/**
 * Replay adapter — autonomous QA release gate.
 *
 * Written against the raw HTTP surface at `https://loop-qa.replay.io/api/v1`
 * (there is no SDK). Every method here makes a real call; with no credentials
 * configured, `requireSecret`/`assertActivated` raise a typed
 * `CredentialsMissingError` naming `REPLAY_API_KEY`. That error is the correct
 * output, and nothing in this file substitutes a stub for it.
 *
 * Replay documents no error envelope and no rate limits, so — unlike Terac —
 * this adapter does not install a custom `classifyError`; the client's
 * generic HTTP-status classification is the honest thing to rely on here.
 */

import {
  ProviderContractError,
  TimeoutError,
  ValidationError,
  systemClock,
  type CredentialsMissingError,
} from '@foundry/core';
import { getLogger } from '@foundry/obs';
import { ProviderAdapter, type AdapterContext, type ProbeResult } from '../http/adapter.js';
import { ProviderHttpClient, bearerAuth, noAuth } from '../http/client.js';
import { SECRETS, REPLAY_MANIFEST } from '../manifests.js';
import {
  ReplayBug,
  ReplayBugStatus,
  ReplayExploration,
  ReplayJourney,
  ReplayOpenApiDocument,
  ReplayProject,
  ReplayProjectStatus,
  ReplayVersion,
  normaliseReplayList,
  replayListEnvelope,
  type ReplayListPage,
} from './schemas.js';
import { isTerminalExplorationStatus } from './gate.js';

/**
 * Fixed host the OpenAPI discovery document is fetched from. This is
 * deliberately NOT the same binding as the manifest's production base URL —
 * `resolveBaseUrl()` exists precisely because those two are allowed to differ.
 */
const REPLAY_OPENAPI_DISCOVERY_BASE = 'https://loop-qa.replay.io/api/v1';

/* -------------------------------------------------------------------------- */
/* Inputs                                                                      */
/* -------------------------------------------------------------------------- */

export interface CreateProjectInput {
  readonly name: string;
  readonly targetUrl: string;
  readonly webhookUrl?: string;
  readonly finishedWebhookUrl?: string;
  readonly logins?: unknown;
  readonly designDocument?: string;
  readonly instructions?: string;
  readonly recordingId?: string;
  readonly useReverseProxy?: boolean;
  readonly enabledPolishPasses?: readonly string[];
  readonly budget?: number;
}

export interface ListBugsOptions {
  readonly status?: 'open' | 'fixed' | 'wontfix' | 'invalid';
  readonly page?: number;
  readonly pageSize?: number;
}

export interface ListJourneysOptions {
  readonly page?: number;
  readonly pageSize?: number;
}

export interface CreateJourneyInput {
  readonly name: string;
  readonly description?: string;
}

export interface CreateVersionInput {
  readonly gitSha: string;
  readonly branchName: string;
  readonly deployedUrl?: string;
  readonly timestamp?: string;
  readonly changeDescription?: string;
}

export interface WaitForExplorationOptions {
  readonly timeoutMs: number;
  readonly pollIntervalMs: number;
  readonly signal?: AbortSignal;
}

/* -------------------------------------------------------------------------- */
/* Adapter                                                                     */
/* -------------------------------------------------------------------------- */

export class ReplayAdapter extends ProviderAdapter {
  override readonly manifest = REPLAY_MANIFEST;
  #resolvedBaseUrl: string | undefined;
  #resolvingBaseUrl: Promise<string> | undefined;

  constructor(ctx: AdapterContext) {
    super(ctx);
  }

  /**
   * Resolves the live API base URL from Replay's own OpenAPI document rather
   * than trusting a hard-coded constant — the research pass found the docs
   * disagreeing with themselves about the host (`loop-qa.replay.io` vs
   * `qa.replay.io`). Fetches `${REPLAY_OPENAPI_DISCOVERY_BASE}/openapi.json`
   * once per adapter instance, reads `servers[0].url`, and caches the result
   * for the lifetime of this adapter; on any failure (network, missing/empty
   * `servers`) it falls back to the manifest's production URL. Either way, it
   * logs which host ended up being used, so a silent host mismatch is never
   * invisible in production logs.
   */
  async resolveBaseUrl(): Promise<string> {
    if (this.#resolvedBaseUrl) return this.#resolvedBaseUrl;
    if (!this.#resolvingBaseUrl) this.#resolvingBaseUrl = this.#discoverBaseUrl();
    return this.#resolvingBaseUrl;
  }

  async #discoverBaseUrl(): Promise<string> {
    const fallback = this.manifest.baseUrls.production;
    if (!fallback) {
      throw new Error('replay manifest has no fallback production base URL configured');
    }

    // A one-off client pointed at the fixed discovery host, deliberately not
    // `this.http()` — that method memoises the adapter's real client on first
    // use, and the whole point here is to decide the real base URL *before*
    // that memoisation happens. It is still a `ProviderHttpClient`, never a
    // bare `fetch`, so this bootstrap call gets the same timeout/error
    // handling discipline as every other request.
    const discoveryClient = new ProviderHttpClient({
      provider: this.provider,
      baseUrl: REPLAY_OPENAPI_DISCOVERY_BASE,
      auth: noAuth(),
      defaultTimeoutMs: 10_000,
    });

    try {
      const response = await discoveryClient.request(
        { method: 'GET', path: '/openapi.json', operation: 'openapi.discover' },
        ReplayOpenApiDocument,
      );
      const server = response.body.servers[0]?.url;
      if (!server) {
        throw new ProviderContractError('replay', 'openapi.json servers[] was empty');
      }
      const resolved = server.replace(/\/+$/, '');
      this.#resolvedBaseUrl = resolved;
      getLogger().info(
        { provider: 'replay', resolvedBaseUrl: resolved, source: 'openapi_discovery' },
        'replay base URL resolved from the live OpenAPI document',
      );
      return resolved;
    } catch (error) {
      this.#resolvedBaseUrl = fallback;
      getLogger().warn(
        {
          provider: 'replay',
          fallbackBaseUrl: fallback,
          error: error instanceof Error ? error.message : String(error),
        },
        'replay OpenAPI discovery failed; falling back to the manifest base URL',
      );
      return fallback;
    }
  }

  async #client(): Promise<ProviderHttpClient> {
    const secret = this.requireSecret(SECRETS.replayApiKey);
    const baseUrl = await this.resolveBaseUrl();
    return this.http(bearerAuth(secret), { baseUrl });
  }

  /* --- Probe -------------------------------------------------------------- */

  override async probe(): Promise<ProbeResult> {
    const client = await this.#client();
    const response = await client.request(
      { method: 'GET', path: '/projects', query: { page_size: 1 }, operation: 'projects.list' },
      replayListEnvelope(ReplayProject),
    );
    const page = normaliseReplayList(response.body, 1, 1);
    return {
      succeeded: true,
      detail: `GET /projects?page_size=1 returned ${page.items.length} project(s)`,
      evidence: {
        endpoint: 'GET /projects',
        count: page.items.length,
        resolvedBaseUrl: this.#resolvedBaseUrl,
      },
    };
  }

  /* --- Projects ------------------------------------------------------------ */

  async createProject(input: CreateProjectInput): Promise<ReplayProject> {
    this.assertActivated();
    if (input.name.length === 0) throw new ValidationError('name is required to create a Replay project');
    if (input.targetUrl.length === 0) throw new ValidationError('target_url is required to create a Replay project');

    const client = await this.#client();
    const response = await client.request(
      {
        method: 'POST',
        path: '/projects',
        operation: 'projects.create',
        body: {
          name: input.name,
          target_url: input.targetUrl,
          ...(input.webhookUrl ? { webhook_url: input.webhookUrl } : {}),
          ...(input.finishedWebhookUrl ? { finished_webhook_url: input.finishedWebhookUrl } : {}),
          ...(input.logins !== undefined ? { logins: input.logins } : {}),
          ...(input.designDocument ? { design_document: input.designDocument } : {}),
          ...(input.instructions ? { instructions: input.instructions } : {}),
          ...(input.recordingId ? { recording_id: input.recordingId } : {}),
          ...(input.useReverseProxy !== undefined ? { use_reverse_proxy: input.useReverseProxy } : {}),
          ...(input.enabledPolishPasses ? { enabled_polish_passes: input.enabledPolishPasses } : {}),
          ...(input.budget !== undefined ? { budget: input.budget } : {}),
        },
      },
      ReplayProject,
    );
    return response.body;
  }

  async getProject(id: string): Promise<ReplayProject> {
    this.assertActivated();
    const client = await this.#client();
    const response = await client.request(
      { method: 'GET', path: `/projects/${encodeURIComponent(id)}`, operation: 'projects.get' },
      ReplayProject,
    );
    return response.body;
  }

  async getProjectStatus(id: string): Promise<ReplayProjectStatus> {
    this.assertActivated();
    const client = await this.#client();
    const response = await client.request(
      { method: 'GET', path: `/projects/${encodeURIComponent(id)}/status`, operation: 'projects.status' },
      ReplayProjectStatus,
    );
    return response.body;
  }

  /* --- Explorations --------------------------------------------------------- */

  /** "Run QA now". `prompt` is optional free-text guidance for the exploration. */
  async startExploration(projectId: string, prompt?: string): Promise<ReplayExploration> {
    this.assertActivated();
    const client = await this.#client();
    const response = await client.request(
      {
        method: 'POST',
        path: `/projects/${encodeURIComponent(projectId)}/explorations`,
        operation: 'explorations.start',
        body: prompt ? { prompt } : {},
      },
      ReplayExploration,
    );
    return response.body;
  }

  async getExploration(id: string): Promise<ReplayExploration> {
    this.assertActivated();
    const client = await this.#client();
    const response = await client.request(
      { method: 'GET', path: `/explorations/${encodeURIComponent(id)}`, operation: 'explorations.get' },
      ReplayExploration,
    );
    return response.body;
  }

  /**
   * Polls `getExploration` with exponential backoff until the exploration
   * reaches a terminal status (`isTerminalExplorationStatus`, in `gate.ts`) or
   * `timeoutMs` elapses, whichever comes first. This is a real polling loop —
   * no fixed number of attempts is assumed, and the deadline is wall-clock,
   * not attempt-count, so a slow-but-alive exploration is not killed early.
   */
  async waitForExploration(explorationId: string, options: WaitForExplorationOptions): Promise<ReplayExploration> {
    this.assertActivated();
    if (options.timeoutMs <= 0) throw new ValidationError('timeoutMs must be positive', { timeoutMs: options.timeoutMs });
    if (options.pollIntervalMs <= 0) {
      throw new ValidationError('pollIntervalMs must be positive', { pollIntervalMs: options.pollIntervalMs });
    }

    const clock = systemClock;
    const deadline = clock.nowMs() + options.timeoutMs;
    const maxDelayMs = Math.max(options.pollIntervalMs, 30_000);
    let delayMs = options.pollIntervalMs;

    for (;;) {
      const exploration = await this.getExploration(explorationId);
      if (isTerminalExplorationStatus(exploration.status)) return exploration;

      const now = clock.nowMs();
      if (now >= deadline) {
        throw new TimeoutError(`replay exploration ${explorationId} did not reach a terminal status`, options.timeoutMs);
      }
      const wait = Math.min(delayMs, maxDelayMs, deadline - now);
      await clock.sleep(wait, options.signal);
      delayMs = Math.min(delayMs * 1.5, maxDelayMs);
    }
  }

  /* --- Bugs ------------------------------------------------------------------ */

  async listBugs(projectId: string, options: ListBugsOptions = {}): Promise<ReplayListPage<ReplayBug>> {
    this.assertActivated();
    if (options.pageSize !== undefined && (options.pageSize < 1 || options.pageSize > 100)) {
      throw new ValidationError('page_size must be between 1 and 100', { pageSize: options.pageSize });
    }
    const page = options.page ?? 1;
    const pageSize = options.pageSize ?? 20;

    const client = await this.#client();
    const response = await client.request(
      {
        method: 'GET',
        path: `/projects/${encodeURIComponent(projectId)}/bugs`,
        operation: 'bugs.list',
        query: { status: options.status, page, page_size: pageSize },
      },
      replayListEnvelope(ReplayBug),
    );
    return normaliseReplayList<ReplayBug>(response.body, page, pageSize);
  }

  async getBug(id: string): Promise<ReplayBug> {
    this.assertActivated();
    const client = await this.#client();
    const response = await client.request(
      { method: 'GET', path: `/bugs/${encodeURIComponent(id)}`, operation: 'bugs.get' },
      ReplayBug,
    );
    return response.body;
  }

  async updateBugStatus(id: string, status: ReplayBugStatus): Promise<ReplayBug> {
    this.assertActivated();
    const client = await this.#client();
    const response = await client.request(
      { method: 'PATCH', path: `/bugs/${encodeURIComponent(id)}`, operation: 'bugs.update_status', body: { status } },
      ReplayBug,
    );
    return response.body;
  }

  /* --- Journeys --------------------------------------------------------------- */

  async listJourneys(projectId: string, options: ListJourneysOptions = {}): Promise<ReplayListPage<ReplayJourney>> {
    this.assertActivated();
    const page = options.page ?? 1;
    const pageSize = options.pageSize ?? 20;
    const client = await this.#client();
    const response = await client.request(
      {
        method: 'GET',
        path: `/projects/${encodeURIComponent(projectId)}/journeys`,
        operation: 'journeys.list',
        query: { page, page_size: pageSize },
      },
      replayListEnvelope(ReplayJourney),
    );
    return normaliseReplayList<ReplayJourney>(response.body, page, pageSize);
  }

  async createJourney(projectId: string, input: CreateJourneyInput): Promise<ReplayJourney> {
    this.assertActivated();
    if (input.name.length === 0) throw new ValidationError('name is required to create a journey');
    const client = await this.#client();
    const response = await client.request(
      {
        method: 'POST',
        path: `/projects/${encodeURIComponent(projectId)}/journeys`,
        operation: 'journeys.create',
        body: { name: input.name, ...(input.description ? { description: input.description } : {}) },
      },
      ReplayJourney,
    );
    return response.body;
  }

  /* --- Versions --------------------------------------------------------------- */

  async createVersion(projectId: string, input: CreateVersionInput): Promise<ReplayVersion> {
    this.assertActivated();
    if (input.gitSha.length === 0) throw new ValidationError('git_sha is required to create a version');
    if (input.branchName.length === 0) throw new ValidationError('branch_name is required to create a version');

    const client = await this.#client();
    const response = await client.request(
      {
        method: 'POST',
        path: `/projects/${encodeURIComponent(projectId)}/versions`,
        operation: 'versions.create',
        body: {
          git_sha: input.gitSha,
          branch_name: input.branchName,
          ...(input.deployedUrl ? { deployed_url: input.deployedUrl } : {}),
          ...(input.timestamp ? { timestamp: input.timestamp } : {}),
          ...(input.changeDescription ? { change_description: input.changeDescription } : {}),
        },
      },
      ReplayVersion,
    );
    return response.body;
  }
}

export type { CredentialsMissingError };
export * from './schemas.js';
export * from './gate.js';
