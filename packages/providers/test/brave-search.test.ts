/**
 * Brave Search adapter tests.
 *
 * No live network: fixtures are the documented `web.results` shape, and the
 * mapping test injects a fetch stub. A missing key must throw
 * `CredentialsMissingError` — never produce a fabricated hit.
 */

import { describe, expect, it } from 'vitest';
import { CredentialsMissingError, SecretStore } from '@foundry/core';
import type { AdapterContext } from '../src/http/adapter.js';
import { BraveSearchAdapter } from '../src/brave-search/index.js';
import { BraveWebSearchResponse } from '../src/brave-search/schemas.js';

/** Documented Brave Web Search payload (title/url/description/extra_snippets). */
const BRAVE_WEB_FIXTURE = {
  query: { original: 'foundry' },
  web: {
    results: [
      {
        title: 'Python Web Frameworks',
        url: 'https://example.com/python-frameworks',
        description: 'Main snippet text...',
        extra_snippets: [
          'First additional excerpt from the page...',
          'Second additional excerpt from the page...',
        ],
      },
    ],
  },
};

function ctx(env: Record<string, string> = {}): AdapterContext {
  return {
    secrets: new SecretStore({ get: (name) => env[name] }),
    environment: 'preview',
    publicBaseUrl: 'https://example.test',
  };
}

function jsonFetch(body: unknown): typeof fetch {
  return async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
}

describe('BraveSearchAdapter credentials', () => {
  it('throws CredentialsMissingError naming BRAVE_SEARCH_API_KEY when the key is absent', async () => {
    const adapter = new BraveSearchAdapter(ctx());
    await expect(adapter.searchWeb({ query: 'foundry', count: 1 })).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(CredentialsMissingError);
      const missing = err as CredentialsMissingError;
      expect(missing.provider).toBe('brave_search');
      expect(missing.missing).toContain('BRAVE_SEARCH_API_KEY');
      return true;
    });
  });
});

describe('Brave web search schema', () => {
  it('parses a documented Brave web.results fixture', () => {
    const parsed = BraveWebSearchResponse.parse(BRAVE_WEB_FIXTURE);
    expect(parsed.web?.results).toHaveLength(1);
    const hit = parsed.web?.results[0];
    expect(hit?.title).toBe('Python Web Frameworks');
    expect(hit?.url).toBe('https://example.com/python-frameworks');
    expect(hit?.description).toBe('Main snippet text...');
    expect(hit?.extra_snippets).toEqual([
      'First additional excerpt from the page...',
      'Second additional excerpt from the page...',
    ]);
  });
});

describe('BraveSearchAdapter.searchWeb', () => {
  it('maps a documented web.results payload onto structured hits', async () => {
    const adapter = new BraveSearchAdapter(ctx({ BRAVE_SEARCH_API_KEY: 'test-brave-key' }), {
      fetchImpl: jsonFetch(BRAVE_WEB_FIXTURE),
    });
    const hits = await adapter.searchWeb({ query: 'foundry', count: 1, extraSnippets: true });
    expect(hits).toEqual([
      {
        title: 'Python Web Frameworks',
        url: 'https://example.com/python-frameworks',
        description: 'Main snippet text...',
        extraSnippets: [
          'First additional excerpt from the page...',
          'Second additional excerpt from the page...',
        ],
      },
    ]);
  });
});
