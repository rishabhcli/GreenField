/**
 * Queue handlers.
 *
 * One entry per queue in `QUEUE_NAMES`. Each handler is thin: it resolves the
 * service that owns the work and returns a serialisable result that lands in the
 * job record, so an operator can see what a job actually did rather than just
 * that it "succeeded".
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
 *  - **`companyId === 'SCHEDULED'` sweeps every company.** Repeatable jobs use
 *    that sentinel so a single cron can operate the whole deployment.
 */

import { AssetKind, CredentialsMissingError, CapabilityUnsupportedError, QaRunKind, VendorApprovalRequiredError, describeError, type ProviderId } from '@foundry/core';
import { getLogger } from '@foundry/obs';
import type { HandlerMap, QueueName } from '@foundry/queue';
import type { AppContext } from '@foundry/runtime';
import type { Services } from '@foundry/runtime';

const SCHEDULED = 'SCHEDULED';

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
export function tolerateMissingCapability<T>(
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

  async function companyIds(companyId: string): Promise<readonly string[]> {
    if (companyId !== SCHEDULED) return [companyId];
    return (await ctx.repos.companies.list()).map((row) => row.id);
  }

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
      // Every 10 minutes is soon enough that a killed run does not pin a
      // parent for a day, and rare enough that the extra `deadline_at`
      // query is noise. Daily reconcile is the backstop if this worker
      // is the one that is down.
      const reaped = await ctx.dispatcher.reapOverdueRuns();
      const ids = await companyIds(payload.companyId);
      const ticks = [];
      for (const companyId of ids) {
        const tick = await services.loop.tick(companyId);
        log.info({ companyId, ...tick }, 'loop tick');
        ticks.push({ companyId, ...tick });
      }
      return { ticks, reaped, forcePhaseIgnored: payload.forcePhase };
    },

    /* ------------------------------------------------------------------ */
    /* Research                                                            */
    /* ------------------------------------------------------------------ */

    'research.collect': async (payload) =>
      tolerateMissingCapability(() =>
        services.research.collect({
          companyId: payload.companyId,
          query: payload.query,
          sourceKinds: payload.sourceKinds,
          maxItems: payload.maxItems,
          ...(payload.opportunityId ? { opportunityId: payload.opportunityId } : {}),
        }),
      ),

    'research.cluster': async (payload) => {
      const ids = await companyIds(payload.companyId);
      const results = [];
      for (const companyId of ids) {
        results.push(
          await services.cluster.cluster({
            companyId,
            ...(payload.sinceIso ? { sinceIso: payload.sinceIso } : {}),
            minClusterSize: payload.minClusterSize,
          }),
        );
      }
      return { results };
    },

    'opportunity.score': async (payload) =>
      services.score.score({
        companyId: payload.companyId,
        opportunityId: payload.opportunityId,
        weightProfile: payload.weightProfile,
      }),

    'expert.poll': async (payload) =>
      tolerateMissingCapability(async () => {
        if (payload.expertReviewId) {
          return { polls: [await services.experts.poll(payload.expertReviewId)] };
        }
        const polls = [];
        for (const companyId of await companyIds(payload.companyId)) {
          const open = await ctx.repos.research.expertReviews.listOpen(companyId);
          for (const review of open) {
            polls.push(await services.experts.poll(review.id));
          }
        }
        return { polls };
      }),

    /* ------------------------------------------------------------------ */
    /* Sourcing                                                            */
    /* ------------------------------------------------------------------ */

    'sourcing.scan': async (payload) =>
      tolerateMissingCapability(() =>
        services.sourcing.scan({
          companyId: payload.companyId,
          opportunityId: payload.opportunityId,
          keywords: payload.keywords.join(' '),
          destinationCountry: payload.destinationCountry,
          maxSuppliers: payload.maxSuppliers,
        }),
      ),

    'sourcing.rfq_send': async (payload) =>
      tolerateMissingCapability(() =>
        services.rfq.send({ rfqId: payload.rfqId, approvalId: payload.approvalId }),
      ),

    'sourcing.quote_poll': async (payload) =>
      tolerateMissingCapability(async () => {
        if (payload.rfqId) {
          return { polls: [await services.rfq.pollQuotes({ rfqId: payload.rfqId })] };
        }
        const polls = [];
        for (const companyId of await companyIds(payload.companyId)) {
          const waiting = await ctx.repos.sourcing.rfqs.awaitingReply(companyId, 0);
          for (const rfq of waiting) {
            polls.push(await services.rfq.pollQuotes({ rfqId: rfq.id }));
          }
        }
        return { polls };
      }),

    /* ------------------------------------------------------------------ */
    /* Brand / site / QA                                                   */
    /* ------------------------------------------------------------------ */

    'brand.asset_generate': async (payload) =>
      tolerateMissingCapability(() =>
        services.assets.generate({
          companyId: payload.companyId,
          brandId: payload.brandId,
          assetKind: AssetKind.parse(payload.assetKind),
          prompt: payload.prompt,
          variants: payload.variants,
        }),
      ),

    'site.build': async (payload) =>
      tolerateMissingCapability(() =>
        services.site.generate({
          siteId: payload.siteId,
          instructions: payload.instructions ?? `Build the storefront (${payload.reason}).`,
        }),
      ),

    'site.deploy': async (payload) =>
      tolerateMissingCapability(async () => {
        if (payload.environment === 'production') {
          if (!payload.gatingQaRunId) {
            return {
              status: 'blocked' as const,
              reason: 'Production deploy requires gatingQaRunId from a completed QA run.',
              capability: 'qa.release_gate',
            };
          }
          return services.deploy.deployProduction({
            siteId: payload.siteId,
            gatingQaRunId: payload.gatingQaRunId,
          });
        }
        return services.deploy.deployPreview({ siteId: payload.siteId });
      }),

    'qa.run': async (payload) =>
      tolerateMissingCapability(() => {
        const kinds = payload.kinds.map((kind) => QaRunKind.parse(kind));
        return services.qa.run({
          companyId: payload.companyId,
          siteId: payload.siteId,
          deploymentId: payload.deploymentId,
          targetUrl: payload.targetUrl,
          kinds,
          blockingForRelease: payload.blockingForRelease,
        });
      }),

    /* ------------------------------------------------------------------ */
    /* Commerce — the money path                                           */
    /* ------------------------------------------------------------------ */

    'commerce.webhook': async (payload) => {
      return services.webhooks.process(payload.webhookEventId);
    },

    'commerce.reconcile': async (payload) => {
      const windowDays = payload.sinceIso
        ? Math.max(1, Math.ceil((Date.now() - Date.parse(payload.sinceIso)) / 86_400_000))
        : 14;
      const reports = [];
      for (const companyId of await companyIds(payload.companyId)) {
        const report = await services.reconciliation.run(companyId, 'stripe', windowDays);
        const integrity = await services.reconciliation.verifyLedgerIntegrity(companyId);
        reports.push({
          companyId,
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
        });
      }
      return { reports };
    },

    'fulfilment.sync': async (payload) =>
      tolerateMissingCapability(async () => {
        if (payload.orderId) return services.fulfilment.fulfil(payload.orderId);
        const results = [];
        for (const companyId of await companyIds(payload.companyId)) {
          results.push({ companyId, ...(await services.fulfilment.syncTracking(companyId)) });
        }
        return { results };
      }),

    'finance.reconcile': async (payload) => {
      if (payload.scope === 'order' && payload.orderId) {
        return services.ledger.postSale(payload.orderId);
      }
      if (payload.scope === 'refund' && payload.orderId && payload.refundExternalId) {
        const order = await ctx.repos.commerce.orders.byId(payload.orderId);
        const refund = await ctx.repos.commerce.payments.byExternalId('stripe', payload.refundExternalId);
        if (!refund) {
          return { posted: false, reason: `no refund record for ${payload.refundExternalId}` };
        }
        return services.ledger.postRefund({
          companyId: order.company_id,
          orderId: order.id,
          refundExternalId: refund.external_id,
          refundAmountMinor: refund.amount_minor,
          taxRefundedMinor: 0,
          feeRetainedMinor: 0,
          currency: refund.currency,
        });
      }
      const reports = [];
      for (const companyId of await companyIds(payload.companyId)) {
        const report = await services.reconciliation.run(companyId, 'stripe');
        reports.push({ companyId, clean: report.result.clean, skippedReason: report.skippedReason });
      }
      return { reports };
    },

    /* ------------------------------------------------------------------ */
    /* Marketing / support                                                 */
    /* ------------------------------------------------------------------ */

    'marketing.metrics_collect': async (payload) =>
      tolerateMissingCapability(async () => {
        const windowEndIso = payload.windowEndIso ?? new Date().toISOString();
        const windowStartIso =
          payload.windowStartIso ?? new Date(Date.now() - 86_400_000).toISOString();
        if (payload.experimentId) {
          return services.experiments.collectMetrics({
            experimentId: payload.experimentId,
            windowStartIso,
            windowEndIso,
          });
        }
        const results = [];
        for (const companyId of await companyIds(payload.companyId)) {
          const running = await ctx.repos.growth.experiments.listRunning(companyId);
          for (const experiment of running) {
            results.push(
              await services.experiments.collectMetrics({
                experimentId: experiment.id,
                windowStartIso,
                windowEndIso,
              }),
            );
          }
        }
        return { results };
      }),

    'marketing.decide': async (payload) =>
      tolerateMissingCapability(async () => {
        if (payload.experimentId) {
          return services.experiments.decideArms({
            experimentId: payload.experimentId,
            unitContributionMinor: 0,
          });
        }
        const results = [];
        for (const companyId of await companyIds(payload.companyId)) {
          const running = await ctx.repos.growth.experiments.listRunning(companyId);
          for (const experiment of running) {
            results.push(
              await services.experiments.decideArms({
                experimentId: experiment.id,
                unitContributionMinor: 0,
              }),
            );
          }
        }
        return { results };
      }),

    'support.inbound': async (payload) =>
      tolerateMissingCapability(async () => {
        const message = await ctx.repos.growth.support.messageById(payload.supportMessageId);
        const ticketId = message?.ticket_id ?? payload.supportMessageId;
        const ticket = await ctx.repos.growth.support.byId(ticketId);
        await ctx.dispatcher.enqueueSystem({
          companyId: ticket.company_id,
          toRoleKey: 'customer_ops_manager',
          objective: `Handle inbound ticket ${ticket.id} (intent=${ticket.intent}, channel=${ticket.channel}). Do not invent a reply that was not sent.`,
          inputRefs: { ticketId: ticket.id, supportMessageId: payload.supportMessageId },
          traceId: payload.traceId,
        });
        return { ticketId: ticket.id, dispatched: 'customer_ops_manager' };
      }),

    'support.followup': async (payload) =>
      tolerateMissingCapability(async () => {
        const ticket = await ctx.repos.growth.support.byId(payload.ticketId);
        await ctx.dispatcher.enqueueSystem({
          companyId: ticket.company_id,
          toRoleKey: 'customer_ops_manager',
          objective: `Follow up ticket ${ticket.id}: ${payload.reason}`,
          inputRefs: { ticketId: ticket.id, reason: payload.reason },
          traceId: payload.traceId,
        });
        return { ticketId: ticket.id, dispatched: 'customer_ops_manager' };
      }),

    /* ------------------------------------------------------------------ */
    /* Platform                                                            */
    /* ------------------------------------------------------------------ */

    'verification.probe': async (payload) => {
      const only =
        payload.providers.length > 0 ? (payload.providers as ProviderId[]) : undefined;
      const results = await ctx.providers.probeAll(only);
      for (const row of results) {
        await ctx.repos.verifications.record({
          provider: row.provider,
          capability: row.capability,
          succeeded: row.succeeded,
          detail: row.detail,
          evidence: { ...row.evidence },
          environment: ctx.config.environment,
          checkedAt: row.checkedAt,
        });
      }
      return {
        probed: results.length,
        succeeded: results.filter((row) => row.succeeded).map((row) => row.provider),
        failed: results.filter((row) => !row.succeeded).map((row) => ({
          provider: row.provider,
          detail: row.detail,
        })),
      };
    },

    'maintenance.retention': async (payload) => {
      if (payload.dryRun) {
        return {
          dryRun: true,
          purged: false,
          note: 'Retention methods delete rows. dryRun does not execute them.',
        };
      }
      const webhooks = await ctx.repos.webhooks.purgeProcessedOlderThan(30);
      const idempotency = await ctx.repos.idempotency.purgeOlderThan(14);
      return { dryRun: false, webhooks, idempotency };
    },

    'maintenance.budget_rollover': async () => {
      const budgetsRolled = await ctx.repos.governance.budgets.rolloverWindows();
      const approvalsExpired = await ctx.repos.governance.approvals.expireStale();
      return { budgetsRolled, approvalsExpired };
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
