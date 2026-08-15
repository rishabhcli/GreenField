/**
 * Supplier discovery.
 *
 * A supplier exists in our system only when a provider actually returned them.
 * Empty search results stay empty — there is no placeholder factory, no
 * "typical Alibaba vendor", and no scrape of a marketplace whose terms we have
 * not confirmed. Missing Alibaba/Solari credentials fail as blockedOn, not as
 * a cue to invent a directory.
 */

import {
  CapabilityUnsupportedError,
  CredentialsMissingError,
  SupplierKind as SupplierKindSchema,
  VendorApprovalRequiredError,
  type Capability,
  type SupplierKind,
} from '@foundry/core';
import type { SourcedSupplierProfile } from '@foundry/providers';
import type { SupplierRow } from '@foundry/db';
import { getLogger } from '@foundry/obs';
import { requireCapability, type ServiceDeps } from '../deps.js';

export interface SupplierSearchInput {
  readonly companyId: string;
  readonly opportunityId: string;
  readonly keywords: string;
  readonly destinationCountry: string;
  readonly maxSuppliers?: number;
}

export interface SupplierSearchResult {
  readonly suppliersFound: readonly SupplierRow[];
  readonly solariSessionId?: string;
  readonly blockedOn?: { capability: Capability; reason: string };
}

interface SupplierSearchAdapter {
  readonly providerId?: string;
  readonly provider?: string;
  supports?(method: string): boolean;
  searchSuppliers?(input: {
    readonly query: string;
    readonly limit?: number;
  }): Promise<unknown>;
}

interface SolariSessionAdapter {
  createBrowserSession?(input?: { readonly recording?: boolean }): Promise<{ readonly sessionId?: string }>;
}

const DISCOVERED_VIA = ['provider_api', 'browser_session', 'human_expert', 'manual_entry'] as const;
type DiscoveredVia = (typeof DISCOVERED_VIA)[number];

export class SourcingSearchService {
  constructor(private readonly deps: ServiceDeps) {}

  async scan(input: SupplierSearchInput): Promise<SupplierSearchResult> {
    const log = getLogger();
    const limit = input.maxSuppliers ?? 20;

    try {
      requireCapability<SupplierSearchAdapter>(this.deps, 'sourcing.supplier_search');
    } catch (error) {
      const blocked = blockedFrom(error, 'sourcing.supplier_search');
      if (blocked) return { suppliersFound: [], blockedOn: blocked };
      throw error;
    }

    const alibaba = asSearchAdapter(this.deps.providers.adapter('alibaba'));
    const hits: ParsedHit[] = [];
    let vendorBlock: SupplierSearchResult['blockedOn'];
    let solariSessionId: string | undefined;

    if (alibaba && implementsSupplierSearch(alibaba)) {
      try {
        const raw = await alibaba.searchSuppliers!({ query: input.keywords, limit });
        hits.push(...parseHits(raw, alibaba.providerId ?? alibaba.provider ?? 'alibaba', 'provider_api'));
      } catch (error) {
        if (error instanceof VendorApprovalRequiredError) {
          const solari = await this.#trySolariSession();
          solariSessionId = solari.sessionId;
          vendorBlock = {
            capability: 'sourcing.supplier_search',
            reason:
              `${error.message} Remediation: obtain Alibaba.com Open Platform GGS (Global Gold Supplier) ` +
              `developer approval, then request API permissions. ` +
              (solari.sessionId
                ? `Solari browser session ${solari.sessionId} was created, but no extract parser is registered for a permitted marketplace. Marketplace HTML was not parsed and no suppliers were invented.`
                : solari.note),
          };
        } else {
          const blocked = blockedFrom(error, 'sourcing.supplier_search');
          if (blocked) return { suppliersFound: [], blockedOn: blocked };
          throw error;
        }
      }
    } else {
      const solari = await this.#trySolariSession();
      solariSessionId = solari.sessionId;
      vendorBlock = {
        capability: 'sourcing.supplier_search',
        reason:
          `Alibaba searchSuppliers is not callable in this deployment. Remediation: obtain Alibaba.com Open Platform GGS (Global Gold Supplier) developer approval. ` +
          (solari.sessionId
            ? `Solari browser session ${solari.sessionId} was created, but no extract parser is registered for a permitted marketplace. Marketplace HTML was not parsed and no suppliers were invented.`
            : solari.note),
      };
    }

    const suppliersFound: SupplierRow[] = [];
    const seen = new Set<string>();
    for (const hit of hits) {
      const key = `${hit.sourceProvider}:${hit.externalId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const row = await this.deps.repos.sourcing.suppliers.upsert({
        companyId: input.companyId,
        sourceProvider: hit.sourceProvider,
        externalId: hit.externalId,
        legalName: hit.legalName,
        displayName: hit.displayName,
        kind: hit.kind,
        countryCode: hit.countryCode,
        discoveredVia: hit.discoveredVia,
        profileUrl: hit.profileUrl,
        region: hit.region,
        yearsActive: hit.yearsActive,
        claimedCertifications: hit.claimedCertifications,
        platformSignals: hit.platformSignals,
        supportsPrivateLabel: hit.supportsPrivateLabel,
        supportsCustomPackaging: hit.supportsCustomPackaging,
        contactHandle: hit.contactHandle,
        riskFlags: hit.riskFlags,
      });
      suppliersFound.push(row);
    }

    log.info(
      {
        companyId: input.companyId,
        opportunityId: input.opportunityId,
        destinationCountry: input.destinationCountry,
        keywords: input.keywords,
        returned: hits.length,
        upserted: suppliersFound.length,
        solariSessionId,
        blockedOn: vendorBlock?.capability,
      },
      'supplier search completed',
    );

    if (suppliersFound.length === 0 && vendorBlock) {
      return solariSessionId
        ? { suppliersFound: [], solariSessionId, blockedOn: vendorBlock }
        : { suppliersFound: [], blockedOn: vendorBlock };
    }
    if (vendorBlock) {
      return solariSessionId
        ? { suppliersFound, solariSessionId, blockedOn: vendorBlock }
        : { suppliersFound, blockedOn: vendorBlock };
    }
    return solariSessionId ? { suppliersFound, solariSessionId } : { suppliersFound };
  }

  /** @deprecated Use scan. */
  search(input: SupplierSearchInput): Promise<SupplierSearchResult> {
    return this.scan(input);
  }

  /**
   * Creates a Solari session when credentials exist. Does not navigate to, or
   * parse, any marketplace — robots.txt and an extract parser are both absent.
   */
  async #trySolariSession(): Promise<{ sessionId?: string; note: string }> {
    const solari = this.deps.providers.adapter('solari') as SolariSessionAdapter | undefined;
    if (!solari || typeof solari.createBrowserSession !== 'function') {
      return {
        note: 'Solari createBrowserSession is not registered; no browser fallback ran.',
      };
    }
    try {
      const session = await solari.createBrowserSession({ recording: false });
      return {
        sessionId: session.sessionId,
        note: session.sessionId
          ? `Solari session ${session.sessionId} created without an extract parser.`
          : 'Solari createBrowserSession returned no sessionId.',
      };
    } catch (error) {
      if (
        error instanceof CredentialsMissingError ||
        error instanceof CapabilityUnsupportedError ||
        error instanceof VendorApprovalRequiredError
      ) {
        return { note: `Solari browser path unavailable: ${error.message}` };
      }
      throw error;
    }
  }
}

function asSearchAdapter(adapter: unknown): SupplierSearchAdapter | undefined {
  if (!adapter || typeof adapter !== 'object') return undefined;
  return adapter as SupplierSearchAdapter;
}

function implementsSupplierSearch(adapter: SupplierSearchAdapter): boolean {
  if (typeof adapter.searchSuppliers !== 'function') return false;
  if (typeof adapter.supports === 'function' && !adapter.supports('searchSuppliers')) return false;
  return true;
}

function blockedFrom(error: unknown, capability: Capability): { capability: Capability; reason: string } | undefined {
  if (
    error instanceof CredentialsMissingError ||
    error instanceof CapabilityUnsupportedError ||
    error instanceof VendorApprovalRequiredError
  ) {
    return { capability, reason: error.message };
  }
  return undefined;
}

interface ParsedHit {
  readonly sourceProvider: string;
  readonly externalId: string;
  readonly legalName: string;
  readonly displayName: string;
  readonly kind: SupplierKind;
  readonly countryCode: string;
  readonly discoveredVia: DiscoveredVia;
  readonly profileUrl: string | null;
  readonly region: string | null;
  readonly yearsActive: number | null;
  readonly claimedCertifications: readonly string[];
  readonly platformSignals: Record<string, unknown>;
  readonly supportsPrivateLabel: boolean | null;
  readonly supportsCustomPackaging: boolean | null;
  readonly contactHandle: string | null;
  readonly riskFlags: readonly string[];
}

/**
 * Keep only hits that already carry the fields the supplier table requires.
 * Inventing a kind or a country so a thin API row can be saved would mint a
 * supplier we did not actually observe.
 */
function parseHits(raw: unknown, fallbackProvider: string, fallbackDiscoveredVia: DiscoveredVia): ParsedHit[] {
  const list = asList(raw);
  const out: ParsedHit[] = [];
  for (const item of list) {
    const parsed = parseHit(item, fallbackProvider, fallbackDiscoveredVia);
    if (parsed) out.push(parsed);
  }
  return out;
}

function asList(raw: unknown): readonly unknown[] {
  if (raw == null) return [];
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'object') {
    const rec = raw as Record<string, unknown>;
    if (Array.isArray(rec.suppliers)) return rec.suppliers;
    if (Array.isArray(rec.items)) return rec.items;
    if (Array.isArray(rec.results)) return rec.results;
  }
  return [];
}

function parseHit(item: unknown, fallbackProvider: string, fallbackDiscoveredVia: DiscoveredVia): ParsedHit | null {
  if (item == null || typeof item !== 'object') return null;
  const rec = item as Record<string, unknown> & Partial<SourcedSupplierProfile>;

  const externalId = statedString(rec.externalId) ?? statedString(rec.supplier_id) ?? statedString(rec.supplierId);
  const displayName =
    statedString(rec.displayName) ?? statedString(rec.company_name) ?? statedString(rec.legalName);
  const legalName = statedString(rec.legalName) ?? statedString(rec.company_name) ?? displayName;
  if (!externalId || !displayName || !legalName) return null;

  const kindParsed = SupplierKindSchema.safeParse(rec.kind);
  if (!kindParsed.success) return null;

  const countryCode = statedCountry(rec.countryCode ?? rec.country);
  if (!countryCode) return null;

  const discoveredVia = parseDiscoveredVia(rec.discoveredVia) ?? fallbackDiscoveredVia;
  const sourceProvider = statedString(rec.sourceProvider) ?? fallbackProvider;
  const profileUrl = statedUrl(rec.sourceUrl) ?? statedUrl(rec.profileUrl) ?? statedUrl(rec.profile_url);

  return {
    sourceProvider,
    externalId,
    legalName,
    displayName,
    kind: kindParsed.data,
    countryCode,
    discoveredVia,
    profileUrl,
    region: statedString(rec.region) ?? null,
    yearsActive: statedInt(rec.yearsActive ?? rec.years_active),
    claimedCertifications: statedStringArray(rec.claimedCertifications ?? rec.certifications),
    platformSignals: isPlainObject(rec.platformSignals) ? { ...rec.platformSignals } : {},
    supportsPrivateLabel: statedBool(rec.supportsPrivateLabel),
    supportsCustomPackaging: statedBool(rec.supportsCustomPackaging),
    contactHandle: statedString(rec.contactHandle) ?? null,
    riskFlags: statedStringArray(rec.riskFlags),
  };
}

function statedString(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function statedInt(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return value;
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) {
    const n = Number(value.trim());
    return Number.isInteger(n) && n >= 0 ? n : null;
  }
  return null;
}

function statedBool(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function statedStringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.map(statedString).filter((s): s is string => s !== null);
}

function statedCountry(value: unknown): string | null {
  const text = statedString(value);
  if (!text || text.length !== 2) return null;
  return text.toUpperCase();
}

function statedUrl(value: unknown): string | null {
  const text = statedString(value);
  if (!text) return null;
  try {
    const url = new URL(text);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

function parseDiscoveredVia(value: unknown): DiscoveredVia | null {
  return typeof value === 'string' && (DISCOVERED_VIA as readonly string[]).includes(value)
    ? (value as DiscoveredVia)
    : null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
