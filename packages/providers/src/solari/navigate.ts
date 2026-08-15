/**
 * Drive a live Solari session over cdpEndpoint (raw CDP) or, if that is
 * absent, wsEndpoint. Search-engine HTML is a navigation source only —
 * evidence URLs are pages the session actually opened, never invented.
 */

import WebSocket from 'ws';
import { CapabilityUnsupportedError } from '@foundry/core';
import { getLogger } from '@foundry/obs';
import { assertNavigationPermitted, isUnreviewedMarketplaceHost } from './compliance.js';

export interface LoadedBrowserPage {
  readonly url: string;
  readonly title: string;
}

export interface SessionPageLoad {
  /** Non-search pages the session successfully opened — safe to persist. */
  readonly evidence: readonly LoadedBrowserPage[];
  /** Every http(s) URL the session successfully opened, including search pages. */
  readonly loaded: readonly LoadedBrowserPage[];
}

const SEARCH_HOSTS = new Set([
  'duckduckgo.com',
  'www.duckduckgo.com',
  'html.duckduckgo.com',
  'bing.com',
  'www.bing.com',
  'google.com',
  'www.google.com',
  'google.co.uk',
  'www.google.co.uk',
]);

const CONNECT_TIMEOUT_MS = 20_000;
const NAVIGATE_TIMEOUT_MS = 20_000;
const CONNECT_ATTEMPTS = 3;
const CONNECT_RETRY_MS = 1_500;

export function searchPageUrls(query: string): readonly string[] {
  const q = query.trim();
  const ddg = new URL('https://html.duckduckgo.com/html/');
  ddg.searchParams.set('q', q);
  const bing = new URL('https://www.bing.com/search');
  bing.searchParams.set('q', q);
  const wiki = new URL('https://en.wikipedia.org/w/index.php');
  wiki.searchParams.set('search', q);
  wiki.searchParams.set('title', 'Special:Search');
  return [ddg.toString(), bing.toString(), wiki.toString()];
}

export function isSearchHost(hostname: string): boolean {
  const host = hostname.replace(/^www\./, '').toLowerCase();
  if (SEARCH_HOSTS.has(hostname.toLowerCase()) || SEARCH_HOSTS.has(host)) return true;
  return host.endsWith('.duckduckgo.com') || host.endsWith('.bing.com') || host.endsWith('.google.com');
}

export function isSearchResultsPage(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (isSearchHost(parsed.hostname)) return true;
    const path = parsed.pathname;
    if (parsed.hostname.endsWith('wikipedia.org')) {
      return path.includes('Special:Search') || path.includes('/w/index.php');
    }
    return false;
  } catch {
    return false;
  }
}

/** Resolve an href from a loaded search page into a navigable http(s) result URL. */
export function resolveResultUrl(href: string, base: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(href, base);
  } catch {
    return undefined;
  }
  const uddg = parsed.searchParams.get('uddg');
  if (uddg) {
    try {
      parsed = new URL(uddg);
    } catch {
      return undefined;
    }
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
  if (isSearchResultsPage(parsed.toString())) return undefined;
  if (isUnreviewedMarketplaceHost(parsed.toString())) return undefined;
  return parsed.toString();
}

/**
 * Result URLs the search page actually emitted. Empty hrefs stay empty —
 * this never invents a destination to keep maxItems satisfied.
 */
export function selectResultUrls(
  hrefs: readonly string[],
  searchBase: string,
  maxItems: number,
): readonly string[] {
  const targets: string[] = [];
  const seen = new Set<string>();
  for (const href of hrefs) {
    const resolved = resolveResultUrl(href, searchBase);
    if (!resolved) continue;
    const key = canonicalUrl(resolved);
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push(resolved);
    if (targets.length >= maxItems) break;
  }
  return targets;
}

export async function loadQueryPagesFromEndpoints(input: {
  readonly query: string;
  readonly maxItems: number;
  readonly cdpEndpoint?: string | null;
  readonly wsEndpoint?: string | null;
}): Promise<SessionPageLoad> {
  const cdp = input.cdpEndpoint?.trim();
  const ws = input.wsEndpoint?.trim();
  const endpoint = cdp || ws;
  if (!endpoint) {
    throw new CapabilityUnsupportedError(
      'solari',
      'research.browser_session',
      'Session has neither cdpEndpoint nor wsEndpoint; cannot observe which pages actually loaded.',
    );
  }
  return openLoadedPagesViaCdp({
    cdpEndpoint: endpoint,
    query: input.query,
    maxItems: input.maxItems,
  });
}

export async function openLoadedPagesViaCdp(input: {
  readonly cdpEndpoint: string;
  readonly query: string;
  readonly maxItems: number;
}): Promise<SessionPageLoad> {
  const endpoint = input.cdpEndpoint.trim();
  if (!endpoint) {
    throw new CapabilityUnsupportedError(
      'solari',
      'research.browser_session',
      'Session has no cdpEndpoint or wsEndpoint; cannot observe which pages actually loaded.',
    );
  }

  const cdp = await connectWithRetry(endpoint);
  const loaded: LoadedBrowserPage[] = [];
  try {
    await cdp.attachToPage();
    const hrefs: string[] = [];
    let searchBase = '';
    for (const searchUrl of searchPageUrls(input.query)) {
      assertNavigationPermitted(searchUrl);
      const page = await cdp.navigate(searchUrl);
      if (!page) continue;
      loaded.push(page);
      searchBase = page.url;
      hrefs.push(...(await cdp.resultHrefs()));
      if (hrefs.length > 0) break;
    }

    const targets = selectResultUrls(hrefs, searchBase, input.maxItems);

    const evidence: LoadedBrowserPage[] = [];
    for (const url of targets) {
      const page = await cdp.navigate(url);
      if (!page) continue;
      loaded.push(page);
      if (isSearchResultsPage(page.url)) continue;
      evidence.push(page);
    }
    getLogger().info(
      { endpointHost: safeHost(endpoint), loaded: loaded.map((p) => p.url), evidence: evidence.length },
      'solari session pages loaded',
    );
    return { evidence, loaded };
  } finally {
    await cdp.close();
  }
}

function canonicalUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname.replace(/\/$/, '')}`;
  } catch {
    return url;
  }
}

function safeHost(endpoint: string): string {
  try {
    return new URL(endpoint).host;
  } catch {
    return 'invalid';
  }
}

async function connectWithRetry(url: string): Promise<CdpClient> {
  let last: unknown;
  for (let attempt = 1; attempt <= CONNECT_ATTEMPTS; attempt += 1) {
    try {
      return await CdpClient.connect(url);
    } catch (error) {
      last = error;
      getLogger().warn({ attempt, err: error instanceof Error ? error.message : String(error) }, 'solari CDP connect failed');
      if (attempt < CONNECT_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, CONNECT_RETRY_MS));
      }
    }
  }
  if (last instanceof Error) throw last;
  throw new CapabilityUnsupportedError(
    'solari',
    'research.browser_session',
    'CDP websocket failed to connect; the session cannot be driven',
  );
}

interface CdpResponse {
  readonly id?: number;
  readonly method?: string;
  readonly params?: unknown;
  readonly result?: unknown;
  readonly error?: { readonly message?: string; readonly code?: number };
  readonly sessionId?: string;
}

class CdpClient {
  #ws: WebSocket;
  #nextId = 1;
  #sessionId: string | undefined;
  #pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  #waiters: Array<{ method: string; resolve: (params: unknown) => void }> = [];

  private constructor(ws: WebSocket) {
    this.#ws = ws;
    ws.on('message', (data) => this.#onMessage(String(data)));
    ws.on('close', () => {
      for (const pending of this.#pending.values()) {
        pending.reject(new Error('CDP websocket closed'));
      }
      this.#pending.clear();
    });
  }

  static connect(url: string): Promise<CdpClient> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const timer = setTimeout(() => {
        ws.terminate();
        reject(
          new CapabilityUnsupportedError(
            'solari',
            'research.browser_session',
            `Timed out connecting to CDP endpoint after ${CONNECT_TIMEOUT_MS}ms`,
          ),
        );
      }, CONNECT_TIMEOUT_MS);
      ws.once('open', () => {
        clearTimeout(timer);
        resolve(new CdpClient(ws));
      });
      ws.once('error', () => {
        clearTimeout(timer);
        reject(
          new CapabilityUnsupportedError(
            'solari',
            'research.browser_session',
            'CDP websocket failed to connect; the session cannot be driven',
          ),
        );
      });
    });
  }

  async attachToPage(): Promise<void> {
    await this.send('Target.setDiscoverTargets', { discover: true }).catch(() => undefined);
    await this.send('Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
    }).catch(() => undefined);

    const targets = await this.send('Target.getTargets');
    const infos = targetInfos(targets);
    let page = infos.find((t) => t.type === 'page' && !t.url.startsWith('devtools://'));
    if (!page) {
      const created = await this.send('Target.createTarget', { url: 'about:blank' });
      const targetId = asRecord(created)['targetId'];
      if (typeof targetId !== 'string') {
        throw new CapabilityUnsupportedError(
          'solari',
          'research.browser_session',
          'Target.createTarget did not return a targetId',
        );
      }
      page = { targetId, type: 'page', url: 'about:blank' };
    }

    const attached = await this.send('Target.attachToTarget', { targetId: page.targetId, flatten: true });
    const sessionId = asRecord(attached)['sessionId'];
    if (typeof sessionId === 'string' && sessionId.length > 0) {
      this.#sessionId = sessionId;
    }
    await this.send('Page.enable');
    await this.send('Runtime.enable');
  }

  async navigate(url: string): Promise<LoadedBrowserPage | undefined> {
    const load = this.waitFor('Page.loadEventFired', NAVIGATE_TIMEOUT_MS);
    const nav = await this.send('Page.navigate', { url }).catch((error: unknown) => {
      getLogger().warn({ url, err: error instanceof Error ? error.message : String(error) }, 'solari Page.navigate failed');
      return undefined;
    });
    if (nav === undefined) {
      await load.catch(() => undefined);
      return undefined;
    }
    const errorText = asRecord(nav)['errorText'];
    if (typeof errorText === 'string' && errorText.length > 0) {
      await load.catch(() => undefined);
      return undefined;
    }
    await load.catch(() => undefined);
    const location = await this.evaluate<{ url?: unknown; title?: unknown }>(
      `(() => ({ url: location.href, title: document.title || '' }))()`,
    );
    const loadedUrl = typeof location?.url === 'string' ? location.url : '';
    if (!isLoadedHttpUrl(loadedUrl)) return undefined;
    const title = typeof location?.title === 'string' ? location.title : '';
    return { url: loadedUrl, title };
  }

  async resultHrefs(): Promise<readonly string[]> {
    const hrefs = await this.evaluate<unknown>(
      `(() => {
        const preferred = document.querySelectorAll(
          'a.result__a, a.result-link, ol#b_results h2 a, a[data-testid="result-title-a"], .mw-search-result-heading a, .mw-search-results a'
        );
        const nodes = preferred.length > 0 ? preferred : document.querySelectorAll('a[href]');
        return Array.from(nodes).map((a) => a.href).filter(Boolean);
      })()`,
    );
    return Array.isArray(hrefs) ? hrefs.filter((h): h is string => typeof h === 'string') : [];
  }

  async evaluate<T>(expression: string): Promise<T | undefined> {
    const result = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    const rec = asRecord(result);
    const inner = asRecord(rec['result']);
    return inner['value'] as T | undefined;
  }

  send(method: string, params?: Record<string, unknown>): Promise<unknown> {
    const id = this.#nextId++;
    const payload: Record<string, unknown> = { id, method };
    if (params) payload['params'] = params;
    if (this.#sessionId && !method.startsWith('Target.') && !method.startsWith('Browser.')) {
      payload['sessionId'] = this.#sessionId;
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`CDP ${method} timed out after ${NAVIGATE_TIMEOUT_MS}ms`));
      }, NAVIGATE_TIMEOUT_MS);
      this.#pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.#ws.send(JSON.stringify(payload));
    });
  }

  waitFor(method: string, timeoutMs: number): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#waiters = this.#waiters.filter((w) => w.method !== method);
        reject(new Error(`Timed out waiting for ${method}`));
      }, timeoutMs);
      this.#waiters.push({
        method,
        resolve: (params) => {
          clearTimeout(timer);
          resolve(params);
        },
      });
    });
  }

  async close(): Promise<void> {
    try {
      this.#ws.close();
    } catch {
      // already closed
    }
  }

  #onMessage(raw: string): void {
    let message: CdpResponse;
    try {
      message = JSON.parse(raw) as CdpResponse;
    } catch {
      return;
    }
    if (typeof message.id === 'number') {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(message.error.message ?? `CDP error ${message.error.code ?? ''}`));
        return;
      }
      pending.resolve(message.result);
      return;
    }
    if (typeof message.method === 'string') {
      const idx = this.#waiters.findIndex((w) => w.method === message.method);
      if (idx >= 0) {
        const waiter = this.#waiters.splice(idx, 1)[0];
        waiter?.resolve(message.params);
      }
    }
  }
}

function targetInfos(result: unknown): Array<{ targetId: string; type: string; url: string }> {
  const rec = asRecord(result);
  const list = rec['targetInfos'];
  if (!Array.isArray(list)) return [];
  const out: Array<{ targetId: string; type: string; url: string }> = [];
  for (const item of list) {
    const row = asRecord(item);
    if (typeof row['targetId'] === 'string') {
      out.push({
        targetId: row['targetId'],
        type: typeof row['type'] === 'string' ? row['type'] : '',
        url: typeof row['url'] === 'string' ? row['url'] : '',
      });
    }
  }
  return out;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function isLoadedHttpUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    if (parsed.hostname === 'localhost' || parsed.hostname.endsWith('.invalid')) return false;
    return true;
  } catch {
    return false;
  }
}
