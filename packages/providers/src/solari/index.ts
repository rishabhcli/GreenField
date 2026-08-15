/**
 * Solari (by Pinetree Research) adapter — cloud browsers, sandboxes and full
 * GUI computers, used for compliant public-web research and supplier
 * discovery where no API exists.
 *
 * Written against the raw HTTP surface documented at docs.getsolari.com
 * (verified 2026-08-14; see `docs/research/SPONSOR_API_RESEARCH.md` §12 —
 * that document is the authority this file is written against). There is no
 * webhook surface for Solari ("No webhooks found" per the research pass), so
 * unlike Stripe/Terac/Whop there is no `events.ts`/`verifyWebhook` here.
 *
 * Two things this adapter refuses to fake, both called out explicitly in the
 * build brief:
 *
 *  1. `GET /sessions/:id` is documented as "always returns 404 in practice;
 *     route is non-functional." `getSessionStatus` below throws instead of
 *     polling a route the vendor has told us is dead. Solari has no webhook
 *     mechanism either, so there is no async completion signal to wait for —
 *     browser/desktop sessions are driven synchronously over the returned
 *     `wsEndpoint`/`cdpEndpoint`/`streamUrl`, and the only genuine
 *     post-creation read is `getReplayUrl` once a *recorded* session has
 *     ended.
 *  2. Human takeover (two-way control over `ws/observe` or the VNC `stream`)
 *     is UNVERIFIED — the docs describe both only as observation/embedding
 *     mechanisms and never state whether either accepts input.
 *     `requestHumanTakeover` throws rather than implying this works; the
 *     sourcing workflow's human-escalation path goes through Terac's expert
 *     marketplace instead (see `../terac`).
 */

import { CapabilityUnsupportedError, LONG_RUNNING_RETRY, ProviderContractError, ValidationError, toFoundryError } from '@foundry/core';
import { getLogger } from '@foundry/obs';
import { ProviderAdapter, type AdapterContext, type ProbeResult } from '../http/adapter.js';
import { bearerAuth, newIdempotencyToken, type ProviderHttpClient } from '../http/client.js';
import { SECRETS, SOLARI_MANIFEST } from '../manifests.js';
import {
  SolariBrowserSession,
  SolariDesktop,
  SolariExecResult,
  SolariProfile,
  SolariReplayUrlResponse,
  SolariSandbox,
  SolariSandboxMetrics,
  SolariSnapshot,
} from './schemas.js';

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
 * `POST /sandboxes/:id/exec` has no documented request shape at all. `command`
 * is required here because every comparable sandbox-exec API surveyed in this
 * research pass (Sandbox0's `POST /contexts/{id}/exec`, Superserve's
 * `POST /exec`) names exactly that field — treated as the single safe minimum
 * inference, not a confirmed Solari contract. Extra caller-supplied fields
 * pass through verbatim since we do not know what else the real API accepts.
 */
export interface ExecInSandboxInput {
  readonly command: string;
  readonly [extra: string]: unknown;
}

/* -------------------------------------------------------------------------- */
/* Adapter                                                                     */
/* -------------------------------------------------------------------------- */

export class SolariAdapter extends ProviderAdapter {
  override readonly manifest = SOLARI_MANIFEST;

  constructor(ctx: AdapterContext) {
    super(ctx);
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
    });
  }

  /* ---------------------------------------------------------------------- */
  /* Probe                                                                   */
  /* ---------------------------------------------------------------------- */

  /**
   * `GET /health`/`GET /healthz` are documented as unauthenticated, so success
   * there proves only that the API is up, not that the credential works. No
   * authenticated non-destructive read is directly confirmed for Solari:
   * session status is dead (404), and every other documented GET requires an
   * id we would have to pay to create first — which a probe must never do.
   *
   * This attempts `GET /sandboxes?limit=1` as the credential-exercising step,
   * matching this provider's own manifest `liveProbe.description`. That is a
   * deliberate, flagged inference: the research pass confirmed `POST
   * /sandboxes` (create) for Solari but never showed a `GET /sandboxes` list
   * route the way it did for Superserve and Sandbox0 (`POST/GET /sandboxes`
   * explicitly). If the route does not really exist, this call fails with a
   * non-2xx status or a thrown error below, and that failure is reported
   * honestly as `succeeded: false` — it never fabricates a success.
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
      const response = await client.raw({
        method: 'GET',
        path: '/sandboxes',
        query: { limit: 1 },
        operation: 'sandboxes.list.probe',
        retryable: false,
      });
      if (response.status >= 200 && response.status < 300) {
        return {
          succeeded: true,
          detail: 'GET /health succeeded and GET /sandboxes?limit=1 was accepted by the API with the configured credential',
          evidence: { endpoint: 'GET /sandboxes?limit=1', status: response.status, healthStatus: health.status },
        };
      }
      return {
        succeeded: false,
        detail:
          `GET /health succeeded but GET /sandboxes?limit=1 returned HTTP ${response.status}. This could mean the ` +
          'credential is invalid, or that this list endpoint does not exist for Solari (only POST /sandboxes is ' +
          "directly documented) — the probe cannot tell those apart, so this reports unverifiable rather than " +
          'asserting either one.',
        evidence: { endpoint: 'GET /sandboxes?limit=1', status: response.status, healthStatus: health.status },
      };
    } catch (error) {
      const foundry = toFoundryError(error);
      return {
        succeeded: false,
        detail:
          `GET /health succeeded but GET /sandboxes?limit=1 failed: ${foundry.message}. See the code comment on ` +
          'SolariAdapter.probe() — this list endpoint is a documented-by-inference guess for Solari, not a ' +
          'directly confirmed route.',
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

  /** `DELETE /sessions/:id` → 204, documented. */
  async deleteSession(sessionId: string): Promise<void> {
    this.assertActivated();
    await this.#client().raw({
      method: 'DELETE',
      path: `/sessions/${encodeURIComponent(sessionId)}`,
      operation: 'sessions.delete',
    });
  }

  /**
   * There is no working status-poll for a Solari browser session.
   *
   * Docs state `GET /sessions/:id` "always returns 404 in practice; route is
   * non-functional." This throws immediately — no HTTP call is made — so a
   * caller reaching for the obvious method name gets a clear, typed refusal
   * instead of a confusing live 404, and so nothing in this codebase is
   * tempted to build a polling loop against a route the vendor has told us is
   * dead. Session state must be tracked locally by whichever service created
   * the session; the only genuine read available after creation is
   * `getReplayUrl`, once the session has ended and recording was enabled.
   */
  getSessionStatus(_sessionId: string): never {
    throw new CapabilityUnsupportedError(
      'solari',
      'research.browser_session.status_poll',
      'GET /sessions/:id is documented as always returning 404 in practice (route is non-functional; verified ' +
        'against docs.getsolari.com/api-reference/browser on 2026-08-14). Solari has no webhook mechanism either, ' +
        'so there is no async completion event to subscribe to instead. Track session state locally from the ' +
        'POST /sessions response, and use getReplayUrl() once a recorded session has ended.',
    );
  }

  /**
   * The only genuine post-creation read: the recording replay, once the
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
    getLogger().info({ sandboxId: response.body.sandboxId }, 'solari sandbox created');
    return response.body;
  }

  /**
   * `POST /sandboxes/:id/exec` — request/response shapes are both UNVERIFIED
   * for Solari (see `ExecInSandboxInput` and `SolariExecResult`). The response
   * is returned to the caller unshaped rather than destructured into invented
   * fields like `stdout`/`exitCode`, which would misrepresent confidence we
   * do not have.
   */
  async execInSandbox(sandboxId: string, input: ExecInSandboxInput): Promise<SolariExecResult> {
    this.assertActivated();
    if (input.command.trim().length === 0) {
      throw new ValidationError('execInSandbox requires a non-empty command', { sandboxId });
    }
    const response = await this.#client().request(
      {
        method: 'POST',
        path: `/sandboxes/${encodeURIComponent(sandboxId)}/exec`,
        operation: 'sandboxes.exec',
        body: input,
      },
      SolariExecResult,
    );
    return response.body;
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

  async createDesktop(input: CreateDesktopInput = {}): Promise<SolariDesktop> {
    this.assertActivated();
    const response = await this.#client().request(
      {
        method: 'POST',
        path: '/desktops',
        operation: 'desktops.create',
        idempotencyKey: input.idempotencyKey ?? newIdempotencyToken(),
        body: { ...(input.metadata ? { metadata: input.metadata } : {}) },
      },
      SolariDesktop,
    );
    getLogger().info({ desktopId: response.body.sessionId }, 'solari desktop created');
    return response.body;
  }

  /**
   * Unlike browser sessions, `GET /desktops/:id` is documented as a real,
   * working route (no "always 404" caveat is stated for desktops).
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
