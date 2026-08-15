/**
 * Solari navigate reports pages the session opened. Empty or search-only
 * hrefs stay empty — no invented result URLs or DOM.
 */

import { describe, expect, it } from 'vitest';
import { CapabilityUnsupportedError, CredentialsMissingError, SecretStore } from '@foundry/core';
import type { AdapterContext } from '../src/http/adapter.js';
import {
  SolariAdapter,
  isSearchResultsPage,
  loadQueryPagesFromEndpoints,
  resolveResultUrl,
  selectResultUrls,
} from '../src/solari/index.js';

function ctx(env: Record<string, string> = {}): AdapterContext {
  return {
    secrets: new SecretStore({ get: (name) => env[name] }),
    environment: 'preview',
    publicBaseUrl: 'https://example.test',
  };
}

describe('Solari navigate does not fabricate DOM', () => {
  it('selectResultUrls returns [] when the page had no result hrefs', () => {
    expect(selectResultUrls([], 'https://html.duckduckgo.com/html/?q=mugs', 5)).toEqual([]);
  });

  it('drops search-host and non-http hrefs instead of inventing destinations', () => {
    const hrefs = [
      'https://www.bing.com/search?q=more',
      'javascript:void(0)',
      '/search?q=again',
      'https://html.duckduckgo.com/html/?q=mugs',
    ];
    expect(selectResultUrls(hrefs, 'https://html.duckduckgo.com/html/?q=mugs', 8)).toEqual([]);
    expect(resolveResultUrl('javascript:alert(1)', 'https://html.duckduckgo.com/html/')).toBeUndefined();
    expect(isSearchResultsPage('https://www.bing.com/search?q=mugs')).toBe(true);
  });

  it('keeps only hrefs the search page actually emitted', () => {
    const hrefs = [
      'https://html.duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org%2Fmugs',
      'https://en.wikipedia.org/wiki/Mug',
    ];
    expect(selectResultUrls(hrefs, 'https://html.duckduckgo.com/html/?q=mugs', 8)).toEqual([
      'https://example.org/mugs',
      'https://en.wikipedia.org/wiki/Mug',
    ]);
  });

  it('loadQueryPagesFromEndpoints throws when there is no CDP/WS — it does not invent pages', async () => {
    await expect(
      loadQueryPagesFromEndpoints({ query: 'ceramic mugs', maxItems: 3 }),
    ).rejects.toBeInstanceOf(CapabilityUnsupportedError);
  });

  it('adapter loadQueryPages refuses to invent pages without endpoints', async () => {
    const adapter = new SolariAdapter(ctx({ SOLARI_API_KEY: 'slr_test_abcdefghijklmnopqrstuvwxyz' }), {
      fetchImpl: async () => new Response('{}', { status: 500 }),
    });
    await expect(
      adapter.loadQueryPages({ query: 'mugs', maxItems: 3, sessionId: 'sess_1' }),
    ).rejects.toBeInstanceOf(CapabilityUnsupportedError);
  });

  it('probe names SOLARI_API_KEY when the key is absent', async () => {
    const adapter = new SolariAdapter(ctx());
    await expect(adapter.probe()).rejects.toSatisfy(
      (error: unknown) => error instanceof CredentialsMissingError && error.missing.includes('SOLARI_API_KEY'),
    );
  });
});
