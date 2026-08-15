/**
 * Base class for every provider adapter.
 *
 * It enforces the two rules that make the integration layer honest:
 *   1. Credentials are resolved lazily, per call, through the secret store —
 *      so a missing key produces a typed `CredentialsMissingError` naming the
 *      exact variable, and never a fabricated value or a skipped call.
 *   2. Every adapter must implement `probe()`, a documented non-destructive
 *      call whose success is the *only* thing that can move a capability to
 *      `live_verified`. Nothing else may set that flag.
 */

import {
  CircuitBreaker,
  CredentialsMissingError,
  Secret,
  SecretStore,
  assertModeMatchesEnvironment,
  toFoundryError,
  type DeploymentEnvironment,
  type ProviderId,
  type ProviderManifest,
  type SecretSpec,
} from '@foundry/core';
import { ProviderHttpClient, type AuthApplier, type ProviderHttpClientOptions } from './client.js';
import { limiterFor } from './rate-limit.js';

export interface ProbeResult {
  readonly succeeded: boolean;
  readonly detail: string;
  /** HTTP status, returned ids, latency — the record of what actually happened. */
  readonly evidence: Readonly<Record<string, unknown>>;
}

export interface AdapterContext {
  readonly secrets: SecretStore;
  readonly environment: DeploymentEnvironment;
  /** Public base URL of this deployment, used to construct webhook URLs. */
  readonly publicBaseUrl: string;
}

export abstract class ProviderAdapter {
  abstract readonly manifest: ProviderManifest;
  protected readonly ctx: AdapterContext;
  readonly #breaker: CircuitBreaker;
  #client: ProviderHttpClient | undefined;

  constructor(ctx: AdapterContext) {
    this.ctx = ctx;
    this.#breaker = new CircuitBreaker(this.constructor.name);
  }

  get provider(): ProviderId {
    return this.manifest.id;
  }

  /** True when every required secret is present and well-formed. */
  get isConfigured(): boolean {
    const resolution = this.ctx.secrets.resolve(this.manifest.secrets);
    return resolution.missingRequired.length === 0 && resolution.malformed.length === 0;
  }

  /** Names of the required environment variables that are not set. */
  get missingSecrets(): readonly string[] {
    return this.ctx.secrets.resolve(this.manifest.secrets).missingRequired;
  }

  /**
   * Resolves a required secret, throwing the actionable error when absent, and
   * refusing to proceed when a test key is loaded in production or vice versa.
   */
  protected requireSecret(spec: SecretSpec): Secret {
    const secret = this.ctx.secrets.tryGet(spec);
    if (!secret) {
      throw new CredentialsMissingError(this.provider, [spec.env], spec.obtainFrom);
    }
    assertModeMatchesEnvironment(this.provider, secret.mode, this.ctx.environment);
    return secret;
  }

  protected optionalSecret(spec: SecretSpec): Secret | undefined {
    return this.ctx.secrets.tryGet(spec);
  }

  /** Guard placed at the top of every public adapter method. */
  protected assertActivated(): void {
    const resolution = this.ctx.secrets.resolve(this.manifest.secrets);
    if (resolution.missingRequired.length > 0) {
      throw new CredentialsMissingError(
        this.provider,
        resolution.missingRequired,
        this.manifest.secrets[0]?.obtainFrom,
      );
    }
  }

  /** Base URL for the current environment, honouring provider test hosts. */
  protected baseUrl(): string {
    const { production, test } = this.manifest.baseUrls;
    const chosen = this.ctx.environment === 'production' ? production : (test ?? production);
    if (!chosen) {
      throw new Error(`Provider ${this.provider} has no base URL configured for ${this.ctx.environment}`);
    }
    return chosen;
  }

  /** Memoised HTTP client wired with this provider's limiter and breaker. */
  protected http(
    auth: AuthApplier,
    overrides: Partial<Omit<ProviderHttpClientOptions, 'provider' | 'auth'>> = {},
  ): ProviderHttpClient {
    if (!this.#client) {
      this.#client = new ProviderHttpClient({
        provider: this.provider,
        baseUrl: overrides.baseUrl ?? this.baseUrl(),
        auth,
        breaker: this.#breaker,
        rateLimiter: limiterFor(this.provider),
        defaultTimeoutMs: 30_000,
        ...overrides,
      });
    }
    return this.#client;
  }

  /** Discards the memoised client so a rotated secret or base URL takes effect. */
  protected resetClient(): void {
    this.#client = undefined;
  }

  /** Webhook URL this deployment exposes for the provider, if it has one. */
  webhookUrl(path?: string): string | null {
    const spec = this.manifest.webhooks?.[0];
    const chosen = path ?? spec?.path;
    if (!chosen) return null;
    return new URL(chosen, this.ctx.publicBaseUrl).toString();
  }

  /**
   * A read-only call against the live service that proves the credential works.
   * Must never create, modify or delete anything.
   */
  abstract probe(): Promise<ProbeResult>;

  /** Wraps `probe()` so an unconfigured provider reports honestly, not crashes. */
  async safeProbe(): Promise<ProbeResult> {
    if (!this.isConfigured) {
      return {
        succeeded: false,
        detail: `not activated: missing ${this.missingSecrets.join(', ')}`,
        evidence: { missingSecrets: this.missingSecrets, reason: 'credentials_missing' },
      };
    }
    const startedAt = Date.now();
    try {
      const result = await this.probe();
      return { ...result, evidence: { ...result.evidence, latencyMs: Date.now() - startedAt } };
    } catch (error) {
      const foundry = toFoundryError(error);
      return {
        succeeded: false,
        detail: foundry.message,
        evidence: {
          code: foundry.code,
          category: foundry.category,
          latencyMs: Date.now() - startedAt,
          ...foundry.context,
        },
      };
    }
  }
}
