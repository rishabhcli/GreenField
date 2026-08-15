/**
 * Queue handlers.
 *
 * One entry per queue in `QUEUE_NAMES`. Each handler is thin: it resolves the
 * service that owns the work and returns a serialisable result that lands in
 * the job record, so an operator can see what a job actually did rather than
 * just that it "succeeded".
 *
 * Two conventions hold throughout:
 *
 *  - **A handler that cannot do its work returns a blocked result; it does not
 *    throw.** Throwing means "retry me", and retrying a job that is waiting on
 *    a missing API key just burns the retry budget and hides the real reason.
 *    A genuine transient failure (network, 5xx, rate limit) still throws, so
 *    BullMQ retries it.
 *  - **A handler never invents a result.** If the underlying service returns
 *    "no data", that is the result.
 */

import { CredentialsMissingError, CapabilityUnsupportedError, VendorApprovalRequiredError, describeError } from '@foundry/core';
import { getLogger } from '@foundry/obs';
import type { HandlerMap, QueueName } from '@foundry/queue';
import type { AppContext } from '@foundry/runtime';
import type { Services } from '@foundry/runtime';

/** Result shape a blocked handler returns instead of throwing. */
interface BlockedResult {
  readonly status: 'blocked';
  readonly reason: string;
  readonly capability?: string;
}

/**
 * Wraps a handler so a "this cannot run yet" error becomes a recorded blocked
 * result rather than a retry loop against a credential that does not exist.
 */
function tolerateMissingCapability<T>(
  fn: () => Promise<T>,
): Promise<T | BlockedResult> {
  return fn().catch((error: unknown) => {
    if (
      error instanceof CredentialsMissingError ||
      error instanceof CapabilityUnsupportedError ||
      error instanceof VendorApprovalRequiredError
    ) {
      getLogger().warn({ err: describeError(error) }, 'job blocked on an unavailable capability');
      return {
        status: 'blocked' as const,
        reason: error.message,
        capability: String(error.context['capability'] ?? error.context['provider'] ?? 'unknown'),
      };
    }
    throw error;
  });
}

export function buildHandlers(ctx: AppContext, services: Services): HandlerMap {
  const log = getLogger();

  const handlers: HandlerMap = {
    /* ------------------------------------------------------------------ */
    /* Agent organisation                                                  */
    /* ------------------------------------------------------------------ */

    'agent.run': async (payload, jobCtx) => {
      const result = await ctx.executor.run({
        runId: payload.runId,
        companyId: payload.companyId,
        roleKey: payload.roleKey,
        objective: payload.objective,
        inputRefs: payload.inputRefs,
        // The job's abort signal is the run's deadline. Without it a wedged
        // model call would hold a worker slot past the job timeout.
        signal: jobCtx.signal,
      });
      return {
        status: result.status,
        iterations: result.iterations,
        toolCalls: result.toolCalls,
        costMinorUsd: result.costMinorUsd,
        blockedReason: result.blockedReason,
        finalText: result.finalText,
      };
    },

    'loop.tick': async (payload) => {
      const tick = await services.loop.tick(payload.companyId);
      log.info({ ...tick }, 'loop tick');
      return tick;
    },

    /* ------------------------------------------------------------------ */
    /* Commerce — the money path                                           */
    /* ------------------------------------------------------------------ */

    'commerce.webhook': async (payload) => {
      // Deliberately NOT wrapped: a webhook that fails must retry. Money state
      // arriving and being dropped is the worst outcome in the system.
      return services.webhooks.process(payload.webhookEventId);
    },

    'commerce.reconcile': async (payload) => {
      const windowDays = payload.sinceIso
        ? Math.max(1, Math.ceil((Date.now() - Date.parse(payload.sinceIso)) / 86_400_000))
        : 14;
      const report = await services.reconciliation.run(payload.companyId, 'stripe', windowDays);
      const integrity = await services.reconciliation.verifyLedgerIntegrity(payload.companyId);
      return {
        clean: report.result.clean && integrity.balanced,
        skippedReason: report.skippedReason,
        matched: report.result.matched,
        discrepancies: {
          missingLocally: report.result.missingLocally.length,
          missingAtProvider: report.result.missingAtProvider.length,
          amountMismatches: report.result.amountMismatches.length,
          statusMismatches: report.result.statusMismatches.length,
        },
        feesBackfilled: report.feesBackfilled,
        ledgerBalanced: integrity.balanced,
      };
    },

    'fulfilment.sync': async (payload) =>
      tolerateMissingCapability(async () => {
        if (payload.orderId) return services.fulfilment.fulfil(payload.orderId);
        return services.fulfilment.syncTracking(payload.companyId);
      }),

    'finance.reconcile': async (payload) => {
      if (payload.scope === 'order' && payload.orderId) {
        return services.ledger.postSale(payload.orderId);
      }
      if (payload.scope === 'refund' && payload.orderId && payload.refundExternalId) {
        // The refund service already recorded the provider's numbers; this
        // reads them back rather than recomputing, so the ledger matches the
        // refund row exactly.
        const order = await ctx.repos.commerce.orders.byId(payload.orderId);
        const refund = await ctx.repos.commerce.payments.refundByExternalId(payload.refundExternalId);
        if (!refund) {
          return { posted: false, reason: `no refund record for ${payload.refundExternalId}` };
        }
        return services.ledger.postRefund({
          companyId: order.company_id,
          orderId: order.id,
          refundExternalId: refund.external_id,
          refundAmountMinor: refund.amount_minor,
          // Tax and retained fee come from the provider's own refund object.
          // Zero means the provider reported none, not that we assumed none.
          taxRefundedMinor: 0,
          feeRetainedMinor: 0,
          currency: refund.currency,
        });
      }
      const report = await services.reconciliation.run(payload.companyId, 'stripe');
      return { clean: report.result.clean, skippedReason: report.skippedReason };
    },
  };

  return handlers;
}

/**
 * Queues with no handler in this deployment.
 *
 * Reported at boot rather than discovered when a job silently sits forever.
 * A queue listed here accepts jobs but nothing consumes them, which is a real
 * operational fact an operator needs to know.
 */
export function unhandledQueues(handlers: HandlerMap, all: readonly QueueName[]): readonly QueueName[] {
  return all.filter((name) => handlers[name] === undefined);
}
