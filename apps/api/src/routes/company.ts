/**
 * Company, loop, research, and prize-track control-plane routes.
 *
 * Creating a company seeds one actor per org-chart role (the policy gate
 * requires a handle) and enqueues the first loop tick. Missing live keys do
 * not block creation; the loop records blocked phases instead.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { CompanyConfig, ValidationError } from '@foundry/core';
import { defaultHackathonCompanyConfig, seedOrgActors } from '@foundry/services';
import type { AppContext, Services } from '@foundry/runtime';

const CreateCompany = z.object({
  name: z.string().min(1),
  mission: z.string().min(1),
  ownerName: z.string().min(1),
  ownerEmail: z.string().email(),
  config: CompanyConfig.optional(),
});

const UpdateConfig = z.object({
  config: CompanyConfig,
});

const CollectResearch = z.object({
  query: z.string().min(3),
  sourceKinds: z.array(z.string()).min(1).default(['blog_post', 'reddit_post', 'product_review']),
  maxItems: z.number().int().positive().max(100).default(40),
});

const PRIZE_CAPABILITIES = [
  { track: 'Terac (required)', capability: 'expert.structured_review' as const },
  { track: 'Best Overall Agent-Run Company / Stripe', capability: 'payments.checkout.physical' as const },
  { track: 'Stripe Payment Link (hackathon revenue)', capability: 'payments.payment_link' as const },
  { track: 'Linq Agent Pay / iMessage', capability: 'payments.imessage_checkout' as const },
  { track: 'Best use of Replay', capability: 'qa.autonomous_exploration' as const },
  { track: 'Best use of Superserve', capability: 'compute.persistent_sandbox' as const },
  { track: 'Best use of Pioneer (PII)', capability: 'compliance.pii_scan' as const },
  { track: 'Best use of Pioneer (GLiGuard)', capability: 'compliance.prompt_guard' as const },
  { track: 'Best use of Band', capability: 'coordination.agent_mesh' as const },
  { track: 'Best use of Render (Workflows)', capability: 'platform.workflows' as const },
  { track: 'Render deploys', capability: 'platform.deploy_control' as const },
  { track: 'Lovable storefront generate', capability: 'site.generate' as const },
  { track: 'Solari browser', capability: 'research.browser_session' as const },
] as const;

export async function registerCompanyRoutes(
  app: FastifyInstance,
  ctx: AppContext,
  services: Services,
): Promise<void> {
  app.post<{ Body: unknown }>('/api/companies', async (request, reply) => {
    const body = CreateCompany.parse(request.body);
    const existing = await ctx.repos.companies.first();
    if (existing) {
      throw new ValidationError(
        `A company already exists (${existing.id}). PUT /api/companies/${existing.id}/config to update it.`,
        { companyId: existing.id },
      );
    }

    const config = body.config ?? defaultHackathonCompanyConfig({
      ownerName: body.ownerName,
      ownerEmail: body.ownerEmail,
    });

    const company = await ctx.repos.companies.create({
      name: body.name,
      mission: body.mission,
      config,
    });
    const actorsSeeded = await seedOrgActors(ctx.repos, company.id, config.commerce.baseCurrency);
    const cycle = await ctx.repos.loop.currentOrStart(company.id);
    const jobId = await ctx.queues.enqueue('loop.tick', {
      companyId: company.id,
      traceId: company.id,
      originRunId: null,
      idempotencyKey: `loop:start:${company.id}`,
      cycleId: cycle.id,
      forcePhase: null,
    });

    return reply.code(201).send({
      companyId: company.id,
      cycleId: cycle.id,
      actorsSeeded,
      loopJobId: jobId,
      note: 'Legal documents will not generate until legalEntity.registeredName and related fields are set. Missing sponsor keys block phases; they do not fake completion.',
    });
  });

  app.get('/api/companies', async () => {
    const rows = await ctx.repos.companies.list();
    return {
      companies: rows.map((row) => ({
        id: row.id,
        name: row.name,
        stage: row.stage,
        selectedOpportunityId: row.selected_opportunity_id,
        activeBrandId: row.active_brand_id,
        activeSiteId: row.active_site_id,
      })),
    };
  });

  app.get<{ Params: { id: string } }>('/api/companies/:id', async (request) => {
    const company = await ctx.repos.companies.byId(request.params.id);
    const cycle = await ctx.repos.loop.currentOrStart(company.id);
    return {
      id: company.id,
      name: company.name,
      mission: company.mission,
      stage: company.stage,
      selectedOpportunityId: company.selected_opportunity_id,
      activeBrandId: company.active_brand_id,
      activeSiteId: company.active_site_id,
      loop: {
        cycleId: cycle.id,
        number: cycle.cycle_number,
        phase: cycle.phase,
        status: cycle.status,
        blockedReason: cycle.blocked_reason,
        blockedOnCapability: cycle.blocked_on_capability,
        ceoDecision: cycle.ceo_decision,
      },
    };
  });

  app.put<{ Params: { id: string }; Body: unknown }>('/api/companies/:id/config', async (request) => {
    const body = UpdateConfig.parse(request.body);
    const company = await ctx.repos.companies.updateConfig(request.params.id, body.config);
    return { companyId: company.id, updated: true };
  });

  app.get<{ Params: { id: string } }>('/api/companies/:id/loop', async (request) => {
    const history = await ctx.repos.loop.history(request.params.id, 10);
    return {
      cycles: history.map((cycle) => ({
        id: cycle.id,
        number: cycle.cycle_number,
        phase: cycle.phase,
        status: cycle.status,
        blockedReason: cycle.blocked_reason,
        blockedOnCapability: cycle.blocked_on_capability,
        ceoDecision: cycle.ceo_decision,
        startedAt: cycle.started_at,
      })),
    };
  });

  app.post<{ Params: { id: string } }>('/api/companies/:id/loop/tick', async (request) => {
    const tick = await services.loop.tick(request.params.id);
    return tick;
  });

  app.post<{ Params: { id: string }; Body: unknown }>('/api/companies/:id/research', async (request, reply) => {
    const body = CollectResearch.parse(request.body);
    const jobId = await ctx.queues.enqueue('research.collect', {
      companyId: request.params.id,
      traceId: `research:${request.params.id}:${Date.now().toString(36)}`,
      originRunId: null,
      idempotencyKey: null,
      query: body.query,
      sourceKinds: body.sourceKinds,
      maxItems: body.maxItems,
      opportunityId: null,
    });
    return reply.code(202).send({ queued: true, jobId });
  });

  app.get<{ Params: { id: string } }>('/api/companies/:id/opportunities', async (request) => {
    const rows = await ctx.repos.research.opportunities.list(request.params.id);
    return {
      opportunities: rows.map((row) => ({
        id: row.id,
        title: row.title,
        stage: row.stage,
        category: row.category,
        painPointIds: row.pain_point_ids,
      })),
    };
  });

  /**
   * Prize-track capability snapshot. `usable` means the adapter will attempt a
   * real call. `live_verified` is only true after the verifier wrote a probe row.
   */
  app.get('/api/prize-tracks', async () => {
    return {
      tracks: PRIZE_CAPABILITIES.map((item) => {
        const status = ctx.capabilities.resolveCapability(item.capability);
        return {
          track: item.track,
          capability: item.capability,
          state: status.state,
          usable: status.usable,
          liveVerified: status.state === 'live_verified',
          missingSecrets: status.missingSecrets,
          remediation: status.remediation,
        };
      }),
    };
  });
}
