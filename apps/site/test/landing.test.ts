import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';

/**
 * Landing page smoke verification.
 *
 * The page is intentionally dependency-free static assets, so the checks here
 * are structural: the document exists, references resolve, the script
 * compiles, and the honest-copy invariants the project is built on are
 * present. This is a smoke gate, not a rendering test.
 */
const siteDir = join(dirname(fileURLToPath(import.meta.url)), '..');

function read(rel: string): string {
  const p = join(siteDir, rel);
  expect(existsSync(p), `missing ${rel}`).toBe(true);
  return readFileSync(p, 'utf8');
}

describe('landing page', () => {
  const html = read('index.html');
  const css = read('assets/styles.css');
  const js = read('assets/main.js');

  it('references resolve to real files', () => {
    const refs = [...html.matchAll(/(?:href|src)="\.\/([^"]+)"/g)].map((m) => m[1] ?? '');
    expect(refs.length).toBeGreaterThanOrEqual(2);
    for (const ref of refs) {
      expect(existsSync(join(siteDir, ref)), `broken reference: ${ref}`).toBe(true);
    }
  });

  it('has the required section structure', () => {
    for (const id of ['main', 'nav', 'top', 'loop', 'organization', 'infrastructure', 'evidence']) {
      expect(html.includes(`id="${id}"`), `missing #${id}`).toBe(true);
    }
    expect(html.includes('<h1')).toBe(true);
    expect(html.includes('<footer')).toBe(true);
  });

  it('exposes exactly the twelve sponsors', () => {
    const sponsors = [
      'Terac',
      'Stripe',
      'Lovable',
      'Whop',
      'Render',
      'Linq',
      'Superserve',
      'Replay',
      'BAND',
      'Dodo Payments',
      'Sandbox0',
      'Solari',
    ];
    for (const s of sponsors) {
      expect(html.includes(s), `missing sponsor: ${s}`).toBe(true);
    }
  });

  it('keeps the honest-status claims intact', () => {
    expect(html).toContain('356');
    expect(html).toContain('probe verified');
    expect(html).toContain('surface built');
    expect(html).toContain('NOT COMPLETE');
    expect(html).toContain('Illustrative operating view');
  });

  it('script compiles as valid JavaScript', () => {
    expect(() => new Script(js)).not.toThrow();
  });

  it('stylesheet is balanced and compositor-friendly', () => {
    const opens = (css.match(/{/g) ?? []).length;
    const closes = (css.match(/}/g) ?? []).length;
    expect(opens).toBe(closes);
    expect(css).toContain('prefers-reduced-motion');
    expect(css).toContain('backdrop-filter');
  });

  it('meets baseline accessibility markup', () => {
    expect(html).toContain('lang="en"');
    expect(html).toContain('skip-link');
    expect(html).toContain('name="viewport"');
    expect(html).toContain('aria-hidden="true"');
    expect(css).toContain(':focus-visible');
  });

  it('loads no third-party scripts besides fonts', () => {
    const scripts = [...html.matchAll(/<script[^>]*src="([^"]+)"/g)].map((m) => m[1] ?? '');
    for (const src of scripts) {
      expect(src.startsWith('./'), `unexpected external script: ${src}`).toBe(true);
    }
  });
});
