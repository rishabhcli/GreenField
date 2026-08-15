/**
 * When Brave/Reddit are missing, collection may fall through to a Solari
 * browser session. Evidence must be URLs the session actually loaded — never
 * invented search hits, and never marked as a Brave success.
 */

import { describe, expect, it } from 'vitest';
import { CredentialsMissingError, type Capability, type EvidenceDraft } from '@foundry/core';
import type { ServiceDeps } from '../src/deps.js';
import { ResearchCollectService } from '../src/research/collect.js';

interface CapRow {
  readonly adapter?: unknown;
  readonly status?: {
    readonly provider?: string | null;
    readonly state?: string;
    readonly usable?: boolean;
    readonly remediation?: string;
    readonly missingSecrets?: readonly string[];
  };
}

function providersFor(map: Record<string, CapRow>): ServiceDeps['providers'] {
  return {
    forCapability: (capability: string) => {
      const row = map[capability] ?? {};
      const usable = row.status?.usable ?? Boolean(row.adapter);
      return {
        adapter: usable ? row.adapter : undefined,
        status: {
          capability,
          provider: row.status?.provider ?? null,
          state: row.status?.state ?? (usable ? 'live_verified' : 'blocked_missing_credentials'),
          usable,
          evidence: null,
          remediation: row.status?.remediation ?? `${capability} unavailable`,
          missingSecrets: row.status?.missingSecrets ?? [],
          lastVerifiedAt: null,
          alternatives: [],
        },
      };
    },
    adapter: (id: string) => map[id]?.adapter,
  } as unknown as ServiceDeps['providers'];
}

function service(options: {
  readonly caps: Record<string, CapRow>;
  readonly inserted?: EvidenceDraft[];
}): { collect: ResearchCollectService; inserted: EvidenceDraft[] } {
  const inserted = options.inserted ?? [];
  const deps = {
    providers: providersFor(options.caps),
    repos: {
      research: {
        evidence: {
          insert: async (_companyId: string, draft: EvidenceDraft) => {
            inserted.push(draft);
            return { isNew: true, row: { id: `ev_${inserted.length}` } };
          },
        },
      },
    },
  } as unknown as ServiceDeps;
  return { collect: new ResearchCollectService(deps), inserted };
}

const COMPANY = 'co_01M03F7RQW2M6540BY2GZHCFBW';

describe('ResearchCollectService Solari fallback', () => {
  it('blocks on research.browser_session when Brave and Solari are both unusable', async () => {
    const { collect } = service({
      caps: {
        'research.web_search': {
          status: {
            provider: 'brave_search',
            usable: false,
            state: 'blocked_missing_credentials',
            remediation: 'BRAVE_SEARCH_API_KEY is not set',
            missingSecrets: ['BRAVE_SEARCH_API_KEY'],
          },
        },
        'research.browser_session': {
          status: {
            provider: 'solari',
            usable: false,
            state: 'blocked_missing_credentials',
            remediation: 'SOLARI_API_KEY is not set',
            missingSecrets: ['SOLARI_API_KEY'],
          },
        },
      },
    });

    const result = await collect.collect({ companyId: COMPANY, query: 'leaking bottle cap', sourceKinds: ['web'] });

    expect(result.inserted).toBe(0);
    expect(result.duplicates).toBe(0);
    expect(result.blockedOn?.capability).toBe('research.browser_session' satisfies Capability);
    expect(result.blockedOn?.reason).toMatch(/SOLARI_API_KEY|browser_session|not set/i);
  });

  it('records URL+title from pages the Solari session actually loaded, with browser provenance', async () => {
    const sessionId = 'sess_live_1';
    let created = false;
    const { collect, inserted } = service({
      caps: {
        'research.web_search': {
          status: {
            provider: 'brave_search',
            usable: false,
            state: 'blocked_missing_credentials',
            remediation: 'BRAVE_SEARCH_API_KEY is not set',
            missingSecrets: ['BRAVE_SEARCH_API_KEY'],
          },
        },
        'research.browser_session': {
          adapter: {
            createBrowserSession: async () => {
              created = true;
              return { sessionId, cdpEndpoint: 'wss://example.test/cdp/sess_live_1' };
            },
            deleteSession: async () => undefined,
            loadQueryPages: async (input: { sessionId: string }) => {
              expect(input.sessionId).toBe(sessionId);
              return [
                { url: 'https://news.example.test/cap-leaks', title: 'Bottle cap leaks after two weeks' },
                { url: 'https://forum.example.test/thread/1', title: 'Frustrated with cheap lids' },
              ];
            },
          },
          status: { provider: 'solari', usable: true, state: 'live_verified' },
        },
      },
    });

    const result = await collect.collect({ companyId: COMPANY, query: 'leaking bottle cap', sourceKinds: ['web'] });

    expect(created).toBe(true);
    expect(result.inserted).toBe(2);
    expect(result.blockedOn).toBeUndefined();
    expect(result.sessionId).toBe(sessionId);
    expect(result.loadedUrls).toEqual([
      'https://news.example.test/cap-leaks',
      'https://forum.example.test/thread/1',
    ]);
    expect(inserted).toHaveLength(2);

    for (const draft of inserted) {
      expect(draft.provenance).toEqual({
        method: 'browser_session',
        provider: 'solari',
        sessionId,
      });
      expect(draft.excerpt).toBeNull();
      expect(draft.compliance.excerptStoragePermitted).toBe(false);
      expect(draft.compliance.robotsCheckedAt).toBeNull();
      expect(draft.compliance.robotsAllowed).toBe(false);
      expect(draft.summary.length).toBeGreaterThan(0);
    }
    expect(inserted.map((d) => d.sourceUrl)).toEqual([
      'https://news.example.test/cap-leaks',
      'https://forum.example.test/thread/1',
    ]);
    expect(inserted.some((d) => d.provenance.method === 'public_api')).toBe(false);
    expect(inserted.some((d) => d.provenance.method === 'browser_session' && 'provider' in d.provenance && d.provenance.provider === 'brave_search')).toBe(false);
  });

  it('does not invent pages when the session loaded nothing', async () => {
    const { collect, inserted } = service({
      caps: {
        'research.web_search': {
          status: {
            provider: 'brave_search',
            usable: false,
            remediation: 'BRAVE_SEARCH_API_KEY is not set',
            missingSecrets: ['BRAVE_SEARCH_API_KEY'],
          },
        },
        'research.browser_session': {
          adapter: {
            createBrowserSession: async () => ({
              sessionId: 'sess_empty',
              cdpEndpoint: 'wss://example.test/cdp/sess_empty',
            }),
            loadQueryPages: async () => [],
          },
          status: { provider: 'solari', usable: true, state: 'live_verified' },
        },
      },
    });

    const result = await collect.collect({ companyId: COMPANY, query: 'no such product xyzzy', sourceKinds: ['web'] });

    expect(result.inserted).toBe(0);
    expect(result.duplicates).toBe(0);
    expect(result.sessionId).toBe('sess_empty');
    expect(result.loadedUrls).toEqual([]);
    expect(result.blockedOn?.capability).toBe('research.browser_session');
    expect(result.blockedOn?.reason).toMatch(/loaded 0 pages/i);
    expect(inserted).toEqual([]);
  });

  it('keeps Brave hits as public_api and does not open a Solari session', async () => {
    let solariCalled = false;
    const { collect, inserted } = service({
      caps: {
        'research.web_search': {
          adapter: {
            provider: 'brave_search',
            searchWeb: async () => [
              {
                url: 'https://www.reuters.com/example',
                title: 'Example news',
                description: 'A real snippet from Brave.',
                extraSnippets: [],
              },
            ],
          },
          status: { provider: 'brave_search', usable: true, state: 'live_verified' },
        },
        'research.browser_session': {
          adapter: {
            createBrowserSession: async () => {
              solariCalled = true;
              throw new Error('Solari must not run when Brave returned hits');
            },
          },
          status: { provider: 'solari', usable: true, state: 'live_verified' },
        },
      },
    });

    const result = await collect.collect({ companyId: COMPANY, query: 'example', sourceKinds: ['web'] });

    expect(solariCalled).toBe(false);
    expect(result.inserted).toBe(1);
    expect(inserted[0]?.provenance).toEqual({
      method: 'public_api',
      provider: 'brave_search',
      endpoint: 'GET /web/search',
    });
  });

  it('blocks on research.browser_session when Solari create throws CredentialsMissingError', async () => {
    const { collect } = service({
      caps: {
        'research.web_search': {
          status: {
            provider: 'brave_search',
            usable: false,
            remediation: 'BRAVE_SEARCH_API_KEY is not set',
            missingSecrets: ['BRAVE_SEARCH_API_KEY'],
          },
        },
        'research.browser_session': {
          adapter: {
            createBrowserSession: async () => {
              throw new CredentialsMissingError('solari', ['SOLARI_API_KEY'], 'https://console.getsolari.com');
            },
          },
          status: { provider: 'solari', usable: true, state: 'configured_unverified' },
        },
      },
    });

    const result = await collect.collect({ companyId: COMPANY, query: 'leaking bottle cap', sourceKinds: ['web'] });
    expect(result.inserted).toBe(0);
    expect(result.blockedOn?.capability).toBe('research.browser_session');
    expect(result.blockedOn?.reason).toMatch(/SOLARI_API_KEY/);
  });

  it('blocks on research.browser_session when the session cannot be driven (no CDP, no loader)', async () => {
    const { collect } = service({
      caps: {
        'research.web_search': {
          status: {
            provider: 'brave_search',
            usable: false,
            remediation: 'BRAVE_SEARCH_API_KEY is not set',
          },
        },
        'research.browser_session': {
          adapter: {
            createBrowserSession: async () => ({ sessionId: 'sess_no_cdp' }),
          },
          status: { provider: 'solari', usable: true, state: 'live_verified' },
        },
      },
    });

    const result = await collect.collect({ companyId: COMPANY, query: 'leaking bottle cap', sourceKinds: ['web'] });
    expect(result.inserted).toBe(0);
    expect(result.blockedOn?.capability).toBe('research.browser_session');
  });

  it('uses the loaded URL as summary when the page title is empty', async () => {
    const { collect, inserted } = service({
      caps: {
        'research.web_search': {
          status: { provider: 'brave_search', usable: false, remediation: 'BRAVE_SEARCH_API_KEY is not set' },
        },
        'research.browser_session': {
          adapter: {
            createBrowserSession: async () => ({
              sessionId: 'sess_title',
              cdpEndpoint: 'wss://example.test/cdp/sess_title',
            }),
            loadQueryPages: async () => [{ url: 'https://shop.example.test/lid', title: '   ' }],
          },
          status: { provider: 'solari', usable: true, state: 'live_verified' },
        },
      },
    });

    await collect.collect({ companyId: COMPANY, query: 'lid', sourceKinds: ['web'] });
    expect(inserted).toHaveLength(1);
    expect(inserted[0]?.summary).toBe('https://shop.example.test/lid');
    expect(inserted[0]?.excerpt).toBeNull();
  });
});
