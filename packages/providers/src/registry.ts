/**
 * Provider registry: the single place the rest of the system asks for an
 * adapter, and the bridge between adapters and the capability registry.
 *
 * Adapters are constructed lazily and memoised. Asking for an adapter whose
 * credentials are missing still returns the adapter — the call it makes will
 * throw a typed `CredentialsMissingError` with setup instructions, which is the
 * honest behaviour. What the registry will not do is silently substitute a
 * stub, return canned data, or report the capability as working.
 */

import {
  CapabilityRegistry,
  type Capability,
  type CapabilityStatus,
  type ProviderId,
  type ProviderManifest,
  type SecretStore,
  type VerificationLookup,
  type VerificationRecord,
} from '@foundry/core';
import { getLogger, metrics } from '@foundry/obs';
import type { AdapterContext, ProbeResult, ProviderAdapter } from './http/adapter.js';
import { ALL_MANIFESTS } from './manifests.js';

export type AdapterFactory = (ctx: AdapterContext) => ProviderAdapter;

export interface ProviderRegistryOptions {
  readonly context: AdapterContext;
  readonly factories: Partial<Record<ProviderId, AdapterFactory>>;
  readonly manifests?: readonly ProviderManifest[];
  readonly verifications?: VerificationLookup;
  readonly disabledProviders?: ReadonlySet<ProviderId>;
}

export class ProviderRegistry {
  readonly capabilities: CapabilityRegistry;
  readonly #factories: Partial<Record<ProviderId, AdapterFactory>>;
  readonly #context: AdapterContext;
  readonly #instances = new Map<ProviderId, ProviderAdapter>();
  readonly #manifests: readonly ProviderManifest[];

  constructor(options: ProviderRegistryOptions) {
    this.#context = options.context;
    this.#factories = options.factories;
    this.#manifests = options.manifests ?? ALL_MANIFESTS;
    this.capabilities = new CapabilityRegistry({
      manifests: this.#manifests,
      secrets: options.context.secrets,
      verifications: options.verifications,
      disabledProviders: options.disabledProviders,
    });
  }

  /** Adapter for a provider, or undefined when no adapter is implemented. */
  adapter(provider: ProviderId): ProviderAdapter | undefined {
    const existing = this.#instances.get(provider);
    if (existing) return existing;
    const factory = this.#factories[provider];
    if (!factory) return undefined;
    const created = factory(this.#context);
    this.#instances.set(provider, created);
    return created;
  }

  /** Typed accessor so callers keep their concrete adapter type. */
  require<T extends ProviderAdapter>(provider: ProviderId): T {
    const adapter = this.adapter(provider);
    if (!adapter) {
      throw new Error(
        `No adapter is registered for provider "${provider}". Register a factory in the provider registry.`,
      );
    }
    return adapter as T;
  }

  /**
   * Resolves a capability to the adapter that should serve it right now,
   * returning the honest status when nothing can.
   */
  forCapability(capability: Capability): { status: CapabilityStatus; adapter: ProviderAdapter | undefined } {
    const status = this.capabilities.resolveCapability(capability);
    if (!status.provider || !status.usable) return { status, adapter: undefined };
    return { status, adapter: this.adapter(status.provider) };
  }

  registeredProviders(): readonly ProviderId[] {
    return this.#manifests.map((m) => m.id).filter((id) => this.#factories[id] !== undefined);
  }

  /** Providers with a manifest but no adapter — a gap, reported not hidden. */
  unimplementedProviders(): readonly ProviderId[] {
    return this.#manifests.map((m) => m.id).filter((id) => this.#factories[id] === undefined);
  }

  /**
   * Runs every provider's non-destructive live probe. This is the only path
   * that produces verification records, and it is invoked by the verification
   * harness and the scheduled readiness job — never by application code trying
   * to mark itself healthy.
   */
  async probeAll(only?: readonly ProviderId[]): Promise<readonly VerificationRecord[]> {
    const targets = (only ?? this.registeredProviders()).filter((id) => this.#factories[id] !== undefined);
    const results = await Promise.all(
      targets.map(async (provider): Promise<VerificationRecord> => {
        const adapter = this.adapter(provider)!;
        const result: ProbeResult = await adapter.safeProbe();
        getLogger().info(
          { provider, succeeded: result.succeeded, detail: result.detail },
          'provider live probe',
        );
        return {
          provider,
          capability: null,
          succeeded: result.succeeded,
          checkedAt: new Date(),
          detail: result.detail,
          evidence: result.evidence,
        };
      }),
    );
    return results;
  }

  /** Publishes capability usability to metrics so blocked capabilities are visible. */
  publishCapabilityMetrics(): void {
    for (const status of this.capabilities.allCapabilityStatuses()) {
      metrics.capabilityState.set(status.usable ? 1 : 0, {
        capability: status.capability,
        provider: status.provider ?? 'none',
        state: status.state,
      });
    }
  }
}

/** In-memory verification lookup built from the rows the harness persisted. */
export class MapVerificationLookup implements VerificationLookup {
  readonly #byProvider = new Map<ProviderId, VerificationRecord>();

  constructor(records: readonly VerificationRecord[] = []) {
    for (const record of records) this.put(record);
  }

  put(record: VerificationRecord): void {
    const existing = this.#byProvider.get(record.provider);
    if (!existing || existing.checkedAt <= record.checkedAt) {
      this.#byProvider.set(record.provider, record);
    }
  }

  latest(provider: ProviderId): VerificationRecord | undefined {
    return this.#byProvider.get(provider);
  }
}

export type { AdapterContext, ProbeResult, ProviderAdapter };
