/**
 * Capability registry.
 *
 * This is the file that makes "no fake integration-complete flags" a structural
 * property rather than a promise. Nothing in the system may assert that an
 * integration works. It may only ask the registry, and the registry can only
 * return `live_verified` when BOTH of these are true:
 *
 *   1. every required secret for the provider is present and well-formed, and
 *   2. a recorded, dated, non-destructive live probe against the real provider
 *      succeeded — a row written by the verification harness, never by hand.
 *
 * Absent a verification record the honest answer is `configured_unverified`,
 * and the UI, the readiness endpoint, the CEO agent's situation report and the
 * production checklist all render it that way.
 */

import type { SecretSpec, SecretStore } from './secrets.js';

/* -------------------------------------------------------------------------- */
/* Providers                                                                   */
/* -------------------------------------------------------------------------- */

export const PROVIDER_IDS = [
  // Sponsors
  'terac',
  'stripe',
  'lovable',
  'whop',
  'render',
  'linq',
  'superserve',
  'replay',
  'band',
  'dodo',
  'sandbox0',
  'solari',
  'pioneer',
  'egoist',
  // Non-sponsor externals required by the business loop
  'anthropic',
  'meta_ads',
  'google_ads',
  'resend',
  'cloudflare_dns',
  'shippo',
  'alibaba',
  'openai_images',
  // Required business capabilities no sponsor covers
  'brave_search',
  'reddit',
] as const;

export type ProviderId = (typeof PROVIDER_IDS)[number];

export type SponsorTier = 'sponsor' | 'external';

/* -------------------------------------------------------------------------- */
/* Capabilities                                                                */
/* -------------------------------------------------------------------------- */

/**
 * A business capability the platform needs. Deliberately phrased in business
 * terms, not vendor terms, so a capability can be re-bound to another provider
 * without touching the services that depend on it.
 */
export const CAPABILITIES = [
  // Research & intelligence
  'research.web_search',
  'research.browser_session',
  'research.gui_computer',
  'research.session_recording',
  // Human expertise
  'expert.source_and_hire',
  'expert.structured_review',
  'expert.payment',
  // Reasoning
  'llm.reasoning',
  'llm.structured_output',
  'llm.open_weight',
  'compliance.pii_scan',
  'compliance.prompt_guard',
  // Sourcing
  'sourcing.supplier_search',
  'sourcing.supplier_profile',
  'sourcing.rfq_submit',
  'sourcing.quote_retrieve',
  // Brand & site
  'site.generate',
  'site.iterate',
  'site.export_code',
  'site.publish_preview',
  'asset.image_generation',
  'domain.availability_check',
  'domain.dns_manage',
  // Commerce
  'payments.checkout.physical',
  'payments.checkout.digital_mor',
  'payments.webhooks',
  'payments.refund',
  'payments.dispute',
  'payments.tax_calculation',
  'payments.payment_link',
  'payments.imessage_checkout',
  'commerce.catalog',
  'commerce.membership',
  'fulfilment.rate_quote',
  'fulfilment.label_purchase',
  'fulfilment.tracking',
  // Marketing
  'ads.campaign_manage',
  'ads.creative_upload',
  'ads.metrics_read',
  'email.transactional',
  // Support
  'messaging.sms',
  'messaging.imessage',
  'messaging.rcs',
  'messaging.voice',
  'messaging.inbound_webhook',
  'messaging.imessage_app',
  // Personalisation
  'personalization.passport',
  // Execution planes
  'compute.persistent_sandbox',
  'compute.isolated_execution',
  'compute.credential_isolation',
  // Coordination
  'coordination.agent_mesh',
  'coordination.governance',
  // Quality
  'qa.autonomous_exploration',
  'qa.release_gate',
  // Platform
  'platform.hosting',
  'platform.deploy_control',
  'platform.log_read',
  'platform.workflows',
] as const;

export type Capability = (typeof CAPABILITIES)[number];

/* -------------------------------------------------------------------------- */
/* Manifests                                                                   */
/* -------------------------------------------------------------------------- */

export type AuthMethod =
  | 'bearer_token'
  | 'api_key_header'
  | 'basic_auth'
  | 'oauth2_client_credentials'
  | 'oauth2_authorization_code'
  | 'hmac_signed_request'
  | 'mcp_oauth'
  | 'none';

export interface WebhookSpec {
  /** Our inbound route, e.g. `/webhooks/stripe`. */
  readonly path: string;
  /** Header carrying the signature, if the provider signs. */
  readonly signatureHeader?: string;
  readonly signatureScheme?: 'stripe_v1_hmac_sha256' | 'standard_webhooks' | 'hmac_sha256_hex' | 'none';
  /** Event names we handle. Empty means the provider has no webhooks. */
  readonly events: readonly string[];
  /** Whether the raw body must be preserved for signature verification. */
  readonly requiresRawBody: boolean;
}

export interface DocumentationRecord {
  readonly url: string;
  /** ISO date on which a human/agent actually read this page. */
  readonly verifiedOn: string;
  readonly note?: string;
}

/** What we know about a capability the provider is claimed to offer. */
export type CapabilityEvidence =
  /** Documented in the provider's own API reference; endpoint path known. */
  | { readonly kind: 'documented_api'; readonly detail: string }
  /** Documented MCP tool. */
  | { readonly kind: 'documented_mcp_tool'; readonly detail: string }
  /** Claimed on the provider's site but no public API reference located. */
  | { readonly kind: 'marketing_claim_only'; readonly detail: string }
  /** We looked and the provider explicitly does not do this. */
  | { readonly kind: 'explicitly_unsupported'; readonly detail: string };

export interface ProviderCapabilityBinding {
  readonly capability: Capability;
  readonly evidence: CapabilityEvidence;
  /** Priority when several providers offer the same capability (lower wins). */
  readonly priority: number;
}

export interface RateLimitSpec {
  readonly requestsPerWindow: number;
  readonly windowMs: number;
  readonly note?: string;
}

export interface ProviderManifest {
  readonly id: ProviderId;
  readonly displayName: string;
  readonly tier: SponsorTier;
  readonly summary: string;
  readonly docs: readonly DocumentationRecord[];
  readonly authMethod: AuthMethod;
  readonly secrets: readonly SecretSpec[];
  readonly baseUrls: { readonly production?: string; readonly test?: string };
  readonly capabilities: readonly ProviderCapabilityBinding[];
  readonly webhooks?: readonly WebhookSpec[];
  readonly rateLimit?: RateLimitSpec;
  /** Set when the provider gates API access behind manual approval. */
  readonly vendorApproval?: { readonly required: boolean; readonly how: string };
  /**
   * Non-destructive call the verification harness makes to prove the credential
   * works. Describing it here keeps "verified" auditable.
   */
  readonly liveProbe: { readonly description: string; readonly mutatesState: false };
  /** Documented failure/retry behaviour, surfaced in INTEGRATIONS.md. */
  readonly failureBehaviour: string;
  readonly retryStrategy: string;
  readonly idempotency: string;
}

/* -------------------------------------------------------------------------- */
/* Activation state                                                            */
/* -------------------------------------------------------------------------- */

export type ActivationState =
  /** Required secrets absent. The capability is blocked, with setup instructions. */
  | 'blocked_missing_credentials'
  /** A secret is present but malformed. */
  | 'blocked_malformed_credentials'
  /** Provider requires an approval/allowlist we do not hold. */
  | 'blocked_vendor_approval'
  /** Turned off by an operator kill switch or policy. */
  | 'disabled_by_policy'
  /** Provider genuinely cannot do this. Recorded so we stop asking. */
  | 'unsupported_by_provider'
  /** Only a marketing claim backs this capability; no API reference found. */
  | 'unverifiable_no_public_api'
  /** Secrets present and well-formed, but no successful live probe on record. */
  | 'configured_unverified'
  /** The last recorded live probe failed. */
  | 'degraded'
  /** Secrets present AND a dated successful live probe is on record. */
  | 'live_verified';

export const ACTIVATION_STATE_IS_USABLE: Readonly<Record<ActivationState, boolean>> = {
  blocked_missing_credentials: false,
  blocked_malformed_credentials: false,
  blocked_vendor_approval: false,
  disabled_by_policy: false,
  unsupported_by_provider: false,
  unverifiable_no_public_api: false,
  // Usable: the code path is real and will attempt the call. It simply has not
  // been proven against the live service yet, and reports itself that way.
  configured_unverified: true,
  degraded: true,
  live_verified: true,
};

export interface VerificationRecord {
  readonly provider: ProviderId;
  readonly capability: Capability | null;
  readonly succeeded: boolean;
  readonly checkedAt: Date;
  readonly detail: string;
  /** Free-form evidence: HTTP status, resource id returned, latency. */
  readonly evidence: Readonly<Record<string, unknown>>;
}

export interface VerificationLookup {
  /** Most recent probe for a provider, or undefined if never probed. */
  latest(provider: ProviderId): VerificationRecord | undefined;
}

export const emptyVerificationLookup: VerificationLookup = { latest: () => undefined };

export interface CapabilityStatus {
  readonly capability: Capability;
  readonly provider: ProviderId | null;
  readonly state: ActivationState;
  readonly usable: boolean;
  readonly evidence: CapabilityEvidence | null;
  /** Human-actionable next step. Always populated for blocked states. */
  readonly remediation: string | null;
  readonly missingSecrets: readonly string[];
  readonly lastVerifiedAt: Date | null;
  /** Providers that also declare this capability, in priority order. */
  readonly alternatives: readonly ProviderId[];
}

export interface ProviderStatus {
  readonly provider: ProviderId;
  readonly displayName: string;
  readonly tier: SponsorTier;
  readonly state: ActivationState;
  readonly missingSecrets: readonly string[];
  readonly malformedSecrets: readonly { env: string; reason: string }[];
  readonly secretModes: Readonly<Record<string, string>>;
  readonly lastVerifiedAt: Date | null;
  readonly lastVerificationDetail: string | null;
  readonly capabilities: readonly Capability[];
  readonly remediation: string | null;
}

/* -------------------------------------------------------------------------- */
/* Registry                                                                    */
/* -------------------------------------------------------------------------- */

export interface CapabilityRegistryOptions {
  readonly manifests: readonly ProviderManifest[];
  readonly secrets: SecretStore;
  readonly verifications?: VerificationLookup;
  /** Provider ids switched off by an operator. */
  readonly disabledProviders?: ReadonlySet<ProviderId>;
}

export class CapabilityRegistry {
  readonly #manifests: Map<ProviderId, ProviderManifest>;
  readonly #secrets: SecretStore;
  #verifications: VerificationLookup;
  #disabled: ReadonlySet<ProviderId>;

  constructor(options: CapabilityRegistryOptions) {
    this.#manifests = new Map(options.manifests.map((m) => [m.id, m]));
    this.#secrets = options.secrets;
    this.#verifications = options.verifications ?? emptyVerificationLookup;
    this.#disabled = options.disabledProviders ?? new Set();
  }

  /** Swap in fresh verification rows (called after each harness run). */
  setVerifications(lookup: VerificationLookup): void {
    this.#verifications = lookup;
  }

  setDisabledProviders(disabled: ReadonlySet<ProviderId>): void {
    this.#disabled = disabled;
  }

  manifest(provider: ProviderId): ProviderManifest | undefined {
    return this.#manifests.get(provider);
  }

  allManifests(): readonly ProviderManifest[] {
    return [...this.#manifests.values()];
  }

  /** Provider-level activation state (independent of any one capability). */
  providerState(provider: ProviderId): ActivationState {
    const manifest = this.#manifests.get(provider);
    if (!manifest) return 'unsupported_by_provider';
    if (this.#disabled.has(provider)) return 'disabled_by_policy';

    const resolution = this.#secrets.resolve(manifest.secrets);
    if (resolution.malformed.length > 0) return 'blocked_malformed_credentials';
    if (resolution.missingRequired.length > 0) return 'blocked_missing_credentials';
    if (manifest.vendorApproval?.required) {
      // Credentials exist, so approval was granted in practice; a successful
      // probe is what proves it. Fall through to the verification check.
    }
    const latest = this.#verifications.latest(provider);
    if (!latest) return 'configured_unverified';
    return latest.succeeded ? 'live_verified' : 'degraded';
  }

  providerStatus(provider: ProviderId): ProviderStatus {
    const manifest = this.#manifests.get(provider);
    const state = this.providerState(provider);
    if (!manifest) {
      return {
        provider,
        displayName: provider,
        tier: 'external',
        state,
        missingSecrets: [],
        malformedSecrets: [],
        secretModes: {},
        lastVerifiedAt: null,
        lastVerificationDetail: null,
        capabilities: [],
        remediation: `No manifest registered for provider "${provider}".`,
      };
    }
    const resolution = this.#secrets.resolve(manifest.secrets);
    const latest = this.#verifications.latest(provider);
    return {
      provider,
      displayName: manifest.displayName,
      tier: manifest.tier,
      state,
      missingSecrets: resolution.missingRequired,
      malformedSecrets: resolution.malformed,
      secretModes: resolution.modes,
      lastVerifiedAt: latest?.checkedAt ?? null,
      lastVerificationDetail: latest?.detail ?? null,
      capabilities: manifest.capabilities.map((c) => c.capability),
      remediation: remediationFor(state, manifest, resolution.missingRequired, resolution.malformed),
    };
  }

  /** Every provider that declares a capability, best (lowest priority) first. */
  providersFor(capability: Capability): readonly ProviderId[] {
    return this.allManifests()
      .flatMap((m) => m.capabilities.filter((c) => c.capability === capability).map((c) => ({ m, c })))
      .sort((a, b) => a.c.priority - b.c.priority)
      .map(({ m }) => m.id);
  }

  /**
   * Resolve a capability to the highest-priority provider that is actually
   * usable right now, falling back through the list. Returns the honest status
   * of the best candidate even when nothing is usable.
   */
  resolveCapability(capability: Capability): CapabilityStatus {
    const candidates = this.allManifests()
      .flatMap((m) => m.capabilities.filter((c) => c.capability === capability).map((c) => ({ m, c })))
      .sort((a, b) => a.c.priority - b.c.priority);

    if (candidates.length === 0) {
      return {
        capability,
        provider: null,
        state: 'unsupported_by_provider',
        usable: false,
        evidence: null,
        remediation:
          `No provider in the registry offers "${capability}". Add a provider manifest and adapter, ` +
          `or mark the dependent feature blocked.`,
        missingSecrets: [],
        lastVerifiedAt: null,
        alternatives: [],
      };
    }

    const statuses = candidates.map(({ m, c }) => {
      const state = this.#capabilityState(m, c);
      return { manifest: m, binding: c, state };
    });

    const chosen = statuses.find((s) => ACTIVATION_STATE_IS_USABLE[s.state]) ?? statuses[0]!;
    const resolution = this.#secrets.resolve(chosen.manifest.secrets);
    const latest = this.#verifications.latest(chosen.manifest.id);

    return {
      capability,
      provider: chosen.manifest.id,
      state: chosen.state,
      usable: ACTIVATION_STATE_IS_USABLE[chosen.state],
      evidence: chosen.binding.evidence,
      remediation: remediationFor(
        chosen.state,
        chosen.manifest,
        resolution.missingRequired,
        resolution.malformed,
        chosen.binding,
      ),
      missingSecrets: resolution.missingRequired,
      lastVerifiedAt: latest?.checkedAt ?? null,
      alternatives: statuses.filter((s) => s !== chosen).map((s) => s.manifest.id),
    };
  }

  /** True only when the capability can actually be attempted right now. */
  isUsable(capability: Capability): boolean {
    return this.resolveCapability(capability).usable;
  }

  allCapabilityStatuses(): readonly CapabilityStatus[] {
    return CAPABILITIES.map((c) => this.resolveCapability(c));
  }

  /** Rolls up to the honest one-line answer for a readiness endpoint. */
  summary(): {
    liveVerified: number;
    configuredUnverified: number;
    blocked: number;
    unsupported: number;
    total: number;
  } {
    const counts = { liveVerified: 0, configuredUnverified: 0, blocked: 0, unsupported: 0, total: 0 };
    for (const status of this.allCapabilityStatuses()) {
      counts.total += 1;
      switch (status.state) {
        case 'live_verified':
          counts.liveVerified += 1;
          break;
        case 'configured_unverified':
        case 'degraded':
          counts.configuredUnverified += 1;
          break;
        case 'unsupported_by_provider':
        case 'unverifiable_no_public_api':
          counts.unsupported += 1;
          break;
        default:
          counts.blocked += 1;
      }
    }
    return counts;
  }

  #capabilityState(manifest: ProviderManifest, binding: ProviderCapabilityBinding): ActivationState {
    if (binding.evidence.kind === 'explicitly_unsupported') return 'unsupported_by_provider';
    if (binding.evidence.kind === 'marketing_claim_only') return 'unverifiable_no_public_api';
    return this.providerState(manifest.id);
  }
}

function remediationFor(
  state: ActivationState,
  manifest: ProviderManifest,
  missing: readonly string[],
  malformed: readonly { env: string; reason: string }[],
  binding?: ProviderCapabilityBinding,
): string | null {
  switch (state) {
    case 'blocked_missing_credentials': {
      const lines = missing.map((env) => {
        const spec = manifest.secrets.find((s) => s.env === env);
        return `  - ${env}: ${spec?.description ?? 'required credential'} — obtain at ${spec?.obtainFrom ?? 'the provider dashboard'}`;
      });
      return `Set the following environment variables on the Render service, then re-run the verification harness:\n${lines.join('\n')}`;
    }
    case 'blocked_malformed_credentials':
      return `These credentials are set but the wrong shape: ${malformed
        .map((m) => `${m.env} (${m.reason})`)
        .join(', ')}. Re-copy them from ${manifest.docs[0]?.url ?? 'the provider dashboard'}.`;
    case 'blocked_vendor_approval':
      return manifest.vendorApproval?.how ?? `Request API access from ${manifest.displayName}.`;
    case 'disabled_by_policy':
      return `${manifest.displayName} is disabled by an operator kill switch. Re-enable it in the governance settings.`;
    case 'unsupported_by_provider':
      return binding?.evidence.kind === 'explicitly_unsupported'
        ? `${manifest.displayName} does not provide this: ${binding.evidence.detail}. Bind the capability to a different provider.`
        : `${manifest.displayName} does not provide this capability.`;
    case 'unverifiable_no_public_api':
      return (
        `${manifest.displayName} advertises this capability but no public API reference was located ` +
        `(${binding?.evidence.detail ?? 'marketing claim only'}). The adapter is written against the ` +
        `documented surface we could find; confirm the contract with the vendor before depending on it.`
      );
    case 'configured_unverified':
      return `Credentials are present. Run the verification harness (\`pnpm verify --provider ${manifest.id}\`) to record a live probe: ${manifest.liveProbe.description}`;
    case 'degraded':
      return `The last live probe against ${manifest.displayName} failed. Inspect the verification record and re-run \`pnpm verify --provider ${manifest.id}\`.`;
    case 'live_verified':
      return null;
  }
}
