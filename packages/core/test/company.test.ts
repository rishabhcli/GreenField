/**
 * Operating-loop phase order and legal-document readiness.
 */

import { describe, expect, it } from 'vitest';
import { CompanyConfig, LOOP_PHASE_ORDER, assessDocumentReadiness, nextPhase, productLineOf } from '@foundry/core';

/** A config that parses, so the product-line assertions are about that field alone. */
function baseConfig(commerce: Record<string, unknown> = {}) {
  return {
    owner: { name: 'Owner', email: 'owner@example.test', delegationRecordedAt: null },
    legalEntity: {
      type: 'not_yet_formed',
      registeredName: null,
      registrationNumber: null,
      taxId: null,
      jurisdiction: null,
      registeredAddress: null,
    },
    contact: { supportEmail: 'support@example.test', supportPhone: null, supportMessagingHandle: null },
    commerce: {
      baseCurrency: 'USD',
      sellsTo: ['US'],
      shipsFrom: ['US'],
      returnWindowDays: 30,
      whoPaysReturnShipping: 'merchant',
      warrantyOffered: false,
      warrantyTermMonths: null,
      taxCollectionEnabled: false,
      taxProvider: null,
      ...commerce,
    },
    privacy: { dataController: null, personalDataCategories: ['email'], retentionDays: 365, analyticsEnabled: false, dpoContact: null },
    messaging: {
      marketingMessagingEnabled: false,
      consentLanguage: null,
      messageFrequencyDisclosure: null,
      optOutInstructions: null,
      helpInstructions: null,
    },
    risk: {
      maxOrderValueMinor: 50_000,
      maxDailyOrdersBeforeReview: 25,
      agentRefundLimitMinor: 5_000,
      maxSupplierPurchaseWithoutHumanMinor: 0,
      maxDailyAdSpendMinor: 5_000,
    },
  };
}

describe('commerce.productLine', () => {
  it('defaults to physical so a config written before the field existed keeps its behaviour', () => {
    const parsed = CompanyConfig.parse(baseConfig());
    expect(parsed.commerce.productLine).toBe('physical');
  });

  it('round-trips an explicit digital line and rejects an unknown one', () => {
    expect(CompanyConfig.parse(baseConfig({ productLine: 'digital' })).commerce.productLine).toBe('digital');
    expect(CompanyConfig.safeParse(baseConfig({ productLine: 'dropship' })).success).toBe(false);
  });

  it('reads the field out of a raw stored config, falling back to physical when it is absent or unreadable', () => {
    expect(productLineOf({ commerce: { productLine: 'digital' } })).toBe('digital');
    expect(productLineOf({ commerce: { productLine: 'physical' } })).toBe('physical');
    // Absent, drifted, or not a config at all: the conservative branch, which
    // waits for a real supplier quote rather than skipping sourcing.
    expect(productLineOf({ commerce: {} })).toBe('physical');
    expect(productLineOf({ commerce: { productLine: 'services' } })).toBe('physical');
    expect(productLineOf({})).toBe('physical');
    expect(productLineOf(null)).toBe('physical');
    expect(productLineOf(undefined)).toBe('physical');
    expect(productLineOf('digital')).toBe('physical');
  });
});

describe('nextPhase', () => {
  it('walks the loop in order and wraps replan back to observe', () => {
    for (let i = 0; i < LOOP_PHASE_ORDER.length - 1; i += 1) {
      expect(nextPhase(LOOP_PHASE_ORDER[i]!)).toBe(LOOP_PHASE_ORDER[i + 1]);
    }
    expect(nextPhase('replan')).toBe('observe');
  });
});

describe('assessDocumentReadiness', () => {
  it('refuses to generate documents whose required fields are unset', () => {
    const readiness = assessDocumentReadiness({
      legalEntity: { registeredName: null, jurisdiction: null, registeredAddress: null },
      contact: { supportEmail: null },
      commerce: { baseCurrency: 'USD', sellsTo: [], shipsFrom: [], returnWindowDays: 30 },
      privacy: { dataController: null, personalDataCategories: [], retentionDays: 365, cookiesUsed: [] },
      messaging: {
        consentLanguage: null,
        messageFrequencyDisclosure: null,
        optOutInstructions: null,
        helpInstructions: null,
      },
    });
    const byDoc = Object.fromEntries(readiness.map((r) => [r.document, r]));
    expect(byDoc['terms_of_sale']?.canGenerate).toBe(false);
    expect(byDoc['terms_of_sale']?.missingFields).toEqual(
      expect.arrayContaining(['legalEntity.registeredName', 'contact.supportEmail']),
    );
    expect(byDoc['privacy_policy']?.canGenerate).toBe(false);
    expect(byDoc['sms_terms']?.canGenerate).toBe(false);
  });

  it('allows generation only when every required field has a value', () => {
    const readiness = assessDocumentReadiness({
      legalEntity: {
        registeredName: 'GreenField LLC',
        jurisdiction: 'US-DE',
        registeredAddress: { line1: '1 Main', city: 'Wilmington', postalCode: '19801', country: 'US' },
      },
      contact: { supportEmail: 'support@example.test' },
      commerce: {
        baseCurrency: 'USD',
        sellsTo: ['US'],
        shipsFrom: ['US'],
        returnWindowDays: 30,
        whoPaysReturnShipping: 'merchant',
        warrantyOffered: true,
        warrantyTermMonths: 12,
      },
      privacy: {
        dataController: 'GreenField LLC',
        personalDataCategories: ['email'],
        retentionDays: 365,
        cookiesUsed: ['strictly_necessary'],
        analyticsEnabled: false,
      },
      messaging: {
        consentLanguage: 'Reply YES',
        messageFrequencyDisclosure: 'up to 4 msgs/month',
        optOutInstructions: 'STOP to opt out',
        helpInstructions: 'HELP for help',
      },
    });
    expect(readiness.every((r) => r.canGenerate)).toBe(true);
  });
});
