/**
 * Legal document assembly from company configuration.
 *
 * A document is published only when `assessDocumentReadiness` says every
 * required field is present, and the markdown is interpolated from those
 * fields. Missing configuration returns `missingFields` and does not publish
 * boilerplate. Category screening is a sourced web search, never an
 * "approved for sale" stamp.
 */

import {
  CapabilityUnsupportedError,
  CredentialsMissingError,
  LEGAL_DOCUMENT_REQUIREMENTS,
  assessDocumentReadiness,
  type Capability,
  type DocumentReadiness,
} from '@foundry/core';
import { companyConfig } from '@foundry/db';
import { optionalCapability, type ServiceDeps, type ServiceOutcome } from '../deps.js';
import { ExpertReviewService } from '../research/expert.js';
import { MarketingCreativeService } from '../marketing/creative.js';

export interface LegalGenerateInput {
  readonly companyId: string;
  readonly kind: string;
  readonly siteId?: string;
}

export interface LegalGenerateResult {
  readonly canGenerate: boolean;
  readonly missingFields: readonly string[];
  readonly documentId?: string;
  readonly version?: number;
}

interface WebSearchHit {
  readonly title: string;
  readonly url: string;
  readonly description: string;
}

interface WebSearchAdapter {
  searchWeb(input: { query: string; count: number }): Promise<readonly WebSearchHit[]>;
}

export class LegalDocumentService {
  constructor(private readonly deps: ServiceDeps) {}

  async generate(input: LegalGenerateInput): Promise<ServiceOutcome<LegalGenerateResult>> {
    const company = await this.deps.repos.companies.byId(input.companyId);
    let config;
    try {
      config = companyConfig(company);
    } catch (error) {
      return {
        ok: false,
        data: {
          canGenerate: false,
          missingFields: [`config (${error instanceof Error ? error.message : 'schema invalid'})`],
        },
      };
    }

    const readiness = assessDocumentReadiness(config);
    const forKind = readiness.find((r) => r.document === input.kind) ?? unknownKind(input.kind);
    if (!forKind.canGenerate) {
      return {
        ok: false,
        data: { canGenerate: false, missingFields: forKind.missingFields },
      };
    }

    const bodyMarkdown = assembleMarkdown(input.kind, config);
    const published = await this.deps.repos.build.legal.publish({
      companyId: input.companyId,
      siteId: input.siteId ?? null,
      kind: input.kind,
      bodyMarkdown,
      generatedFrom: snapshotFor(input.kind, config),
    });
    return {
      ok: true,
      data: { canGenerate: true, missingFields: [], documentId: published.id, version: published.version },
    };
  }

  async screenProductCategory(input: {
    category: string;
  }): Promise<ServiceOutcome<{
    category: string;
    findings: readonly { title: string; url: string; snippet: string }[];
    approvedForSale: false;
    note: string;
  }>> {
    const search = optionalCapability<WebSearchAdapter>(this.deps, 'research.web_search');
    if (!search || typeof search.searchWeb !== 'function') {
      return blocked('research.web_search', this.#reason('research.web_search'));
    }
    try {
      const hits = await search.searchWeb({
        query: `"${input.category}" product sale restrictions banned prohibited`,
        count: 10,
      });
      return {
        ok: true,
        data: {
          category: input.category,
          findings: hits.map((h) => ({ title: h.title, url: h.url, snippet: h.description })),
          approvedForSale: false,
          note: 'Search findings are not an approval to sell. Restricted categories require counsel review.',
        },
      };
    } catch (error) {
      return this.#fromProviderError('research.web_search', error);
    }
  }

  async checkAdClaims(input: { conceptId: string }): Promise<ServiceOutcome<{ ok: boolean; unsupported: readonly string[] }>> {
    return new MarketingCreativeService(this.deps).checkClaims(input.conceptId);
  }

  /**
   * Compares configured retention to what the nightly retention job is
   * *supposed* to enforce. This service does not scan every table.
   */
  async checkDataRetention(input: { companyId: string }): Promise<ServiceOutcome<{
    configuredRetentionDays: number;
    enforcement: string;
    scannedAllTables: false;
  }>> {
    const company = await this.deps.repos.companies.byId(input.companyId);
    const config = companyConfig(company);
    return {
      ok: true,
      data: {
        configuredRetentionDays: config.privacy.retentionDays,
        enforcement:
          `Company config sets retention to ${config.privacy.retentionDays} days. ` +
          `Queue contract \`maintenance.retention\` is scheduled daily for that policy. ` +
          `This service does not scan tables to prove rows were deleted, and a missing ` +
          `retention handler means enforcement is unverified — not confirmed.`,
        scannedAllTables: false,
      },
    };
  }

  async escalateToHuman(input: {
    companyId: string;
    kind: string;
    actorId: string;
    reason: string;
  }): Promise<ServiceOutcome<{ approvalId: string; reviewId?: string }>> {
    const approval = await this.deps.repos.governance.approvals.create({
      companyId: input.companyId,
      request: `Legal escalation (${input.kind}): ${input.reason}`,
      authority: 'legal.publish_policy',
      requestedByActorId: input.actorId,
      riskNotes: [input.reason],
    });
    const experts = new ExpertReviewService(this.deps);
    const review = await experts.request({
      companyId: input.companyId,
      subjectRefId: approval.id,
      subject: 'legal_escalation',
      question: input.reason,
    });
    return {
      ok: true,
      data: { approvalId: approval.id, reviewId: review.reviewId },
    };
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

function unknownKind(kind: string): DocumentReadiness {
  const fields = LEGAL_DOCUMENT_REQUIREMENTS[kind];
  if (!fields) {
    return { document: kind, canGenerate: false, missingFields: [`unknown document kind "${kind}"`] };
  }
  return { document: kind, canGenerate: false, missingFields: [...fields] };
}

function snapshotFor(kind: string, config: ReturnType<typeof companyConfig>): Record<string, unknown> {
  return {
    kind,
    generatedAt: new Date().toISOString(),
    legalEntity: config.legalEntity,
    contact: config.contact,
    commerce: config.commerce,
    privacy: config.privacy,
    messaging: config.messaging,
  };
}

function assembleMarkdown(kind: string, config: ReturnType<typeof companyConfig>): string {
  const generatedAt = new Date().toISOString();
  const header = [
    `# ${titleFor(kind)}`,
    '',
    `_Generated from company configuration at ${generatedAt}. This is not a lawyer-reviewed instrument._`,
    '',
  ];

  switch (kind) {
    case 'terms_of_sale':
      return [
        ...header,
        `**Seller:** ${config.legalEntity.registeredName}`,
        `**Jurisdiction:** ${config.legalEntity.jurisdiction}`,
        `**Support:** ${config.contact.supportEmail}`,
        `**Currency:** ${config.commerce.baseCurrency}`,
        `**Sells to:** ${config.commerce.sellsTo.join(', ')}`,
        `**Return window:** ${config.commerce.returnWindowDays} days`,
        '',
        'Orders are contracts of sale under the jurisdiction named above. Returns follow the return window recorded in this configuration.',
      ].join('\n');
    case 'privacy_policy':
      return [
        ...header,
        `**Controller:** ${config.privacy.dataController}`,
        `**Registered name:** ${config.legalEntity.registeredName}`,
        `**Contact:** ${config.contact.supportEmail}`,
        `**Personal data categories:** ${config.privacy.personalDataCategories.join(', ')}`,
        `**Retention:** ${config.privacy.retentionDays} days`,
        '',
        'This policy describes only the categories and retention window stored in company configuration.',
      ].join('\n');
    case 'cookie_policy':
      return [
        ...header,
        `**Cookies used:** ${config.privacy.cookiesUsed.join(', ')}`,
        `**Analytics enabled:** ${config.privacy.analyticsEnabled ? 'yes' : 'no'}`,
      ].join('\n');
    case 'shipping_policy':
      return [
        ...header,
        `**Ships from:** ${config.commerce.shipsFrom.join(', ')}`,
        `**Sells to:** ${config.commerce.sellsTo.join(', ')}`,
      ].join('\n');
    case 'returns_policy':
      return [
        ...header,
        `**Return window:** ${config.commerce.returnWindowDays} days`,
        `**Return shipping paid by:** ${config.commerce.whoPaysReturnShipping}`,
        `**Support:** ${config.contact.supportEmail}`,
      ].join('\n');
    case 'sms_terms':
      return [
        ...header,
        `**Consent language:** ${config.messaging.consentLanguage}`,
        `**Frequency:** ${config.messaging.messageFrequencyDisclosure}`,
        `**Opt-out:** ${config.messaging.optOutInstructions}`,
        `**Help:** ${config.messaging.helpInstructions}`,
        `**Support:** ${config.contact.supportEmail}`,
      ].join('\n');
    case 'warranty':
      return [
        ...header,
        `**Seller:** ${config.legalEntity.registeredName}`,
        `**Warranty offered:** ${config.commerce.warrantyOffered ? 'yes' : 'no'}`,
        `**Term (months):** ${config.commerce.warrantyTermMonths ?? 'not offered'}`,
      ].join('\n');
    case 'business_identity_disclosure':
      return [
        ...header,
        `**Registered name:** ${config.legalEntity.registeredName}`,
        `**Address:** ${formatAddress(config.legalEntity.registeredAddress)}`,
        `**Support:** ${config.contact.supportEmail}`,
      ].join('\n');
    default:
      return [...header, 'No template is defined for this kind; refusing to invent legal prose.'].join('\n');
  }
}

function titleFor(kind: string): string {
  return kind.replaceAll('_', ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatAddress(
  address: ReturnType<typeof companyConfig>['legalEntity']['registeredAddress'],
): string {
  if (!address) return 'not on file';
  return [address.line1, address.line2, address.city, address.state, address.postalCode, address.country]
    .filter((p) => typeof p === 'string' && p.length > 0)
    .join(', ');
}
