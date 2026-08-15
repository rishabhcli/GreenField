/**
 * Brand, creative asset and storefront domain.
 */

import { z } from 'zod';

export const BrandNameCandidate = z.object({
  name: z.string().min(1),
  rationale: z.string().min(1),
  /** Preliminary, non-legal signals only. */
  domainChecks: z.array(
    z.object({
      domain: z.string().min(1),
      available: z.boolean().nullable(),
      checkedAt: z.string().datetime().nullable(),
      provider: z.string().min(1),
      priceMinor: z.number().int().nonnegative().nullable(),
      currency: z.string().length(3).nullable(),
    }),
  ),
  /**
   * Preliminary trademark research. Never a clearance opinion — the field name
   * says so, and the legal surface always renders the disclaimer alongside it.
   */
  trademarkPreliminary: z.object({
    searched: z.boolean(),
    registry: z.string().nullable(),
    searchedAt: z.string().datetime().nullable(),
    potentialConflicts: z.array(
      z.object({
        mark: z.string(),
        owner: z.string().nullable(),
        classes: z.array(z.string()).default([]),
        status: z.string().nullable(),
        sourceUrl: z.string().url().nullable(),
      }),
    ),
    riskLevel: z.enum(['unknown', 'low', 'medium', 'high']),
    requiresCounselReview: z.boolean(),
  }),
  pronounceability: z.number().min(0).max(1),
  distinctiveness: z.number().min(0).max(1),
});
export type BrandNameCandidate = z.infer<typeof BrandNameCandidate>;

export const BrandIdentity = z.object({
  id: z.string().min(1),
  companyId: z.string().min(1),
  opportunityId: z.string().min(1),
  name: z.string().min(1),
  legalEntityName: z.string().nullable(),
  tagline: z.string().min(1),
  positioning: z.string().min(1),
  /** The single sentence the whole funnel has to earn. */
  valueProposition: z.string().min(1),
  targetSegment: z.string().min(1),
  toneAttributes: z.array(z.string()).min(1),
  /** Claims marketing is permitted to make, with their substantiation. */
  permittedClaims: z.array(
    z.object({
      claim: z.string().min(1),
      substantiation: z.string().min(1),
      substantiationSourceRef: z.string().nullable(),
      approvedBy: z.string().nullable(),
      approvedAt: z.string().datetime().nullable(),
    }),
  ),
  prohibitedClaims: z.array(z.string()).default([]),
  palette: z.array(z.object({ role: z.string(), hex: z.string().regex(/^#[0-9a-fA-F]{6}$/) })).min(2),
  typography: z.object({ headingFamily: z.string(), bodyFamily: z.string(), source: z.string() }),
  domain: z.string().nullable(),
  nameCandidates: z.array(BrandNameCandidate).default([]),
  status: z.enum(['draft', 'in_review', 'approved', 'retired']).default('draft'),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type BrandIdentity = z.infer<typeof BrandIdentity>;

export const AssetKind = z.enum([
  'logo_primary',
  'logo_mark',
  'logo_wordmark',
  'favicon',
  'packaging_concept',
  'product_render',
  'lifestyle_image',
  'ad_static',
  'ad_video',
  'social_post',
  'email_header',
  'og_image',
]);
export type AssetKind = z.infer<typeof AssetKind>;

export const CreativeAsset = z.object({
  id: z.string().min(1),
  companyId: z.string().min(1),
  brandId: z.string().nullable(),
  kind: AssetKind,
  /** Durable object-storage URL. Never a data URI in the database. */
  url: z.string().url(),
  mimeType: z.string().min(1),
  widthPx: z.number().int().positive().nullable(),
  heightPx: z.number().int().positive().nullable(),
  bytes: z.number().int().positive().nullable(),
  /** How it was produced, including the exact prompt for reproducibility. */
  generation: z.object({
    provider: z.string().min(1),
    model: z.string().nullable(),
    prompt: z.string().nullable(),
    seed: z.string().nullable(),
    /** Set when a human made or heavily edited it. */
    humanAuthored: z.boolean().default(false),
  }),
  altText: z.string().nullable(),
  /** Terac review outcomes attached to this asset. */
  reviewIds: z.array(z.string()).default([]),
  status: z.enum(['generated', 'in_review', 'approved', 'rejected', 'live', 'archived']).default('generated'),
  createdAt: z.string().datetime(),
});
export type CreativeAsset = z.infer<typeof CreativeAsset>;

/* -------------------------------------------------------------------------- */
/* Storefront                                                                  */
/* -------------------------------------------------------------------------- */

export const SitePage = z.object({
  path: z.string().min(1),
  title: z.string().min(1),
  kind: z.enum([
    'home',
    'product',
    'collection',
    'cart',
    'checkout_redirect',
    'order_confirmation',
    'faq',
    'about',
    'contact',
    'terms_of_sale',
    'privacy_policy',
    'cookie_policy',
    'shipping_policy',
    'returns_policy',
    'sms_terms',
    'accessibility',
    'warranty',
    'product_safety',
  ]),
  /** Markdown or structured content handed to the site generator. */
  content: z.string().min(1),
  required: z.boolean().default(false),
});
export type SitePage = z.infer<typeof SitePage>;

export const SiteSpec = z.object({
  brandId: z.string().min(1),
  productIds: z.array(z.string()).min(1),
  pages: z.array(SitePage).min(1),
  /** API base the generated site calls for cart/checkout/support. */
  apiBaseUrl: z.string().url(),
  /** Publishable keys only. A secret key never reaches a generated site. */
  publicConfig: z.record(z.string(), z.string()).default({}),
  analytics: z.object({
    enabled: z.boolean(),
    endpoint: z.string().url().nullable(),
    consentRequired: z.boolean().default(true),
  }),
  designDirection: z.string().min(1),
});
export type SiteSpec = z.infer<typeof SiteSpec>;

export const SiteStatus = z.enum([
  'spec_drafted',
  'generating',
  'generated',
  'code_exported',
  'building',
  'build_failed',
  'preview_deployed',
  'qa_running',
  'qa_failed',
  'qa_passed',
  'release_blocked',
  'production_deployed',
  'rolled_back',
  'retired',
]);
export type SiteStatus = z.infer<typeof SiteStatus>;

export const Site = z.object({
  id: z.string().min(1),
  companyId: z.string().min(1),
  brandId: z.string().min(1),
  spec: SiteSpec,
  status: SiteStatus,
  /** Provider that generated the code, e.g. `lovable`. */
  generatorProvider: z.string().nullable(),
  generatorProjectId: z.string().nullable(),
  repositoryUrl: z.string().url().nullable(),
  previewUrl: z.string().url().nullable(),
  productionUrl: z.string().url().nullable(),
  /** Render service id hosting the storefront, when self-hosted. */
  hostingServiceId: z.string().nullable(),
  currentDeploymentId: z.string().nullable(),
  lastQaRunId: z.string().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Site = z.infer<typeof Site>;

export const Deployment = z.object({
  id: z.string().min(1),
  companyId: z.string().min(1),
  siteId: z.string().nullable(),
  provider: z.enum(['render', 'lovable']),
  externalDeployId: z.string().nullable(),
  serviceId: z.string().nullable(),
  environment: z.enum(['preview', 'staging', 'production']),
  commitSha: z.string().nullable(),
  status: z.enum(['queued', 'building', 'live', 'failed', 'canceled', 'rolled_back']),
  url: z.string().url().nullable(),
  /** Deployment this one replaced, enabling one-call rollback. */
  previousDeploymentId: z.string().nullable(),
  /** QA run that gated this deployment. Required for `production`. */
  gatingQaRunId: z.string().nullable(),
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime().nullable(),
  logsUrl: z.string().url().nullable(),
  error: z.string().nullable(),
});
export type Deployment = z.infer<typeof Deployment>;
