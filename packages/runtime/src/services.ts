/**
 * The service container.
 *
 * Constructed once per process from the application context. Keeping it
 * separate from `context.ts` matters for a practical reason: the context owns
 * connections and shutdown, the container owns business logic, and a service
 * must never be able to close a pool or reach for an environment variable.
 */

import type { ServiceDeps } from '@foundry/services';
import {
  FulfilmentService,
  LedgerService,
  LoopOrchestrator,
  ReconciliationService,
  RefundService,
  WebhookProcessorService,
} from '@foundry/services';
import type { AppContext } from './context.js';

export interface Services {
  readonly deps: ServiceDeps;
  readonly webhooks: WebhookProcessorService;
  readonly fulfilment: FulfilmentService;
  readonly refunds: RefundService;
  readonly ledger: LedgerService;
  readonly reconciliation: ReconciliationService;
  readonly loop: LoopOrchestrator;
}

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
  };

  return {
    deps,
    webhooks: new WebhookProcessorService(deps),
    fulfilment: new FulfilmentService(deps),
    refunds: new RefundService(deps),
    ledger: new LedgerService(deps),
    reconciliation: new ReconciliationService(deps),
    loop: new LoopOrchestrator(deps),
  };
}
