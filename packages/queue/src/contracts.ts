/**
 * Job contracts.
 *
 * Every queue has a zod-validated payload. A worker that receives a malformed
 * payload fails the job with a terminal error rather than half-executing, and
 * because payloads are validated on both enqueue and dequeue, a schema change
 * that would strand in-flight jobs is caught at deploy time.
 */

import { z } from 'zod';

export const QUEUE_NAMES = [
  'agent.run',
  'loop.tick',
  'research.collect',
  'research.cluster',
  'opportunity.score',
  'expert.poll',
  'sourcing.scan',
  'sourcing.rfq_send',
  'sourcing.quote_poll',
  'brand.asset_generate',
  'site.build',
  'site.deploy',
  'qa.run',
  'commerce.webhook',
  'commerce.reconcile',
  'fulfilment.sync',
  'marketing.metrics_collect',
  'marketing.decide',
  'support.inbound',
  'support.followup',
  'finance.reconcile',
  'verification.probe',
  'maintenance.retention',
  'maintenance.budget_rollover',
] as const;

export type QueueName = (typeof QUEUE_NAMES)[number];

/** Every job carries the identity needed to trace it and to attribute spend. */
export const JobEnvelope = z.object({
  companyId: z.string().min(1),
  /** Correlates the job with the request or run that created it. */
  traceId: z.string().min(1),
  /** Agent run that scheduled this job, when there was one. */
  originRunId: z.string().nullable().default(null),
  /** Platform idempotency key; the handler claims it before doing work. */
  idempotencyKey: z.string().nullable().default(null),
});
export type JobEnvelope = z.infer<typeof JobEnvelope>;

const withEnvelope = <T extends z.ZodRawShape>(shape: T) => JobEnvelope.extend(shape);

export const JOB_SCHEMAS = {
  'agent.run': withEnvelope({
    runId: z.string().min(1),
    roleKey: z.string().min(1),
    objective: z.string().min(1),
    inputRefs: z.record(z.string(), z.unknown()).default({}),
    parentRunId: z.string().nullable().default(null),
    deadlineAt: z.string().datetime(),
  }),
  'loop.tick': withEnvelope({
    cycleId: z.string().nullable().default(null),
    /** When set, force the loop into this phase instead of advancing. */
    forcePhase: z.string().nullable().default(null),
  }),
  'research.collect': withEnvelope({
    query: z.string().min(1),
    sourceKinds: z.array(z.string()).min(1),
    maxItems: z.number().int().positive().default(50),
    opportunityId: z.string().nullable().default(null),
  }),
  'research.cluster': withEnvelope({
    sinceIso: z.string().datetime().nullable().default(null),
    minClusterSize: z.number().int().positive().default(3),
  }),
  'opportunity.score': withEnvelope({
    opportunityId: z.string().min(1),
    weightProfile: z.string().default('commercial_impact'),
  }),
  'expert.poll': withEnvelope({
    expertReviewId: z.string().min(1),
    attempt: z.number().int().nonnegative().default(0),
  }),
  'sourcing.scan': withEnvelope({
    opportunityId: z.string().min(1),
    keywords: z.array(z.string()).min(1),
    destinationCountry: z.string().length(2),
    maxSuppliers: z.number().int().positive().default(25),
  }),
  'sourcing.rfq_send': withEnvelope({
    rfqId: z.string().min(1),
    approvalId: z.string().min(1),
  }),
  'sourcing.quote_poll': withEnvelope({
    rfqId: z.string().min(1),
    attempt: z.number().int().nonnegative().default(0),
  }),
  'brand.asset_generate': withEnvelope({
    brandId: z.string().min(1),
    assetKind: z.string().min(1),
    prompt: z.string().min(1),
    variants: z.number().int().positive().default(3),
  }),
  'site.build': withEnvelope({
    siteId: z.string().min(1),
    reason: z.enum(['initial', 'iteration', 'defect_fix', 'content_update']),
    instructions: z.string().nullable().default(null),
  }),
  'site.deploy': withEnvelope({
    siteId: z.string().min(1),
    environment: z.enum(['preview', 'staging', 'production']),
    commitSha: z.string().nullable().default(null),
    /** Production deploys must name the QA run that cleared them. */
    gatingQaRunId: z.string().nullable().default(null),
  }),
  'qa.run': withEnvelope({
    siteId: z.string().min(1),
    deploymentId: z.string().min(1),
    targetUrl: z.string().url(),
    kinds: z.array(z.string()).min(1),
    blockingForRelease: z.boolean().default(true),
  }),
  'commerce.webhook': withEnvelope({
    webhookEventId: z.string().min(1),
    provider: z.string().min(1),
  }),
  'commerce.reconcile': withEnvelope({
    sinceIso: z.string().datetime(),
    provider: z.string().min(1),
  }),
  'fulfilment.sync': withEnvelope({
    /** One order, or null to sweep tracking for every in-flight shipment. */
    orderId: z.string().min(1).nullable().default(null),
  }),
  'marketing.metrics_collect': withEnvelope({
    experimentId: z.string().min(1),
    windowStartIso: z.string().datetime(),
    windowEndIso: z.string().datetime(),
  }),
  'marketing.decide': withEnvelope({
    experimentId: z.string().min(1),
  }),
  'support.inbound': withEnvelope({
    supportMessageId: z.string().min(1),
  }),
  'support.followup': withEnvelope({
    ticketId: z.string().min(1),
    reason: z.string().min(1),
  }),
  'finance.reconcile': withEnvelope({
    sinceIso: z.string().datetime().nullable().default(null),
    /**
     * `order` posts the sale for one order, `refund` posts a refund reversal,
     * `sweep` reconciles the provider over a window. Splitting these keeps a
     * single-order posting off the same retry schedule as a full sweep.
     */
    scope: z.enum(['order', 'refund', 'sweep']).default('sweep'),
    orderId: z.string().min(1).nullable().default(null),
    refundExternalId: z.string().min(1).nullable().default(null),
  }),
  'verification.probe': withEnvelope({
    providers: z.array(z.string()).default([]),
  }),
  'maintenance.retention': withEnvelope({
    dryRun: z.boolean().default(false),
  }),
  'maintenance.budget_rollover': withEnvelope({}),
} as const satisfies Record<QueueName, z.ZodTypeAny>;

export type JobPayload<Q extends QueueName> = z.infer<(typeof JOB_SCHEMAS)[Q]>;

/* -------------------------------------------------------------------------- */
/* Per-queue operational policy                                                */
/* -------------------------------------------------------------------------- */

export interface QueuePolicy {
  /** Worker concurrency for this queue. */
  readonly concurrency: number;
  readonly attempts: number;
  readonly backoffMs: number;
  /** Hard timeout; a job exceeding it is failed so it cannot occupy a slot forever. */
  readonly jobTimeoutMs: number;
  /** Completed jobs retained, for operational forensics. */
  readonly keepCompleted: number;
  readonly keepFailed: number;
  /**
   * True for queues whose jobs move money or contact the outside world. These
   * are never auto-retried past their attempt cap and always land in the
   * dead-letter queue for a human, rather than being dropped.
   */
  readonly consequential: boolean;
  /** Rate limit applied at the queue level, on top of per-provider limiters. */
  readonly limiter?: { max: number; durationMs: number };
}

export const QUEUE_POLICIES: Readonly<Record<QueueName, QueuePolicy>> = {
  'agent.run': { concurrency: 6, attempts: 2, backoffMs: 5_000, jobTimeoutMs: 15 * 60_000, keepCompleted: 500, keepFailed: 2000, consequential: true },
  'loop.tick': { concurrency: 1, attempts: 1, backoffMs: 0, jobTimeoutMs: 10 * 60_000, keepCompleted: 200, keepFailed: 500, consequential: false },
  'research.collect': { concurrency: 8, attempts: 4, backoffMs: 10_000, jobTimeoutMs: 10 * 60_000, keepCompleted: 200, keepFailed: 1000, consequential: false },
  'research.cluster': { concurrency: 2, attempts: 3, backoffMs: 15_000, jobTimeoutMs: 10 * 60_000, keepCompleted: 100, keepFailed: 200, consequential: false },
  'opportunity.score': { concurrency: 4, attempts: 3, backoffMs: 10_000, jobTimeoutMs: 5 * 60_000, keepCompleted: 200, keepFailed: 500, consequential: false },
  'expert.poll': { concurrency: 4, attempts: 6, backoffMs: 60_000, jobTimeoutMs: 2 * 60_000, keepCompleted: 200, keepFailed: 500, consequential: false },
  'sourcing.scan': { concurrency: 3, attempts: 3, backoffMs: 30_000, jobTimeoutMs: 20 * 60_000, keepCompleted: 100, keepFailed: 500, consequential: false },
  'sourcing.rfq_send': { concurrency: 2, attempts: 3, backoffMs: 30_000, jobTimeoutMs: 5 * 60_000, keepCompleted: 500, keepFailed: 2000, consequential: true },
  'sourcing.quote_poll': { concurrency: 4, attempts: 8, backoffMs: 300_000, jobTimeoutMs: 2 * 60_000, keepCompleted: 100, keepFailed: 500, consequential: false },
  'brand.asset_generate': { concurrency: 4, attempts: 3, backoffMs: 15_000, jobTimeoutMs: 10 * 60_000, keepCompleted: 200, keepFailed: 500, consequential: false },
  'site.build': { concurrency: 2, attempts: 2, backoffMs: 60_000, jobTimeoutMs: 45 * 60_000, keepCompleted: 100, keepFailed: 500, consequential: false },
  'site.deploy': { concurrency: 1, attempts: 2, backoffMs: 30_000, jobTimeoutMs: 30 * 60_000, keepCompleted: 200, keepFailed: 1000, consequential: true },
  'qa.run': { concurrency: 2, attempts: 2, backoffMs: 60_000, jobTimeoutMs: 60 * 60_000, keepCompleted: 200, keepFailed: 500, consequential: false },
  // Webhook processing must be fast, highly parallel and effectively never lost.
  'commerce.webhook': { concurrency: 16, attempts: 10, backoffMs: 2_000, jobTimeoutMs: 60_000, keepCompleted: 2000, keepFailed: 10_000, consequential: true },
  'commerce.reconcile': { concurrency: 1, attempts: 3, backoffMs: 60_000, jobTimeoutMs: 15 * 60_000, keepCompleted: 100, keepFailed: 500, consequential: true },
  'fulfilment.sync': { concurrency: 6, attempts: 5, backoffMs: 30_000, jobTimeoutMs: 5 * 60_000, keepCompleted: 500, keepFailed: 2000, consequential: true },
  'marketing.metrics_collect': { concurrency: 4, attempts: 4, backoffMs: 30_000, jobTimeoutMs: 10 * 60_000, keepCompleted: 500, keepFailed: 1000, consequential: false },
  'marketing.decide': { concurrency: 2, attempts: 2, backoffMs: 30_000, jobTimeoutMs: 10 * 60_000, keepCompleted: 500, keepFailed: 1000, consequential: true },
  'support.inbound': { concurrency: 8, attempts: 5, backoffMs: 5_000, jobTimeoutMs: 5 * 60_000, keepCompleted: 1000, keepFailed: 5000, consequential: true },
  'support.followup': { concurrency: 4, attempts: 3, backoffMs: 60_000, jobTimeoutMs: 5 * 60_000, keepCompleted: 500, keepFailed: 1000, consequential: true },
  'finance.reconcile': { concurrency: 1, attempts: 3, backoffMs: 60_000, jobTimeoutMs: 20 * 60_000, keepCompleted: 200, keepFailed: 500, consequential: true },
  'verification.probe': { concurrency: 2, attempts: 1, backoffMs: 0, jobTimeoutMs: 5 * 60_000, keepCompleted: 200, keepFailed: 500, consequential: false },
  'maintenance.retention': { concurrency: 1, attempts: 2, backoffMs: 300_000, jobTimeoutMs: 30 * 60_000, keepCompleted: 50, keepFailed: 100, consequential: false },
  'maintenance.budget_rollover': { concurrency: 1, attempts: 3, backoffMs: 60_000, jobTimeoutMs: 5 * 60_000, keepCompleted: 50, keepFailed: 100, consequential: false },
};

/**
 * Repeatable jobs. These are what make the company a running loop rather than
 * a one-shot pipeline: the CEO cycle ticks, metrics are collected, payments are
 * reconciled, provider health is re-probed and retention is enforced, forever.
 */
export interface ScheduledJob {
  readonly queue: QueueName;
  readonly name: string;
  /** Standard 5-field cron, evaluated in UTC. */
  readonly cron: string;
  readonly payload: Record<string, unknown>;
}

export const SCHEDULED_JOBS: readonly ScheduledJob[] = [
  { queue: 'loop.tick', name: 'operating-loop', cron: '*/10 * * * *', payload: {} },
  { queue: 'marketing.metrics_collect', name: 'hourly-ad-metrics', cron: '7 * * * *', payload: {} },
  { queue: 'marketing.decide', name: 'arm-decisions', cron: '20 */4 * * *', payload: {} },
  { queue: 'commerce.reconcile', name: 'payment-reconciliation', cron: '15 */2 * * *', payload: {} },
  { queue: 'finance.reconcile', name: 'ledger-reconciliation', cron: '45 3 * * *', payload: {} },
  { queue: 'fulfilment.sync', name: 'tracking-sync', cron: '*/30 * * * *', payload: {} },
  { queue: 'expert.poll', name: 'expert-review-poll', cron: '*/15 * * * *', payload: {} },
  { queue: 'sourcing.quote_poll', name: 'quote-poll', cron: '0 */6 * * *', payload: {} },
  { queue: 'verification.probe', name: 'integration-health', cron: '0 */6 * * *', payload: {} },
  { queue: 'maintenance.budget_rollover', name: 'budget-windows', cron: '2 0 * * *', payload: {} },
  { queue: 'maintenance.retention', name: 'data-retention', cron: '30 4 * * *', payload: {} },
];
