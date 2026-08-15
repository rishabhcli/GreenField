/**
 * Creating a storefront spec must pin the company to that site and copy the
 * configured Render hosting service id onto the row. A spec with no hosting
 * id is not a fabricated live site.
 */

import { describe, expect, it } from 'vitest';
import type { SiteSpec } from '@foundry/core';
import type { ServiceDeps } from '../src/deps.js';
import { SiteBuildService } from '../src/site/build.js';

const COMPANY = 'co_01M03F7RQW2M6540BY2GZHCFBW';
const BRAND = 'br_01SITECREATE0000000000000';
const SITE = 'site_01SITECREATE000000000000';

const spec: SiteSpec = {
  brandId: BRAND,
  productIds: ['prd_01SITECREATE000000000000'],
  pages: [{ kind: 'home', content: 'Welcome', required: true }],
  apiBaseUrl: 'https://api.example.test',
  publicConfig: {},
  analytics: { enabled: false, endpoint: null, consentRequired: true },
  designDirection: 'plain storefront',
};

describe('SiteBuildService.createSpec', () => {
  it('writes companies.active_site_id and persists RENDER_STOREFRONT_SERVICE_ID', async () => {
    const setActive: Array<{ companyId: string; refs: { siteId?: string | null } }> = [];
    const setUrls: Array<{ siteId: string; urls: { hostingServiceId?: string | null } }> = [];

    const deps = {
      renderStorefrontServiceId: 'srv-storefront-test',
      repos: {
        companies: {
          setActive: async (companyId: string, refs: { siteId?: string | null }) => {
            setActive.push({ companyId, refs });
          },
        },
        build: {
          sites: {
            create: async () => ({ id: SITE, status: 'spec_drafted', hosting_service_id: null }),
            setUrls: async (siteId: string, urls: { hostingServiceId?: string | null }) => {
              setUrls.push({ siteId, urls });
            },
          },
        },
      },
    } as unknown as ServiceDeps;

    const result = await new SiteBuildService(deps).createSpec({
      companyId: COMPANY,
      brandId: BRAND,
      spec,
    });

    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({ siteId: SITE, status: 'spec_drafted' });
    expect(setActive).toEqual([{ companyId: COMPANY, refs: { siteId: SITE } }]);
    expect(setUrls).toEqual([
      { siteId: SITE, urls: { hostingServiceId: 'srv-storefront-test' } },
    ]);
  });

  it('does not invent a hosting service id when config has none', async () => {
    const setUrls: unknown[] = [];
    const deps = {
      renderStorefrontServiceId: undefined,
      repos: {
        companies: { setActive: async () => undefined },
        build: {
          sites: {
            create: async () => ({ id: SITE, status: 'spec_drafted', hosting_service_id: null }),
            setUrls: async (...args: unknown[]) => {
              setUrls.push(args);
            },
          },
        },
      },
    } as unknown as ServiceDeps;

    await new SiteBuildService(deps).createSpec({ companyId: COMPANY, brandId: BRAND, spec });
    expect(setUrls).toEqual([]);
  });
});
