/**
 * Health, readiness and the capability report.
 *
 * `/readiness/capabilities` is the honest answer to "is this thing actually
 * working?". It cannot be faked: a capability reaches `live_verified` only
 * when the verification harness has recorded a dated, successful, read-only
 * probe against the real provider. Everything else reports what is missing and
 * exactly how to fix it.
 */

import type { FastifyInstance } from 'fastify';
import { ACTIVATION_STATE_IS_USABLE, type ActivationState } from '@foundry/core';
import { registry as metricsRegistry } from '@foundry/obs';
import { allSecretSpecs } from '@foundry/providers';
import type { AppContext } from '@foundry/runtime';
import { requireOperator } from '../auth.js';

export async function registerReadinessRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  /**
   * Liveness. Cheap, no dependency I/O — Render restarts an instance after 60s
   * of failures, so this must not fail because Postgres is briefly slow.
   */
  app.get('/health', async (_request, reply) => {
    const liveness = ctx.health.liveness();
    return reply.code(liveness.state === 'healthy' ? 200 : 503).send(liveness);
  });

  /**
   * Readiness. Exercises real dependencies and is what Render's
   * `healthCheckPath` points at, so a instance whose pool is not open yet never
   * receives traffic.
   */
  app.get('/ready', async (_request, reply) => {
    const report = await ctx.health.readiness();
    const code = report.state === 'unhealthy' ? 503 : 200;
    return reply.code(code).send(report);
  });

  app.get('/metrics', async (request, reply) => {
    await requireOperator(request, ctx.config.operatorApiToken);
    ctx.providers.publishCapabilityMetrics();
    return reply.type('text/plain; version=0.0.4').send(metricsRegistry.render());
  });

  /**
   * The capability report.
   *
   * Deliberately blunt: `operational` is true only when every capability the
   * business loop needs is genuinely usable. A partially configured system says
   * so, in detail, rather than rounding up to "ready".
   */
  app.get('/readiness/capabilities', async () => {
    const statuses = ctx.capabilities.allCapabilityStatuses();
    const summary = ctx.capabilities.summary();

    const byState: Partial<Record<ActivationState, number>> = {};
    for (const status of statuses) {
      byState[status.state] = (byState[status.state] ?? 0) + 1;
    }

    return {
      environment: ctx.config.environment,
      release: ctx.config.releaseSha,
      summary,
      byState,
      /**
       * True only when every capability is live-verified. Never inferred from
       * the presence of an API key.
       */
      fullyVerified: summary.liveVerified === summary.total,
      capabilities: statuses.map((s) => ({
        capability: s.capability,
        provider: s.provider,
        state: s.state,
        usable: s.usable,
        evidence: s.evidence,
        missingSecrets: s.missingSecrets,
        lastVerifiedAt: s.lastVerifiedAt,
        remediation: s.remediation,
        alternatives: s.alternatives,
      })),
    };
  });

  /** Per-provider view, including which env vars are missing. */
  app.get('/readiness/providers', async () => {
    const manifests = ctx.capabilities.allManifests();
    return {
      providers: manifests.map((m) => {
        const status = ctx.capabilities.providerStatus(m.id);
        return {
          id: m.id,
          displayName: m.displayName,
          tier: m.tier,
          state: status.state,
          usable: ACTIVATION_STATE_IS_USABLE[status.state],
          missingSecrets: status.missingSecrets,
          malformedSecrets: status.malformedSecrets,
          secretModes: status.secretModes,
          lastVerifiedAt: status.lastVerifiedAt,
          lastVerificationDetail: status.lastVerificationDetail,
          capabilities: status.capabilities,
          remediation: status.remediation,
          docs: m.docs,
          liveProbe: m.liveProbe.description,
          vendorApproval: m.vendorApproval ?? null,
        };
      }),
      unimplementedAdapters: ctx.providers.unimplementedProviders(),
    };
  });

  /**
   * Every environment variable the system can consume, and whether it is set.
   * Values are never returned — only presence and mode.
   */
  app.get('/readiness/secrets', async () => {
    const specs = allSecretSpecs();
    const resolution = ctx.secrets.resolve(specs);
    return {
      total: specs.length,
      present: resolution.present.length,
      missingRequired: resolution.missingRequired,
      missingOptional: resolution.missingOptional,
      malformed: resolution.malformed,
      modes: resolution.modes,
      specs: specs.map((s) => ({
        env: s.env,
        description: s.description,
        required: s.required,
        obtainFrom: s.obtainFrom,
        set: resolution.present.includes(s.env),
      })),
    };
  });

  /**
   * The company's operating state: what stage it is in, what the loop is doing,
   * and what is blocking it.
   */
  app.get('/readiness/company', async () => {
    const company = await ctx.repos.companies.first();
    if (!company) {
      return {
        configured: false,
        message: 'No company has been created yet. POST /api/companies to configure one.',
      };
    }
    const cycles = await ctx.repos.loop.history(company.id, 5);
    const pendingApprovals = await ctx.repos.governance.approvals.listPending(company.id);
    const killSwitches = await ctx.repos.governance.killSwitches.engagedScopes(company.id);
    const budgets = await ctx.repos.governance.budgets.list(company.id);

    return {
      configured: true,
      company: {
        id: company.id,
        name: company.name,
        stage: company.stage,
        selectedOpportunityId: company.selected_opportunity_id,
        activeBrandId: company.active_brand_id,
        activeSiteId: company.active_site_id,
      },
      loop: cycles.map((c) => ({
        cycleNumber: c.cycle_number,
        phase: c.phase,
        status: c.status,
        blockedReason: c.blocked_reason,
        blockedOnCapability: c.blocked_on_capability,
        ceoDecision: c.ceo_decision,
      })),
      governance: {
        pendingApprovals: pendingApprovals.length,
        engagedKillSwitches: killSwitches,
        budgets: budgets.map((b) => ({
          scope: b.scope,
          window: b.window_kind,
          limitMinor: b.limit_minor,
          reservedMinor: b.reserved_minor,
          spentMinor: b.spent_minor,
          currency: b.currency,
        })),
      },
    };
  });
}
