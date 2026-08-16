/**
 * The service container.
 *
 * Constructed once per process from the application context. Keeping it
 * separate from `context.ts` matters for a practical reason: the context owns
 * connections and shutdown, the container owns business logic, and a service
 * must never be able to close a pool or reach for an environment variable.
 *
 * `wireRuntime` registers the org-chart tool catalog after the container
 * exists. Tools call services; services must not import the catalog at
 * module load, so registration happens here, after `buildServices`.
 */

import type { ServiceDeps } from '@foundry/services';
import {
  BrandAssetService,
  BrandIdentityService,
  CollectPaymentService,
  SmsInvoiceService,
  ComplianceScanService,
  ExpertReviewService,
  FulfilmentService,
  LandedCostService,
  LedgerService,
  LegalDocumentService,
  LoopOrchestrator,
  MarketingCreativeService,
  MarketingExperimentService,
  AudienceSegmentService,
  LinqOutreachService,
  OpportunityScoreService,
  QaOrchestrationService,
  ReconciliationService,
  RefundService,
  ResearchClusterService,
  ResearchCollectService,
  RfqService,
  SiteBuildService,
  SiteDeployService,
  SourcingQuoteService,
  SourcingSearchService,
  SupportInboxService,
  WebhookProcessorService,
  buildCompanyTools,
  type CompanyToolHost,
} from '@foundry/services';
import type { AppContext } from './context.js';

export interface Services extends CompanyToolHost {}

export function buildServices(ctx: AppContext): Services {
  const deps: ServiceDeps = {
    repos: ctx.repos,
    providers: ctx.providers,
    capabilities: ctx.capabilities,
    queues: ctx.queues,
    gate: ctx.gate,
    executor: ctx.executor,
    dispatcher: ctx.dispatcher,
    publicBaseUrl: ctx.config.publicBaseUrl,
    environment: ctx.config.environment,
    renderStorefrontServiceId: ctx.config.renderStorefrontServiceId,
  };

  return {
    deps,
    loop: new LoopOrchestrator(deps),
    research: new ResearchCollectService(deps),
    cluster: new ResearchClusterService(deps),
    score: new OpportunityScoreService(deps),
    experts: new ExpertReviewService(deps),
    sourcing: new SourcingSearchService(deps),
    rfq: new RfqService(deps),
    quotes: new SourcingQuoteService(deps),
    economics: new LandedCostService(deps),
    brand: new BrandIdentityService(deps),
    assets: new BrandAssetService(deps),
    site: new SiteBuildService(deps),
    deploy: new SiteDeployService(deps),
    qa: new QaOrchestrationService(deps),
    creative: new MarketingCreativeService(deps),
    experiments: new MarketingExperimentService(deps),
    audience: new AudienceSegmentService(deps),
    outreach: new LinqOutreachService(deps),
    support: new SupportInboxService(deps),
    legal: new LegalDocumentService(deps),
    fulfilment: new FulfilmentService(deps),
    refunds: new RefundService(deps),
    ledger: new LedgerService(deps),
    reconciliation: new ReconciliationService(deps),
    collect: new CollectPaymentService(deps),
    smsInvoice: new SmsInvoiceService(deps),
    compliance: new ComplianceScanService(deps),
    webhooks: new WebhookProcessorService(deps),
  };
}

/** Build services and register every org-chart tool. Empty registry is not a running company. */
export function wireRuntime(ctx: AppContext): Services {
  const services = buildServices(ctx);
  ctx.tools.registerAll(buildCompanyTools(services));
  return services;
}
