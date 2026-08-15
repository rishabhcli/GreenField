/**
 * Superserve adapter — persistent Firecracker microVM sandboxes for long-running
 * manager and specialist agent workspaces.
 *
 * Two auth planes, and they are genuinely different, not a stylistic choice:
 *   - Control plane (`https://api.superserve.ai`, header `X-API-Key`): create,
 *     list, patch, delete, pause, resume, activate, secrets, preview ports,
 *     network log, observability.
 *   - Data plane (per-sandbox host `https://boxd-{id}.sandbox.superserve.ai`,
 *     header `X-Access-Token`): exec and file I/O *inside* a running sandbox.
 *
 * The data-plane token is minted on create and **rotated on resume** — the
 * whole reason this file exists rather than just adding a couple of methods to
 * a generic client. `#accessTokens` is the source of truth for "which token is
 * current right now"; `pauseSandbox`/`resumeSandbox`/`activateSandbox` all
 * clear the cached token before conditionally re-caching whatever the response
 * actually returns, so a caller can never accidentally keep using a token the
 * provider has already invalidated. Verified against
 * `docs/research/SPONSOR_API_RESEARCH.md` section 7 on 2026-08-14.
 */

import { z } from 'zod';
import { ConflictError, Secret, ValidationError } from '@foundry/core';
import { getLogger } from '@foundry/obs';
import { ProviderAdapter, type AdapterContext, type ProbeResult } from '../http/adapter.js';
import { apiKeyHeaderAuth, noAuth, ProviderHttpClient } from '../http/client.js';
import { limiterFor } from '../http/rate-limit.js';
import { SECRETS, SUPERSERVE_MANIFEST } from '../manifests.js';
import {
  SuperserveExecResult,
  SuperserveFileList,
  SuperserveNetworkLog,
  SuperservePreviewPortList,
  SuperserveSandbox,
  SuperserveSandboxList,
  extractSuperserveErrorCode,
  filesOf,
  previewPortsOf,
  sandboxesOf,
  type SuperserveFileEntry,
} from './schemas.js';
import { SuperservePreviewPort } from './schemas.js';

// Re-exported so `CoreAdapterContext` is actually referenced (keeps this file
// honest about depending on the shared context shape without a second,
// diverging local definition).
export type { AdapterContext as CoreAdapterContext };

/** Documented browser hostname: `https://{port}-{sandboxId}.sandbox.superserve.ai`. */
export function superservePreviewUrl(sandboxId: string, port: number): string {
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || port === 49983) {
    throw new ValidationError('preview port must be an integer 1024–65535 excluding reserved 49983', { port });
  }
  return `https://${port}-${sandboxId}.sandbox.superserve.ai`;
}

/* -------------------------------------------------------------------------- */
/* Inputs                                                                      */
/* -------------------------------------------------------------------------- */

export interface CreateSandboxInput {
  readonly name?: string;
  readonly fromTemplate?: string;
  /** 1–604800s. Documented as a cap on *active* time, not idle time. */
  readonly timeoutSeconds?: number;
  /** 0–2592000s. */
  readonly autoDeleteSeconds?: number;
  readonly metadata?: Record<string, unknown>;
  readonly envVars?: Record<string, string>;
  /** Shape beyond "network config" is undocumented; passed through verbatim. */
  readonly network?: Record<string, unknown>;
  /**
   * Real secret material, deliberately typed as `Secret` rather than `string`
   * so a caller cannot pass a raw literal without at least wrapping it first.
   * Unlike Sandbox0, Superserve is not a credential-isolation boundary — these
   * values land in the sandbox's own environment by design — so revealing them
   * into the outbound body is correct here, not a leak.
   */
  readonly secrets?: Readonly<Record<string, Secret>>;
  readonly previewAccess?: 'public' | 'private';
  /**
   * Stored in `metadata.agent_run_id`. This is what makes sandbox creation
   * idempotent per the manifest ("keyed on the agent run id via metadata so a
   * retried job reattaches instead of creating a second VM") — see
   * `findSandboxByAgentRunId` / `ensureSandboxForAgentRun` below, which are
   * what actually make that claim true rather than aspirational.
   */
  readonly agentRunId?: string;
}

export interface UpdateSandboxInput {
  readonly ttl?: number;
  readonly timeoutSeconds?: number;
  readonly autoDeleteSeconds?: number;
  readonly metadata?: Record<string, unknown>;
  readonly network?: Record<string, unknown>;
  readonly previewAccess?: 'public' | 'private';
}

export interface ExecInput {
  readonly command: string;
  readonly shell?: string;
  readonly timeoutSeconds?: number;
}

/* -------------------------------------------------------------------------- */
/* Adapter                                                                     */
/* -------------------------------------------------------------------------- */

export class SuperserveAdapter extends ProviderAdapter {
  override readonly manifest = SUPERSERVE_MANIFEST;

  /** Current data-plane token per sandbox id. The only source of truth for "which token is live right now". */
  readonly #accessTokens = new Map<string, Secret>();
  #dataPlane: ProviderHttpClient | undefined;
  /**
   * One bucket shared by both planes. `this.http()` (used for the control
   * plane) would otherwise mint its own limiter via `limiterFor()`, and the
   * data-plane client is constructed by hand (different host per sandbox, so
   * it cannot go through the single-slot `this.http()` memoisation) — sharing
   * this instance keeps the two planes honouring one combined budget instead
   * of silently doubling the effective allowance.
   */
  readonly #sharedLimiter = limiterFor('superserve');
  readonly #fetchImpl: typeof fetch | undefined;

  constructor(ctx: AdapterContext, overrides?: { readonly fetchImpl?: typeof fetch }) {
    super(ctx);
    this.#fetchImpl = overrides?.fetchImpl;
  }

  #controlPlane(): ProviderHttpClient {
    return this.http(apiKeyHeaderAuth('X-API-Key', this.requireSecret(SECRETS.superserveApiKey)), {
      rateLimiter: this.#sharedLimiter,
      fetchImpl: this.#fetchImpl,
      classifyError: (status, body) => {
        const code = extractSuperserveErrorCode(body);
        if (code === 'too_many_sandboxes' || code === 'too_many_builds' || code === 'too_many_templates') {
          return new ConflictError(
            `Superserve refused the request: ${code}` +
              (code === 'too_many_sandboxes' ? ' (paused sandboxes do not count against this quota)' : ''),
            { code, status },
          );
        }
        // `rate_limited` and anything else fall through to the client's
        // generic status mapping, which already turns a 429 into a
        // RateLimitError with Retry-After parsed.
        return undefined;
      },
    });
  }

  /**
   * The data-plane client is built once and reused for every sandbox: its
   * `baseUrl` is a placeholder that is never actually used for path-building,
   * because every data-plane call below supplies a full absolute URL (see
   * `ProviderHttpClient#buildUrl`, which bypasses `baseUrl` whenever `path`
   * already starts with `http`). `auth` is intentionally `noAuth()` — the
   * per-sandbox, rotating `X-Access-Token` is set as a per-request header at
   * the call site instead (`#currentAccessToken`), because `AuthApplier` has
   * no way to know *which* sandbox a given call is for.
   */
  #dataPlaneClient(): ProviderHttpClient {
    if (!this.#dataPlane) {
      this.#dataPlane = new ProviderHttpClient({
        provider: this.provider,
        baseUrl: 'https://unused.invalid.example',
        auth: noAuth(),
        rateLimiter: this.#sharedLimiter,
        defaultTimeoutMs: 30_000,
        fetchImpl: this.#fetchImpl,
      });
    }
    return this.#dataPlane;
  }

  #dataPlaneHost(sandboxId: string): string {
    return `https://boxd-${sandboxId}.sandbox.superserve.ai`;
  }

  previewUrl(sandboxId: string, port: number): string {
    return superservePreviewUrl(sandboxId, port);
  }

  #currentAccessToken(sandboxId: string): Secret {
    const token = this.#accessTokens.get(sandboxId);
    if (!token) {
      throw new ValidationError(
        `No cached Superserve access token for sandbox "${sandboxId}". The token is only ever returned by ` +
          `createSandbox()/resumeSandbox()/activateSandbox() (GET is not documented to return it) — call one of ` +
          `those first. If this is a fresh process after a restart, the in-memory cache is gone and the sandbox ` +
          `must be resumed again to obtain a current token.`,
        { sandboxId, provider: 'superserve' },
      );
    }
    return token;
  }

  /** Absence of `access_token` on a response is normal (GET never carries it) and is not an error. */
  #cacheTokenIfPresent(sandbox: SuperserveSandbox): void {
    if (sandbox.access_token) {
      this.#accessTokens.set(sandbox.id, new Secret(`superserve:access_token:${sandbox.id}`, sandbox.access_token, 'unknown'));
    }
  }

  /** Unconditionally drops whatever was cached — used before every state-changing call whose effect on the token is either "rotates it" or undocumented. */
  #invalidateToken(sandboxId: string): void {
    this.#accessTokens.delete(sandboxId);
  }

  /* ---------------------------------------------------------------------- */
  /* Probe                                                                    */
  /* ---------------------------------------------------------------------- */

  override async probe(): Promise<ProbeResult> {
    const response = await this.#controlPlane().request(
      { method: 'GET', path: '/sandboxes', query: { limit: 1 }, operation: 'listSandboxes' },
      SuperserveSandboxList,
    );
    const sandboxes = sandboxesOf(response.body);
    return {
      succeeded: true,
      detail: `GET /sandboxes?limit=1 returned ${sandboxes.length} sandbox(es)`,
      evidence: {
        endpoint: 'GET /sandboxes?limit=1',
        status: response.status,
        count: sandboxes.length,
        requestId: response.requestId,
      },
    };
  }

  /* ---------------------------------------------------------------------- */
  /* Lifecycle (control plane)                                                */
  /* ---------------------------------------------------------------------- */

  async createSandbox(input: CreateSandboxInput = {}): Promise<SuperserveSandbox> {
    this.assertActivated();
    if (input.timeoutSeconds !== undefined && (input.timeoutSeconds < 1 || input.timeoutSeconds > 604_800)) {
      throw new ValidationError('timeoutSeconds must be between 1 and 604800 seconds (the documented 7-day cap on active time)', {
        timeoutSeconds: input.timeoutSeconds,
      });
    }
    if (input.autoDeleteSeconds !== undefined && (input.autoDeleteSeconds < 0 || input.autoDeleteSeconds > 2_592_000)) {
      throw new ValidationError('autoDeleteSeconds must be between 0 and 2592000 seconds (the documented 30-day cap)', {
        autoDeleteSeconds: input.autoDeleteSeconds,
      });
    }

    const metadata: Record<string, unknown> = { ...(input.metadata ?? {}) };
    if (input.agentRunId) metadata.agent_run_id = input.agentRunId;

    const body: Record<string, unknown> = {
      ...(input.name ? { name: input.name } : {}),
      ...(input.fromTemplate ? { from_template: input.fromTemplate } : {}),
      ...(input.timeoutSeconds !== undefined ? { timeout_seconds: input.timeoutSeconds } : {}),
      ...(input.autoDeleteSeconds !== undefined ? { auto_delete_seconds: input.autoDeleteSeconds } : {}),
      ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
      ...(input.envVars ? { env_vars: input.envVars } : {}),
      ...(input.network ? { network: input.network } : {}),
      ...(input.previewAccess ? { preview_access: input.previewAccess } : {}),
    };
    if (input.secrets) {
      // Revealed only here, inline, to build the outbound body for this one
      // request — never assigned to a variable that outlives this call, never
      // logged, never echoed back to the caller.
      body.secrets = Object.fromEntries(Object.entries(input.secrets).map(([key, secret]) => [key, secret.reveal()]));
    }

    const response = await this.#controlPlane().request(
      { method: 'POST', path: '/sandboxes', body, retryable: false, operation: 'createSandbox' },
      SuperserveSandbox,
    );
    this.#cacheTokenIfPresent(response.body);
    getLogger().info({ sandboxId: response.body.id, status: response.body.status }, 'superserve sandbox created');
    return response.body;
  }

  /**
   * Find-or-create keyed on `agent_run_id`, so a retried job reattaches to the
   * sandbox it already made instead of paying for a second VM. This is what
   * makes the manifest's idempotency claim true in code, not just in prose.
   */
  async ensureSandboxForAgentRun(agentRunId: string, input: Omit<CreateSandboxInput, 'agentRunId'> = {}): Promise<SuperserveSandbox> {
    const existing = await this.findSandboxByAgentRunId(agentRunId);
    if (existing) return existing;
    return this.createSandbox({ ...input, agentRunId });
  }

  async findSandboxByAgentRunId(agentRunId: string): Promise<SuperserveSandbox | undefined> {
    const all = await this.listSandboxes();
    return all.find((s) => {
      const metadata = s.metadata as Record<string, unknown> | null | undefined;
      return typeof metadata?.agent_run_id === 'string' && metadata.agent_run_id === agentRunId;
    });
  }

  async listSandboxes(limit?: number): Promise<readonly SuperserveSandbox[]> {
    this.assertActivated();
    const response = await this.#controlPlane().request(
      { method: 'GET', path: '/sandboxes', query: limit !== undefined ? { limit } : undefined, operation: 'listSandboxes' },
      SuperserveSandboxList,
    );
    return sandboxesOf(response.body);
  }

  async getSandbox(sandboxId: string): Promise<SuperserveSandbox> {
    this.assertActivated();
    const response = await this.#controlPlane().request(
      { method: 'GET', path: `/sandboxes/${sandboxId}`, operation: 'getSandbox' },
      SuperserveSandbox,
    );
    return response.body;
  }

  /**
   * PATCH-able field allowlist is not enumerated anywhere in the source docs
   * (unlike Sandbox0's PUT, which is explicit). This conservatively mirrors
   * the create-time fields minus identity/one-shot ones (`name`,
   * `from_template`, `env_vars`, `secrets`) rather than inventing a
   * restriction the docs never state.
   */
  async updateSandbox(sandboxId: string, patch: UpdateSandboxInput): Promise<SuperserveSandbox> {
    this.assertActivated();
    const body: Record<string, unknown> = {
      ...(patch.ttl !== undefined ? { ttl: patch.ttl } : {}),
      ...(patch.timeoutSeconds !== undefined ? { timeout_seconds: patch.timeoutSeconds } : {}),
      ...(patch.autoDeleteSeconds !== undefined ? { auto_delete_seconds: patch.autoDeleteSeconds } : {}),
      ...(patch.metadata ? { metadata: patch.metadata } : {}),
      ...(patch.network ? { network: patch.network } : {}),
      ...(patch.previewAccess ? { preview_access: patch.previewAccess } : {}),
    };
    const response = await this.#controlPlane().request(
      { method: 'PATCH', path: `/sandboxes/${sandboxId}`, body, operation: 'updateSandbox' },
      SuperserveSandbox,
    );
    return response.body;
  }

  async deleteSandbox(sandboxId: string): Promise<void> {
    this.assertActivated();
    await this.#controlPlane().raw({ method: 'DELETE', path: `/sandboxes/${sandboxId}`, operation: 'deleteSandbox' });
    this.#invalidateToken(sandboxId);
    getLogger().info({ sandboxId }, 'superserve sandbox deleted');
  }

  /** Checkpoints memory + processes + filesystem and stops compute billing, per the docs. */
  async pauseSandbox(sandboxId: string): Promise<SuperserveSandbox> {
    this.assertActivated();
    const raw = await this.#controlPlane().raw({
      method: 'POST',
      path: `/sandboxes/${sandboxId}/pause`,
      retryable: false,
      operation: 'pauseSandbox',
    });
    this.#invalidateToken(sandboxId);
    const parsed = SuperserveSandbox.safeParse(raw.body);
    const paused = parsed.success ? parsed.data : await this.getSandbox(sandboxId);
    getLogger().info({ sandboxId, status: paused.status, httpStatus: raw.status }, 'superserve sandbox paused');
    return paused;
  }

  /**
   * Resumes a paused sandbox. **Rotates the access token** — this is the
   * documented behaviour this whole adapter exists to get right. The old
   * token is dropped unconditionally before the response is even inspected,
   * so a resume that (unexpectedly) omits `access_token` fails the next
   * data-plane call loudly via `#currentAccessToken` instead of silently
   * reusing a token the provider may have already invalidated.
   */
  async resumeSandbox(sandboxId: string): Promise<SuperserveSandbox> {
    this.assertActivated();
    const response = await this.#controlPlane().request(
      { method: 'POST', path: `/sandboxes/${sandboxId}/resume`, retryable: false, operation: 'resumeSandbox' },
      SuperserveSandbox,
    );
    this.#invalidateToken(sandboxId);
    this.#cacheTokenIfPresent(response.body);
    getLogger().info({ sandboxId, tokenRotated: Boolean(response.body.access_token) }, 'superserve sandbox resumed');
    return response.body;
  }

  /**
   * Listed in the docs by path only, with no prose distinguishing it from
   * `resume`. Treated with the same defensive rotation as resume rather than
   * assumed to leave the token alone, since the docs do not say either way.
   */
  async activateSandbox(sandboxId: string): Promise<SuperserveSandbox> {
    this.assertActivated();
    const response = await this.#controlPlane().request(
      { method: 'POST', path: `/sandboxes/${sandboxId}/activate`, retryable: false, operation: 'activateSandbox' },
      SuperserveSandbox,
    );
    this.#invalidateToken(sandboxId);
    this.#cacheTokenIfPresent(response.body);
    return response.body;
  }

  /** Exposes the currently cached data-plane token's presence without ever exposing its value — for callers/tests that need to assert rotation happened. */
  hasCachedAccessToken(sandboxId: string): boolean {
    return this.#accessTokens.has(sandboxId);
  }

  /* ---------------------------------------------------------------------- */
  /* Secrets (control plane)                                                  */
  /* ---------------------------------------------------------------------- */

  /** Sets secrets directly in the sandbox's environment. Real values, revealed only inline for this call. */
  async setSandboxSecrets(sandboxId: string, secrets: Readonly<Record<string, Secret>>): Promise<void> {
    this.assertActivated();
    const body = Object.fromEntries(Object.entries(secrets).map(([key, secret]) => [key, secret.reveal()]));
    await this.#controlPlane().raw({ method: 'POST', path: `/sandboxes/${sandboxId}/secrets`, body, operation: 'setSandboxSecrets' });
    // Key names only. Values never reach a log line.
    getLogger().info({ sandboxId, keys: Object.keys(secrets) }, 'superserve sandbox secrets set');
  }

  async deleteSandboxSecrets(sandboxId: string, keys: readonly string[]): Promise<void> {
    this.assertActivated();
    await this.#controlPlane().raw({
      method: 'DELETE',
      path: `/sandboxes/${sandboxId}/secrets`,
      body: { keys: [...keys] },
      operation: 'deleteSandboxSecrets',
    });
    getLogger().info({ sandboxId, keys }, 'superserve sandbox secrets deleted');
  }

  /* ---------------------------------------------------------------------- */
  /* Preview ports (control plane)                                            */
  /* ---------------------------------------------------------------------- */

  async listPreviewPorts(sandboxId: string): Promise<readonly SuperservePreviewPort[]> {
    this.assertActivated();
    const response = await this.#controlPlane().request(
      { method: 'GET', path: `/sandboxes/${sandboxId}/preview-ports`, operation: 'listPreviewPorts' },
      SuperservePreviewPortList,
    );
    return previewPortsOf(response.body);
  }

  async createPreviewPort(sandboxId: string, port: number): Promise<SuperservePreviewPort> {
    this.assertActivated();
    const response = await this.#controlPlane().request(
      {
        method: 'POST',
        path: `/sandboxes/${sandboxId}/preview-ports`,
        body: { port },
        operation: 'createPreviewPort',
      },
      SuperservePreviewPort,
    );
    return response.body;
  }

  async deletePreviewPort(sandboxId: string, port: number): Promise<void> {
    this.assertActivated();
    await this.#controlPlane().raw({
      method: 'DELETE',
      path: `/sandboxes/${sandboxId}/preview-ports`,
      query: { port },
      operation: 'deletePreviewPort',
    });
  }

  /** "egress log" is the entire documented description; shape is otherwise unconfirmed. */
  async getNetworkLog(sandboxId: string): Promise<Readonly<Record<string, unknown>>> {
    this.assertActivated();
    const response = await this.#controlPlane().request(
      { method: 'GET', path: `/sandboxes/${sandboxId}/network`, operation: 'getNetworkLog' },
      SuperserveNetworkLog,
    );
    return response.body;
  }

  /* ---------------------------------------------------------------------- */
  /* Files (control-plane listing; data-plane content)                       */
  /* ---------------------------------------------------------------------- */

  async listSandboxFiles(sandboxId: string): Promise<readonly SuperserveFileEntry[]> {
    this.assertActivated();
    const response = await this.#controlPlane().request(
      { method: 'GET', path: `/sandboxes/${sandboxId}/files`, operation: 'listSandboxFiles' },
      SuperserveFileList,
    );
    return filesOf(response.body);
  }

  /**
   * `GET /files?path=` is documented with no `{id}` segment, which strongly
   * implies it runs on the data plane (identified by host + rotating token,
   * the same way `/exec` is) rather than the control plane. Modelled that way
   * here; flagged because the docs never show the two side by side.
   */
  async readSandboxFile(sandboxId: string, path: string): Promise<string> {
    this.assertActivated();
    const token = this.#currentAccessToken(sandboxId);
    const response = await this.#dataPlaneClient().raw({
      method: 'GET',
      path: `${this.#dataPlaneHost(sandboxId)}/files`,
      query: { path },
      headers: { 'x-access-token': token.reveal() },
      operation: 'readSandboxFile',
    });
    return typeof response.body === 'string' ? response.body : JSON.stringify(response.body);
  }

  async writeSandboxFile(sandboxId: string, path: string, content: string): Promise<void> {
    this.assertActivated();
    const token = this.#currentAccessToken(sandboxId);
    await this.#dataPlaneClient().raw({
      method: 'POST',
      path: `${this.#dataPlaneHost(sandboxId)}/files`,
      query: { path },
      headers: { 'x-access-token': token.reveal(), 'content-type': 'text/plain' },
      body: content,
      operation: 'writeSandboxFile',
    });
  }

  /* ---------------------------------------------------------------------- */
  /* Exec (data plane)                                                        */
  /* ---------------------------------------------------------------------- */

  /** `POST /exec` on the data plane: command in, stdout/stderr/exit_code/truncated out. */
  async execInSandbox(sandboxId: string, input: ExecInput): Promise<SuperserveExecResult> {
    this.assertActivated();
    const token = this.#currentAccessToken(sandboxId);
    const response = await this.#dataPlaneClient().request(
      {
        method: 'POST',
        path: `${this.#dataPlaneHost(sandboxId)}/exec`,
        headers: { 'x-access-token': token.reveal() },
        body: {
          command: input.command,
          ...(input.shell ? { shell: input.shell } : {}),
          ...(input.timeoutSeconds !== undefined ? { timeout_s: input.timeoutSeconds } : {}),
        },
        operation: 'exec',
      },
      SuperserveExecResult,
    );
    return response.body;
  }
}

/* -------------------------------------------------------------------------- */
/* Re-exports                                                                  */
/* -------------------------------------------------------------------------- */

export * from './schemas.js';
export const SUPERSERVE_UNIMPLEMENTED_SURFACE = z
  .array(z.string())
  .parse([
    // Documented but not implemented in this adapter — none of these change
    // the security/lifecycle model above, and each is a small addition on the
    // same primitives (`#controlPlane()` / `#dataPlaneClient()`) if needed:
    'POST /exec/stream (SSE)',
    'GET /exec/connect (WebSocket)',
    'GET /sandboxes/{id}/metrics',
    'GET /sandboxes/{id}/observability/logs',
    'GET /sandboxes/{id}/observability/events',
  ]);
