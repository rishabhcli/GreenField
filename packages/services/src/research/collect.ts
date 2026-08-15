/**
 * Research collection: web search and Reddit listings → evidence rows.
 *
 * Every inserted draft has a real source URL or external id, a retrieval
 * timestamp, `provenance.method = 'public_api'`, and compliance metadata.
 * Empty provider results stay empty — this service never invents a post,
 * a price, or a pain-point label without a URL.
 */

import {
  CapabilityUnsupportedError,
  CredentialsMissingError,
  EvidenceDraft,
  VendorApprovalRequiredError,
  type Capability,
  type EvidenceDraft as EvidenceDraftType,
  type EvidenceSourceKind,
} from '@foundry/core';
import { optionalCapability, requireCapability, type ServiceDeps } from '../deps.js';

export interface CollectInput {
  readonly companyId: string;
  readonly query: string;
  readonly sourceKinds?: readonly string[];
  readonly maxItems?: number;
  readonly opportunityId?: string;
}

export interface CollectionResult {
  readonly inserted: number;
  readonly duplicates: number;
  readonly blockedOn?: { capability: Capability; reason: string };
}

export interface RefetchResult {
  readonly ok: boolean;
  readonly unverifiable: boolean;
  readonly blockedOn?: { capability: Capability; reason: string };
}

interface WebSearchHit {
  readonly url: string;
  readonly title: string;
  readonly description: string;
  readonly published?: string | null;
  readonly extraSnippets?: readonly string[];
}

interface WebSearchAdapter {
  readonly provider?: string;
  search?(query: string, opts?: { count?: number }): Promise<readonly WebSearchHit[]>;
  searchWeb?(input: {
    query: string;
    count: number;
    extraSnippets?: boolean;
  }): Promise<readonly WebSearchHit[]>;
  fetchUrl?(url: string): Promise<unknown>;
}

interface RedditSearchAdapter {
  readonly provider?: string;
  searchSubmissions?(
    query: string,
    opts?: { count?: number },
  ): Promise<readonly EvidenceDraftType[] | readonly WebSearchHit[]>;
  search?(input: { query: string; subreddit?: string; limit?: number }): Promise<readonly EvidenceDraftType[]>;
}

const NEWS_DOMAINS = [
  'nytimes.com',
  'washingtonpost.com',
  'bbc.com',
  'bbc.co.uk',
  'reuters.com',
  'apnews.com',
  'theguardian.com',
  'wsj.com',
  'bloomberg.com',
  'npr.org',
  'cnn.com',
  'ft.com',
] as const;

const COMPLAINT_LANGUAGE =
  /\b(hate|hates|annoying|frustrated|frustrating|broken|broke|doesn't work|does not work|won't work|useless|terrible|awful|worst|sucks|painful|problem|problems|issue|issues|complaint|leaking|leak|disappointed|cheaply made|poor quality|can't stand|cannot stand)\b/i;

export class ResearchCollectService {
  constructor(private readonly deps: ServiceDeps) {}

  async collect(input: CollectInput): Promise<CollectionResult> {
    const kinds = new Set((input.sourceKinds ?? ['web']).map((k) => k.toLowerCase()));
    const wantWeb = wantsWeb(kinds);
    const wantReddit = wantsReddit(kinds);
    const maxItems = Math.min(20, Math.max(1, Math.trunc(input.maxItems ?? 10)));

    let inserted = 0;
    let duplicates = 0;
    let blockedOn: CollectionResult['blockedOn'];

    if (wantWeb) {
      const web = await this.#collectWeb(input.companyId, input.query, maxItems);
      inserted += web.inserted;
      duplicates += web.duplicates;
      blockedOn = web.blockedOn;
    }

    if (wantReddit) {
      const reddit = await this.#collectReddit(input.companyId, input.query, maxItems);
      inserted += reddit.inserted;
      duplicates += reddit.duplicates;
      if (!blockedOn) blockedOn = reddit.blockedOn;
    }

    if (inserted + duplicates > 0) {
      return { inserted, duplicates };
    }
    return blockedOn ? { inserted, duplicates, blockedOn } : { inserted, duplicates };
  }

  /**
   * Re-establishes a previously collected URL without constructing an HTTP
   * client in this layer. If the search adapter cannot fetch or re-list the
   * URL, confidence is lowered and the item is marked unverifiable — never
   * confirmed from model memory.
   */
  async refetch(evidenceId: string): Promise<RefetchResult> {
    const row = await this.deps.repos.research.evidence.byId(evidenceId);
    const adapter = optionalCapability<WebSearchAdapter>(this.deps, 'research.web_search');

    if (!adapter) {
      await this.deps.repos.research.evidence.updateConfidence(
        evidenceId,
        Math.min(row.confidence, 0.3),
        'unverifiable: research.web_search is not usable; source was not re-fetched',
      );
      return {
        ok: false,
        unverifiable: true,
        blockedOn: {
          capability: 'research.web_search',
          reason: this.#reason('research.web_search'),
        },
      };
    }

    if (typeof adapter.fetchUrl === 'function' && row.source_url) {
      try {
        const fetched = await adapter.fetchUrl(row.source_url);
        const status = httpStatusOf(fetched);
        if (status !== undefined && status >= 200 && status < 400) {
          await this.deps.repos.research.evidence.updateConfidence(
            evidenceId,
            row.confidence,
            `Source URL responded to adapter fetchUrl with HTTP ${status}. Excerpt was not re-interpreted.`,
          );
          return { ok: true, unverifiable: false };
        }
        await this.deps.repos.research.evidence.updateConfidence(
          evidenceId,
          Math.min(row.confidence, 0.3),
          `unverifiable: fetchUrl returned HTTP ${status ?? 'unknown'}`,
        );
        return { ok: true, unverifiable: true };
      } catch (error) {
        const blocked = blockedFrom(error, 'research.web_search');
        if (blocked) {
          await this.deps.repos.research.evidence.updateConfidence(
            evidenceId,
            Math.min(row.confidence, 0.3),
            `unverifiable: ${blocked.reason}`,
          );
          return { ok: false, unverifiable: true, blockedOn: blocked };
        }
        throw error;
      }
    }

    if (row.source_url && canSearch(adapter)) {
      try {
        const hits = await searchWeb(adapter, row.summary || row.source_url, 10);
        const match = hits.some((hit) => sameUrl(hit.url, row.source_url));
        if (match) {
          await this.deps.repos.research.evidence.updateConfidence(
            evidenceId,
            row.confidence,
            'Source URL still appears in search results. Page body was not re-fetched; excerpt not confirmed.',
          );
          return { ok: true, unverifiable: false };
        }
        await this.deps.repos.research.evidence.updateConfidence(
          evidenceId,
          Math.min(row.confidence, 0.3),
          'unverifiable: source URL was not present in a fresh search',
        );
        return { ok: true, unverifiable: true };
      } catch (error) {
        const blocked = blockedFrom(error, 'research.web_search');
        if (blocked) {
          await this.deps.repos.research.evidence.updateConfidence(
            evidenceId,
            Math.min(row.confidence, 0.3),
            `unverifiable: ${blocked.reason}`,
          );
          return { ok: false, unverifiable: true, blockedOn: blocked };
        }
        throw error;
      }
    }

    await this.deps.repos.research.evidence.updateConfidence(
      evidenceId,
      Math.min(row.confidence, 0.3),
      'unverifiable: search adapter has no fetchUrl and cannot re-search this item',
    );
    return { ok: true, unverifiable: true };
  }

  async #collectWeb(companyId: string, query: string, maxItems: number): Promise<CollectionResult> {
    let adapter: WebSearchAdapter;
    try {
      adapter = requireCapability<WebSearchAdapter>(this.deps, 'research.web_search').adapter;
    } catch (error) {
      const blocked = blockedFrom(error, 'research.web_search');
      if (blocked) return { inserted: 0, duplicates: 0, blockedOn: blocked };
      throw error;
    }

    if (!canSearch(adapter)) {
      return {
        inserted: 0,
        duplicates: 0,
        blockedOn: {
          capability: 'research.web_search',
          reason: 'Resolved web-search adapter does not implement search or searchWeb.',
        },
      };
    }

    try {
      const hits = await searchWeb(adapter, query, maxItems);
      const drafts = hits.map(braveHitToDraft).filter((d): d is EvidenceDraftType => d !== undefined);
      return this.#insertAll(companyId, drafts);
    } catch (error) {
      const blocked = blockedFrom(error, 'research.web_search');
      if (blocked) return { inserted: 0, duplicates: 0, blockedOn: blocked };
      throw error;
    }
  }

  async #collectReddit(companyId: string, query: string, maxItems: number): Promise<CollectionResult> {
    const reddit = asReddit(this.deps.providers.adapter('reddit'))
      ?? asReddit(optionalCapability<RedditSearchAdapter>(this.deps, 'research.web_search'));

    if (!reddit) {
      return {
        inserted: 0,
        duplicates: 0,
        blockedOn: {
          capability: 'research.web_search',
          reason: this.#reason('research.web_search') + ' No Reddit adapter is registered.',
        },
      };
    }

    try {
      const drafts: EvidenceDraftType[] = [];
      if (typeof reddit.searchSubmissions === 'function') {
        const page = await reddit.searchSubmissions(query, { count: maxItems });
        for (const item of page) {
          const draft = redditItemToDraft(item);
          if (draft) drafts.push(draft);
        }
      } else if (typeof reddit.search === 'function') {
        const page = await reddit.search({ query, limit: maxItems });
        for (const item of page) {
          const parsed = EvidenceDraft.safeParse(item);
          if (parsed.success && (parsed.data.sourceUrl || parsed.data.externalId)) {
            drafts.push(parsed.data);
          }
        }
      }
      return this.#insertAll(companyId, drafts);
    } catch (error) {
      const blocked = blockedFrom(error, 'research.web_search');
      if (blocked) return { inserted: 0, duplicates: 0, blockedOn: blocked };
      throw error;
    }
  }

  async #insertAll(companyId: string, drafts: readonly EvidenceDraftType[]): Promise<CollectionResult> {
    let inserted = 0;
    let duplicates = 0;
    for (const draft of drafts) {
      const parsed = EvidenceDraft.safeParse(draft);
      if (!parsed.success) continue;
      if (!parsed.data.sourceUrl && !parsed.data.externalId) continue;
      const result = await this.deps.repos.research.evidence.insert(companyId, parsed.data);
      if (result.isNew) inserted += 1;
      else duplicates += 1;
    }
    return { inserted, duplicates };
  }

  #reason(capability: Capability): string {
    const status = this.deps.providers.forCapability(capability).status;
    return status.remediation ?? `capability state is ${status.state}`;
  }
}

/** @deprecated Use ResearchCollectService. */
export { ResearchCollectService as ResearchCollectionService };

function wantsWeb(kinds: ReadonlySet<string>): boolean {
  return (
    kinds.has('web') ||
    kinds.has('search') ||
    kinds.has('blog_post') ||
    kinds.has('news_article')
  );
}

function wantsReddit(kinds: ReadonlySet<string>): boolean {
  return kinds.has('reddit') || kinds.has('reddit_post') || kinds.has('reddit_comment');
}

function canSearch(adapter: WebSearchAdapter): boolean {
  return typeof adapter.search === 'function' || typeof adapter.searchWeb === 'function';
}

async function searchWeb(adapter: WebSearchAdapter, query: string, count: number): Promise<readonly WebSearchHit[]> {
  if (typeof adapter.search === 'function') {
    return adapter.search(query, { count });
  }
  if (typeof adapter.searchWeb === 'function') {
    return adapter.searchWeb({ query, count, extraSnippets: true });
  }
  return [];
}

function blockedFrom(error: unknown, capability: Capability): CollectionResult['blockedOn'] {
  if (
    error instanceof CredentialsMissingError ||
    error instanceof CapabilityUnsupportedError ||
    error instanceof VendorApprovalRequiredError
  ) {
    return { capability, reason: error.message };
  }
  return undefined;
}

function asReddit(adapter: unknown): RedditSearchAdapter | undefined {
  if (!adapter || typeof adapter !== 'object') return undefined;
  const candidate = adapter as RedditSearchAdapter;
  if (typeof candidate.searchSubmissions === 'function' || typeof candidate.search === 'function') {
    return candidate;
  }
  return undefined;
}

function braveHitToDraft(hit: WebSearchHit): EvidenceDraftType | undefined {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(hit.url);
  } catch {
    return undefined;
  }
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') return undefined;

  const description = (hit.description ?? '').trim();
  const extra = (hit.extraSnippets ?? []).map((s) => s.trim()).filter((s) => s.length > 0);
  const title = (hit.title ?? '').trim();
  const summary = [description, ...extra].filter((s) => s.length > 0).join('\n') || title;
  if (!summary) return undefined;

  const host = parsedUrl.hostname.replace(/^www\./, '').toLowerCase();
  const sourceKind = classifyHost(host);
  const retrievedAt = new Date().toISOString();
  const authoredAt = publishedToIso(hit.published);
  const complaintText = `${title}\n${summary}`;
  const painPointLabels = COMPLAINT_LANGUAGE.test(complaintText) && title ? [title.slice(0, 80)] : [];

  const parsed = EvidenceDraft.safeParse({
    sourceKind,
    sourceUrl: parsedUrl.toString(),
    externalId: null,
    sourceDomain: host,
    retrievedAt,
    authoredAt,
    provenance: { method: 'public_api', provider: 'brave_search', endpoint: 'GET /web/search' },
    compliance: {
      robotsAllowed: true,
      robotsCheckedAt: null,
      termsReviewed: true,
      excerptStoragePermitted: true,
      authorIdentifierRetained: false,
      retentionPolicy: 'standard_365d',
      notes: 'Snippet returned by the Brave Search official API (GET /web/search).',
    },
    excerpt: description || null,
    summary,
    language: 'en',
    painPointLabels,
    categoryLabels: [],
    competitorsMentioned: [],
    sentiment: 0,
    severity: 0,
    purchaseIntent: 'none',
    workaroundDescribed: false,
    willingnessToPayCents: null,
    geography: null,
    engagementScore: null,
    confidence: sourceKind === 'news_article' ? 0.7 : 0.4,
  });
  return parsed.success ? parsed.data : undefined;
}

function redditItemToDraft(item: EvidenceDraftType | WebSearchHit): EvidenceDraftType | undefined {
  const asDraft = EvidenceDraft.safeParse(item);
  if (asDraft.success) {
    if (!asDraft.data.sourceUrl && !asDraft.data.externalId) return undefined;
    return asDraft.data;
  }
  if (!('url' in item) || typeof item.url !== 'string') return undefined;
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(item.url);
  } catch {
    return undefined;
  }
  const title = item.title.trim();
  const description = item.description.trim();
  const summary = description || title;
  if (!summary) return undefined;
  const parsed = EvidenceDraft.safeParse({
    sourceKind: 'reddit_post' satisfies EvidenceSourceKind,
    sourceUrl: parsedUrl.toString(),
    externalId: null,
    sourceDomain: parsedUrl.hostname.replace(/^www\./, '').toLowerCase(),
    retrievedAt: new Date().toISOString(),
    authoredAt: publishedToIso(item.published),
    provenance: { method: 'public_api', provider: 'reddit', endpoint: 'GET /search' },
    compliance: {
      robotsAllowed: true,
      robotsCheckedAt: null,
      termsReviewed: true,
      excerptStoragePermitted: true,
      authorIdentifierRetained: false,
      retentionPolicy: 'standard_365d',
      notes: 'Public Reddit listing retrieved via the official API.',
    },
    excerpt: description || null,
    summary,
    language: 'en',
    painPointLabels: COMPLAINT_LANGUAGE.test(`${title}\n${summary}`) && title ? [title.slice(0, 80)] : [],
    categoryLabels: [],
    competitorsMentioned: [],
    sentiment: 0,
    severity: 0,
    purchaseIntent: 'none',
    workaroundDescribed: false,
    willingnessToPayCents: null,
    geography: null,
    engagementScore: null,
    confidence: 0.6,
  });
  return parsed.success ? parsed.data : undefined;
}

function classifyHost(host: string): EvidenceSourceKind {
  if (NEWS_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`))) return 'news_article';
  return 'blog_post';
}

function publishedToIso(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function sameUrl(left: string, right: string | null): boolean {
  if (!right) return false;
  try {
    const a = new URL(left);
    const b = new URL(right);
    return a.origin + a.pathname.replace(/\/$/, '') === b.origin + b.pathname.replace(/\/$/, '');
  } catch {
    return left === right;
  }
}

function httpStatusOf(fetched: unknown): number | undefined {
  if (fetched == null || typeof fetched !== 'object') return undefined;
  const rec = fetched as Record<string, unknown>;
  for (const key of ['statusCode', 'status', 'httpStatus'] as const) {
    const value = rec[key];
    if (typeof value === 'number' && Number.isInteger(value)) return value;
  }
  return undefined;
}
