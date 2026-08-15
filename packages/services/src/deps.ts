/**
 * The dependency surface every service is built on.
 *
 * Services take this explicitly rather than reaching for a global, so each one
 * can be constructed in a test against a real database with a chosen set of
 * adapters, and so the composition root is the single place that decides what
 * the system is made of.
 *
 * Note what is *not* here: no HTTP client, no direct SDK, no environment
 * access. A service that wants to talk to a provider goes through
 * `providers.forCapability(...)`, which is the only path that consults the
 * capability registry — and therefore the only path that can refuse to run
 * because a credential is missing or a probe has never succeeded.
 */

import type { Capability, CapabilityRegistry, CapabilityStatus } from '@foundry/core';
import { CapabilityUnsupportedError, CredentialsMissingError } from '@foundry/core';
import type { Repositories } from '@foundry/db';
import type { ProviderRegistry } from '@foundry/providers';
import type { QueueSet } from '@foundry/queue';
import type { AgentExecutor, OrgDispatcher, PolicyGate } from '@foundry/agents';

export interface ServiceDeps {
  readonly repos: Repositories;
  readonly providers: ProviderRegistry;
  readonly capabilities: CapabilityRegistry;
  readonly queues: QueueSet;
  readonly gate: PolicyGate;
  readonly executor: AgentExecutor;
  readonly dispatcher: OrgDispatcher;
  /** Externally reachable base URL; webhook and return URLs are built from it. */
  readonly publicBaseUrl: string;
  readonly environment: 'production' | 'staging' | 'preview';
  /**
   * Render service id hosting the generated storefront, when configured.
   * Copied onto the site row; never invented.
   */
  readonly renderStorefrontServiceId?: string;
}

/**
 * Resolves the adapter behind a capability, or throws with the specific reason
 * it is unavailable.
 *
 * The thrown error is deliberately precise. "Checkout failed" tells an operator
 * nothing; "STRIPE_SECRET_KEY is not set, obtain it from the Stripe dashboard"
 * tells them exactly what to do. Every service uses this rather than reaching
 * into the registry directly, so the failure message is consistent everywhere.
 */
export function requireCapability<T>(deps: ServiceDeps, capability: Capability): { adapter: T; status: CapabilityStatus } {
  const resolved = deps.providers.forCapability(capability);
  if (!resolved.adapter) {
    const { status } = resolved;
    const detail = status.remediation ?? `capability state is ${status.state}`;
    const provider = status.provider ?? 'none';
    if (status.state === 'blocked_missing_credentials' || status.state === 'blocked_malformed_credentials') {
      throw new CredentialsMissingError(provider, status.missingSecrets, detail);
    }
    throw new CapabilityUnsupportedError(provider, capability, detail);
  }
  return { adapter: resolved.adapter as T, status: resolved.status };
}

/**
 * Non-throwing variant, for the places where a missing capability is a normal
 * branch rather than an error — a marketing loop with one of two ad platforms
 * connected should run on the one it has, not fail.
 */
export function optionalCapability<T>(deps: ServiceDeps, capability: Capability): T | undefined {
  return deps.providers.forCapability(capability).adapter as T | undefined;
}

/** Result shape every service operation returns, so the worker can log uniformly. */
export interface ServiceOutcome<T> {
  readonly ok: boolean;
  readonly data?: T;
  /** Set when the operation could not run; names the capability that blocked it. */
  readonly blockedOn?: { capability: Capability; reason: string };
}
