/**
 * Solari (by Pinetree Research) adapter — cloud browsers, sandboxes and full
 * GUI computers, used for compliant public-web research and supplier
 * discovery where no API exists.
 *
 * Written against docs.getsolari.com and live-probed 2026-08-15 with a
 * `slr_live_` key. There is no webhook surface ("No webhooks found"), so
 * unlike Stripe/Terac/Whop there is no `events.ts`/`verifyWebhook` here.
 *
 * Live 2xx on 2026-08-15 (see probe + mutating calls in this file's comments):
 *   GET /health 200, GET /sandboxes?limit=1 200, GET /profiles 200,
 *   GET /templates 200, POST /sessions 201, GET /sessions/:id 200,
 *   DELETE /sessions/:id 204, POST /sandboxes 201, GET /sandboxes/:id 200,
 *   POST /sandboxes/:id/exec 200 `{cmd,args}` → `{exitCode,stdout,stderr}`,
 *   DELETE /sandboxes/:id 200.
 * Blocked / not claimed:
 *   GET /healthz 401 (not unauthenticated), POST /desktops timed out at 90s
 *   with 0 bytes — GUI create is unverified, not a success.
 *
 * Human takeover (two-way control over `ws/observe` or the VNC `stream`) is
 * still UNVERIFIED. `requestHumanTakeover` throws; sourcing human-escalation
 * goes through Terac (see `../terac`).
 */

import { CapabilityUnsupportedError, LONG_RUNNING_RETRY, ProviderContractError, ValidationError, toFoundryError } from '@foundry/core';
import { getLogger } from '@foundry/obs';
import { ProviderAdapter, type AdapterContext, type ProbeResult } from '../http/adapter.js';
import { bearerAuth, newIdempotencyToken, type ProviderHttpClient } from '../http/client.js';
import { SECRETS, SOLARI_MANIFEST } from '../manifests.js';
import {
  loadQueryPagesFromEndpoints,
  type LoadedBrowserPage,
  type SessionPageLoad,
} from './navigate.js';
import {
  SolariBrowserSession,
  SolariDesktop,
  SolariExecResult,
  SolariProfile,
  SolariReplayUrlResponse,
  SolariSandbox,
  SolariSandboxList,
  SolariSandboxMetrics,
  SolariSessionStatus,
  SolariSnapshot,
} from './schemas.js';

export {
  loadQueryPagesFromEndpoints,
  openLoadedPagesViaCdp,
  searchPageUrls,
  isSearchHost,
  isSearchResultsPage,
  resolveResultUrl,
  type LoadedBrowserPage,
  type SessionPageLoad,
} from './navigate.js';

/* -------------------------------------------------------------------------- */
/* UNVERIFIED path — reassignable like Terac's `feasibilityRequestPath`         */
/* -------------------------------------------------------------------------- */

/**
 * The docs show only the SDK call site `client.profiles.create({name})`, not
 * a REST path. `POST /profiles` is the standard REST inference from that
 * resource name (the same confidence level Terac's `feasibilityRequestPath`
 * carries for its own UNVERIFIED path), exported as a reassignable function so
 * a corrected path is a one-line change rather than a refactor.
 */
export let profileCreatePath: () => string = () => '/profiles';

/* -------------------------------------------------------------------------- */
/* Inputs                                                                      */
/* -------------------------------------------------------------------------- */

export interface CreateBrowserSessionInput {
  readonly profileId?: string;
  /** Docs warn recording captures input values by default — see the log warning below. */
  readonly recording?: boolean;
  readonly stealth?: boolean;
  readonly captcha?: boolean;
  readonly webBotAuth?: boolean;
  /** Shape UNVERIFIED beyond the field name itself; passed through verbatim. */
  readonly proxy?: Readonly<Record<string, unknown>>;
  readonly idempotencyKey?: string;
}

export interface CreateSandboxInput {
  readonly kind?: string;
  readonly template?: string;
  readonly fromSnapshot?: string;
  readonly cpu?: number;
  readonly memMb?: number;
  readonly diskGb?: number;
  readonly envs?: Readonly<Record<string, string>>;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly timeoutMs?: number;
  readonly lifecycle?: Readonly<Record<string, unknown>>;
  readonly record?: boolean;
  readonly volumes?: readonly unknown[];
  readonly idempotencyKey?: string;
}

export interface CreateDesktopInput {
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly idempotencyKey?: string;
}

/**
 * `POST /sandboxes/:id/exec` live body (2026-08-15): `cmd` is the binary,
 * `args` its argv tail. A convenience `command` string is mapped to
 * `{cmd:"sh", args:["-c", command]}` — the wire never sees a `command` field.
 */
export interface ExecInSandboxInput {
  readonly cmd?: string;
  readonly args?: readonly string[];
  /** Shell line. Sent as `{cmd:"sh", args:["-c", command]}` when `cmd` is omitted. */
  readonly command?: string;
  readonly cwd?: string;
  readonly timeoutMs?: number;
}

export interface SolariExecBody {
  readonly cmd: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly timeoutMs?: number;
}

/** Maps caller input onto the live exec body. Never includes `command`. */
export function solariExecBody(input: ExecInSandboxInput): SolariExecBody {
  const extras: { cwd?: string; timeoutMs?: number } = {
    ...(input.cwd ? { cwd: input.cwd } : {}),
    ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
  };
  const cmd = input.cmd?.trim();
  if (cmd) {
    return { cmd, ...(input.args ? { args: [...input.args] } : {}), ...extras };
  }
  const command = input.command?.trim();
  if (!command) {
    throw new ValidationError('execInSandbox requires cmd or a non-empty command');
  }
  return { cmd: 'sh', args: ['-c', command], ...extras };
}

export function solariSandboxId(sandbox: SolariSandbox): string {
  const id = sandbox.sandboxId ?? sandbox.id;
  if (!id) {
    throw new ProviderContractError('solari', 'sandbox response had neither sandboxId nor id', { sandbox });
  }
  return id;
}

/* -------------------------------------------------------------------------- */
/* Adapter                                                                     */
/* -------------------------------------------------------------------------- */

export class SolariAdapter extends ProviderAdapter {
  override readonly manifest = SOLARI_MANIFEST;
  readonly #fetchImpl: typeof fetch | undefined;

  constructor(ctx: AdapterContext, overrides?: { readonly fetchImpl?: typeof fetch }) {
    super(ctx);
    this.#fetchImpl = overrides?.fetchImpl;
  }

  /**
   * Idempotency-Key is documented on create routes; concurrency limiting
   * (429 `ConcurrencyLimitExceeded`, not a fixed rate limit) plus the
   * generally slow nature of spinning up a browser/sandbox/desktop is why
   * this uses the long-running retry policy rather than the default one —
   * mirrored from Superserve's identical reasoning.
   */
  #client(): ProviderHttpClient {
    const secret = this.requireSecret(SECRETS.solariApiKey);
    return this.http(bearerAuth(secret), {
      idempotencyHeader: 'Idempotency-Key',
      retryPolicy: LONG_RUNNING_RETRY,
      fetchImpl: this.#fetchImpl,
    });
  }

  /* ---------------------------------------------------------------------- */
  /* Probe                                                                   */
  /* ---------------------------------------------------------------------- */

  /**
   * `GET /health` is unauthenticated (live 200 on 2026-08-15). `GET /healthz`
   * returned 401 with this key and is not used. Credential check is
   * `GET /sandboxes?limit=1` (live 200 `{sandboxes:[…]}`). Never creates.
   */
  override async probe(): Promise<ProbeResult> {
    const client = this.#client();

    const health = await client.raw({ method: 'GET', path: '/health', operation: 'health.check', retryable: false });
    if (health.status < 200 || health.status >= 300) {
      return {
        succeeded: false,
        detail: `GET /health returned HTTP ${health.status}; Solari's API does not appear reachable`,
        evidence: { endpoint: 'GET /health', status: health.status },
      };
    }

    try {
      const response = await client.request(
        {
          method: 'GET',
          path: '/sandboxes',
          query: { limit: 1 },
          operation: 'sandboxes.list.probe',
          retryable: false,
        },
        SolariSandboxList,
      );
      return {
        succeeded: true,
        detail: 'GET /health succeeded and GET /sandboxes?limit=1 was accepted by the API with the configured credential',
        evidence: {
          endpoint: 'GET /sandboxes?limit=1',
          status: response.status,
          healthStatus: health.status,
          count: response.body.sandboxes.length,
        },
      };
    } catch (error) {
      const foundry = toFoundryError(error);
      return {
        succeeded: false,
        detail: `GET /health succeeded but GET /sandboxes?limit=1 failed: ${foundry.message}`,
        evidence: {
          endpoint: 'GET /sandboxes?limit=1',
          code: foundry.code,
          category: foundry.category,
          healthStatus: health.status,
        },
      };
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Browser sessions                                                        */
  /* ---------------------------------------------------------------------- */

  async createBrowserSession(input: CreateBrowserSessionInput = {}): Promise<SolariBrowserSession> {
    this.assertActivated();
    const response = await this.#client().request(
      {
        method: 'POST',
        path: '/sessions',
        operation: 'sessions.create',
        idempotencyKey: input.idempotencyKey ?? newIdempotencyToken(),
        body: {
          ...(input.profileId ? { profileId: input.profileId } : {}),
          ...(input.recording !== undefined ? { recording: input.recording } : {}),
          ...(input.stealth !== undefined ? { stealth: input.stealth } : {}),
          ...(input.captcha !== undefined ? { captcha: input.captcha } : {}),
          ...(input.webBotAuth !== undefined ? { webBotAuth: input.webBotAuth } : {}),
          ...(input.proxy ? { proxy: input.proxy } : {}),
        },
      },
      SolariBrowserSession,
    );
    if (input.recording) {
      // Docs: "Recording captures input values by default." Logged loudly
      // rather than silently trusted, because the caller — not this adapter —
      // is the one who knows whether this session will touch a credential
      // field, and this is the one place that decision can still be caught.
      getLogger().warn(
        { sessionId: response.body.sessionId },
        'solari session recording is enabled; docs warn recording captures input values by default — never enable this on a session that will touch a credential field',
      );
    }
    getLogger().info({ sessionId: response.body.sessionId }, 'solari browser session created');
    return response.body;
  }

  /**
   * Navigate the live session over cdpEndpoint (raw CDP) or wsEndpoint.
   * Returns only pages the session actually opened. Does not invent URLs.
   */
  async loadQueryPages(input: {
    readonly query: string;
    readonly maxItems: number;
    readonly sessionId: string;
    readonly cdpEndpoint?: string | null;
    readonly wsEndpoint?: string | null;
  }): Promise<readonly LoadedBrowserPage[]> {
    this.assertActivated();
    const loaded = await loadQueryPagesFromEndpoints(input);
    getLogger().info(
      { sessionId: input.sessionId, evidence: loaded.evidence.length, opened: loaded.loaded.length },
      'solari session navigated',
    );
    return loaded.evidence;
  }

  /** Same as loadQueryPages, including search pages that opened. */
  async loadQueryPagesDetailed(input: {
    readonly query: string;
    readonly maxItems: number;
    readonly sessionId: string;
    readonly cdpEndpoint?: string | null;
    readonly wsEndpoint?: string | null;
  }): Promise<SessionPageLoad> {
    this.assertActivated();
    return loadQueryPagesFromEndpoints(input);
  }

  /** `DELETE /sessions/:id` → 204, live 2026-08-15. */
  async deleteSession(sessionId: string): Promise<void> {
    this.assertActivated();
    await this.#client().raw({
      method: 'DELETE',
      path: `/sessions/${encodeURIComponent(sessionId)}`,
      operation: 'sessions.delete',
    });
  }

  /**
   * `GET /sessions/:id`. Older docs said this always 404s; live 200 on
   * 2026-08-15 returned `id`, `status`, `kind`, `org`, `createdAt`, `expiresAt`,
   * `wsEndpoint`, `cdpEndpoint`.
   */
  async getSessionStatus(sessionId: string): Promise<SolariSessionStatus> {
    this.assertActivated();
    const response = await this.#client().request(
      { method: 'GET', path: `/sessions/${encodeURIComponent(sessionId)}`, operation: 'sessions.get' },
      SolariSessionStatus,
    );
    return response.body;
  }

  /**
   * The only genuine post-creation recording read: the replay URL, once the
   * session has ended and `recording: true` was set at creation.
   *
   * Response shape is UNVERIFIED (docs name the endpoint, never a payload);
   * every plausible field name is checked and this fails loudly rather than
   * returning a fabricated URL when none is present.
   */
  async getReplayUrl(sessionId: string): Promise<string> {
    this.assertActivated();
    const response = await this.#client().request(
      { method: 'GET', path: `/sessions/${encodeURIComponent(sessionId)}/replay-url`, operation: 'sessions.replayUrl' },
      SolariReplayUrlResponse,
    );
    const url = response.body.replayUrl ?? response.body.replay_url ?? response.body.url;
    if (!url) {
      throw new ProviderContractError(
        'solari',
        `GET /sessions/${sessionId}/replay-url returned no recognised URL field (checked replayUrl, replay_url, ` +
          'url — the exact field name is UNVERIFIED, see schemas.ts)',
        { sessionId, body: response.body },
      );
    }
    return url;
  }

  /**
   * Constructs the live-observer WebSocket URL.
   *
   * The docs give the path pattern `wss://…/ws/observe/:sessionId?token=` but
   * never state where the token comes from — unlike `wsEndpoint`/`cdpEndpoint`
   * on the session-create response, which arrive ready to use, no create
   * response field carries an observer token. The caller supplies one
   * explicitly; this method only assembles the URL. It asserts nothing about
   * what the token authorises — see `requestHumanTakeover` for why this must
   * never be read as proof that two-way control exists.
   */
  buildObserveUrl(sessionId: string, token: string): string {
    const wsBase = this.baseUrl().replace(/^http/, 'ws');
    const url = new URL(`/ws/observe/${encodeURIComponent(sessionId)}`, wsBase);
    url.searchParams.set('token', token);
    return url.toString();
  }

  /**
   * Human takeover of a live Solari session/desktop is UNVERIFIED.
   *
   * `ws/observe` and the VNC `stream` are documented only as
   * observation/embedding mechanisms; whether either injects two-way human
   * control is never stated (checked docs.getsolari.com/api-reference/browser
   * and /api-reference/desktops on 2026-08-14). Implementing this as if it
   * worked would let a workflow silently depend on a human being able to
   * intervene in a stuck session when nobody has confirmed that is possible.
   * No HTTP call is made — there is nothing documented to call. Route human
   * escalation for supplier research through the Terac expert marketplace
   * instead (see `../terac`), per the sourcing design.
   */
  requestHumanTakeover(_sessionId: string): never {
    throw new CapabilityUnsupportedError(
      'solari',
      'research.browser_session.human_takeover',
      'Two-way human control over a live session/desktop is UNVERIFIED: the docs describe ws/observe and the VNC ' +
        'stream endpoint only as observation/embedding mechanisms and never state whether either accepts input. ' +
        'This capability is not implemented; route human escalation through the Terac expert marketplace instead.',
    );
  }

  /* ---------------------------------------------------------------------- */
  /* Sandboxes                                                               */
  /* ---------------------------------------------------------------------- */

  async createSandbox(input: CreateSandboxInput = {}): Promise<SolariSandbox> {
    this.assertActivated();
    const response = await this.#client().request(
      {
        method: 'POST',
        path: '/sandboxes',
        operation: 'sandboxes.create',
        idempotencyKey: input.idempotencyKey ?? newIdempotencyToken(),
        body: {
          ...(input.kind ? { kind: input.kind } : {}),
          ...(input.template ? { template: input.template } : {}),
          ...(input.fromSnapshot ? { fromSnapshot: input.fromSnapshot } : {}),
          ...(input.cpu !== undefined ? { cpu: input.cpu } : {}),
          ...(input.memMb !== undefined ? { memMb: input.memMb } : {}),
          ...(input.diskGb !== undefined ? { diskGb: input.diskGb } : {}),
          ...(input.envs ? { envs: input.envs } : {}),
          ...(input.metadata ? { metadata: input.metadata } : {}),
          ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
          ...(input.lifecycle ? { lifecycle: input.lifecycle } : {}),
          ...(input.record !== undefined ? { record: input.record } : {}),
          ...(input.volumes ? { volumes: input.volumes } : {}),
        },
      },
      SolariSandbox,
    );
    getLogger().info({ sandboxId: solariSandboxId(response.body) }, 'solari sandbox created');
    return response.body;
  }

  /** `GET /sandboxes/:id` — live 200 on 2026-08-15 (`state: running`). */
  async getSandbox(sandboxId: string): Promise<SolariSandbox> {
    this.assertActivated();
    const response = await this.#client().request(
      { method: 'GET', path: `/sandboxes/${encodeURIComponent(sandboxId)}`, operation: 'sandboxes.get' },
      SolariSandbox,
    );
    return response.body;
  }

  /**
   * `POST /sandboxes/:id/exec` — live body is `{cmd, args?, cwd?, timeoutMs?}`.
   * Response (live 200): `{exitCode, stdout, stderr}`. A non-zero exit is still 200.
   */
  async execInSandbox(sandboxId: string, input: ExecInSandboxInput): Promise<SolariExecResult> {
    this.assertActivated();
    const body = solariExecBody(input);
    const response = await this.#client().request(
      {
        method: 'POST',
        path: `/sandboxes/${encodeURIComponent(sandboxId)}/exec`,
        operation: 'sandboxes.exec',
        body,
      },
      SolariExecResult,
    );
    return response.body;
  }

  /** `DELETE /sandboxes/:id` — live 200 `{ok:true}` (docs also allow 204). */
  async deleteSandbox(sandboxId: string): Promise<void> {
    this.assertActivated();
    await this.#client().raw({
      method: 'DELETE',
      path: `/sandboxes/${encodeURIComponent(sandboxId)}`,
      operation: 'sandboxes.delete',
    });
    getLogger().info({ sandboxId }, 'solari sandbox deleted');
  }

  async pauseSandbox(sandboxId: string): Promise<void> {
    this.assertActivated();
    await this.#client().raw({
      method: 'POST',
      path: `/sandboxes/${encodeURIComponent(sandboxId)}/pause`,
      operation: 'sandboxes.pause',
    });
  }

  async resumeSandbox(sandboxId: string): Promise<void> {
    this.assertActivated();
    await this.#client().raw({
      method: 'POST',
      path: `/sandboxes/${encodeURIComponent(sandboxId)}/resume`,
      operation: 'sandboxes.resume',
    });
  }

  async setSandboxTimeout(sandboxId: string, timeoutMs: number): Promise<void> {
    this.assertActivated();
    await this.#client().raw({
      method: 'POST',
      path: `/sandboxes/${encodeURIComponent(sandboxId)}/timeout`,
      operation: 'sandboxes.timeout',
      body: { timeoutMs },
    });
  }

  /** `GET /sandboxes/:id/metrics` — no documented shape; returned unshaped. */
  async getSandboxMetrics(sandboxId: string): Promise<SolariSandboxMetrics> {
    this.assertActivated();
    const response = await this.#client().request(
      { method: 'GET', path: `/sandboxes/${encodeURIComponent(sandboxId)}/metrics`, operation: 'sandboxes.metrics' },
      SolariSandboxMetrics,
    );
    return response.body;
  }

  async createSandboxSnapshot(sandboxId: string): Promise<SolariSnapshot> {
    this.assertActivated();
    const response = await this.#client().request(
      { method: 'POST', path: `/sandboxes/${encodeURIComponent(sandboxId)}/snapshots`, operation: 'sandboxes.snapshots.create' },
      SolariSnapshot,
    );
    return response.body;
  }

  /** `/snapshots/:id/promote` → turns a snapshot into a reusable template. */
  async promoteSnapshot(snapshotId: string): Promise<SolariSnapshot> {
    this.assertActivated();
    const response = await this.#client().request(
      { method: 'POST', path: `/snapshots/${encodeURIComponent(snapshotId)}/promote`, operation: 'sandboxes.snapshots.promote' },
      SolariSnapshot,
    );
    return response.body;
  }

  /**
   * `POST /:id/revert`. The docs give this as a bare path fragment
   * immediately after the snapshots bullet; read in context it reverts the
   * *sandbox* to a prior snapshot (as opposed to `/snapshots/:id/promote`,
   * which acts on the snapshot). Modelled here as `/sandboxes/:id/revert` —
   * flagged UNVERIFIED in case the real route is nested under `/snapshots`
   * instead.
   */
  async revertSandbox(sandboxId: string, input: Readonly<Record<string, unknown>> = {}): Promise<void> {
    this.assertActivated();
    await this.#client().raw({
      method: 'POST',
      path: `/sandboxes/${encodeURIComponent(sandboxId)}/revert`,
      operation: 'sandboxes.revert',
      body: input,
    });
  }

  /* ---------------------------------------------------------------------- */
  /* Desktops (GUI computers)                                                */
  /* ---------------------------------------------------------------------- */

  /**
   * `POST /desktops` is blocked. Live probe on 2026-08-15 timed out at 90s
   * with 0 bytes. This does not invent a desktop id or call the route.
   */
  createDesktop(_input: CreateDesktopInput = {}): never {
    throw new CapabilityUnsupportedError(
      'solari',
      'research.gui_computer',
      'POST /desktops timed out at 90s with 0 bytes on 2026-08-15. GUI create is unverified and is not called. ' +
        'Use createSandbox({kind:"sandbox"}) for headless exec. Do not treat this as a working desktop plane.',
    );
  }

  /**
   * `GET /desktops/:id` is documented as a real route (no "always 404" caveat).
   * Create remains blocked; this is only useful for an already-known id.
   */
  async getDesktop(desktopId: string): Promise<SolariDesktop> {
    this.assertActivated();
    const response = await this.#client().request(
      { method: 'GET', path: `/desktops/${encodeURIComponent(desktopId)}`, operation: 'desktops.get' },
      SolariDesktop,
    );
    return response.body;
  }

  async deleteDesktop(desktopId: string): Promise<void> {
    this.assertActivated();
    await this.#client().raw({ method: 'DELETE', path: `/desktops/${encodeURIComponent(desktopId)}`, operation: 'desktops.delete' });
  }

  async pauseDesktop(desktopId: string): Promise<void> {
    this.assertActivated();
    await this.#client().raw({ method: 'POST', path: `/desktops/${encodeURIComponent(desktopId)}/pause`, operation: 'desktops.pause' });
  }

  async resumeDesktop(desktopId: string): Promise<void> {
    this.assertActivated();
    await this.#client().raw({ method: 'POST', path: `/desktops/${encodeURIComponent(desktopId)}/resume`, operation: 'desktops.resume' });
  }

  /* ---------------------------------------------------------------------- */
  /* Profiles                                                                */
  /* ---------------------------------------------------------------------- */

  /**
   * Persists cookies/logins so a later session can attach via
   * `POST /sessions {profileId}`. Docs warn: "Anyone with your API key can
   * attach it to a session and act as that account" — profile ids are
   * therefore treated as high-privilege and gated behind the policy service
   * by callers of this adapter, not by this adapter itself.
   */
  async createProfile(name: string): Promise<SolariProfile> {
    this.assertActivated();
    if (name.trim().length === 0) {
      throw new ValidationError('createProfile requires a non-empty name');
    }
    const response = await this.#client().request(
      { method: 'POST', path: profileCreatePath(), operation: 'profiles.create', body: { name } },
      SolariProfile,
    );
    return response.body;
  }
}
