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

export * from './finance/ledger.js';
export * from './finance/reconciliation.js';

export * from './loop/orchestrator.js';
