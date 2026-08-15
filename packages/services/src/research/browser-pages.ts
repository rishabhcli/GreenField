/**
 * Drive a Solari (or other CDP) browser session and report pages that actually
 * loaded. Search-engine HTML is used only as a navigation source — result URLs
 * are recorded after the session opens them, never invented.
 */

import { CapabilityUnsupportedError } from '@foundry/core';

export interface LoadedBrowserPage {
  readonly url: string;
  readonly title: string;
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
const NAVIGATE_TIMEOUT_MS = 15_000;

export function searchPageUrls(query: string): readonly string[] {
  const q = query.trim();
  const ddg = new URL('https://html.duckduckgo.com/html/');
  ddg.searchParams.set('q', q);
  const bing = new URL('https://www.bing.com/search');
  bing.searchParams.set('q', q);
  return [ddg.toString(), bing.toString()];
}

export function isSearchHost(hostname: string): boolean {
  const host = hostname.replace(/^www\./, '').toLowerCase();
  if (SEARCH_HOSTS.has(hostname.toLowerCase()) || SEARCH_HOSTS.has(host)) return true;
  return host.endsWith('.duckduckgo.com') || host.endsWith('.bing.com') || host.endsWith('.google.com');
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
  if (isSearchHost(parsed.hostname)) return undefined;
  return parsed.toString();
}

export async function openLoadedPagesViaCdp(input: {
  readonly cdpEndpoint: string;
  readonly query: string;
  readonly maxItems: number;
}): Promise<readonly LoadedBrowserPage[]> {
  const endpoint = input.cdpEndpoint.trim();
  if (!endpoint) {
    throw new CapabilityUnsupportedError(
      'solari',
      'research.browser_session',
      'Session has no cdpEndpoint; cannot observe which pages actually loaded.',
    );
  }

  const cdp = await CdpClient.connect(endpoint);
  try {
    await cdp.attachToPage();
    const hrefs: string[] = [];
    let searchBase = '';
    for (const searchUrl of searchPageUrls(input.query)) {
      const loaded = await cdp.navigate(searchUrl);
      if (!loaded) continue;
      searchBase = loaded.url;
      hrefs.push(...(await cdp.resultHrefs()));
      if (hrefs.length > 0) break;
    }

    const targets: string[] = [];
    const seen = new Set<string>();
    for (const href of hrefs) {
      const resolved = resolveResultUrl(href, searchBase);
      if (!resolved) continue;
      const key = canonicalUrl(resolved);
      if (seen.has(key)) continue;
      seen.add(key);
      targets.push(resolved);
      if (targets.length >= input.maxItems) break;
    }

    const pages: LoadedBrowserPage[] = [];
    for (const url of targets) {
      const loaded = await cdp.navigate(url);
      if (!loaded) continue;
      if (isSearchHost(new URL(loaded.url).hostname)) continue;
      pages.push(loaded);
    }
    return pages;
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
    ws.addEventListener('message', (event) => this.#onMessage(String(event.data)));
    ws.addEventListener('close', () => {
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
        ws.close();
        reject(
          new CapabilityUnsupportedError(
            'solari',
            'research.browser_session',
            `Timed out connecting to CDP endpoint after ${CONNECT_TIMEOUT_MS}ms`,
          ),
        );
      }, CONNECT_TIMEOUT_MS);
      ws.addEventListener('open', () => {
        clearTimeout(timer);
        resolve(new CdpClient(ws));
      });
      ws.addEventListener('error', () => {
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
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new CapabilityUnsupportedError(
        'solari',
        'research.browser_session',
        'Target.attachToTarget did not return a sessionId',
      );
    }
    this.#sessionId = sessionId;
    await this.send('Page.enable');
    await this.send('Runtime.enable');
  }

  async navigate(url: string): Promise<LoadedBrowserPage | undefined> {
    const load = this.waitFor('Page.loadEventFired', NAVIGATE_TIMEOUT_MS);
    const nav = await this.send('Page.navigate', { url });
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
          'a.result__a, a.result-link, ol#b_results h2 a, a[data-testid="result-title-a"]'
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
