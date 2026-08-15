/**
 * Minimal company config that parses, with legal/tax fields left unset.
 *
 * Legal document generation refuses missing registered-name / jurisdiction /
 * data-controller fields. This default is the honest "not yet formed"
 * starting point for a hackathon company, not a fake entity.
 */

import { CompanyConfig } from '@foundry/core';

/** Identity used when the control plane creates the first company on boot. */
export const HACKATHON_COMPANY = {
  name: 'Zero Human Co',
  mission:
    'Operate an autonomous physical-goods company that earns real revenue. Missing sponsor capabilities block the loop; they are never treated as success.',
  ownerName: 'Rishabh Bansal',
  ownerEmail: 'rishabh.rb@icloud.com',
} as const;

export function defaultHackathonCompanyConfig(input: {
  readonly ownerName: string;
  readonly ownerEmail: string;
}): CompanyConfig {
  return CompanyConfig.parse({
    owner: {
      name: input.ownerName,
      email: input.ownerEmail,
      delegatedAuthorities: [],
      delegationRecordedAt: null,
    },
    legalEntity: {
      type: 'not_yet_formed',
      registeredName: null,
      registrationNumber: null,
      taxId: null,
      jurisdiction: null,
      registeredAddress: null,
    },
    contact: {
      supportEmail: input.ownerEmail,
      supportPhone: null,
      supportMessagingHandle: null,
      physicalAddressDisclosed: false,
    },
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
      personalDataCategories: ['customer_contact', 'order_records'],
      retentionDays: 365,
      analyticsEnabled: false,
      cookiesUsed: ['strictly_necessary'],
      consentRequiredRegions: ['EU', 'UK', 'CA-QC', 'US-CA'],
      dpoContact: null,
      subprocessors: [],
    },
    messaging: {
      marketingMessagingEnabled: false,
      consentLanguage: null,
      messageFrequencyDisclosure: null,
      optOutInstructions: 'Reply STOP to opt out.',
      helpInstructions: 'Reply HELP for support.',
    },
    risk: {
      maxOrderValueMinor: 50_000,
      maxDailyOrdersBeforeReview: 25,
      agentRefundLimitMinor: 5_000,
      maxSupplierPurchaseWithoutHumanMinor: 0,
      maxDailyAdSpendMinor: 5_000,
    },
    integrations: {
      bandChatId: null,
      linqChatId: null,
    },
  });
}
