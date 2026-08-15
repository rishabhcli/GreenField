/**
 * Operating-loop phase order and legal-document readiness.
 */

import { describe, expect, it } from 'vitest';
import { LOOP_PHASE_ORDER, assessDocumentReadiness, nextPhase } from '@foundry/core';

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
