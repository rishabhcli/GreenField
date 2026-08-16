import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';

/**
 * Operator console verification.
 *
 * Like the landing page, the console is dependency-free static assets, so these
 * checks are structural rather than rendering tests. Three of them are real
 * drift detectors rather than smoke:
 *
 *   - every `$('id')` the script reaches for must exist in the document,
 *   - every API path the console calls must exist in `apps/api/src/routes`,
 *   - the phase rail must match `LOOP_PHASE_ORDER` in `@foundry/core`.
 *
 * Those three are the ways this page can rot without anyone noticing: the API
 * moves, and a static console keeps rendering a confident-looking empty state.
 */
const siteDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = join(siteDir, '..', '..');

function read(rel: string, base = siteDir): string {
  const p = join(base, rel);
  expect(existsSync(p), `missing ${rel}`).toBe(true);
  return readFileSync(p, 'utf8');
}

describe('operator console', () => {
  const html = read('console.html');
  const css = read('assets/console.css');
  const js = read('assets/console.js');

  it('references resolve to real files', () => {
    const refs = [...html.matchAll(/(?:href|src)="\.\/([^"]+)"/g)].map((m) => m[1] ?? '');
    expect(refs.length).toBeGreaterThanOrEqual(3);
    for (const ref of refs) {
      expect(existsSync(join(siteDir, ref)), `broken reference: ${ref}`).toBe(true);
    }
  });

  it('script compiles as valid JavaScript', () => {
    expect(() => new Script(js)).not.toThrow();
  });

  it('stylesheet is balanced', () => {
    const opens = (css.match(/{/g) ?? []).length;
    const closes = (css.match(/}/g) ?? []).length;
    expect(opens).toBe(closes);
    expect(css).toContain('prefers-reduced-motion');
  });

  it('every element the script looks up exists in the document', () => {
    const ids = new Set([...js.matchAll(/\$\('([A-Za-z0-9_-]+)'\)/g)].map((m) => m[1] ?? ''));
    // getElementById calls made outside the `$` helper.
    for (const m of js.matchAll(/getElementById\('([A-Za-z0-9_-]+)'\)/g)) ids.add(m[1] ?? '');

    expect(ids.size).toBeGreaterThan(10);
    const missing = [...ids].filter((id) => !html.includes(`id="${id}"`));
    expect(missing, `script references ids not in console.html: ${missing.join(', ')}`).toEqual([]);
  });

  /**
   * Extracts the first argument of every `api(...)` call, then reduces it to a
   * route shape: the literal segments joined by `:param` wherever the console
   * interpolated a value. `api('/api/approvals/' + encodeURIComponent(id) +
   * '/decide')` becomes `/api/approvals/:param/decide`.
   */
  function calledPaths(source: string): string[] {
    const paths: string[] = [];
    const marker = 'api(';
    for (let i = source.indexOf(marker); i !== -1; i = source.indexOf(marker, i + 1)) {
      // Skip `capi(`-style false positives: the char before must not be a word char.
      if (i > 0 && /[\w.]/.test(source[i - 1] ?? '')) continue;

      let depth = 1;
      let quote: string | null = null;
      let arg = '';
      for (let j = i + marker.length; j < source.length && depth > 0; j++) {
        const ch = source[j] ?? '';
        if (quote) {
          if (ch === quote && source[j - 1] !== '\\') quote = null;
          arg += ch;
          continue;
        }
        if (ch === "'" || ch === '"' || ch === '`') quote = ch;
        else if (ch === '(') depth++;
        else if (ch === ')') depth--;
        else if (ch === ',' && depth === 1) break;
        if (depth > 0) arg += ch;
      }

      const literals = [...arg.matchAll(/'([^']*)'/g)].map((m) => m[1] ?? '');
      if (!literals.length || !literals[0]?.startsWith('/')) continue;
      paths.push(literals.join(':param').split('?')[0] ?? '');
    }
    return [...new Set(paths)];
  }

  it('calls only API paths that the API actually registers', () => {
    const registered = ['agent-activity.ts', 'commerce.ts', 'company.ts', 'governance.ts', 'readiness.ts']
      .map((f) => read(join('apps', 'api', 'src', 'routes', f), repoRoot))
      .join('\n');

    const called = calledPaths(js);
    expect(called.length).toBeGreaterThanOrEqual(10);

    for (const path of called) {
      const pattern = path
        .split(':param')
        .map((seg) => seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join(':[A-Za-z]+');
      const found = new RegExp(`['"\`]${pattern}['"\`]`).test(registered);
      expect(found, `console calls ${path}, which no route file registers`).toBe(true);
    }
  });

  it('phase rail matches LOOP_PHASE_ORDER in core', () => {
    const domain = read(join('packages', 'core', 'src', 'domain', 'company.ts'), repoRoot);
    const block = domain.match(/export const LoopPhase = z\.enum\(\[([\s\S]*?)\]\)/);
    expect(block, 'could not find LoopPhase in core').toBeTruthy();
    const corePhases = [...(block?.[1] ?? '').matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);

    const railBlock = js.match(/var PHASES = \[([\s\S]*?)\];/);
    expect(railBlock, 'could not find PHASES in console.js').toBeTruthy();
    const railPhases = [...(railBlock?.[1] ?? '').matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);

    expect(railPhases).toEqual(corePhases);
  });

  it('renders no fabricated figures before data arrives', () => {
    // The static document must not ship a number that looks like live data.
    // Em dashes and skeletons are the only permitted placeholders.
    const body = html.slice(html.indexOf('<main'));
    expect(body).not.toMatch(/\$\d/);
    expect(body).not.toMatch(/\d+(\.\d+)?%/);
    expect(html).toContain('—');
  });

  it('states plainly that its figures are live', () => {
    expect(html).toContain('read live from the running API');
    expect(html).toContain('Nothing here is illustrative');
  });

  it('maps blocked and failed provider states to distinct squares', () => {
    expect(js).toContain('function providerSquare');
    expect(js).toContain('sq-blocked');
    expect(js).toContain('sq-fail');
    expect(js).toContain("state.indexOf('blocked_') === 0");
    expect(js).toContain("=== 'verification_failed'");
    const sharedCss = read('assets/styles.css');
    expect(sharedCss).toContain('.sq-blocked');
    expect(sharedCss).toContain('.sq-fail');
  });

  it('never upgrades a capability state on the client', () => {
    // `live_verified` may only be compared against, never assigned. The console
    // reads the field; it must not construct it. The lookbehind is what makes
    // this meaningful — `=== 'live_verified'` is exactly what we want to see.
    expect(js).not.toMatch(/(?<![=!<>])=\s*['"]live_verified['"]/);
    expect(js).toContain("=== 'live_verified'");
  });

  it('sends the bearer token on every request once it is present', () => {
    // Gated reads (approvals, audit, orders list) and writes share one helper.
    // `opts.auth` must not be required — forgetting it would 403 the console.
    expect(js).toContain("if (auth.token) headers.Authorization = 'Bearer ' + auth.token");
    expect(js).not.toContain('if (opts.auth && auth.token)');
  });

  it('keeps the operator token out of durable storage', () => {
    // The token lives in sessionStorage only. localStorage is used solely for
    // the API base URL, which is not a secret.
    const localStorageWrites = [...js.matchAll(/localStorage\.setItem\('([^']+)'/g)].map((m) => m[1]);
    expect(localStorageWrites).toEqual(['yf.apiBase']);
    expect(js).toContain("sessionStorage.setItem('yf.token'");
  });

  it('replaces every skeleton with a failure state when the API is unreachable', () => {
    // A skeleton means "not yet known". Once a read has failed, leaving one up
    // would report a dead API as a slow one.
    expect(js).toContain('function renderUnreachable');

    const fn = js.slice(js.indexOf('function renderUnreachable'));
    const bodyIds = [
      'approvalsBody',
      'switchBody',
      'budgetBody',
      'runsBody',
      'providerBody',
      'orderBody',
      'auditBody',
      'feedBody',
    ];
    const covered = fn.slice(0, fn.indexOf('/* ---'));
    for (const id of bodyIds) {
      expect(covered.includes(id), `renderUnreachable does not clear ${id}`).toBe(true);
    }
    expect(covered).toContain("emptyState(text, 'danger'");
    expect(js).toContain('renderUnreachable(');
  });

  /**
   * The defect this pins: `configured` was derived from the response body
   * before `res.ok` was checked, so a 403 (no operator token) rendered six
   * panels as "No company configured yet." — a false statement about a running
   * company. Unauthenticated, unconfigured, failed and unreachable must be
   * four different renders.
   */
  describe('unauthenticated is not "no company"', () => {
    it('classifies 401/403 as locked, distinct from absent and failed', () => {
      expect(js).toContain('function readState');
      const fn = js.slice(js.indexOf('function readState'), js.indexOf('function panelState'));
      expect(fn).toContain("res.status === 401 || res.status === 403");
      expect(fn).toContain("return 'locked'");
      expect(fn).toContain("configured === false");
      expect(fn).toContain("return 'absent'");
      expect(fn).toContain("return 'unreachable'");
      expect(fn).toContain("return 'failed'");
      // The status check must precede the body check, which is exactly the
      // ordering the original bug got wrong.
      expect(fn.indexOf("res.status === 401")).toBeLessThan(fn.indexOf('configured === false'));
    });

    it('never derives company state from the body without checking the status', () => {
      expect(js).not.toContain('companyRes.ok && companyRes.data && companyRes.data.configured');
      expect(js).not.toContain('var configured =');
    });

    it('routes every panel through one gate so none can invent its own 403 copy', () => {
      expect(js).toContain('function gateHtml');
      expect(js).toContain('function panelState');
      for (const fn of [
        'renderApprovals',
        'renderSwitches',
        'renderBudgets',
        'renderRuns',
        'renderOrders',
        'renderAudit',
        'renderFeed',
      ]) {
        const body = js.slice(js.indexOf(`function ${fn}(`), js.indexOf(`function ${fn}(`) + 700);
        expect(body.includes('gateHtml('), `${fn} does not use the shared gate`).toBe(true);
      }
      // The "no company" copy must be emitted from exactly one place — the
      // gate — so it can never be reached by a panel that only saw a 403.
      const emitted = js.split("'No company configured yet.").length - 1;
      expect(emitted).toBe(1);
    });

    it('points a locked operator at the token control instead of at Render', () => {
      expect(html).toContain('id="authBanner"');
      expect(html).toContain('id="authBannerBtn"');
      expect(js).toContain("$('authBanner')");
      expect(js).toContain("conn.set('locked'");
      expect(css).toContain('.cnsl-locked');
      expect(css).toContain(".cnsl-conn[data-state='locked']");
      // A 403 must not be reported as an unreachable API: the locked branch
      // has to reach `conn.set('locked')` before any `down` fallback.
      const poll = js.slice(js.indexOf('function poll('), js.indexOf('Actions'));
      expect(poll).toContain('var locked =');
      const lockedBranch = poll.slice(poll.indexOf('} else if (locked) {'));
      expect(lockedBranch.slice(0, lockedBranch.indexOf('conn.set(') + 24)).toContain("conn.set('locked'");
    });

    it('says in the copy that reads are gated, not that they work without a token', () => {
      expect(html).toContain('Reads are gated too');
      expect(html).not.toContain('Reads work without it');
    });
  });

  /**
   * The console used to promise the operator's typed name was written to the
   * audit chain as the deciding actor. It is not: the audit actor is the
   * authenticated `operator`. The name now rides along as an annotation and
   * the copy must say exactly that.
   */
  describe('decision attribution', () => {
    it('sends the typed name as a label, never as the actor', () => {
      expect(js).toContain('decidedByLabel: auth.operator');
      expect(js).toContain('releasedByLabel: auth.operator');
      expect(js).not.toContain('decidedBy: auth.operator');
      expect(js).not.toContain('releasedBy: auth.operator');
    });

    it('describes the label as unverified rather than as the deciding actor', () => {
      expect(js).toContain('an unverified label, not a verified identity');
      expect(html).toContain('operatorLabel');
      expect(html).not.toContain('audit chain as the deciding actor');
    });

    it('is backed by a route that records it in detail, not in actor_id', () => {
      const route = read(join('apps', 'api', 'src', 'routes', 'governance.ts'), repoRoot);
      expect(route).toContain('decidedByLabel');
      expect(route).toContain('operatorLabel: body.decidedByLabel');
      // actorId stays the authenticated operator on every mutating route.
      expect(route).not.toMatch(/actorId:\s*body\./);
    });
  });

  /**
   * The agent interaction feed. Its whole value is that an observer can watch
   * the company act, so the two things it must never do are dump a model's
   * `thinking` signature blob and render a secret.
   */
  describe('agent interaction feed', () => {
    it('renders a feed panel wired to a bounded, authed endpoint', () => {
      expect(html).toContain('id="feedBody"');
      expect(html).toContain('id="feedCount"');
      expect(html).toContain('id="feedNote"');
      expect(js).toContain('function renderFeed');
      expect(js).toContain('/api/agent-activity?limit=');
      expect(js).toMatch(/var FEED_LIMIT = \d+/);
      expect(js).toMatch(/var FEED_RUNS = \d+/);
      expect(css).toContain('.cnsl-step');
    });

    it('renders every step kind the API can emit', () => {
      const route = read(join('apps', 'api', 'src', 'routes', 'agent-activity.ts'), repoRoot);
      const kinds = [...route.matchAll(/'(system|prompt|thinking|assistant_text|tool_call|tool_result|tool_error)'/g)]
        .map((m) => m[1] ?? '');
      const label = js.slice(js.indexOf('var STEP_LABEL'), js.indexOf('var STEP_TONE'));
      for (const kind of new Set(kinds)) {
        expect(label.includes(kind), `console has no label for step kind ${kind}`).toBe(true);
      }
    });

    it('escapes every field it renders and never trusts a raw signature', () => {
      const fn = js.slice(js.indexOf('function renderFeed'), js.indexOf('function renderUnreachable'));
      // Every interpolated step field goes through esc().
      const interpolated = [...fn.matchAll(/\+\s*(st\.[A-Za-z]+)\s*\+/g)].map((m) => m[1]);
      expect(interpolated, 'unescaped step field interpolated into HTML').toEqual([]);
      expect(fn).toContain('esc(');
      expect(js).not.toContain('signature');
    });

    it('is bounded so a polling console cannot ask for the whole table', () => {
      const route = read(join('apps', 'api', 'src', 'routes', 'agent-activity.ts'), repoRoot);
      expect(route).toContain('.max(200)');
      expect(route).toContain('.max(25)');
      const repo = read(join('packages', 'db', 'src', 'repositories', 'agents.ts'), repoRoot);
      expect(repo).toContain('recentForCompany');
      expect(repo).toContain('LIMIT');
      // No ad-hoc SQL in the route — the repository owns the query.
      expect(route).not.toMatch(/SELECT\s/i);
    });
  });

  it('never reassures on a value it did not read', () => {
    // `null` is "not read", which is not `0`. The KPI footers must not say
    // "all clear" or "nothing queued" for an unread count.
    const kpi = js.slice(js.indexOf('function renderKpis'), js.indexOf('function renderApprovals'));
    for (const phrase of ['all clear', 'nothing queued']) {
      const idx = kpi.indexOf(phrase);
      expect(idx, `missing ${phrase}`).toBeGreaterThan(-1);
      // Each reassurance must be guarded by an explicit null check.
      expect(kpi.slice(Math.max(0, idx - 200), idx)).toMatch(/=== null \?/);
    }
    expect(kpi).toContain("var unread = 'not read'");
  });

  it('distinguishes loading, empty and failed states', () => {
    for (const fn of ['skeleton', 'emptyState']) {
      expect(js.includes(`function ${fn}`), `missing ${fn}`).toBe(true);
    }
    // The disconnected banner lives in the document and is toggled by the
    // connection state, so it is the markup and the stylesheet that must carry it.
    expect(html).toContain('id="offlineBanner"');
    expect(js).toContain("$('offlineBanner')");
    expect(css).toContain('.cnsl-offline');
    expect(css).toContain('.cnsl-skel');
    expect(css).toContain('.cnsl-empty');
  });

  it('escapes every interpolated value', () => {
    expect(js).toContain('function esc(');
    // A rough guard against raw interpolation into innerHTML: every template
    // concatenation of a data field should pass through esc().
    const rawInterpolations = [...js.matchAll(/\+\s*(?:a|b|c|e|o|p|r|u)\.[A-Za-z]+\s*\+/g)];
    expect(rawInterpolations, 'unescaped field interpolated into HTML').toEqual([]);
  });

  it('meets baseline accessibility markup', () => {
    expect(html).toContain('lang="en"');
    expect(html).toContain('skip-link');
    expect(html).toContain('name="viewport"');
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('aria-live="polite"');
  });

  it('loads no third-party scripts besides fonts', () => {
    const scripts = [...html.matchAll(/<script[^>]*src="([^"]+)"/g)].map((m) => m[1] ?? '');
    for (const src of scripts) {
      expect(src.startsWith('./'), `unexpected external script: ${src}`).toBe(true);
    }
  });

  it('is reachable from the landing page', () => {
    expect(read('index.html')).toContain('./console.html');
  });

  describe('storefronts gallery', () => {
    const brands = [
      'solenne',
      'northline',
      'lumen',
      'marrow',
      'vesper',
      'fieldwork',
      'aurelia',
      'kite',
    ] as const;

    it('names the Linq thread as the consumer store above the brand windows', () => {
      expect(html).toContain('id="linqStoreNumber"');
      expect(html).toContain('id="linqStoreNote"');
      expect(html).toContain('id="linqStoreLink"');
      expect(html).toContain('id="linqStoreReady"');
      expect(html).toContain('Consumer store');
      expect(js).toContain('/api/store');
    });

    it('ships eight branded sites with local photography', () => {
      expect(html).toContain('id="storefrontsGrid"');
      expect(html).toContain('id="storefrontStage"');
      expect(html).toContain('id="storefrontFrame"');
      expect(js).toContain('function openStorefront');
      expect(css).toContain('.sf-bento');
      expect(css).toContain('.sf-strip');
      for (const brand of brands) {
        expect(existsSync(join(siteDir, `storefronts/${brand}.html`)), `missing ${brand} storefront`).toBe(true);
        expect(existsSync(join(siteDir, `assets/storefronts/${brand}-1.jpg`)), `missing ${brand} photo`).toBe(true);
        expect(html).toContain(`./storefronts/${brand}.html`);
        expect(html).toContain(`./assets/storefronts/${brand}-1.jpg`);
      }
    });

    it('does not label the storefronts as a demo or an illustration', () => {
      const deck = html.slice(html.indexOf('STOREFRONTS'), html.indexOf('PHASE RAIL'));
      expect(deck.toLowerCase()).not.toMatch(/demo|illustrat|sample|placeholder|fake/);
      for (const brand of brands) {
        const page = read(`storefronts/${brand}.html`);
        expect(page.toLowerCase()).not.toMatch(/demo|lorem ipsum|sample store/);
      }
    });

    it('opens the site in-console and never asks the API for the gallery', () => {
      expect(js).toContain("document.querySelectorAll('[data-sf]')");
      expect(js).toContain('closeStorefront');
      const called = calledPaths(js);
      expect(called.some((p) => p.includes('storefront') || p.includes('site'))).toBe(false);
    });
  });

  /**
   * The site and API are different Render services. Defaulting to
   * `window.location.origin` fetches `/readiness/company` from the static
   * host, which answers HTTP 404 — the exact operator-visible failure.
   * `?api=` must not persist an untrusted host (that would send the operator
   * token elsewhere).
   */
  describe('API base', () => {
    const DEPLOYED_API = 'https://foundry-api-8ih0.onrender.com';
    const config = read('assets/console-config.js');
    const resolveFn = js.slice(js.indexOf('function resolveApiBase'), js.indexOf('var API ='));

    it('bakes the deployed API origin so the console does not need ?api=', () => {
      expect(config).toContain(`window.YELLOFIELD_API_BASE = '${DEPLOYED_API}'`);
      expect(html).toContain(`data-api="${DEPLOYED_API}"`);
      expect(js).toContain(DEPLOYED_API);
      expect(resolveFn).not.toMatch(/return window\.location\.origin/);
    });

    it('persists ?api= only when the origin is the known API host', () => {
      expect(resolveFn).toContain("localStorage.setItem('yf.apiBase'");
      expect(resolveFn).not.toContain("localStorage.setItem('yf.apiBase', fromQuery)");
      expect(resolveFn).toMatch(/isAllowedApiBase|ALLOWED_API/);
    });

    it('still loads console-config.js before console.js', () => {
      const scripts = [...html.matchAll(/<script[^>]*src="([^"]+)"/g)].map((m) => m[1] ?? '');
      expect(scripts).toEqual(['./assets/console-config.js', './assets/console.js']);
    });
  });
});
