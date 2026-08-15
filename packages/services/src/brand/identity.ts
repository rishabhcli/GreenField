/**
 * Brand naming and identity persistence.
 *
 * Model output is allowed for *name suggestions*. Domain availability and
 * trademark research are separate lookups against real providers — a generated
 * name is never recorded as cleared, and a missing Cloudflare or search key
 * is a blocked outcome rather than a guessed "available".
 */

import { z } from 'zod';
import {
  CapabilityUnsupportedError,
  CredentialsMissingError,
  EvidenceDraft,
  MODEL_BY_TIER,
  ValidationError,
  type BrandNameCandidate,
  type Capability,
  type EvidenceDraft as EvidenceDraftType,
  type SitePage,
  type SiteSpec,
} from '@foundry/core';
import { CloudflareAdapter } from '@foundry/providers';
import { optionalCapability, type ServiceDeps, type ServiceOutcome } from '../deps.js';

const TRADEMARK_DISCLAIMER =
  'This is preliminary web-search research, not a trademark clearance opinion. Counsel must review before any use.';

const GeneratedNames = z.object({
  names: z
    .array(
      z.object({
        name: z.string().min(1),
        rationale: z.string().min(1),
        pronounceability: z.number().min(0).max(1),
        distinctiveness: z.number().min(0).max(1),
      }),
    )
    .min(1),
});

interface ReasoningAdapter {
  complete(input: {
    model: string;
    system?: string;
    messages: readonly { role: 'user' | 'assistant'; content: string }[];
    maxTokens?: number;
    thinking?: boolean;
  }): Promise<{
    text: string;
    refusal: { category: string | null; explanation: string | null } | null;
  }>;
  completeStructured?<T>(input: {
    model: string;
    system?: string;
    messages: readonly { role: 'user' | 'assistant'; content: string }[];
    schema: z.ZodType<T>;
    jsonSchema: Record<string, unknown>;
    resultName?: string;
    resultDescription?: string;
    maxTokens?: number;
    thinking?: boolean;
  }): Promise<{ value: T }>;
}

interface WebSearchHit {
  readonly title: string;
  readonly url: string;
  readonly description: string;
}

interface WebSearchAdapter {
  searchWeb(input: { query: string; count: number }): Promise<readonly WebSearchHit[]>;
}

export interface GenerateNamesInput {
  readonly companyId: string;
  readonly opportunityId: string;
  readonly count: number;
}

export interface DomainCheckResult {
  readonly domain: string;
  readonly available: boolean | null;
  readonly inRegistrarAccount: boolean;
  readonly checkedAt: string;
  readonly provider: string;
  readonly note: string;
}

export interface TrademarkPreliminaryResult {
  readonly name: string;
  readonly searched: boolean;
  readonly searchedAt: string;
  readonly hits: readonly { title: string; url: string; snippet: string }[];
  readonly potentialConflicts: readonly {
    mark: string;
    owner: string | null;
    classes: readonly string[];
    status: string | null;
    sourceUrl: string | null;
  }[];
  readonly riskLevel: 'unknown' | 'low' | 'medium' | 'high';
  readonly requiresCounselReview: true;
  readonly disclaimer: typeof TRADEMARK_DISCLAIMER;
}

export class BrandIdentityService {
  constructor(private readonly deps: ServiceDeps) {}

  async generateNames(input: GenerateNamesInput): Promise<ServiceOutcome<readonly BrandNameCandidate[]>> {
    const llm = optionalCapability<ReasoningAdapter>(this.deps, 'llm.reasoning');
    if (!llm) return blocked('llm.reasoning', this.#reason('llm.reasoning'));

    const count = Math.min(12, Math.max(1, Math.trunc(input.count)));
    const system =
      'You suggest brand names. Do not claim a name is legally available, trademark-clear, or that a domain is free. Those checks happen elsewhere.';
    const user = `Suggest ${count} distinctive brand names for company ${input.companyId}, opportunity ${input.opportunityId}. Return only the structured result.`;

    try {
      const parsed = await this.#namesFromModel(llm, system, user);
      const candidates: BrandNameCandidate[] = parsed.names.slice(0, count).map((n) => ({
        name: n.name,
        rationale: n.rationale,
        pronounceability: n.pronounceability,
        distinctiveness: n.distinctiveness,
        domainChecks: [],
        trademarkPreliminary: {
          searched: false,
          registry: null,
          searchedAt: null,
          potentialConflicts: [],
          riskLevel: 'unknown',
          requiresCounselReview: true,
        },
      }));
      return { ok: true, data: candidates };
    } catch (error) {
      return this.#fromProviderError('llm.reasoning', error);
    }
  }

  async checkDomains(input: { names: readonly string[] }): Promise<ServiceOutcome<readonly DomainCheckResult[]>> {
    const adapter = optionalCapability<CloudflareAdapter>(this.deps, 'domain.availability_check');
    if (!adapter || typeof adapter.checkDomainAvailability !== 'function') {
      return blocked('domain.availability_check', this.#reason('domain.availability_check'));
    }

    const checkedAt = new Date().toISOString();
    const note =
      'Cloudflare Registrar reports whether a domain is in this account, not whether an unregistered name is available to the public.';

    try {
      const results: DomainCheckResult[] = [];
      for (const name of input.names) {
        const domain = toDotCom(name);
        const lookup = await adapter.checkDomainAvailability(domain);
        results.push({
          domain: lookup.domain,
          // In-account means we already hold it (not "available to register").
          // Out-of-account is unknown — this API cannot answer public availability.
          available: lookup.inRegistrarAccount ? false : null,
          inRegistrarAccount: lookup.inRegistrarAccount,
          checkedAt,
          provider: 'cloudflare_dns',
          note,
        });
      }
      return { ok: true, data: results };
    } catch (error) {
      return this.#fromProviderError('domain.availability_check', error);
    }
  }

  async researchTrademarkPreliminary(input: {
    name: string;
    companyId?: string;
  }): Promise<ServiceOutcome<TrademarkPreliminaryResult>> {
    const search = optionalCapability<WebSearchAdapter>(this.deps, 'research.web_search');
    if (!search || typeof search.searchWeb !== 'function') {
      return blocked('research.web_search', this.#reason('research.web_search'));
    }

    const searchedAt = new Date().toISOString();
    try {
      const hits = await search.searchWeb({ query: `"${input.name}" trademark`, count: 10 });
      const potentialConflicts = hits.map((hit) => ({
        mark: hit.title.trim() || input.name,
        owner: null,
        classes: [],
        status: null,
        sourceUrl: hit.url,
      }));

      if (input.companyId) {
        await this.#storeTrademarkEvidence(input.companyId, input.name, hits, searchedAt);
      }

      return {
        ok: true,
        data: {
          name: input.name,
          searched: true,
          searchedAt,
          hits: hits.map((h) => ({ title: h.title, url: h.url, snippet: h.description })),
          potentialConflicts,
          riskLevel: potentialConflicts.length === 0 ? 'unknown' : 'medium',
          requiresCounselReview: true,
          disclaimer: TRADEMARK_DISCLAIMER,
        },
      };
    } catch (error) {
      return this.#fromProviderError('research.web_search', error);
    }
  }

  async createIdentity(input: {
    companyId: string;
    opportunityId: string;
    name: string;
    tagline: string;
    positioning: string;
    valueProposition: string;
    targetSegment: string;
    toneAttributes: readonly string[];
    palette: readonly Record<string, unknown>[];
    typography: Record<string, unknown>;
    domain?: string | null;
    permittedClaims?: readonly Record<string, unknown>[];
    prohibitedClaims?: readonly string[];
    nameCandidates?: readonly Record<string, unknown>[];
  }): Promise<ServiceOutcome<{ brandId: string }>> {
    const brand = await this.deps.repos.build.brands.create({
      companyId: input.companyId,
      opportunityId: input.opportunityId,
      name: input.name,
      tagline: input.tagline,
      positioning: input.positioning,
      valueProposition: input.valueProposition,
      targetSegment: input.targetSegment,
      toneAttributes: input.toneAttributes,
      palette: input.palette,
      typography: input.typography,
      domain: input.domain ?? null,
      permittedClaims: input.permittedClaims,
      prohibitedClaims: input.prohibitedClaims,
      nameCandidates: input.nameCandidates,
    });
    await this.deps.repos.companies.setActive(input.companyId, { brandId: brand.id });
    return { ok: true, data: { brandId: brand.id } };
  }

  /**
   * Drafts storefront page copy from the persisted brand fields.
   *
   * Legal/policy pages are stubs that point at LegalDocumentService — they are
   * not boilerplate terms. If `siteId` is set, the pages are merged into that
   * site's spec.
   */
  async draftPageContent(input: { brandId: string; siteId?: string }): Promise<ServiceOutcome<{ pages: SitePage[] }>> {
    const brand = await this.deps.repos.build.brands.byId(input.brandId);
    const pages = pagesFromBrand(brand);
    if (input.siteId) {
      const site = await this.deps.repos.build.sites.byId(input.siteId);
      const spec = site.spec as SiteSpec;
      await this.deps.repos.build.sites.updateSpec(input.siteId, { ...spec, pages });
    }
    return { ok: true, data: { pages } };
  }

  async #namesFromModel(llm: ReasoningAdapter, system: string, user: string): Promise<z.infer<typeof GeneratedNames>> {
    const jsonSchema = {
      type: 'object',
      additionalProperties: false,
      required: ['names'],
      properties: {
        names: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['name', 'rationale', 'pronounceability', 'distinctiveness'],
            properties: {
              name: { type: 'string' },
              rationale: { type: 'string' },
              pronounceability: { type: 'number' },
              distinctiveness: { type: 'number' },
            },
          },
        },
      },
    };

    if (typeof llm.completeStructured === 'function') {
      const structured = await llm.completeStructured({
        model: MODEL_BY_TIER.specialist,
        system,
        messages: [{ role: 'user', content: user }],
        schema: GeneratedNames,
        jsonSchema,
        resultName: 'record_names',
        thinking: false,
      });
      return structured.value;
    }

    const result = await llm.complete({
      model: MODEL_BY_TIER.specialist,
      system,
      messages: [{ role: 'user', content: user }],
      maxTokens: 4_000,
      thinking: false,
    });
    if (result.refusal) {
      throw new ValidationError(
        `Model declined the naming request (${result.refusal.category ?? 'unspecified'}): ${result.refusal.explanation ?? 'no explanation given'}`,
      );
    }
    const json = extractJson(result.text);
    return GeneratedNames.parse(json);
  }

  async #storeTrademarkEvidence(
    companyId: string,
    name: string,
    hits: readonly WebSearchHit[],
    retrievedAt: string,
  ): Promise<void> {
    for (const hit of hits) {
      let parsedUrl: URL;
      try {
        parsedUrl = new URL(hit.url);
      } catch {
        continue;
      }
      const draft: EvidenceDraftType = {
        sourceKind: 'blog_post',
        sourceUrl: parsedUrl.toString(),
        externalId: null,
        sourceDomain: parsedUrl.hostname.replace(/^www\./, ''),
        retrievedAt,
        authoredAt: null,
        provenance: { method: 'public_api', provider: 'brave_search', endpoint: '/web/search' },
        compliance: {
          robotsAllowed: false,
          robotsCheckedAt: null,
          termsReviewed: false,
          excerptStoragePermitted: false,
          authorIdentifierRetained: false,
          retentionPolicy: 'summary_only',
          notes: `Preliminary trademark search for "${name}". ${TRADEMARK_DISCLAIMER}`,
        },
        excerpt: null,
        summary: [hit.title, hit.description].filter(Boolean).join('\n') || hit.url,
        language: 'en',
        painPointLabels: [],
        categoryLabels: ['trademark_preliminary'],
        competitorsMentioned: [],
        sentiment: 0,
        severity: 0,
        purchaseIntent: 'none',
        workaroundDescribed: false,
        willingnessToPayCents: null,
        geography: null,
        engagementScore: null,
        confidence: 0.3,
      };
      const parsed = EvidenceDraft.safeParse(draft);
      if (parsed.success) await this.deps.repos.research.evidence.insert(companyId, parsed.data);
    }
  }

  #reason(capability: Capability): string {
    const status = this.deps.providers.forCapability(capability).status;
    return status.remediation ?? `capability state is ${status.state}`;
  }

  #fromProviderError<T>(capability: Capability, error: unknown): ServiceOutcome<T> {
    if (error instanceof CredentialsMissingError || error instanceof CapabilityUnsupportedError) {
      return blocked(capability, error.message);
    }
    throw error;
  }
}

function blocked<T>(capability: Capability, reason: string): ServiceOutcome<T> {
  return { ok: false, blockedOn: { capability, reason } };
}

function toDotCom(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .slice(0, 63);
  return `${slug || 'brand'}.com`;
}

function extractJson(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('model did not return JSON for brand names');
  return JSON.parse(text.slice(start, end + 1));
}

function pagesFromBrand(brand: { name: string; tagline: string; positioning: string; value_proposition: string; target_segment: string }): SitePage[] {
  const identity = [
    `# ${brand.name}`,
    brand.tagline,
    '',
    brand.positioning,
    '',
    brand.value_proposition,
    '',
    `For: ${brand.target_segment}`,
  ].join('\n');

  const legalStub = (kind: string) =>
    `This ${kind.replaceAll('_', ' ')} page is filled by LegalDocumentService from company configuration. It is not boilerplate and is not a clearance opinion.`;

  return [
    { path: '/', title: brand.name, kind: 'home', content: identity, required: true },
    { path: '/about', title: `About ${brand.name}`, kind: 'about', content: identity, required: false },
    { path: '/faq', title: 'FAQ', kind: 'faq', content: `Questions about ${brand.name}. Product and shipping answers are added from catalogue and policy config, not invented here.`, required: false },
    { path: '/contact', title: 'Contact', kind: 'contact', content: `Contact ${brand.name}. Support addresses come from company configuration at publish time.`, required: true },
    { path: '/terms', title: 'Terms of Sale', kind: 'terms_of_sale', content: legalStub('terms_of_sale'), required: true },
    { path: '/privacy', title: 'Privacy Policy', kind: 'privacy_policy', content: legalStub('privacy_policy'), required: true },
    { path: '/cookies', title: 'Cookie Policy', kind: 'cookie_policy', content: legalStub('cookie_policy'), required: true },
    { path: '/shipping', title: 'Shipping Policy', kind: 'shipping_policy', content: legalStub('shipping_policy'), required: true },
    { path: '/returns', title: 'Returns Policy', kind: 'returns_policy', content: legalStub('returns_policy'), required: true },
  ];
}
