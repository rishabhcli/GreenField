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
    const registered = ['commerce.ts', 'company.ts', 'governance.ts', 'readiness.ts']
      .map((f) => read(join('apps', 'api', 'src', 'routes', f), repoRoot))
      .join('\n');

    const called = calledPaths(js);
    expect(called.length).toBeGreaterThanOrEqual(9);

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

  it('never upgrades a capability state on the client', () => {
    // `live_verified` may only be compared against, never assigned. The console
    // reads the field; it must not construct it. The lookbehind is what makes
    // this meaningful — `=== 'live_verified'` is exactly what we want to see.
    expect(js).not.toMatch(/(?<![=!<>])=\s*['"]live_verified['"]/);
    expect(js).toContain("=== 'live_verified'");
  });

  it('keeps the operator token out of durable storage', () => {
    // The token lives in sessionStorage only. localStorage is used solely for
    // the API base URL, which is not a secret.
    const localStorageWrites = [...js.matchAll(/localStorage\.setItem\('([^']+)'/g)].map((m) => m[1]);
    expect(localStorageWrites).toEqual(['yf.apiBase']);
    expect(js).toContain("sessionStorage.setItem('yf.token'");
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
});
