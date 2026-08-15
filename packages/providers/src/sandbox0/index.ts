/**
 * Sandbox0 adapter — isolated execution with network-level credential
 * substitution. This is where untrusted, model-generated code runs: the
 * sandbox sees an opaque placeholder and the real credential is injected at
 * the egress boundary (`placeholder_substitution`), so generated code can call
 * an API it can never read the key for. That is why this plane exists
 * separately from Superserve and Solari.
 *
 * Two planes, same host, same token — unlike Superserve, whose data plane is
 * a different host with a rotating `X-Access-Token`:
 *   - Control plane (scheduler/manager): `POST/GET/PUT/DELETE
 *     /api/v1/sandboxes`, refresh, network policy, previews. Lifecycle and
 *     policy live here.
 *   - Data plane (procd): contexts (exec) and files. The public API namespaces
 *     these under `/api/v1/sandboxes/{id}/…`. OpenAPI `x-upstream-path` for
 *     the same operations is `/api/v1/contexts` and `/api/v1/files` — the
 *     abbreviated `/contexts` and `/files` forms recorded in research §11.
 *     Path helpers below default to the public namespaced form and are
 *     reassignable so a first-live-probe correction is one line.
 *
 * Pause checkpoints the encrypted root filesystem but does **not** preserve
 * running processes, memory, sockets, or PIDs. Superserve pause does. Live
 * `POST …/pause` on 2026-08-15 returned HTTP 200 with `paused: false` /
 * `status: running` — 200 is not proof the sandbox is paused. Workload routing
 * must not treat Sandbox0 as a Superserve-equivalent persistent VM.
 *
 * Auth: OpenAPI `components.securitySchemes.bearerAuth` is HTTP Bearer.
 * Research §11 recorded the header as UNVERIFIED because the public docs
 * originally only showed SDK constructors (`WithToken` / `new Client({token})`).
 * This adapter sends `Authorization: Bearer` via `bearerAuth()` and does not
 * try `X-API-Key`, `X-Sandbox0-Token`, or any other header. Some credential-
 * source curl examples also send `X-Team-ID`; the token is team-scoped and we
 * have no such secret, so that header is not sent.
 *
 * No idempotency header. The adapter still sends `metadata.agent_run_id` on
 * claim. Live claim+GET/LIST on 2026-08-15 dropped that metadata — it was not
 * on the claim response, GET, or LIST — so reattach-by-metadata is not proven
 * and must not be treated as working idempotency.
 *
 * Verified against sandbox0.ai/docs and `docs/research/SPONSOR_API_RESEARCH.md`
 * §11 on 2026-08-15. Public paths are `/api/v1/…` (`GET /v1/sandboxes` 404).
 * Missing `SANDBOX0_TOKEN` raises `CredentialsMissingError`; that is the
 * correct output, not a reason to stub a claim.
 */

import {
  ConflictError,
  CredentialsMissingError,
  ProviderContractError,
  RateLimitError,
  ValidationError,
  type FoundryError,
} from '@foundry/core';
import { getLogger } from '@foundry/obs';
import { ProviderAdapter, type AdapterContext, type ProbeResult } from '../http/adapter.js';
import { bearerAuth, type ProviderHttpClient } from '../http/client.js';
import { verifySandbox0Signature, type VerificationResult } from '../http/webhook-verify.js';
import { SECRETS, SANDBOX0_MANIFEST } from '../manifests.js';
import {
  assertIsolatedFromControlPlane,
  assertSandbox0Workload,
  isolatedExecIdentity,
  type ComputeBusinessFunction,
} from './identities.js';
import {
  SANDBOX0_PREVIEW_TTL_MAX,
  SANDBOX0_PREVIEW_TTL_MIN,
  SANDBOX0_QUOTA_EXCEEDED,
  Sandbox0ClaimEnvelope,
  Sandbox0ContextEnvelope,
  Sandbox0ExecResultEnvelope,
  Sandbox0FileContent,
  Sandbox0FileContentEnvelope,
  Sandbox0FileListEnvelope,
  Sandbox0NetworkPolicyEnvelope,
  Sandbox0PauseEnvelope,
  Sandbox0PreviewEnvelope,
  Sandbox0RefreshEnvelope,
  Sandbox0ResumeEnvelope,
  Sandbox0SandboxEnvelope,
  Sandbox0SandboxListEnvelope,
  Sandbox0WebhookEvent,
  agentRunIdOf,
  extractSandbox0ErrorCode,
  extractSandbox0ErrorMessage,
  type Sandbox0Claim,
  type Sandbox0Context,
  type Sandbox0ExecResult,
  type Sandbox0FileInfo,
  type Sandbox0NetworkPolicy,
  type Sandbox0Pause,
  type Sandbox0Preview,
  type Sandbox0Refresh,
  type Sandbox0Resume,
  type Sandbox0Sandbox,
  type Sandbox0SandboxSummary,
} from './schemas.js';

export type { AdapterContext };
export {
  assertIsolatedFromControlPlane,
  assertSandbox0Workload,
  isolatedExecIdentity,
  type ComputeBusinessFunction,
  type ComputeWorkload,
  type IsolatedExecIdentity,
} from './identities.js';

/** Live 2026-08-15: pause does not keep processes. Superserve pause does. */
export const SANDBOX0_PAUSE_PRESERVES_PROCESSES = false;

/** Live 2026-08-15: claim-body `metadata` was not returned on claim/GET/LIST. */
export const SANDBOX0_CLAIM_METADATA_PERSISTED = false;

/* -------------------------------------------------------------------------- */
/* UNVERIFIED paths — reassignable like Terac's `feasibilityRequestPath`         */
/* -------------------------------------------------------------------------- */

/**
 * Research §11 abbreviated data-plane routes as `POST /contexts` and
 * `POST /contexts/{id}/exec` (the OpenAPI upstream/procd paths, minus `/api/v1`).
 * The public gateway documents `POST /api/v1/sandboxes/{id}/contexts` and
 * `POST /api/v1/sandboxes/{id}/contexts/{ctx_id}/exec`. Defaults follow the
 * public form; reassign after the first live probe if the gateway we hit
 * actually wants the abbreviated upstream paths.
 */
export let sandboxContextsPath: (sandboxId: string) => string = (sandboxId) =>
  `/api/v1/sandboxes/${encodeURIComponent(sandboxId)}/contexts`;

export let sandboxContextExecPath: (sandboxId: string, contextId: string) => string = (sandboxId, contextId) =>
  `/api/v1/sandboxes/${encodeURIComponent(sandboxId)}/contexts/${encodeURIComponent(contextId)}/exec`;

/**
 * Research §11: `GET/POST/DELETE /files?path=`, `GET /files/list`.
 * Public docs/OpenAPI: `/api/v1/sandboxes/{id}/files[ /list]`.
 */
export let sandboxFilesPath: (sandboxId: string) => string = (sandboxId) =>
  `/api/v1/sandboxes/${encodeURIComponent(sandboxId)}/files`;

export let sandboxFilesListPath: (sandboxId: string) => string = (sandboxId) =>
  `/api/v1/sandboxes/${encodeURIComponent(sandboxId)}/files/list`;

/**
 * Research §11: `GET/PUT /sandboxes/{id}/network` (no `/api/v1`).
 * Public docs/OpenAPI: `GET/PUT /api/v1/sandboxes/{id}/network`.
 */
export let sandboxNetworkPath: (sandboxId: string) => string = (sandboxId) =>
  `/api/v1/sandboxes/${encodeURIComponent(sandboxId)}/network`;

/**
 * Research §11: `POST …/previews`. Public docs/OpenAPI:
 * `POST /api/v1/sandboxes/{id}/previews`.
 */
export let sandboxPreviewsPath: (sandboxId: string) => string = (sandboxId) =>
  `/api/v1/sandboxes/${encodeURIComponent(sandboxId)}/previews`;

const SANDBOXES_PATH = '/api/v1/sandboxes';

function sandboxPath(sandboxId: string): string {
  return `${SANDBOXES_PATH}/${encodeURIComponent(sandboxId)}`;
}

function sandboxRefreshPath(sandboxId: string): string {
  return `${sandboxPath(sandboxId)}/refresh`;
}

/* -------------------------------------------------------------------------- */
/* File-write fetch wrap                                                       */
/* -------------------------------------------------------------------------- */

/**
 * `POST /files` is `application/octet-stream` (raw bytes) per OpenAPI.
 * `ProviderHttpClient` JSON-encodes every body and forces `Content-Type:
 * application/json`. This wrap is the only compensation: when the client has
 * JSON-encoded a string body onto a files POST, unwrap it back to the raw
 * bytes and send `application/octet-stream`. It is not an auth-header
 * fallback and does not touch any other route.
 */
export function wrapSandbox0FileWriteFetch(inner: typeof fetch): typeof fetch {
  return async (input, init) => {
    const url = requestUrl(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    if (method === 'POST' && isFilesWriteUrl(url) && typeof init?.body === 'string') {
      const unwrapped = unwrapJsonStringBody(init.body);
      if (unwrapped !== undefined) {
        const headers = new Headers(init.headers);
        headers.set('content-type', 'application/octet-stream');
        return inner(input, { ...init, headers, body: unwrapped });
      }
    }
    return inner(input, init);
  };
}

function requestUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function isFilesWriteUrl(url: string): boolean {
  try {
    const path = new URL(url, 'https://api.sandbox0.ai').pathname;
    return /\/files$/.test(path);
  } catch {
    return /\/files(?:\?|$)/.test(url);
  }
}

function unwrapJsonStringBody(body: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(body);
    return typeof parsed === 'string' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/* -------------------------------------------------------------------------- */
/* Error classification                                                        */
/* -------------------------------------------------------------------------- */

function retryAfterSeconds(headers: Readonly<Record<string, string>>): number | undefined {
  const raw = headers['retry-after'];
  if (!raw) return undefined;
  const seconds = Number.parseInt(raw, 10);
  return Number.isFinite(seconds) && seconds >= 0 && seconds < 3600 ? seconds : undefined;
}

function classifySandbox0Error(
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>>,
): FoundryError | undefined {
  const code = extractSandbox0ErrorCode(body);
  const message = extractSandbox0ErrorMessage(body);
  if (status === 429 || code === SANDBOX0_QUOTA_EXCEEDED) {
    return new RateLimitError('sandbox0', retryAfterSeconds(headers), { code, status, message });
  }
  if (status === 409) {
    return new ConflictError(message ?? 'Sandbox0 reported a conflict (template still creating, or claim collision)', {
      code,
      status,
    });
  }
  return undefined;
}

/* -------------------------------------------------------------------------- */
/* Network policy builder                                                      */
/* -------------------------------------------------------------------------- */

export interface FailClosedCredentialRuleInput {
  readonly credentialRef: string;
  readonly name?: string;
  readonly protocol?: string;
  readonly domains?: readonly string[];
  readonly ports?: readonly { readonly port: number; readonly protocol?: string }[];
  readonly tlsMode?: 'passthrough' | 'terminate-reoriginate';
  readonly httpMatch?: Readonly<Record<string, unknown>>;
  /** Ignored — the builder always emits `fail-closed`. */
  readonly failurePolicy?: 'fail-closed' | 'fail-open';
}

export interface FailClosedNetworkPolicyInput {
  readonly mode?: 'allow-all' | 'block-all';
  readonly trafficRules?: readonly Readonly<Record<string, unknown>>[];
  readonly credentialRules: readonly FailClosedCredentialRuleInput[];
  readonly credentialBindings?: readonly Readonly<Record<string, unknown>>[];
  /**
   * Optional MCP tool firewall (`protocol: mcp` with `mcp.tools.allowed/denied`).
   * MCP protocol rules themselves fail closed when the body cannot be inspected.
   */
  readonly mcp?: {
    readonly name?: string;
    readonly domains?: readonly string[];
    readonly ports?: readonly { readonly port: number; readonly protocol?: string }[];
    readonly allowed?: readonly string[];
    readonly denied?: readonly string[];
    readonly path?: string;
  };
}

/**
 * Builds a `SandboxNetworkPolicy` whose `egress.credentialRules` are
 * fail-closed. Callers that need credential isolation must go through this
 * rather than hand-assembling a policy that could silently `fail-open`.
 */
export function buildFailClosedNetworkPolicy(input: FailClosedNetworkPolicyInput): Sandbox0NetworkPolicy {
  if (input.credentialRules.length === 0) {
    throw new ValidationError(
      'buildFailClosedNetworkPolicy requires at least one credentialRule (credentialRef is required by the API)',
    );
  }
  const credentialRules = input.credentialRules.map((rule) => ({
    ...(rule.name ? { name: rule.name } : {}),
    credentialRef: rule.credentialRef,
    ...(rule.protocol ? { protocol: rule.protocol } : {}),
    ...(rule.domains ? { domains: [...rule.domains] } : {}),
    ...(rule.ports ? { ports: rule.ports.map((p) => ({ ...p })) } : {}),
    ...(rule.tlsMode ? { tlsMode: rule.tlsMode } : {}),
    ...(rule.httpMatch ? { httpMatch: { ...rule.httpMatch } } : {}),
    failurePolicy: 'fail-closed' as const,
  }));
  const protocolRules = input.mcp
    ? [
        {
          name: input.mcp.name ?? 'mcp-tools',
          protocol: 'mcp',
          ...(input.mcp.domains ? { domains: [...input.mcp.domains] } : {}),
          ...(input.mcp.ports ? { ports: input.mcp.ports.map((p) => ({ ...p })) } : {}),
          tlsMode: 'terminate-reoriginate',
          ...(input.mcp.path
            ? { httpMatch: { methods: ['POST'], paths: [input.mcp.path] } }
            : {}),
          mcp: {
            tools: {
              ...(input.mcp.allowed ? { allowed: [...input.mcp.allowed] } : {}),
              ...(input.mcp.denied ? { denied: [...input.mcp.denied] } : {}),
            },
          },
        },
      ]
    : undefined;
  return {
    mode: input.mode ?? 'block-all',
    egress: {
      ...(input.trafficRules ? { trafficRules: input.trafficRules.map((r) => ({ ...r })) } : {}),
      credentialRules,
      ...(protocolRules ? { protocolRules } : {}),
    },
    ...(input.credentialBindings ? { credentialBindings: input.credentialBindings.map((b) => ({ ...b })) } : {}),
  };
}

/* -------------------------------------------------------------------------- */
/* Inputs                                                                      */
/* -------------------------------------------------------------------------- */

export interface ClaimOrCreateSandboxInput {
  readonly template: string;
  readonly ttlSeconds?: number;
  readonly hardTtlSeconds?: number;
  /**
   * Must include `agent_run_id` and is still sent on claim. Live 2026-08-15
   * dropped it on claim/GET/LIST, so reattach-by-metadata is not proven.
   */
  readonly metadata: { readonly agent_run_id: string } & Record<string, unknown>;
  readonly network?: Sandbox0NetworkPolicy;
  readonly webhook?: {
    readonly url: string;
    readonly secret?: string;
    readonly watch_dir?: string;
  };
  readonly envVars?: Readonly<Record<string, string>>;
  readonly snapshotId?: string;
  /** Isolated-exec identity. Must be paired with `companyId`. */
  readonly businessFunction?: ComputeBusinessFunction;
  readonly companyId?: string;
}

export interface ExecInput {
  readonly sandboxId: string;
  readonly contextId?: string;
  readonly command: string;
  /** REPL alias (`python`, `node`, `bash`, …). Omit for a one-shot cmd context. */
  readonly language?: string;
}

export interface CreatePreviewInput {
  readonly port: number;
  readonly protocol?: 'http' | 'https';
  readonly path?: string;
  /** 30–3600 seconds. */
  readonly ttlSeconds?: number;
}

/* -------------------------------------------------------------------------- */
/* Adapter                                                                     */
/* -------------------------------------------------------------------------- */

export class Sandbox0Adapter extends ProviderAdapter {
  override readonly manifest = SANDBOX0_MANIFEST;
  readonly #fetchImpl: typeof fetch | undefined;
  /** REPL context ids reused within this process, keyed by `${sandboxId}:${language}`. */
  readonly #replContexts = new Map<string, string>();

  constructor(ctx: AdapterContext, overrides?: { readonly fetchImpl?: typeof fetch }) {
    super(ctx);
    this.#fetchImpl = overrides?.fetchImpl;
  }

  /**
   * Auth assumption, recorded not silent: `Authorization: Bearer <SANDBOX0_TOKEN>`.
   * No other header is attempted. See the class comment.
   */
  #client(): ProviderHttpClient {
    const secret = this.requireSecret(SECRETS.sandbox0Token);
    return this.http(bearerAuth(secret), {
      fetchImpl: wrapSandbox0FileWriteFetch(this.#fetchImpl ?? globalThis.fetch.bind(globalThis)),
      classifyError: classifySandbox0Error,
      defaultTimeoutMs: 60_000,
    });
  }

  /* ---------------------------------------------------------------------- */
  /* Probe                                                                    */
  /* ---------------------------------------------------------------------- */

  /** `GET /api/v1/sandboxes?limit=1` — read-only list. Never claims. */
  override async probe(): Promise<ProbeResult> {
    const response = await this.#client().request(
      { method: 'GET', path: SANDBOXES_PATH, query: { limit: 1 }, operation: 'listSandboxes', retryable: false },
      Sandbox0SandboxListEnvelope,
    );
    const sandboxes = response.body.data.sandboxes;
    return {
      succeeded: true,
      detail: `GET /api/v1/sandboxes?limit=1 returned ${sandboxes.length} sandbox(es)`,
      evidence: {
        endpoint: 'GET /api/v1/sandboxes?limit=1',
        status: response.status,
        count: sandboxes.length,
        requestId: response.requestId,
      },
    };
  }

  /* ---------------------------------------------------------------------- */
  /* Lifecycle                                                                */
  /* ---------------------------------------------------------------------- */

  /**
   * Claim a sandbox. There is no idempotency header. The body still includes
   * `metadata.agent_run_id` and we look for a matching listed sandbox, but live
   * 2026-08-15 dropped that metadata on claim/GET/LIST — reattach is not proven.
   * POST claim is not retried (`retryable: false`).
   */
  async claimOrCreateSandbox(input: ClaimOrCreateSandboxInput): Promise<Sandbox0Claim | Sandbox0Sandbox | Sandbox0SandboxSummary> {
    this.assertActivated();
    const agentRunId = input.metadata.agent_run_id?.trim();
    if (!agentRunId) {
      throw new ValidationError('claimOrCreateSandbox requires metadata.agent_run_id so a retried job can reattach', {
        provider: 'sandbox0',
      });
    }
    if (input.template.trim().length === 0) {
      throw new ValidationError('claimOrCreateSandbox requires a non-empty template');
    }
    if (input.ttlSeconds !== undefined && input.hardTtlSeconds !== undefined && input.ttlSeconds > input.hardTtlSeconds) {
      throw new ValidationError('ttlSeconds must be <= hardTtlSeconds (documented relationship: ttl <= hard_ttl)', {
        ttlSeconds: input.ttlSeconds,
        hardTtlSeconds: input.hardTtlSeconds,
      });
    }

    if (input.businessFunction || input.companyId) {
      if (!input.businessFunction || !input.companyId) {
        throw new ValidationError('claimOrCreateSandbox businessFunction and companyId must be provided together', {
          provider: 'sandbox0',
        });
      }
      assertSandbox0Workload('untrusted_model_code');
      assertIsolatedFromControlPlane(isolatedExecIdentity(input.businessFunction, input.companyId).name);
    }

    const existing = await this.findSandboxByAgentRunId(agentRunId);
    if (existing) {
      getLogger().info({ sandboxId: existing.id, agentRunId, status: existing.status }, 'sandbox0 reattached existing sandbox');
      return existing;
    }
    return this.#claimSandbox(input, agentRunId);
  }

  /**
   * Best-effort reattach. Live 2026-08-15 dropped claim `metadata`, so listed
   * rows typically have no `agent_run_id` and this returns undefined.
   */
  async findSandboxByAgentRunId(agentRunId: string): Promise<Sandbox0SandboxSummary | undefined> {
    const all = await this.listSandboxes();
    return all.find((sandbox) => {
      if (sandbox.status === 'terminating' || sandbox.status === 'failed') return false;
      return agentRunIdOf(sandbox.metadata) === agentRunId;
    });
  }

  async listSandboxes(): Promise<readonly Sandbox0SandboxSummary[]> {
    this.assertActivated();
    const out: Sandbox0SandboxSummary[] = [];
    let offset = 0;
    const limit = 200;
    for (let page = 0; page < 10; page += 1) {
      const response = await this.#client().request(
        {
          method: 'GET',
          path: SANDBOXES_PATH,
          query: { limit, offset },
          operation: 'listSandboxes',
        },
        Sandbox0SandboxListEnvelope,
      );
      const pageItems = response.body.data.sandboxes;
      out.push(...pageItems);
      if (response.body.data.has_more === false || pageItems.length === 0) break;
      if (pageItems.length < limit && response.body.data.has_more !== true) break;
      offset += pageItems.length;
    }
    return out;
  }

  async #claimSandbox(input: ClaimOrCreateSandboxInput, agentRunId: string): Promise<Sandbox0Claim> {
    const webhook = this.#claimWebhook(input);
    const config: Record<string, unknown> = {
      ...(input.ttlSeconds !== undefined ? { ttl: input.ttlSeconds } : {}),
      ...(input.hardTtlSeconds !== undefined ? { hard_ttl: input.hardTtlSeconds } : {}),
      ...(input.network ? { network: input.network } : {}),
      ...(webhook ? { webhook } : {}),
      ...(input.envVars ? { env_vars: input.envVars } : {}),
    };
    const body: Record<string, unknown> = {
      template: input.template,
      ...(input.snapshotId ? { snapshot_id: input.snapshotId } : {}),
      ...(Object.keys(config).length > 0 ? { config } : {}),
      // Sent, not proven stored. Live 2026-08-15 dropped this field.
      metadata: {
        ...input.metadata,
        agent_run_id: agentRunId,
        ...(input.businessFunction && input.companyId
          ? isolatedExecIdentity(input.businessFunction, input.companyId).metadata
          : {}),
      },
    };
    const response = await this.#client().request(
      { method: 'POST', path: SANDBOXES_PATH, body, retryable: false, operation: 'claimSandbox' },
      Sandbox0ClaimEnvelope,
    );
    getLogger().info(
      { sandboxId: response.body.data.sandbox_id, status: response.body.data.status, agentRunId },
      'sandbox0 sandbox claimed',
    );
    return response.body.data;
  }

  #claimWebhook(input: ClaimOrCreateSandboxInput): { url: string; secret?: string; watch_dir?: string } | undefined {
    if (!input.webhook) return undefined;
    const configured = this.optionalSecret(SECRETS.sandbox0WebhookSecret);
    const secret = input.webhook.secret ?? configured?.reveal();
    return {
      url: input.webhook.url,
      ...(secret ? { secret } : {}),
      ...(input.webhook.watch_dir ? { watch_dir: input.webhook.watch_dir } : {}),
    };
  }

  async getSandbox(sandboxId: string): Promise<Sandbox0Sandbox> {
    this.assertActivated();
    const response = await this.#client().request(
      { method: 'GET', path: sandboxPath(sandboxId), operation: 'getSandbox' },
      Sandbox0SandboxEnvelope,
    );
    return response.body.data;
  }

  async deleteSandbox(sandboxId: string): Promise<void> {
    this.assertActivated();
    await this.#client().raw({ method: 'DELETE', path: sandboxPath(sandboxId), operation: 'deleteSandbox' });
    this.#forgetReplContexts(sandboxId);
    getLogger().info({ sandboxId }, 'sandbox0 sandbox deleted');
  }

  async refreshSandbox(sandboxId: string, durationSeconds?: number): Promise<Sandbox0Refresh> {
    this.assertActivated();
    const response = await this.#client().request(
      {
        method: 'POST',
        path: sandboxRefreshPath(sandboxId),
        body: durationSeconds !== undefined ? { duration: durationSeconds } : {},
        operation: 'refreshSandbox',
      },
      Sandbox0RefreshEnvelope,
    );
    return response.body.data;
  }

  /**
   * `POST /api/v1/sandboxes/{id}/pause`.
   *
   * Live 2026-08-15: HTTP 200 with `paused: false` / `status: running`. This
   * returns that body as-is and does not rewrite `paused` to true. Pause does
   * not preserve processes, memory, sockets, or PIDs (unlike Superserve).
   * When `paused` is actually true, cached REPL context ids are dropped
   * because those processes are gone.
   */
  async pauseSandbox(sandboxId: string): Promise<Sandbox0Pause> {
    this.assertActivated();
    const response = await this.#client().request(
      {
        method: 'POST',
        path: `${sandboxPath(sandboxId)}/pause`,
        retryable: false,
        operation: 'pauseSandbox',
      },
      Sandbox0PauseEnvelope,
    );
    const paused = response.body.data;
    if (paused.paused === true) this.#forgetReplContexts(sandboxId);
    getLogger().info(
      {
        sandboxId,
        paused: paused.paused,
        status: paused.status,
        httpStatus: response.status,
        preservesProcesses: SANDBOX0_PAUSE_PRESERVES_PROCESSES,
      },
      'sandbox0 pause accepted; HTTP 200 does not mean paused:true and does not keep processes',
    );
    return paused;
  }

  /**
   * `POST /api/v1/sandboxes/{id}/resume`. Live 200 on 2026-08-15.
   * Resume does not restore processes that pause discarded — this is not
   * Superserve's memory+PID snapshot.
   */
  async resumeSandbox(sandboxId: string): Promise<Sandbox0Resume> {
    this.assertActivated();
    const response = await this.#client().request(
      {
        method: 'POST',
        path: `${sandboxPath(sandboxId)}/resume`,
        retryable: false,
        operation: 'resumeSandbox',
      },
      Sandbox0ResumeEnvelope,
    );
    getLogger().info(
      {
        sandboxId,
        resumed: response.body.data.resumed,
        status: response.body.data.status,
        httpStatus: response.status,
        preservesProcesses: SANDBOX0_PAUSE_PRESERVES_PROCESSES,
      },
      'sandbox0 resume accepted; processes from before pause are not restored',
    );
    return response.body.data;
  }

  #forgetReplContexts(sandboxId: string): void {
    for (const key of [...this.#replContexts.keys()]) {
      if (key.startsWith(`${sandboxId}:`)) this.#replContexts.delete(key);
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Exec (data plane)                                                        */
  /* ---------------------------------------------------------------------- */

  /**
   * Run a command inside a sandbox.
   *
   * - `contextId` set: `POST …/contexts/{id}/exec` with `{data}`.
   * - `language` set: ensure a REPL context for that alias, then exec.
   * - otherwise: create a one-shot cmd context with `wait_until_done: true`.
   */
  async exec(input: ExecInput): Promise<Sandbox0ExecResult> {
    this.assertActivated();
    if (input.command.trim().length === 0) {
      throw new ValidationError('exec requires a non-empty command', { sandboxId: input.sandboxId });
    }
    if (input.contextId) {
      return this.#execInContext(input.sandboxId, input.contextId, input.command);
    }
    if (input.language) {
      const contextId = await this.#ensureReplContext(input.sandboxId, input.language);
      return this.#execInContext(input.sandboxId, contextId, input.command);
    }
    const created = await this.#createContext(input.sandboxId, {
      type: 'cmd',
      cmd: { command: ['/bin/sh', '-c', input.command] },
      wait_until_done: true,
    });
    return {
      output_raw: typeof created.output_raw === 'string' ? created.output_raw : undefined,
      stdout: typeof created.stdout === 'string' ? created.stdout : undefined,
      stderr: typeof created.stderr === 'string' ? created.stderr : undefined,
      exit_code: typeof created.exit_code === 'number' ? created.exit_code : undefined,
      state: typeof created.state === 'string' ? created.state : undefined,
    };
  }

  async #execInContext(sandboxId: string, contextId: string, command: string): Promise<Sandbox0ExecResult> {
    const response = await this.#client().request(
      {
        method: 'POST',
        path: sandboxContextExecPath(sandboxId, contextId),
        body: { data: command },
        operation: 'contextExec',
        timeoutMs: 120_000,
        retryable: false,
      },
      Sandbox0ExecResultEnvelope,
    );
    return response.body.data;
  }

  async #ensureReplContext(sandboxId: string, language: string): Promise<string> {
    const key = `${sandboxId}:${language}`;
    const cached = this.#replContexts.get(key);
    if (cached) return cached;
    const created = await this.#createContext(sandboxId, {
      type: 'repl',
      repl: { alias: language },
    });
    this.#replContexts.set(key, created.id);
    return created.id;
  }

  async #createContext(sandboxId: string, body: Record<string, unknown>): Promise<Sandbox0Context> {
    const response = await this.#client().request(
      {
        method: 'POST',
        path: sandboxContextsPath(sandboxId),
        body,
        operation: 'createContext',
        timeoutMs: 120_000,
        retryable: false,
      },
      Sandbox0ContextEnvelope,
    );
    return response.body.data;
  }

  /* ---------------------------------------------------------------------- */
  /* Files (data plane)                                                       */
  /* ---------------------------------------------------------------------- */

  async writeFile(sandboxId: string, path: string, content: string): Promise<void> {
    this.assertActivated();
    await this.#client().raw({
      method: 'POST',
      path: sandboxFilesPath(sandboxId),
      query: { path },
      body: content,
      operation: 'writeFile',
    });
  }

  async readFile(sandboxId: string, path: string): Promise<string> {
    this.assertActivated();
    const response = await this.#client().raw({
      method: 'GET',
      path: sandboxFilesPath(sandboxId),
      query: { path },
      operation: 'readFile',
    });
    if (typeof response.body === 'string') return response.body;
    const enveloped = Sandbox0FileContentEnvelope.safeParse(response.body);
    if (enveloped.success) return decodeFileContent(enveloped.data.data);
    const direct = Sandbox0FileContent.safeParse(response.body);
    if (direct.success) return decodeFileContent(direct.data);
    throw new ProviderContractError(
      'sandbox0',
      `GET files?path= returned neither octet-stream text nor a JSON {content,encoding} payload`,
      { sandboxId, path },
    );
  }

  async listFiles(sandboxId: string, path: string): Promise<readonly Sandbox0FileInfo[]> {
    this.assertActivated();
    const response = await this.#client().request(
      {
        method: 'GET',
        path: sandboxFilesListPath(sandboxId),
        query: { path },
        operation: 'listFiles',
      },
      Sandbox0FileListEnvelope,
    );
    return response.body.data.entries ?? [];
  }

  /* ---------------------------------------------------------------------- */
  /* Network policy                                                           */
  /* ---------------------------------------------------------------------- */

  /** `PUT /api/v1/sandboxes/{id}/network`. Pass a fail-closed policy from `buildFailClosedNetworkPolicy`. */
  async setNetworkPolicy(sandboxId: string, policy: Sandbox0NetworkPolicy): Promise<Sandbox0NetworkPolicy> {
    this.assertActivated();
    const response = await this.#client().request(
      {
        method: 'PUT',
        path: sandboxNetworkPath(sandboxId),
        body: policy,
        operation: 'setNetworkPolicy',
      },
      Sandbox0NetworkPolicyEnvelope,
    );
    return response.body.data;
  }

  /* ---------------------------------------------------------------------- */
  /* Previews                                                                 */
  /* ---------------------------------------------------------------------- */

  /**
   * `POST …/previews`. Returns a one-time-credential bootstrap URL.
   * The preview hostname is routing information, not authorization — requests
   * without a valid preview cookie still follow normal public service policy.
   */
  async createPreview(sandboxId: string, input: CreatePreviewInput): Promise<Sandbox0Preview> {
    this.assertActivated();
    if (input.port < 1 || input.port > 65535) {
      throw new ValidationError('createPreview port must be between 1 and 65535', { port: input.port });
    }
    if (
      input.ttlSeconds !== undefined &&
      (input.ttlSeconds < SANDBOX0_PREVIEW_TTL_MIN || input.ttlSeconds > SANDBOX0_PREVIEW_TTL_MAX)
    ) {
      throw new ValidationError(
        `createPreview ttlSeconds must be between ${SANDBOX0_PREVIEW_TTL_MIN} and ${SANDBOX0_PREVIEW_TTL_MAX}`,
        { ttlSeconds: input.ttlSeconds },
      );
    }
    const response = await this.#client().request(
      {
        method: 'POST',
        path: sandboxPreviewsPath(sandboxId),
        body: {
          port: input.port,
          ...(input.protocol ? { protocol: input.protocol } : {}),
          ...(input.path ? { path: input.path } : {}),
          ...(input.ttlSeconds !== undefined ? { ttl_seconds: input.ttlSeconds } : {}),
        },
        operation: 'createPreview',
      },
      Sandbox0PreviewEnvelope,
    );
    return response.body.data;
  }

  /* ---------------------------------------------------------------------- */
  /* Webhooks                                                                 */
  /* ---------------------------------------------------------------------- */

  /**
   * Verifies an inbound Sandbox0 webhook using `verifySandbox0Signature`.
   * Layout is UNVERIFIED (raw body vs `timestamp.body`, hex vs base64) — the
   * shared verifier already tries the documented-plausible combinations.
   * Docs (2026-08-15) state hex HMAC-SHA256 of the raw body; the extra
   * layouts stay until a live signed delivery pins one.
   */
  verifyWebhook(
    rawBody: Buffer | string,
    headers: Record<string, string | string[] | undefined>,
  ): { readonly verification: VerificationResult; readonly event: Sandbox0WebhookEvent } {
    const secret = this.requireSecret(SECRETS.sandbox0WebhookSecret);
    const verification = verifySandbox0Signature({ rawBody, headers, secret });
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8'));
    } catch (error) {
      throw new ProviderContractError('sandbox0', 'webhook body was not valid JSON', {
        cause: error instanceof Error ? error.message : String(error),
      });
    }
    const parsed = Sandbox0WebhookEvent.safeParse(parsedJson);
    if (!parsed.success) {
      throw new ProviderContractError(
        'sandbox0',
        `webhook body did not match the defensive event envelope: ${parsed.error.message}`,
      );
    }
    return { verification, event: parsed.data };
  }
}

function decodeFileContent(payload: { readonly content?: string | null; readonly encoding?: string | null }): string {
  const content = payload.content ?? '';
  if (payload.encoding === 'base64') {
    return Buffer.from(content, 'base64').toString('utf8');
  }
  return content;
}

/* -------------------------------------------------------------------------- */
/* Re-exports                                                                  */
/* -------------------------------------------------------------------------- */

export * from './schemas.js';
export { CredentialsMissingError };
