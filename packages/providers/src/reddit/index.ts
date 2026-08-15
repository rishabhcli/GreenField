/**
 * Reddit adapter — public listings via OAuth client-credentials.
 *
 * Token minting is a one-off POST to `https://www.reddit.com/api/v1/access_token`
 * (basic auth, `grant_type=client_credentials`). That host is *not* the
 * manifest base (`https://oauth.reddit.com`); the token client is therefore a
 * second `ProviderHttpClient`, not `this.http()`.
 *
 * Reddit rejects generic User-Agents. Every request, including the token
 * call, sends the `REDDIT_USER_AGENT` secret.
 *
 * Canonical live probe: `GET /api/v1/me`. Client-credentials apps often get
 * HTTP 400 on `/me` because that endpoint is identity-scoped. A 400 is not
 * success. Fallback 1 is `GET /api/v1/me/karma` (documented for app-only).
 * Fallback 2 is `GET /search?q=foundry&limit=1`.
 */

import { z } from 'zod';
import {
  CredentialsMissingError,
  EvidenceDraft,
  FoundryError,
  ProviderAuthError,
  ValidationError,
  type EvidenceDraft as EvidenceDraftType,
} from '@foundry/core';
import { ProviderAdapter, type AdapterContext, type ProbeResult } from '../http/adapter.js';
import { basicAuth, ProviderHttpClient, type AuthApplier, type HttpRequest } from '../http/client.js';
import { limiterFor } from '../http/rate-limit.js';
import { REDDIT_MANIFEST, SECRETS } from '../manifests.js';
import {
  RedditListing,
  RedditThreadResponse,
  RedditTokenResponse,
  type RedditChild,
  type RedditListing as RedditListingType,
} from './schemas.js';

const TOKEN_BASE_URL = 'https://www.reddit.com';
const EXCERPT_MAX_CHARS = 2_000;
/** Any JSON object — used for `/api/v1/me` and `/api/v1/me/karma`, which are not listings. */
const JsonObject = z.record(z.string(), z.unknown());

export interface RedditSearchInput {
  readonly query: string;
  readonly subreddit?: string;
  readonly limit?: number;
}

export interface RedditFetchThreadInput {
  readonly permalink?: string;
  readonly id?: string;
}

export class RedditAdapter extends ProviderAdapter {
  override readonly manifest = REDDIT_MANIFEST;
  readonly #fetchImpl: typeof fetch | undefined;
  readonly #limiter = limiterFor('reddit');
  #tokenClient: ProviderHttpClient | undefined;
  #accessToken: string | undefined;
  #tokenExpiresAtMs = 0;

  constructor(ctx: AdapterContext, overrides?: { readonly fetchImpl?: typeof fetch }) {
    super(ctx);
    this.#fetchImpl = overrides?.fetchImpl;
  }

  #userAgent(): string {
    return this.requireSecret(SECRETS.redditUserAgent).reveal();
  }

  #redditHeaders(): Record<string, string> {
    return {
      accept: 'application/json',
      'user-agent': this.#userAgent(),
    };
  }

  #tokenHttp(): ProviderHttpClient {
    if (!this.#tokenClient) {
      const clientId = this.requireSecret(SECRETS.redditClientId);
      const clientSecret = this.requireSecret(SECRETS.redditClientSecret);
      this.#tokenClient = new ProviderHttpClient({
        provider: this.provider,
        baseUrl: TOKEN_BASE_URL,
        auth: basicAuth(clientId, clientSecret),
        rateLimiter: this.#limiter,
        defaultHeaders: this.#redditHeaders(),
        defaultTimeoutMs: 30_000,
        fetchImpl: this.#fetchImpl,
      });
    }
    return this.#tokenClient;
  }

  readonly #applyBearer: AuthApplier = (headers) => {
    if (!this.#accessToken) {
      throw new ProviderAuthError('reddit', 'OAuth access token has not been minted');
    }
    headers['authorization'] = `Bearer ${this.#accessToken}`;
  };

  #oauth(): ProviderHttpClient {
    return this.http(this.#applyBearer, {
      rateLimiter: this.#limiter,
      defaultHeaders: this.#redditHeaders(),
      fetchImpl: this.#fetchImpl,
    });
  }

  async #ensureToken(): Promise<void> {
    if (this.#accessToken && Date.now() < this.#tokenExpiresAtMs) return;
    const response = await this.#tokenHttp().request(
      {
        method: 'POST',
        path: '/api/v1/access_token',
        operation: 'oauth.token',
        form: true,
        body: { grant_type: 'client_credentials' },
        retryable: true,
      },
      RedditTokenResponse,
    );
    this.#accessToken = response.body.access_token;
    this.#tokenExpiresAtMs = Date.now() + response.body.expires_in * 1000 - 60_000;
  }

  async #oauthRequest<T>(req: HttpRequest, schema: z.ZodType<T>, retried = false): Promise<{ body: T; status: number }> {
    this.assertActivated();
    await this.#ensureToken();
    try {
      const response = await this.#oauth().request(req, schema);
      return { body: response.body, status: response.status };
    } catch (error) {
      if (!retried && error instanceof ProviderAuthError) {
        this.#accessToken = undefined;
        this.#tokenExpiresAtMs = 0;
        return this.#oauthRequest(req, schema, true);
      }
      throw error;
    }
  }

  /**
   * Canonical probe is `GET /api/v1/me`. A 400 from a client-credentials app
   * is the documented identity-scope limitation, not success — we fall back
   * to `GET /api/v1/me/karma`, then to a limit=1 search.
   */
  override async probe(): Promise<ProbeResult> {
    this.assertActivated();
    await this.#ensureToken();

    try {
      const me = await this.#oauth().request(
        { method: 'GET', path: '/api/v1/me', operation: 'identity.me' },
        JsonObject,
      );
      return {
        succeeded: true,
        detail: 'GET /api/v1/me succeeded (canonical probe)',
        evidence: { endpoint: 'GET /api/v1/me', status: me.status, probe: 'me' },
      };
    } catch (error) {
      if (!isHttp400(error)) throw error;
    }

    try {
      const karma = await this.#oauth().request(
        { method: 'GET', path: '/api/v1/me/karma', operation: 'identity.karma' },
        JsonObject,
      );
      return {
        succeeded: true,
        detail: 'GET /api/v1/me returned 400 (app-only limitation); GET /api/v1/me/karma succeeded',
        evidence: { endpoint: 'GET /api/v1/me/karma', status: karma.status, probe: 'me_karma', meFailed: 400 },
      };
    } catch (error) {
      if (!isHttp400(error)) throw error;
    }

    const search = await this.#oauth().request(
      {
        method: 'GET',
        path: '/search',
        query: { q: 'foundry', limit: 1 },
        operation: 'search.probe',
      },
      RedditListing,
    );
    return {
      succeeded: true,
      detail:
        'GET /api/v1/me and GET /api/v1/me/karma returned 400 (app-only limitation); GET /search?q=foundry&limit=1 succeeded',
      evidence: {
        endpoint: 'GET /search',
        status: search.status,
        probe: 'search',
        resultCount: search.body.data.children.length,
      },
    };
  }

  async search(input: RedditSearchInput): Promise<readonly EvidenceDraftType[]> {
    const query = input.query.trim();
    if (query.length === 0) {
      throw new ValidationError('search requires a non-empty query');
    }
    const limit = Math.min(100, Math.max(1, Math.trunc(input.limit ?? 25)));
    const subreddit = input.subreddit?.replace(/^\/?r\//, '').trim();
    const path = subreddit ? `/r/${encodeURIComponent(subreddit)}/search` : '/search';
    const response = await this.#oauthRequest(
      {
        method: 'GET',
        path,
        query: {
          q: query,
          sort: 'relevance',
          t: 'year',
          limit,
          raw_json: 1,
          ...(subreddit ? { restrict_sr: 1 } : {}),
        },
        operation: 'search',
      },
      RedditListing,
    );
    return listingToEvidenceDrafts(response.body, { endpoint: path });
  }

  async fetchThread(input: RedditFetchThreadInput): Promise<readonly EvidenceDraftType[]> {
    const path = threadPath(input);
    const response = await this.#oauthRequest(
      {
        method: 'GET',
        path,
        query: { raw_json: 1, limit: 100 },
        operation: 'comments.fetch',
      },
      RedditThreadResponse,
    );
    return listingToEvidenceDrafts(response.body, { endpoint: path });
  }
}

function isHttp400(error: unknown): boolean {
  return error instanceof FoundryError && error.context['status'] === 400;
}

function threadPath(input: RedditFetchThreadInput): string {
  if (input.permalink) {
    const path = pathFromPermalink(input.permalink);
    if (path) return path;
  }
  if (input.id) {
    const id = input.id.replace(/^(t3_|t1_)/, '');
    return `/comments/${encodeURIComponent(id)}`;
  }
  throw new ValidationError('fetchThread requires a permalink or an id');
}

function pathFromPermalink(permalink: string): string | undefined {
  const trimmed = permalink.trim();
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    try {
      return new URL(trimmed).pathname;
    } catch {
      return undefined;
    }
  }
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

/* -------------------------------------------------------------------------- */
/* Listing → EvidenceDraft                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Maps a Reddit listing (or a comments-endpoint pair of listings) onto
 * evidence drafts. Children without a permalink *and* without id/name are
 * skipped — we never invent a URL. Excerpt is filled only from public
 * `selftext`/`body` that we are permitted to store.
 */
export function listingToEvidenceDrafts(
  listing: unknown,
  meta: { readonly endpoint: string; readonly retrievedAt?: string },
): EvidenceDraftType[] {
  const listings = asListings(listing);
  const retrievedAt = meta.retrievedAt ?? new Date().toISOString();
  const drafts: EvidenceDraftType[] = [];

  for (const page of listings) {
    for (const child of page.data.children) {
      const draft = childToDraft(child, meta.endpoint, retrievedAt);
      if (draft) drafts.push(draft);
    }
  }
  return drafts;
}

function asListings(input: unknown): RedditListingType[] {
  const parsed = RedditThreadResponse.safeParse(input);
  if (!parsed.success) {
    throw new ValidationError('listingToEvidenceDrafts expected a Reddit listing or an array of listings');
  }
  return Array.isArray(parsed.data) ? parsed.data : [parsed.data];
}

function childToDraft(child: RedditChild, endpoint: string, retrievedAt: string): EvidenceDraftType | undefined {
  const data = child.data;
  const externalId = nonempty(data.name) ?? nonempty(data.id);
  const sourceUrl = sourceUrlFromPermalink(data.permalink);
  if (!sourceUrl && !externalId) return undefined;

  const bodyText = nonempty(data.selftext) ?? nonempty(data.body);
  const title = nonempty(data.title);
  const summary =
    title ?? (bodyText ? truncate(bodyText, EXCERPT_MAX_CHARS) : undefined) ?? nonempty(data.permalink) ?? externalId;
  if (!summary) return undefined;

  const excerpt = bodyText ? truncate(bodyText, EXCERPT_MAX_CHARS) : null;
  const authoredAt =
    typeof data.created_utc === 'number' && Number.isFinite(data.created_utc)
      ? new Date(data.created_utc * 1000).toISOString()
      : null;
  const subreddit = nonempty(data.subreddit);

  const parsed = EvidenceDraft.safeParse({
    sourceKind: sourceKindOf(child.kind, data.name, bodyText, title),
    sourceUrl,
    externalId: externalId ?? null,
    sourceDomain: subreddit ? `reddit.com/r/${subreddit}` : 'reddit.com',
    retrievedAt,
    authoredAt,
    provenance: { method: 'public_api', provider: 'reddit', endpoint },
    compliance: {
      robotsAllowed: false,
      robotsCheckedAt: null,
      termsReviewed: true,
      excerptStoragePermitted: excerpt !== null,
      authorIdentifierRetained: false,
      retentionPolicy: excerpt !== null ? 'standard_365d' : 'summary_only',
      notes:
        'Storage is of public listings retrieved via the Reddit OAuth API (client-credentials). Excerpt is truncated public selftext/body only.',
    },
    excerpt,
    summary,
    language: 'en',
    painPointLabels: [],
    categoryLabels: subreddit ? [subreddit] : [],
    competitorsMentioned: [],
    sentiment: 0,
    severity: 0,
    purchaseIntent: 'none',
    workaroundDescribed: false,
    willingnessToPayCents: null,
    geography: null,
    engagementScore: typeof data.score === 'number' ? Math.trunc(data.score) : null,
    confidence: bodyText || title ? 0.6 : 0.4,
  });
  return parsed.success ? parsed.data : undefined;
}

function sourceKindOf(
  kind: string | undefined,
  name: string | undefined,
  bodyText: string | undefined,
  title: string | undefined,
): 'reddit_post' | 'reddit_comment' {
  const token = (kind ?? name ?? '').toLowerCase();
  if (token.startsWith('t1')) return 'reddit_comment';
  if (token.startsWith('t3')) return 'reddit_post';
  if (bodyText && !title) return 'reddit_comment';
  return 'reddit_post';
}

function sourceUrlFromPermalink(permalink: string | undefined): string | null {
  const value = nonempty(permalink);
  if (!value) return null;
  if (value.startsWith('http://') || value.startsWith('https://')) {
    try {
      const url = new URL(value);
      if (!/(^|\.)reddit\.com$/i.test(url.hostname)) return null;
      return value;
    } catch {
      return null;
    }
  }
  const path = value.startsWith('/') ? value : `/${value}`;
  return `https://reddit.com${path}`;
}

function nonempty(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}

export { CredentialsMissingError };
export * from './schemas.js';
