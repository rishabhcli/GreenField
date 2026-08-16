/**
 * Business services.
 *
 * Each module owns one operating function of the company and takes
 * `ServiceDeps` explicitly, so the composition root is the only place that
 * decides what the system is wired to. Nothing here reads the environment or
 * constructs a provider client directly.
 */

export * from './deps.js';

export * from './commerce/webhook-processor.js';
export * from './commerce/fulfilment.js';
export * from './commerce/refunds.js';
export * from './commerce/collect.js';
export * from './commerce/sms-invoice.js';
export * from './commerce/store-intake.js';
export * from './commerce/dodo.js';
export * from './commerce/whop.js';

export * from './finance/ledger.js';
export * from './finance/reconciliation.js';

export * from './loop/orchestrator.js';

export * from './compliance/scan.js';
export * from './qa/orchestration.js';

export * from './research/collect.js';
export * from './research/cluster.js';
export * from './research/score.js';
export * from './research/expert.js';
export * from './research/selection.js';

export * from './sourcing/search.js';
export * from './sourcing/rfq.js';
export * from './sourcing/quotes.js';
export * from './sourcing/economics.js';

export * from './brand/identity.js';
export * from './brand/assets.js';

export * from './site/build.js';
export * from './site/deploy.js';

export * from './marketing/creative.js';
export * from './marketing/experiments.js';
export * from './marketing/audience.js';
export * from './marketing/outreach.js';

export * from './support/inbox.js';
export * from './legal/documents.js';

export * from './org/seed.js';
export * from './org/default-config.js';
export * from './org/ensure.js';
export * from './org/prize-tracks.js';

export * from './tools/host.js';
export * from './tools/catalog.js';
