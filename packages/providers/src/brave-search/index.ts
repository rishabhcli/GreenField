/**
 * Brave Search adapter — production substrate for `research.web_search`.
 *
 * No sponsor offers a search API. This adapter is the real one: every call
 * hits `GET https://api.search.brave.com/res/v1/web/search` with
 * `X-Subscription-Token`. A missing `BRAVE_SEARCH_API_KEY` raises
 * `CredentialsMissingError`; nothing here substitutes a stub hit.
 *
 * The live probe `GET /web/search?q=foundry&count=1` is a billed search. It is
 * still the documented non-destructive probe (it creates no index-side state).
 * `safeProbe` already no-ops when the key is not configured.
 */

import { CredentialsMissingError, ValidationError } from '@foundry/core';
import { ProviderAdapter, type AdapterContext, type ProbeResult } from '../http/adapter.js';
import { apiKeyHeaderAuth, type ProviderHttpClient } from '../http/client.js';
import { BRAVE_SEARCH_MANIFEST, SECRETS } from '../manifests.js';
import { BraveWebSearchResponse } from './schemas.js';

export interface BraveSearchHit {
  readonly title: string;
  readonly url: string;
  readonly description: string;
  readonly extraSnippets: readonly string[];
}

export interface SearchWebInput {
  readonly query: string;
  readonly count: number;
  readonly extraSnippets?: boolean;
}

export class BraveSearchAdapter extends ProviderAdapter {
  override readonly manifest = BRAVE_SEARCH_MANIFEST;
  readonly #fetchImpl: typeof fetch | undefined;

  constructor(ctx: AdapterContext, overrides?: { readonly fetchImpl?: typeof fetch }) {
    super(ctx);
    this.#fetchImpl = overrides?.fetchImpl;
  }

  #client(): ProviderHttpClient {
    const secret = this.requireSecret(SECRETS.braveSearchApiKey);
    return this.http(apiKeyHeaderAuth('X-Subscription-Token', secret), {
      defaultHeaders: {
        accept: 'application/json',
        'accept-encoding': 'gzip',
      },
      fetchImpl: this.#fetchImpl,
    });
  }

  /**
   * Documented probe. This request is billed; it is still read-only against
   * the index (no write, no mutation of a Brave-side resource we own).
   */
  override async probe(): Promise<ProbeResult> {
    const response = await this.#client().request(
      {
        method: 'GET',
        path: '/web/search',
        query: { q: 'foundry', count: 1 },
        operation: 'web.search.probe',
      },
      BraveWebSearchResponse,
    );
    const count = response.body.web?.results.length ?? 0;
    return {
      succeeded: true,
      detail: `GET /web/search?q=foundry&count=1 returned ${count} result(s)`,
      evidence: { endpoint: 'GET /web/search', resultCount: count, billed: true },
    };
  }

  async searchWeb(input: SearchWebInput): Promise<readonly BraveSearchHit[]> {
    this.assertActivated();
    const query = input.query.trim();
    if (query.length === 0) {
      throw new ValidationError('searchWeb requires a non-empty query');
    }
    // Brave documents `count` as 1–20 per page.
    const count = Math.min(20, Math.max(1, Math.trunc(input.count)));

    const response = await this.#client().request(
      {
        method: 'GET',
        path: '/web/search',
        query: {
          q: query,
          count,
          extra_snippets: input.extraSnippets ? true : undefined,
        },
        operation: 'web.search',
      },
      BraveWebSearchResponse,
    );

    const hits: BraveSearchHit[] = [];
    for (const result of response.body.web?.results ?? []) {
      if (!result.url) continue;
      hits.push({
        title: result.title ?? '',
        url: result.url,
        description: result.description ?? '',
        extraSnippets: result.extra_snippets ?? [],
      });
    }
    return hits;
  }
}

export { CredentialsMissingError };
export * from './schemas.js';
