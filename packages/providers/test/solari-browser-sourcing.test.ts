/**
 * Browser-backed supplier discovery refuses unreviewed hosts in #visit
 * (PolicyDeniedError) and never invents supplier rows from missing HTML.
 */

import { describe, expect, it } from 'vitest';
import { CapabilityUnsupportedError, PolicyDeniedError } from '@foundry/core';
import { refuseUnreviewedHost } from '../src/solari/index.js';
import {
  BrowserSourcingProvider,
  runCompliantBrowserSupplierSearch,
  type BrowserDriver,
} from '../src/sourcing/browser-sourcing.js';

class RecordingDriver implements BrowserDriver {
  readonly navigated: string[] = [];
  async navigate(url: string): Promise<void> {
    this.navigated.push(url);
  }
  async getContent(): Promise<string> {
    return '<html><body>not a supplier directory</body></html>';
  }
  async currentUrl(): Promise<string> {
    return this.navigated.at(-1) ?? 'about:blank';
  }
  async close(): Promise<void> {}
}

describe('Solari browser-sourcing compliance', () => {
  it('refuses an unreviewed marketplace before navigate and records compliance_blocked', async () => {
    const driver = new RecordingDriver();
    const provider = new BrowserSourcingProvider({
      driver,
      complianceGate: { check: refuseUnreviewedHost },
      providerId: 'solari_browser',
    });

    await expect(
      provider.searchTarget({
        url: 'https://www.alibaba.com/trade/search?SearchText=mugs',
        extract: () => [{ externalId: 'invented', displayName: 'Invented Co' }],
      }),
    ).rejects.toBeInstanceOf(PolicyDeniedError);

    expect(driver.navigated).toEqual([]);
    expect(provider.sessionLog).toHaveLength(1);
    expect(provider.sessionLog[0]?.outcome).toBe('compliance_blocked');
    expect(provider.sessionLog[0]?.detail).toMatch(/robots|ToS|review/i);
  });

  it('does not invent suppliers when no marketplace target is registered', async () => {
    const driver = new RecordingDriver();
    const result = await runCompliantBrowserSupplierSearch({
      query: 'ceramic mugs private label',
      driver,
      complianceGate: { check: refuseUnreviewedHost },
    });
    expect(result.profiles).toEqual([]);
    expect(result.blocked).toBeInstanceOf(CapabilityUnsupportedError);
    expect(driver.navigated).toEqual([]);
  });

  it('does not invent extract hits when the gate allows but extract returns []', async () => {
    const driver = new RecordingDriver();
    const provider = new BrowserSourcingProvider({
      driver,
      complianceGate: { check: () => ({ robotsAllowed: true, reason: 'test allow' }) },
      providerId: 'solari_browser',
      targets: {
        forQuery: () => ({
          url: 'https://html.duckduckgo.com/html/?q=mugs+supplier',
          extract: () => [],
        }),
        forSupplier: () => null,
      },
    });
    const hits = await provider.searchSuppliers({ query: 'mugs' });
    expect(hits).toEqual([]);
    expect(driver.navigated).toEqual(['https://html.duckduckgo.com/html/?q=mugs+supplier']);
  });
});
