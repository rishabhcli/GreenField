/**
 * Robots/ToS refusal is a thrown PolicyDeniedError, not a comment.
 * stealth/captcha/anti-bot flags never override a robots denial.
 */

import { describe, expect, it } from 'vitest';
import { PolicyDeniedError, ValidationError } from '@foundry/core';
import {
  assertNavigationPermitted,
  assertRobotsNotOverridden,
  assertSolariWorkload,
  browserSessionIdentity,
  refuseUnreviewedHost,
} from '../src/solari/index.js';

const COMPANY = 'co_01TESTCOMPANY000000000000';

describe('Solari ToS/robots refusal is a code path', () => {
  it('allows reviewed research search hosts and refuses unreviewed marketplaces', () => {
    expect(refuseUnreviewedHost('https://html.duckduckgo.com/html/?q=mugs').robotsAllowed).toBe(true);
    expect(refuseUnreviewedHost('https://www.bing.com/search?q=mugs').robotsAllowed).toBe(true);
    expect(refuseUnreviewedHost('https://en.wikipedia.org/w/index.php?search=mugs').robotsAllowed).toBe(true);

    const marketplace = refuseUnreviewedHost('https://www.alibaba.com/trade/search?SearchText=mugs');
    expect(marketplace.robotsAllowed).toBe(false);
    expect(marketplace.reason).toMatch(/robots|ToS|review/i);

    expect(() => assertNavigationPermitted('https://www.alibaba.com/trade/search?SearchText=mugs')).toThrow(
      PolicyDeniedError,
    );
    expect(() => assertNavigationPermitted('https://html.duckduckgo.com/html/?q=mugs')).not.toThrow();
  });

  it('stealth, captcha, and anti-bot do not override robotsAllowed=false', () => {
    expect(() =>
      assertRobotsNotOverridden({
        url: 'https://www.alibaba.com/trade/search?SearchText=mugs',
        robotsAllowed: false,
        stealth: true,
        captcha: true,
        antiBot: true,
      }),
    ).toThrow(PolicyDeniedError);
    try {
      assertRobotsNotOverridden({
        url: 'https://www.alibaba.com/trade/search?SearchText=mugs',
        robotsAllowed: false,
        stealth: true,
        captcha: true,
        antiBot: true,
      });
    } catch (error) {
      expect(error).toBeInstanceOf(PolicyDeniedError);
      expect((error as Error).message).toMatch(/stealth|captcha|anti-bot|robots/i);
      expect((error as Error).message).not.toMatch(/comment-only/);
    }
  });

  it('browser identities stay off the control plane and only accept browser/GUI work', () => {
    const research = browserSessionIdentity('research', COMPANY);
    const sourcing = browserSessionIdentity('sourcing', COMPANY);
    expect(research.plane).toBe('solari');
    expect(research.name).not.toBe(sourcing.name);
    expect(research.metadata.isolation).toBe('browser_session');
    expect(research.metadata.control_plane).toBe(false);
    expect(() => assertSolariWorkload('browser_or_gui')).not.toThrow();
    expect(() => assertSolariWorkload('untrusted_model_code')).toThrow(ValidationError);
    expect(() => assertSolariWorkload('persistent_multi_hour')).toThrow(ValidationError);
  });
});
