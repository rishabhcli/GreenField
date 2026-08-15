/**
 * Legal generation must refuse to publish when required company-config fields
 * are missing. Publishing boilerplate that misstates the business is the
 * failure this service exists to prevent.
 */

import { describe, expect, it } from 'vitest';
import type { ServiceDeps } from '../src/deps.js';
import { LegalDocumentService } from '../src/legal/documents.js';

function incompleteConfig(): unknown {
  return {
    owner: { name: 'Operator', email: 'owner@example.com', delegatedAuthorities: [], delegationRecordedAt: null },
    legalEntity: {
      type: 'not_yet_formed',
      registeredName: null,
      registrationNumber: null,
      taxId: null,
      jurisdiction: null,
      registeredAddress: null,
    },
    contact: { supportEmail: 'support@example.com', supportPhone: null, supportMessagingHandle: null, physicalAddressDisclosed: false },
    commerce: {
      baseCurrency: 'USD',
      sellsTo: ['US'],
      shipsFrom: ['US'],
      returnWindowDays: 30,
      restockingFeeBps: 0,
      whoPaysReturnShipping: 'depends_on_reason',
      warrantyOffered: false,
      warrantyTermMonths: null,
      taxCollectionEnabled: false,
      taxProvider: null,
    },
    privacy: {
      dataController: null,
      personalDataCategories: ['contact'],
      retentionDays: 365,
      analyticsEnabled: false,
      cookiesUsed: ['strictly_necessary'],
      consentRequiredRegions: ['EU'],
      dpoContact: null,
      subprocessors: [],
    },
    messaging: {
      marketingMessagingEnabled: false,
      consentLanguage: null,
      messageFrequencyDisclosure: null,
      optOutInstructions: null,
      helpInstructions: null,
    },
    risk: {
      maxOrderValueMinor: 50_000,
      maxDailyOrdersBeforeReview: 100,
      agentRefundLimitMinor: 5_000,
      maxSupplierPurchaseWithoutHumanMinor: 20_000,
      maxDailyAdSpendMinor: 50_000,
    },
  };
}

describe('LegalDocumentService.generate refuses missing fields', () => {
  it('does not publish terms_of_sale when the registered name and jurisdiction are unset', async () => {
    let published = 0;
    const deps = {
      repos: {
        companies: {
          byId: async () => ({ id: 'co_1', config: incompleteConfig() }),
        },
        build: {
          legal: {
            publish: async () => {
              published += 1;
              return { id: 'doc_1', version: 1 };
            },
          },
        },
      },
    } as unknown as ServiceDeps;

    const result = await new LegalDocumentService(deps).generate({
      companyId: 'co_1',
      kind: 'terms_of_sale',
    });

    expect(result.ok).toBe(false);
    expect(result.data?.canGenerate).toBe(false);
    expect(result.data?.missingFields).toEqual(
      expect.arrayContaining(['legalEntity.registeredName', 'legalEntity.jurisdiction']),
    );
    expect(result.data?.documentId).toBeUndefined();
    expect(published).toBe(0);
  });

  it('does not publish a privacy policy when the data controller is unset', async () => {
    let published = 0;
    const deps = {
      repos: {
        companies: {
          byId: async () => ({ id: 'co_1', config: incompleteConfig() }),
        },
        build: {
          legal: {
            publish: async () => {
              published += 1;
              return { id: 'doc_1', version: 1 };
            },
          },
        },
      },
    } as unknown as ServiceDeps;

    const result = await new LegalDocumentService(deps).generate({
      companyId: 'co_1',
      kind: 'privacy_policy',
    });

    expect(result.ok).toBe(false);
    expect(result.data?.canGenerate).toBe(false);
    expect(result.data?.missingFields).toEqual(expect.arrayContaining(['privacy.dataController']));
    expect(published).toBe(0);
  });
});
