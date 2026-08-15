import { describe, expect, it } from 'vitest';
import type { Capability } from '@foundry/core';
import type { ServiceDeps } from '../src/deps.js';
import { LoopOrchestrator } from '../src/loop/orchestrator.js';

const COMPANY = 'co_01M03F7RQW2M6540BY2GZHCFBW';

function cap(capability: Capability, usable: boolean) {
  return {
    capability,
    provider: 'test',
    state: usable ? 'live_verified' : 'blocked_missing_credentials',
    usable,
    evidence: null,
    remediation: `${capability} blocked`,
    missingSecrets: usable ? [] : ['KEY'],
    lastVerifiedAt: null,
    alternatives: [],
  };
}

function orchestrator(options: {
  readonly experiments: number;
  readonly linqOutbound: number;
  readonly adsUsable: boolean;
  readonly linqUsable: boolean;
}): LoopOrchestrator {
  const deps = {
    repos: {
      growth: {
        experiments: { listRunning: async () => Array.from({ length: options.experiments }, (_, i) => ({ id: `exp_${i}` })) },
        support: { countOutbound: async () => options.linqOutbound },
      },
    },
    capabilities: {
      resolveCapability: (capability: Capability) => {
        if (capability === 'ads.campaign_manage') return cap(capability, options.adsUsable);
        if (capability === 'messaging.imessage_app') return cap(capability, options.linqUsable);
        return cap(capability, false);
      },
    },
  } as unknown as ServiceDeps;
  return new LoopOrchestrator(deps);
}

describe('assessMarket', () => {
  it('completes when Linq outreach has been sent even if ads are unusable', async () => {
    const loop = orchestrator({ experiments: 0, linqOutbound: 2, adsUsable: false, linqUsable: true });
    const assessment = await loop.assess(COMPANY, 'market');
    expect(assessment.complete).toBe(true);
    expect(assessment.detail).toMatch(/Linq/i);
  });

  it('does not block on ads when Linq messaging is usable and nothing has been sent yet', async () => {
    const loop = orchestrator({ experiments: 0, linqOutbound: 0, adsUsable: false, linqUsable: true });
    const assessment = await loop.assess(COMPANY, 'market');
    expect(assessment.complete).toBe(false);
    expect(assessment.blockedOn).toBeUndefined();
  });
});
