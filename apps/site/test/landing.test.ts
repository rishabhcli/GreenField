import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Script, runInNewContext } from 'node:vm';

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
    for (const id of [
      'main',
      'nav',
      'top',
      'loop',
      'organization',
      'infrastructure',
      'evidence',
      'pricing',
    ]) {
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

  /**
   * The conversion path is load-bearing: a landing page that explains the
   * product but cannot take money converts at exactly zero. These checks pin
   * the checkout surface so it cannot be refactored away silently.
   */
  describe('checkout path', () => {
    const PAYMENT_LINK = 'https://buy.stripe.com/bJe7sE7Ti3nmbLYdjb2go00';
    const checkoutHrefs = [...html.matchAll(/href="(https:\/\/buy\.stripe\.com\/[^"]+)"/g)].map(
      (m) => m[1] ?? '',
    );

    it('reaches the submitted Payment Link and never mints a second one', () => {
      expect(checkoutHrefs.length).toBeGreaterThanOrEqual(3);
      for (const href of checkoutHrefs) {
        expect(href.startsWith(`${PAYMENT_LINK}?`) || href === PAYMENT_LINK).toBe(true);
      }
    });

    it('tags every checkout link with a tier for webhook attribution', () => {
      const tiers = checkoutHrefs.map((href) => new URL(href).searchParams.get('client_reference_id'));
      expect(new Set(tiers)).toEqual(new Set(['tier_backer', 'tier_founding', 'tier_operator']));
    });

    it('opens checkout without leaking window.opener', () => {
      for (const tag of html.matchAll(/<a\b[^>]*buy\.stripe\.com[^>]*>/g)) {
        expect(tag[0]).toContain('rel="noopener"');
      }
    });

    it('states the price and the refund promise in the copy', () => {
      expect(html).toContain('$99');
      expect(html).toContain('customer-chooses-price');
      expect(html).toContain('you get');
    });
  });

  it('script compiles as valid JavaScript', () => {
    expect(() => new Script(js)).not.toThrow();
  });

  /**
   * The hero LED field is a rAF loop. A ReferenceError on the first paint
   * (an identifier the draw path reads but never declares) leaves a frozen
   * first frame — which is what shipped. This harness is the regression
   * gate: two frames must complete without throwing.
   */
  it('keeps the LED field looping after the first paint', () => {
    const empty = {
      length: 0,
      item: () => null,
      forEach: () => undefined,
      [Symbol.iterator]: function* () {},
    };

    const ctx2d = () => ({
      fillStyle: '',
      globalCompositeOperation: 'source-over',
      beginPath() {},
      rect() {},
      roundRect() {},
      fill() {},
      clearRect() {},
      setTransform() {},
      drawImage() {},
      fillRect() {},
      createRadialGradient() {
        return { addColorStop() {} };
      },
    });

    const canvas = {
      width: 0,
      height: 0,
      getContext: (type: string) => (type === '2d' ? ctx2d() : null),
      getBoundingClientRect: () => ({
        left: 0,
        top: 0,
        width: 800,
        height: 400,
        right: 800,
        bottom: 400,
      }),
    };

    const hero = {
      getBoundingClientRect: canvas.getBoundingClientRect,
      addEventListener() {},
    };

    let now = 0;
    const rafQueue: FrameRequestCallback[] = [];
    const errors: string[] = [];

    function requestAnimationFrame(cb: FrameRequestCallback): number {
      rafQueue.push(cb);
      return rafQueue.length;
    }

    const sandbox: Record<string, unknown> = {
      Float32Array,
      Int32Array,
      Math,
      Date,
      parseInt,
      performance: { now: () => now },
      requestAnimationFrame,
      cancelAnimationFrame() {},
      IntersectionObserver: class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
      ResizeObserver: class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
      document: {
        hidden: false,
        getElementById: (id: string) => (id === 'heroLeds' ? canvas : null),
        querySelector: (sel: string) => (sel === '.hero' ? hero : null),
        querySelectorAll: () => empty,
        createElement: (tag: string) =>
          tag === 'canvas'
            ? {
                width: 0,
                height: 0,
                getContext: () => ctx2d(),
              }
            : {},
        addEventListener() {},
      },
      matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
      addEventListener() {},
      devicePixelRatio: 1,
      scrollY: 0,
      innerHeight: 800,
    };
    sandbox.window = sandbox;

    runInNewContext(js, sandbox, { filename: 'assets/main.js' });

    function paint(): boolean {
      const cb = rafQueue.shift();
      if (!cb) return false;
      now += 16;
      try {
        cb(now);
      } catch (err) {
        errors.push(err instanceof Error ? `${err.name}: ${err.message}` : String(err));
      }
      return true;
    }

    expect(paint(), 'LED loop never scheduled a frame').toBe(true);
    expect(errors, `first paint threw:\n${errors.join('\n')}`).toEqual([]);
    expect(paint(), 'LED loop died after the first paint').toBe(true);
    expect(errors, `second paint threw:\n${errors.join('\n')}`).toEqual([]);
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
