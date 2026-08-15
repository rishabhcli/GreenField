import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Script, runInNewContext } from 'node:vm';

/**
 * Landing site smoke verification.
 *
 * The site is a dependency-free static bundle: a short home page plus one
 * page each for the system, the evidence, and pricing (the long-scroll
 * single page was split on purpose). The checks here are structural: every
 * page exists, references resolve, the script compiles, and the honest-copy,
 * checkout, and sponsor-logo invariants the project is built on are present
 * on the page that now owns them. This is a smoke gate, not a rendering test.
 */
const siteDir = join(dirname(fileURLToPath(import.meta.url)), '..');

function read(rel: string): string {
  const p = join(siteDir, rel);
  expect(existsSync(p), `missing ${rel}`).toBe(true);
  return readFileSync(p, 'utf8');
}

describe('landing site', () => {
  const pageNames = ['index.html', 'system.html', 'evidence.html', 'pricing.html'] as const;
  const pages: Record<(typeof pageNames)[number], string> = {
    'index.html': read('index.html'),
    'system.html': read('system.html'),
    'evidence.html': read('evidence.html'),
    'pricing.html': read('pricing.html'),
  };
  const index = pages['index.html'];
  const system = pages['system.html'];
  const evidence = pages['evidence.html'];
  const pricing = pages['pricing.html'];
  const css = read('assets/styles.css');
  const js = read('assets/main.js');

  it('references resolve to real files on every page', () => {
    for (const name of pageNames) {
      const refs = [...pages[name].matchAll(/(?:href|src)="\.\/([^"]+)"/g)].map((m) => m[1] ?? '');
      expect(refs.length, `${name} has no local references`).toBeGreaterThanOrEqual(2);
      for (const ref of refs) {
        const file = ref.split('#')[0] ?? ref;
        expect(existsSync(join(siteDir, file)), `broken reference in ${name}: ${ref}`).toBe(true);
      }
    }
  });

  it('splits the site into pages with the required section structure', () => {
    for (const id of ['main', 'nav', 'top']) {
      expect(index.includes(`id="${id}"`), `missing #${id} on home`).toBe(true);
    }
    for (const id of ['loop', 'organization', 'infrastructure']) {
      expect(system.includes(`id="${id}"`), `missing #${id} on system page`).toBe(true);
    }
    for (const id of ['evidence', 'faq']) {
      expect(evidence.includes(`id="${id}"`), `missing #${id} on evidence page`).toBe(true);
    }
    expect(pricing.includes('id="pricing"'), 'missing #pricing on pricing page').toBe(true);
    for (const name of pageNames) {
      expect(pages[name].includes('<footer'), `missing footer on ${name}`).toBe(true);
      expect(pages[name].includes('id="nav"'), `missing nav on ${name}`).toBe(true);
    }
    expect(index.includes('<h1')).toBe(true);
  });

  it('exposes exactly the twelve sponsors on the home page', () => {
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
      expect(index.includes(s), `missing sponsor: ${s}`).toBe(true);
    }
  });

  it('ships a real logo asset for every sponsor and references each one', () => {
    const assets = [
      'terac.svg',
      'stripe.svg',
      'lovable.png',
      'whop.png',
      'render.svg',
      'linq.png',
      'superserve.svg',
      'replay.ico',
      'band.png',
      'dodo.svg',
      'sandbox0.ico',
      'solari.png',
    ];
    for (const a of assets) {
      expect(existsSync(join(siteDir, 'assets', 'sponsors', a)), `missing sponsor logo: ${a}`).toBe(true);
      expect(index.includes(`./assets/sponsors/${a}`), `sponsor logo not referenced: ${a}`).toBe(true);
    }
  });

  it('keeps the honest-status claims intact on their pages', () => {
    expect(index).toContain('test suite executed — the count lives in CI, not here');
    expect(index).not.toContain('356');
    expect(system).toContain('probe verified');
    expect(system).toContain('surface built');
    expect(pricing).toContain('NOT COMPLETE');
    expect(index).toContain('Illustrative operating view');
  });

  /**
   * The conversion path is load-bearing: a landing page that explains the
   * product but cannot take money converts at exactly zero. These checks pin
   * the checkout surface on the pricing page so it cannot be refactored
   * away silently.
   */
  describe('checkout path', () => {
    const PAYMENT_LINK = 'https://buy.stripe.com/bJe7sE7Ti3nmbLYdjb2go00';
    const checkoutHrefs = [...pricing.matchAll(/href="(https:\/\/buy\.stripe\.com\/[^"]+)"/g)].map(
      (m) => m[1] ?? '',
    );

    it('reaches the submitted Payment Link for founding access and never mints a second one', () => {
      expect(checkoutHrefs.length).toBeGreaterThanOrEqual(1);
      for (const href of checkoutHrefs) {
        expect(href.startsWith(`${PAYMENT_LINK}?`) || href === PAYMENT_LINK).toBe(true);
      }
    });

    it('tags founding checkout with a tier for webhook attribution', () => {
      const tiers = checkoutHrefs.map((href) => new URL(href).searchParams.get('client_reference_id'));
      expect(tiers).toContain('tier_founding');
      expect(tiers).not.toContain(null);
    });

    it('opens checkout without leaking window.opener', () => {
      for (const tag of pricing.matchAll(/<a\b[^>]*buy\.stripe\.com[^>]*>/g)) {
        expect(tag[0]).toContain('rel="noopener"');
      }
    });

    it('states the price and the refund promise in the copy', () => {
      expect(pricing).toContain('$99');
      expect(pricing).toContain('customer-chooses-price');
      expect(pricing).toContain('you get');
    });

    it('posts Backer/Operator checkout to the deployed API origin', () => {
      expect(index).toContain('data-api="https://foundry-api-8ih0.onrender.com"');
      expect(js).toContain('https://foundry-api-8ih0.onrender.com');
      expect(js).toContain('/api/checkout');
      expect(js).not.toContain('customer-chooses-price');
    });
  });

  it('script compiles as valid JavaScript', () => {
    expect(() => new Script(js)).not.toThrow();
  });

  /**
   * The hero LED field is a rAF loop. A ReferenceError on the first paint
   * (an identifier the draw path reads but never declares) leaves a frozen
   * first frame, which is what shipped. This harness is the regression
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

  it('meets baseline accessibility markup on every page', () => {
    for (const name of pageNames) {
      expect(pages[name], `${name} missing lang`).toContain('lang="en"');
      expect(pages[name], `${name} missing skip-link`).toContain('skip-link');
      expect(pages[name], `${name} missing viewport`).toContain('name="viewport"');
      expect(pages[name], `${name} missing aria-hidden`).toContain('aria-hidden="true"');
    }
    expect(css).toContain(':focus-visible');
  });

  it('loads no third-party scripts besides fonts', () => {
    for (const name of pageNames) {
      const scripts = [...pages[name].matchAll(/<script[^>]*src="([^"]+)"/g)].map((m) => m[1] ?? '');
      for (const src of scripts) {
        expect(src.startsWith('./'), `unexpected external script on ${name}: ${src}`).toBe(true);
      }
    }
  });

  describe('polish surfaces', () => {
    it('exposes the FAQ accordion with accessible toggles on the evidence page', () => {
      expect(evidence.includes('id="faq"')).toBe(true);
      const questions = evidence.match(/class="faq-q"/g) ?? [];
      expect(questions.length).toBe(6);
      const collapsed = evidence.match(/faq-q" type="button" aria-expanded="false"/g) ?? [];
      expect(collapsed.length).toBe(questions.length);
      expect(css).toContain('.faq-item.is-open');
    });

    it('wires the scroll progress hairline and mobile menu on every page', () => {
      for (const name of pageNames) {
        expect(pages[name].includes('id="scrollProgressFill"'), `${name} missing progress fill`).toBe(true);
        expect(pages[name].includes('id="navMenuBtn"'), `${name} missing menu button`).toBe(true);
        expect(pages[name].includes('id="navPanel"'), `${name} missing nav panel`).toBe(true);
        expect(pages[name], `${name} missing aria-controls`).toContain('aria-controls="navPanel"');
      }
      expect(css).toContain('.scroll-progress-fill');
      expect(js).toContain('scrollProgressFill');
    });

    it('floats the nav into a pill once the page scrolls', () => {
      expect(css).toContain('.nav.is-floating');
      expect(js).toContain('is-floating');
    });

    it('keeps the spotlight and float layers compositor-friendly', () => {
      expect(css).toContain('.card-spot');
      expect(css).toContain('.float-card');
      expect(css).toContain('prefers-reduced-motion');
      expect(index.includes('float-card-a')).toBe(true);
      expect(index.includes('float-card-b')).toBe(true);
    });

    it('serves a branded og image', () => {
      const og = read('assets/og.svg');
      expect(index).toContain('content="./assets/og.svg"');
      expect(og).toContain('YELLOFIELD');
      expect(og).toContain('run by agents');
    });
  });
});
