/**
 * Company configuration and the operating loop state.
 *
 * `CompanyConfig` is the single source of truth from which legal documents,
 * tax behaviour, messaging compliance and disclosure text are generated. If a
 * field is unset, the dependent document cannot be generated — that is the
 * mechanism preventing boilerplate policies that misstate the business.
 */

import { z } from 'zod';

export const LegalEntityType = z.enum([
  'sole_proprietor',
  'llc',
  'corporation',
  'partnership',
  'not_yet_formed',
]);
export type LegalEntityType = z.infer<typeof LegalEntityType>;

/**
 * What kind of thing the company sells.
 *
 * This is structure, not a label. A physical line has a supplier, an RFQ and a
 * quote, so the loop's `source` phase has a concrete artefact to wait for and
 * the landed cost is goods + freight + duty. A digital line has none of those:
 * there is no supplier to contact, so waiting for a supplier quote is waiting
 * for something that can never arrive, and the real marginal cost is compute,
 * delivery and payment processing instead.
 *
 * Defaulting to `physical` is deliberate — every config written before this
 * field existed described a physical business, and reading one must not
 * silently change what the loop does.
 */
export const ProductLine = z.enum(['physical', 'digital']);
export type ProductLine = z.infer<typeof ProductLine>;

export const CompanyConfig = z.object({
  /** Legal owner of the business. Agents act inside permissions this person granted. */
  owner: z.object({
    name: z.string().min(1),
    email: z.string().email(),
    /** Authorities the human owner has explicitly delegated to the system. */
    delegatedAuthorities: z.array(z.string()).default([]),
    delegationRecordedAt: z.string().datetime().nullable(),
  }),
  legalEntity: z.object({
    type: LegalEntityType,
    registeredName: z.string().nullable(),
    registrationNumber: z.string().nullable(),
    taxId: z.string().nullable(),
    jurisdiction: z.string().nullable(),
    registeredAddress: z
      .object({
        line1: z.string(),
        line2: z.string().nullable(),
        city: z.string(),
        state: z.string().nullable(),
        postalCode: z.string(),
        country: z.string().length(2),
      })
      .nullable(),
  }),
  contact: z.object({
    supportEmail: z.string().email().nullable(),
    supportPhone: z.string().nullable(),
    supportMessagingHandle: z.string().nullable(),
    physicalAddressDisclosed: z.boolean().default(false),
  }),
  commerce: z.object({
    /** Physical or digital. Drives sourcing, the cost model and the payment route. */
    productLine: ProductLine.default('physical'),
    baseCurrency: z.string().length(3),
    sellsTo: z.array(z.string().length(2)).min(1),
    shipsFrom: z.array(z.string().length(2)).min(1),
    returnWindowDays: z.number().int().nonnegative(),
    restockingFeeBps: z.number().int().nonnegative().default(0),
    whoPaysReturnShipping: z.enum(['customer', 'merchant', 'depends_on_reason']),
    warrantyOffered: z.boolean(),
    warrantyTermMonths: z.number().int().nonnegative().nullable(),
    taxCollectionEnabled: z.boolean(),
    taxProvider: z.string().nullable(),
  }),
  privacy: z.object({
    dataController: z.string().nullable(),
    personalDataCategories: z.array(z.string()).min(1),
    retentionDays: z.number().int().positive(),
    analyticsEnabled: z.boolean(),
    cookiesUsed: z.array(z.enum(['strictly_necessary', 'analytics', 'marketing'])).default(['strictly_necessary']),
    consentRequiredRegions: z.array(z.string()).default(['EU', 'UK', 'CA-QC', 'US-CA']),
    dpoContact: z.string().nullable(),
    subprocessors: z.array(z.object({ name: z.string(), purpose: z.string(), region: z.string() })).default([]),
  }),
  messaging: z.object({
    marketingMessagingEnabled: z.boolean(),
    consentLanguage: z.string().nullable(),
    messageFrequencyDisclosure: z.string().nullable(),
    optOutInstructions: z.string().nullable(),
    helpInstructions: z.string().nullable(),
    /** E.164 / Linq handles the growth loop may message. Empty means no invented recipients. */
    outreachHandles: z.array(z.string().min(1)).default([]),
  }),
  risk: z.object({
    maxOrderValueMinor: z.number().int().positive(),
    maxDailyOrdersBeforeReview: z.number().int().positive(),
    agentRefundLimitMinor: z.number().int().nonnegative(),
    maxSupplierPurchaseWithoutHumanMinor: z.number().int().nonnegative(),
    maxDailyAdSpendMinor: z.number().int().nonnegative(),
  }),
  /** Optional live-provider ids written after the first successful create-or-lookup. */
  integrations: z
    .object({
      bandChatId: z.string().nullable().optional(),
      linqChatId: z.string().nullable().optional(),
    })
    .optional(),
});
export type CompanyConfig = z.infer<typeof CompanyConfig>;

/**
 * The product line of a stored config, read without demanding the whole config parse.
 *
 * Callers in the operating loop need this one field to decide whether a phase
 * has anything to wait for, and they must keep working against a config that
 * has drifted somewhere unrelated — a stale `messaging` block should not stop
 * the loop from knowing what the company sells. An unreadable or absent field
 * resolves to `physical`, which is the conservative answer: the physical branch
 * waits for a real supplier quote, so a misread can only ever make the loop
 * more cautious, never less.
 */
export function productLineOf(config: unknown): ProductLine {
  if (config === null || typeof config !== 'object') return 'physical';
  const commerce = (config as { commerce?: unknown }).commerce;
  if (commerce === null || typeof commerce !== 'object') return 'physical';
  const parsed = ProductLine.safeParse((commerce as { productLine?: unknown }).productLine);
  return parsed.success ? parsed.data : 'physical';
}

/** Fields each generated legal document depends on. Missing → cannot generate. */
export const LEGAL_DOCUMENT_REQUIREMENTS: Readonly<Record<string, readonly string[]>> = {
  terms_of_sale: [
    'legalEntity.registeredName',
    'legalEntity.jurisdiction',
    'contact.supportEmail',
    'commerce.baseCurrency',
    'commerce.sellsTo',
    'commerce.returnWindowDays',
  ],
  privacy_policy: [
    'legalEntity.registeredName',
    'privacy.dataController',
    'privacy.personalDataCategories',
    'privacy.retentionDays',
    'contact.supportEmail',
  ],
  cookie_policy: ['privacy.cookiesUsed', 'privacy.analyticsEnabled'],
  shipping_policy: ['commerce.shipsFrom', 'commerce.sellsTo'],
  returns_policy: ['commerce.returnWindowDays', 'commerce.whoPaysReturnShipping', 'contact.supportEmail'],
  sms_terms: [
    'messaging.consentLanguage',
    'messaging.messageFrequencyDisclosure',
    'messaging.optOutInstructions',
    'messaging.helpInstructions',
    'contact.supportEmail',
  ],
  warranty: ['commerce.warrantyOffered', 'commerce.warrantyTermMonths', 'legalEntity.registeredName'],
  business_identity_disclosure: ['legalEntity.registeredName', 'legalEntity.registeredAddress', 'contact.supportEmail'],
};

export interface DocumentReadiness {
  readonly document: string;
  readonly canGenerate: boolean;
  readonly missingFields: readonly string[];
}

export function assessDocumentReadiness(config: unknown): readonly DocumentReadiness[] {
  return Object.entries(LEGAL_DOCUMENT_REQUIREMENTS).map(([document, fields]) => {
    const missingFields = fields.filter((path) => !hasValue(config, path));
    return { document, canGenerate: missingFields.length === 0, missingFields };
  });
}

function hasValue(root: unknown, path: string): boolean {
  let current: unknown = root;
  for (const segment of path.split('.')) {
    if (current === null || typeof current !== 'object') return false;
    current = (current as Record<string, unknown>)[segment];
  }
  if (current === null || current === undefined) return false;
  if (typeof current === 'string' && current.trim() === '') return false;
  if (Array.isArray(current) && current.length === 0) return false;
  return true;
}

/* -------------------------------------------------------------------------- */
/* Company & operating loop                                                    */
/* -------------------------------------------------------------------------- */

export const CompanyStage = z.enum([
  'initialising',
  'researching',
  'evaluating_opportunities',
  'sourcing',
  'building_brand',
  'building_storefront',
  'pre_launch_qa',
  'launched',
  'scaling',
  'pivoting',
  'wound_down',
]);
export type CompanyStage = z.infer<typeof CompanyStage>;

export const Company = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  mission: z.string().min(1),
  stage: CompanyStage,
  config: CompanyConfig,
  selectedOpportunityId: z.string().nullable(),
  activeBrandId: z.string().nullable(),
  activeSiteId: z.string().nullable(),
  /** Current KPI targets the CEO is steering toward. */
  kpiTargets: z.record(z.string(), z.number()).default({}),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Company = z.infer<typeof Company>;

/**
 * The operating loop. Each cycle is a durable record so the company's history
 * is inspectable: what it decided, on what evidence, and what happened next.
 */
export const LoopPhase = z.enum([
  'observe',
  'discover',
  'score',
  'expert_validate',
  'select',
  'source',
  'model_economics',
  'brand',
  'build',
  'qa',
  'launch',
  'market',
  'measure',
  'decide',
  'replan',
]);
export type LoopPhase = z.infer<typeof LoopPhase>;

export const LOOP_PHASE_ORDER: readonly LoopPhase[] = [
  'observe',
  'discover',
  'score',
  'expert_validate',
  'select',
  'source',
  'model_economics',
  'brand',
  'build',
  'qa',
  'launch',
  'market',
  'measure',
  'decide',
  'replan',
];

export function nextPhase(current: LoopPhase): LoopPhase {
  const idx = LOOP_PHASE_ORDER.indexOf(current);
  return LOOP_PHASE_ORDER[(idx + 1) % LOOP_PHASE_ORDER.length]!;
}

export const LoopCycle = z.object({
  id: z.string().min(1),
  companyId: z.string().min(1),
  cycleNumber: z.number().int().positive(),
  phase: LoopPhase,
  status: z.enum(['running', 'blocked', 'completed', 'aborted']),
  /** Why the loop cannot advance, with the exact remediation. */
  blockedReason: z.string().nullable(),
  blockedOnCapability: z.string().nullable(),
  /** Structured phase output — what this phase actually produced. */
  phaseOutputs: z.record(z.string(), z.unknown()).default({}),
  ceoDecision: z.string().nullable(),
  ceoDecisionRationale: z.string().nullable(),
  startedAt: z.string().datetime(),
  phaseEnteredAt: z.string().datetime(),
  completedAt: z.string().datetime().nullable(),
});
export type LoopCycle = z.infer<typeof LoopCycle>;
