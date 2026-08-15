/**
 * Creative claims are checked against the brand's substantiation register.
 * An unsupported claim fails the concept rather than being dropped or waved
 * through — that is the advertising-claims checker, not a suggestion.
 */

import { describe, expect, it } from 'vitest';
import type { ServiceDeps } from '../src/deps.js';
import { MarketingCreativeService } from '../src/marketing/creative.js';

describe('MarketingCreativeService claims check', () => {
  it('fails a concept whose claims are not on the brand permitted list', async () => {
    let checkedId: string | undefined;
    const deps = {
      repos: {
        growth: {
          creative: {
            create: async (input: { claimsUsed: readonly string[] }) => ({
              id: 'concept_1',
              claims_used: [...input.claimsUsed],
              status: 'draft',
            }),
            checkClaims: async (conceptId: string) => {
              checkedId = conceptId;
              return { ok: false, unsupported: ['cures anxiety overnight'] };
            },
            requestReview: async () => undefined,
            byId: async () => ({
              id: 'concept_1',
              claims_used: ['cures anxiety overnight'],
              status: 'claims_check_failed',
            }),
          },
        },
      },
      providers: {
        forCapability: () => ({ adapter: undefined, status: { state: 'blocked_missing_credentials', remediation: 'unset', missingSecrets: [] } }),
      },
    } as unknown as ServiceDeps;

    const service = new MarketingCreativeService(deps);
    const created = await service.createConcept({
      companyId: 'co_1',
      brandId: 'brand_1',
      hypothesis: 'pain-relief angle converts',
      angle: 'relief',
      hook: 'Sleep through the night',
      primaryText: 'Our supplement cures anxiety overnight.',
      headline: 'Cures anxiety overnight',
      callToAction: 'SHOP_NOW',
      landingPath: '/',
      platform: 'meta',
      claimsUsed: ['cures anxiety overnight'],
    });

    expect(created.ok).toBe(true);
    expect(created.data?.claims_used).toEqual(['cures anxiety overnight']);

    const check = await service.checkClaims('concept_1');
    expect(checkedId).toBe('concept_1');
    expect(check.ok).toBe(true);
    expect(check.data?.ok).toBe(false);
    expect(check.data?.unsupported).toEqual(['cures anxiety overnight']);
  });

  it('passes only when every listed claim is permitted', async () => {
    const deps = {
      repos: {
        growth: {
          creative: {
            checkClaims: async () => ({ ok: true, unsupported: [] }),
          },
        },
      },
      providers: {
        forCapability: () => ({ adapter: undefined, status: { state: 'blocked_missing_credentials', remediation: 'unset', missingSecrets: [] } }),
      },
    } as unknown as ServiceDeps;

    const check = await new MarketingCreativeService(deps).checkClaims('concept_ok');
    expect(check.data?.ok).toBe(true);
    expect(check.data?.unsupported).toEqual([]);
  });
});
