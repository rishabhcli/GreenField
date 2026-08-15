/**
 * `BrowserSourcingProvider` — supplier discovery via a real browser session,
 * for marketplaces with no usable API. One of the real
 * `SupplierSourcingProvider` implementations behind the provider-neutral
 * layer in `./interface.ts`.
 *
 * This class does **not** import the Solari adapter (another agent owns that
 * directory); it is driven by a narrow `BrowserDriver` interface defined
 * right here, so any browser-automation backend can be plugged in. It also
 * has no built-in scraper for any specific marketplace — parsing a rendered
 * page into supplier data is inherently site-specific, so the caller supplies
 * an `extract` function per `BrowserSearchTarget`. What this class actually
 * owns is the honest, safety-relevant orchestration around that: a compliance
 * check that can refuse to proceed, a session record for every navigation
 * attempted, and provenance (source URL + retrieval timestamp) stamped onto
 * every result.
 */

import { CapabilityUnsupportedError, PolicyDeniedError, ProviderContractError, type SupplierKind } from '@foundry/core';
import type { SourcedSupplierProfile, SourcingMethod, SupplierSourcingProvider } from './interface.js';

/** The narrow surface this class needs from a browser-automation backend. Deliberately not tied to any one vendor. */
export interface BrowserDriver {
  navigate(url: string): Promise<void>;
  /** Rendered HTML (or text) of the current page. */
  getContent(): Promise<string>;
  currentUrl(): Promise<string>;
  close(): Promise<void>;
}

export interface ComplianceCheckResult {
  readonly robotsAllowed: boolean;
  readonly reason?: string;
}

/** Robots.txt / ToS review gate, checked before every navigation — never bypassable from inside this class. */
export interface ComplianceGate {
  check(url: string): Promise<ComplianceCheckResult> | ComplianceCheckResult;
}

/** What a site-specific `extract` function hands back; provenance and domain-shape assembly happen here, not in the caller's parser. */
export interface RawBrowserSupplierHit {
  readonly externalId: string;
  readonly displayName: string;
  readonly legalName?: string;
  readonly countryCode?: string;
  readonly kind?: SupplierKind;
  readonly platformSignals?: Readonly<Record<string, unknown>>;
  readonly claimedCertifications?: readonly string[];
}

export interface BrowserSearchTarget {
  readonly url: string;
  /** Parses the rendered page into raw hits. Site-specific; owned by the caller, not this class. */
  readonly extract: (html: string, pageUrl: string) => readonly RawBrowserSupplierHit[];
}

export interface BrowserSessionRecord {
  readonly url: string;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly outcome: 'ok' | 'compliance_blocked' | 'error';
  readonly detail: string | null;
}

/**
 * Turns a plain search query into a navigable target.
 *
 * The provider-neutral interface speaks in queries; a browser speaks in URLs
 * and site-specific parsers. This resolver is the bridge, and it is required
 * rather than defaulted: without a registered marketplace there is no honest
 * way to answer "search suppliers for X", so the provider reports the method
 * as unsupported instead of returning nothing and calling it a result.
 */
export interface SearchTargetResolver {
  /** Target for a keyword search, or `null` if this resolver covers no such site. */
  forQuery(query: string, limit: number | undefined): BrowserSearchTarget | null;
  /** Target for a specific supplier's profile page. */
  forSupplier(externalId: string): BrowserSearchTarget | null;
}

export interface BrowserSourcingOptions {
  readonly driver: BrowserDriver;
  readonly complianceGate: ComplianceGate;
  readonly providerId?: string;
  /** Registered marketplaces. With none, search and profile are unsupported. */
  readonly targets?: SearchTargetResolver;
}

export class BrowserSourcingProvider implements SupplierSourcingProvider {
  readonly providerId: string;
  readonly #driver: BrowserDriver;
  readonly #complianceGate: ComplianceGate;
  readonly #targets: SearchTargetResolver | undefined;
  readonly #sessions: BrowserSessionRecord[] = [];

  constructor(options: BrowserSourcingOptions) {
    this.providerId = options.providerId ?? 'browser_sourcing';
    this.#driver = options.driver;
    this.#complianceGate = options.complianceGate;
    this.#targets = options.targets;
  }

  /** Every navigation attempted so far — the caller persists this as the audit trail; this class only keeps it in memory. */
  get sessionLog(): readonly BrowserSessionRecord[] {
    return this.#sessions;
  }

  supports(method: SourcingMethod): boolean {
    // Without a resolver there is no site to visit and no parser to apply, so
    // the method genuinely is not available — saying otherwise would make the
    // capability registry report a discovery path that cannot run.
    if (!this.#targets) return false;
    return method === 'searchSuppliers' || method === 'getSupplierProfile';
  }

  async searchSuppliers(input: { readonly query: string; readonly limit?: number }): Promise<readonly SourcedSupplierProfile[]> {
    const target = this.#resolve('searchSuppliers', () => this.#targets?.forQuery(input.query, input.limit) ?? null);
    return this.searchTarget(target);
  }

  async getSupplierProfile(input: { readonly externalId: string }): Promise<SourcedSupplierProfile> {
    const target = this.#resolve('getSupplierProfile', () => this.#targets?.forSupplier(input.externalId) ?? null);
    return this.profileFromTarget(target);
  }

  /** Direct target form, for a caller that already knows the URL and parser. */
  async searchTarget(target: BrowserSearchTarget): Promise<readonly SourcedSupplierProfile[]> {
    const retrievedAt = new Date().toISOString();
    const html = await this.#visit(target.url);
    return target.extract(html, target.url).map((hit) => toProfile(this.providerId, target.url, retrievedAt, hit));
  }

  async profileFromTarget(target: BrowserSearchTarget): Promise<SourcedSupplierProfile> {
    const retrievedAt = new Date().toISOString();
    const html = await this.#visit(target.url);
    const hits = target.extract(html, target.url);
    const first = hits[0];
    if (!first) {
      throw new ProviderContractError(this.providerId, `no supplier data extracted from ${target.url}`, { url: target.url });
    }
    return toProfile(this.providerId, target.url, retrievedAt, first);
  }

  #resolve(method: SourcingMethod, lookup: () => BrowserSearchTarget | null): BrowserSearchTarget {
    const target = lookup();
    if (!target) {
      throw new CapabilityUnsupportedError(
        this.providerId,
        method,
        this.#targets
          ? 'no registered marketplace matches this request, so there is no page to visit and no parser to apply'
          : 'no marketplace targets are registered on this provider',
      );
    }
    return target;
  }

  async close(): Promise<void> {
    await this.#driver.close();
  }

  /**
   * The single choke point every read in this class goes through: checked
   * against the compliance gate first, and refuses outright — never
   * navigates — when it reports `robotsAllowed: false`. Every attempt,
   * refused or not, is appended to `sessionLog` with its source URL and a
   * start/end timestamp.
   */
  async #visit(url: string): Promise<string> {
    const startedAt = new Date().toISOString();
    const check = await this.#complianceGate.check(url);
    if (!check.robotsAllowed) {
      this.#sessions.push({
        url,
        startedAt,
        endedAt: new Date().toISOString(),
        outcome: 'compliance_blocked',
        detail: check.reason ?? null,
      });
      throw new PolicyDeniedError(
        `Refusing to browse ${url}: compliance gate reported robotsAllowed=false${check.reason ? ` (${check.reason})` : ''}`,
        { url, reason: check.reason ?? null },
      );
    }

    try {
      await this.#driver.navigate(url);
      const html = await this.#driver.getContent();
      this.#sessions.push({ url, startedAt, endedAt: new Date().toISOString(), outcome: 'ok', detail: null });
      return html;
    } catch (error) {
      this.#sessions.push({
        url,
        startedAt,
        endedAt: new Date().toISOString(),
        outcome: 'error',
        detail: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }
}

function toProfile(providerId: string, url: string, retrievedAt: string, hit: RawBrowserSupplierHit): SourcedSupplierProfile {
  return {
    sourceProvider: providerId,
    sourceUrl: url,
    retrievedAt,
    discoveredVia: 'browser_session',
    externalId: hit.externalId,
    legalName: hit.legalName ?? null,
    displayName: hit.displayName,
    kind: hit.kind ?? null,
    countryCode: hit.countryCode ?? null,
    region: null,
    yearsActive: null,
    claimedCertifications: hit.claimedCertifications ?? [],
    platformSignals: hit.platformSignals ?? {},
    supportsPrivateLabel: null,
    supportsCustomPackaging: null,
    contactHandle: null,
    riskFlags: [],
  };
}
