/**
 * Company, loop, research, and prize-track control-plane routes.
 *
 * Creating a company seeds one actor per org-chart role (the policy gate
 * requires a handle) and enqueues the first loop tick. Missing live keys do
 * not block creation; the loop records blocked phases instead.
 *
 * Mutators require the operator bearer. GET company / loop / opportunities
 * stay public and do not return `config` or risk limits.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { CompanyConfig, isFoundryError, type FoundryError, ValidationError } from '@foundry/core';
import {
  companyAlreadyExistsError,
  defaultHackathonCompanyConfig,
  ensureOperatingCompany,
  prizeTrackSnapshot,
} from '@foundry/services';
import type { AppContext, Services } from '@foundry/runtime';
import { requireOperator } from '../auth.js';

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

/**
 * Reply with the Foundry error envelope directly. Fastify's default handler
 * looks at `statusCode`, not `httpStatus`, so throwing a FoundryError becomes
 * a 500 `{ code: internal }` even when the category is conflict/validation.
 */
function sendFoundryError(request: FastifyRequest, reply: FastifyReply, error: FoundryError) {
  return reply.code(error.httpStatus).send({
    error: {
      code: error.code,
      message: error.message,
      traceId: (request as { traceId?: string }).traceId,
    },
  });
}

function isZodIssues(error: unknown): error is { issues: { path: PropertyKey[]; message: string }[] } {
  return Boolean(
    error &&
      typeof error === 'object' &&
      'issues' in error &&
      Array.isArray((error as { issues: unknown }).issues),
  );
}

export async function registerCompanyRoutes(
  app: FastifyInstance,
  ctx: AppContext,
  services: Services,
): Promise<void> {
  app.post<{ Body: unknown }>('/api/companies', async (request, reply) => {
    await requireOperator(request, ctx.config.operatorApiToken);
    const parsed = CreateCompany.safeParse(request.body);
    if (!parsed.success) {
      return sendFoundryError(
        request,
        reply,
        new ValidationError('Invalid company payload', {
          issues: parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
        }),
      );
    }
    const body = parsed.data;

    const existing = await ctx.repos.companies.first();
    if (existing) {
      return sendFoundryError(request, reply, companyAlreadyExistsError(existing.id));
    }

    try {
      const config = body.config ?? defaultHackathonCompanyConfig({
        ownerName: body.ownerName,
        ownerEmail: body.ownerEmail,
      });

      const seeded = await ensureOperatingCompany({
        repos: ctx.repos,
        queues: ctx.queues,
        name: body.name,
        mission: body.mission,
        ownerName: body.ownerName,
        ownerEmail: body.ownerEmail,
        config,
      });

      // Lost the create race with boot or another POST — still not a 201.
      if (!seeded.created) {
        return sendFoundryError(request, reply, companyAlreadyExistsError(seeded.companyId));
      }

      return reply.code(201).send({
        companyId: seeded.companyId,
        cycleId: seeded.cycleId,
        actorsSeeded: seeded.actorsSeeded,
        loopJobId: seeded.loopJobId,
        enqueueError: seeded.enqueueError,
        prizeTracks: prizeTrackSnapshot(ctx.capabilities),
        note: 'Legal documents will not generate until legalEntity.registeredName and related fields are set. Missing sponsor keys block phases; they do not fake completion.',
      });
    } catch (error) {
      if (isZodIssues(error)) {
        return sendFoundryError(
          request,
          reply,
          new ValidationError('Invalid company payload', {
            issues: error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
          }),
        );
      }
      throw error;
    }
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

  app.put<{ Params: { id: string }; Body: unknown }>('/api/companies/:id/config', async (request, reply) => {
    await requireOperator(request, ctx.config.operatorApiToken);
    const parsed = UpdateConfig.safeParse(request.body);
    if (!parsed.success) {
      return sendFoundryError(
        request,
        reply,
        new ValidationError('Invalid company config', {
          issues: parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
        }),
      );
    }
    try {
      const company = await ctx.repos.companies.updateConfig(request.params.id, parsed.data.config);
      return reply.code(200).send({ companyId: company.id, updated: true });
    } catch (error) {
      if (isZodIssues(error)) {
        return sendFoundryError(
          request,
          reply,
          new ValidationError('Invalid company config', {
            issues: error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
          }),
        );
      }
      if (isFoundryError(error)) {
        return sendFoundryError(request, reply, error);
      }
      throw error;
    }
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
    await requireOperator(request, ctx.config.operatorApiToken);
    const tick = await services.loop.tick(request.params.id);
    return tick;
  });

  app.post<{ Params: { id: string }; Body: unknown }>('/api/companies/:id/research', async (request, reply) => {
    await requireOperator(request, ctx.config.operatorApiToken);
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
   * Prize-track snapshot. `probeLive` is adapter.probe() (GET /projects,
   * catalog, …). `liveVerified` is true only when the prize-relevant method
   * succeeded — catalog/list probes are not a prize-method pass.
   */
  app.get('/api/prize-tracks', async () => {
    return {
      tracks: prizeTrackSnapshot(ctx.capabilities),
    };
  });
}
