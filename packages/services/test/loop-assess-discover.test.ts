/**
 * Discover assessment: Solari evidence unblocks Brave; zero pages is
 * research.browser_session, never research.web_search.
 */

import { describe, expect, it } from 'vitest';
import type { Capability } from '@foundry/core';
import type { ServiceDeps } from '../src/deps.js';
import { LoopOrchestrator } from '../src/loop/orchestrator.js';

const COMPANY = 'co_01M03F7RQW2M6540BY2GZHCFBW';

function cap(
  capability: Capability,
  usable: boolean,
  remediation: string,
): {
  capability: Capability;
  provider: string | null;
  state: string;
  usable: boolean;
  evidence: null;
  remediation: string;
  missingSecrets: readonly string[];
  lastVerifiedAt: null;
  alternatives: readonly never[];
} {
  return {
    capability,
    provider: capability === 'research.web_search' ? 'brave_search' : 'solari',
    state: usable ? 'live_verified' : 'blocked_missing_credentials',
    usable,
    evidence: null,
    remediation,
    missingSecrets: usable ? [] : [capability === 'research.web_search' ? 'BRAVE_SEARCH_API_KEY' : 'SOLARI_API_KEY'],
    lastVerifiedAt: null,
    alternatives: [],
  };
}

function orchestrator(options: {
  readonly evidenceCount: number;
  readonly opportunityCount?: number;
  readonly webUsable: boolean;
  readonly browserUsable: boolean;
}): LoopOrchestrator {
  const deps = {
    repos: {
      research: {
        evidence: {
          search: async () => Array.from({ length: options.evidenceCount }, (_, i) => ({ id: `ev_${i + 1}` })),
        },
        opportunities: {
          list: async () =>
            Array.from({ length: options.opportunityCount ?? 0 }, (_, i) => ({ id: `opp_${i + 1}` })),
        },
      },
    },
    capabilities: {
      resolveCapability: (capability: Capability) => {
        if (capability === 'research.web_search') {
          return cap(capability, options.webUsable, 'BRAVE_SEARCH_API_KEY is not set');
        }
        if (capability === 'research.browser_session') {
          return cap(capability, options.browserUsable, 'SOLARI_API_KEY is not set');
        }
        return cap(capability, false, `${capability} unavailable`);
      },
    },
  } as unknown as ServiceDeps;
  return new LoopOrchestrator(deps);
}

describe('assessDiscover', () => {
  it('does not block on Brave when Solari produced evidence rows', async () => {
    const loop = orchestrator({ evidenceCount: 2, opportunityCount: 0, webUsable: false, browserUsable: true });
    const assessment = await loop.assess(COMPANY, 'discover');
    expect(assessment.complete).toBe(false);
    expect(assessment.blockedOn).toBeUndefined();
    expect(assessment.detail).toMatch(/evidence/i);
  });

  it('blocks on research.browser_session when 0 pages / 0 evidence, not web_search', async () => {
    const loop = orchestrator({ evidenceCount: 0, webUsable: false, browserUsable: true });
    const assessment = await loop.assess(COMPANY, 'discover');
    expect(assessment.complete).toBe(false);
    expect(assessment.blockedOn?.capability).toBe('research.browser_session' satisfies Capability);
    expect(assessment.blockedOn?.capability).not.toBe('research.web_search');
    expect(assessment.blockedOn?.remediation).toMatch(/0 pages|browser_session/i);
  });

  it('waits rather than blocking when Brave is usable and evidence has not arrived', async () => {
    const loop = orchestrator({ evidenceCount: 0, webUsable: true, browserUsable: false });
    const assessment = await loop.assess(COMPANY, 'discover');
    expect(assessment.blockedOn).toBeUndefined();
    expect(assessment.detail).toMatch(/waiting/i);
  });
});
