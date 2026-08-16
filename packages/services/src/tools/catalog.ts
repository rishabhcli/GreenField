/**
 * Org-chart tool catalog.
 *
 * Every name in `allReferencedTools()` must be registered here. A missing name
 * is a boot failure, not a silent reduction of what a role can do.
 */

import { z } from 'zod';
import {
  AssetKind,
  BudgetScope,
  BudgetWindow,
  EvidenceSourceKind,
  ExperimentObjective,
  KillSwitchScope,
  PaymentRoute,
  ProductKind,
  RfqSpecification,
  SiteSpec,
  allReferencedTools,
  type Authority,
  type Capability,
} from '@foundry/core';
import { companyConfig } from '@foundry/db';
import { defineTool, type AgentTool, type ToolContext } from '@foundry/agents';
import {
  BandAdapter,
  LinqAdapter,
  RenderAdapter,
  ReplayAdapter,
  Sandbox0Adapter,
  SolariAdapter,
  StripeAdapter,
  SuperserveAdapter,
  TeracAdapter,
} from '@foundry/providers';
import { optionalCapability as optCap } from '../deps.js';
import { prizeTrackSnapshot } from '../org/prize-tracks.js';
import { matchCatalogProducts } from '../commerce/sms-invoice.js';
import { loadAndEvaluateSelection } from '../research/selection.js';
import { resolveUnitContributionMinor } from '../sourcing/economics.js';
import type { CompanyToolHost } from './host.js';

interface ToolSpec<T extends z.ZodTypeAny> {
  readonly name: string;
  readonly description: string;
  readonly authority: Authority;
  readonly capability?: Capability;
  readonly consequential: boolean;
  readonly input: T;
  readonly execute: (input: z.infer<T>, ctx: ToolContext, s: CompanyToolHost) => Promise<unknown>;
}

function tool<T extends z.ZodTypeAny>(spec: ToolSpec<T>, s: CompanyToolHost): AgentTool<never, unknown> {
  return defineTool({
    name: spec.name,
    description: spec.description,
    authority: spec.authority,
    capability: spec.capability,
    consequential: spec.consequential,
    inputSchema: spec.input,
    describeAction: () => spec.name,
    subjectRef: () => null,
    execute: (input, ctx) => spec.execute(input as z.infer<T>, ctx, s),
  }) as unknown as AgentTool<never, unknown>;
}

const Empty = z.object({});
const Id = z.string().min(1);
const Text = z.string().min(1);

function blocked(capability: Capability, reason: string) {
  return { ok: false as const, blockedOn: { capability, reason } };
}

function blockedFrom(capability: Capability, error: unknown) {
  const reason = error instanceof Error ? error.message : String(error);
  return blocked(capability, reason);
}

export function buildCompanyTools(s: CompanyToolHost): AgentTool<never, unknown>[] {
  const tools: AgentTool<never, unknown>[] = [
    /* ------------------------------------------------------------------ */
    /* Company / org / governance                                          */
    /* ------------------------------------------------------------------ */
    tool(
      {
        name: 'company.get_state',
        description: 'Read the company row, loop cycle, capability summary and kill-switch state. Call this first on every run.',
        authority: 'research.collect',
        consequential: false,
        input: Empty,
        execute: async (_i, ctx) => {
          const company = await s.deps.repos.companies.byId(ctx.companyId);
          const cycle = await s.deps.repos.loop.currentOrStart(ctx.companyId);
          const killed = await s.deps.repos.governance.killSwitches.engagedScopes(ctx.companyId);
          return {
            company: {
              id: company.id,
              name: company.name,
              mission: company.mission,
              stage: company.stage,
              selectedOpportunityId: company.selected_opportunity_id,
              activeBrandId: company.active_brand_id,
              activeSiteId: company.active_site_id,
              kpiTargets: company.kpi_targets,
            },
            cycle: {
              id: cycle.id,
              number: cycle.cycle_number,
              phase: cycle.phase,
              status: cycle.status,
              blockedReason: cycle.blocked_reason,
              ceoDecision: cycle.ceo_decision,
            },
            capabilities: s.deps.capabilities.summary(),
            prizeTracks: prizeTrackSnapshot(s.deps.capabilities),
            engagedKillSwitches: killed,
          };
        },
      },
      s,
    ),
    tool(
      {
        name: 'org.dispatch_manager',
        description: 'CEO only: enqueue a manager run. Use when a function must own the next artefact.',
        authority: 'research.collect',
        consequential: true,
        input: z.object({ toRoleKey: Id, objective: Text }),
        execute: async (input, ctx) =>
          s.deps.dispatcher.dispatch({
            companyId: ctx.companyId,
            fromRoleKey: 'ceo',
            toRoleKey: input.toRoleKey,
            objective: input.objective,
            parentRunId: ctx.runId,
            traceId: ctx.traceId,
          }),
      },
      s,
    ),
    tool(
      {
        name: 'org.dispatch_specialist',
        description: 'Manager only: enqueue a direct-report specialist. The BAND room is the handoff when Band is configured.',
        authority: 'research.collect',
        consequential: true,
        input: z.object({ toRoleKey: Id, objective: Text }),
        execute: async (input, ctx) =>
          s.deps.dispatcher.dispatch({
            companyId: ctx.companyId,
            fromRoleKey: ctx.roleKey,
            toRoleKey: input.toRoleKey,
            objective: input.objective,
            parentRunId: ctx.runId,
            traceId: ctx.traceId,
          }),
      },
      s,
    ),
    tool(
      {
        name: 'org.get_manager_reports',
        description: 'Collect child run outputs for this run. Call after dispatching specialists.',
        authority: 'research.collect',
        consequential: false,
        input: Empty,
        execute: async (_i, ctx) => s.deps.dispatcher.collectReports(ctx.runId),
      },
      s,
    ),
    tool(
      {
        name: 'org.report_to_ceo',
        description: 'Write a structured report the CEO can read. Does not invent metrics.',
        authority: 'research.collect',
        consequential: false,
        input: z.object({ summary: Text, evidence: z.array(z.string()).default([]) }),
        execute: async (input, ctx) => {
          await s.deps.repos.audit.append({
            companyId: ctx.companyId,
            kind: 'agent_decision',
            actorId: ctx.actorHandle,
            actorKind: 'manager_agent',
            action: `report to CEO from ${ctx.roleKey}`,
            subjectType: 'agent_run',
            subjectRefId: ctx.runId,
            outcome: 'success',
            detail: { summary: input.summary, evidence: input.evidence },
          });
          return { recorded: true };
        },
      },
      s,
    ),
    tool(
      {
        name: 'org.report_to_manager',
        description: 'Write a structured specialist report for the parent manager.',
        authority: 'research.collect',
        consequential: false,
        input: z.object({ summary: Text, evidence: z.array(z.string()).default([]) }),
        execute: async (input, ctx) => {
          await s.deps.repos.audit.append({
            companyId: ctx.companyId,
            kind: 'agent_decision',
            actorId: ctx.actorHandle,
            actorKind: 'specialist_agent',
            action: `report to manager from ${ctx.roleKey}`,
            subjectType: 'agent_run',
            subjectRefId: ctx.runId,
            outcome: 'success',
            detail: { summary: input.summary, evidence: input.evidence },
          });
          return { recorded: true };
        },
      },
      s,
    ),
    tool(
      {
        name: 'band.post_message',
        description: 'Post into the company BAND coordination room. Recipients must be @mentioned or the send is refused.',
        authority: 'research.collect',
        capability: 'coordination.agent_mesh',
        consequential: true,
        input: z.object({ body: Text, recipients: z.array(Id).min(1) }),
        execute: async (input, ctx) => {
          const band = optCap<BandAdapter>(s.deps, 'coordination.agent_mesh');
          if (!band) {
            return blocked(
              'coordination.agent_mesh',
              'BAND is not usable; coordination.agent_mesh is blocked.',
            );
          }
          const company = await s.deps.repos.companies.byId(ctx.companyId);
          const config = companyConfig(company);
          let chatId = config.integrations?.bandChatId ?? null;
          if (!chatId) {
            try {
              const chat = await band.createChat({
                name: `${company.name} coordination`,
                taskId: ctx.companyId,
              });
              chatId = chat.id;
              await s.deps.repos.companies.updateConfig(ctx.companyId, {
                ...config,
                integrations: { ...config.integrations, bandChatId: chatId },
              });
            } catch (error) {
              return blockedFrom('coordination.agent_mesh', error);
            }
          }
          try {
            const message = await band.sendMessage(chatId, {
              recipients: input.recipients,
              body: input.body,
              taskId: ctx.runId,
            });
            return { posted: true, messageId: message.id, chatId };
          } catch (error) {
            return blockedFrom('coordination.agent_mesh', error);
          }
        },
      },
      s,
    ),
    tool(
      {
        name: 'audit.write_decision',
        description: 'Persist a CEO decision on the current loop cycle with the rationale.',
        authority: 'research.collect',
        consequential: true,
        input: z.object({
          decision: z.enum(['scale', 'hold', 'pivot', 'stop', 'select', 'reject']),
          rationale: Text,
        }),
        execute: async (input, ctx) => {
          const cycle = await s.deps.repos.loop.currentOrStart(ctx.companyId);
          await s.deps.repos.loop.recordDecision(cycle.id, input.decision, input.rationale);
          await s.deps.repos.audit.append({
            companyId: ctx.companyId,
            kind: 'agent_decision',
            actorId: ctx.actorHandle,
            actorKind: 'ceo_agent',
            action: `CEO decision ${input.decision}`,
            subjectType: 'loop_cycle',
            subjectRefId: cycle.id,
            outcome: 'success',
            detail: { rationale: input.rationale },
          });
          return { cycleId: cycle.id, decision: input.decision };
        },
      },
      s,
    ),
    tool(
      {
        name: 'audit.verify_chain',
        description: 'Verify the append-only audit hash chain for this company.',
        authority: 'research.collect',
        consequential: false,
        input: Empty,
        execute: async (_i, ctx) => s.deps.repos.audit.verifyChain(ctx.companyId),
      },
      s,
    ),
    tool(
      {
        name: 'governance.request_approval',
        description: 'Open a human approval request. Use before supplier contact, production spend, or policy publish.',
        authority: 'research.collect',
        consequential: true,
        input: z.object({
          request: Text,
          authority: z.string().min(1),
          subjectRefId: z.string().nullable().default(null),
          amountMinor: z.number().int().nonnegative().nullable().default(null),
          currency: z.string().length(3).nullable().default(null),
          riskNotes: z.array(z.string()).default([]),
        }),
        execute: async (input, ctx) => {
          const actor = await s.deps.repos.governance.actors.requireByHandle(ctx.companyId, ctx.actorHandle);
          const row = await s.deps.repos.governance.approvals.create({
            companyId: ctx.companyId,
            request: input.request,
            authority: input.authority as Authority,
            requestedByActorId: actor.id,
            subjectRefId: input.subjectRefId,
            amountMinor: input.amountMinor,
            currency: input.currency,
            riskNotes: input.riskNotes,
          });
          return { approvalId: row.id, status: row.status };
        },
      },
      s,
    ),
    tool(
      {
        name: 'governance.set_budget',
        description: 'Set or update a spend budget window. Does not spend money.',
        authority: 'research.collect',
        consequential: true,
        input: z.object({
          scope: BudgetScope,
          window: BudgetWindow,
          limitMinor: z.number().int().nonnegative(),
          currency: z.string().length(3),
          hardStop: z.boolean().default(true),
        }),
        execute: async (input, ctx) => {
          const row = await s.deps.repos.governance.budgets.upsert({
            companyId: ctx.companyId,
            scope: input.scope,
            window: input.window,
            limitMinor: input.limitMinor,
            currency: input.currency,
            hardStop: input.hardStop,
          });
          return { budgetId: row.id, remaining: row.limit_minor - row.reserved_minor - row.spent_minor };
        },
      },
      s,
    ),
    tool(
      {
        name: 'governance.engage_kill_switch',
        description: 'Engage a kill switch. Stops the matching class of actions until a human releases it.',
        authority: 'research.collect',
        consequential: true,
        input: z.object({ scope: KillSwitchScope, reason: Text }),
        execute: async (input, ctx) => {
          const row = await s.deps.repos.governance.killSwitches.engage(
            ctx.companyId,
            input.scope,
            input.reason,
            ctx.actorHandle,
          );
          return { scope: row.scope, engaged: row.engaged };
        },
      },
      s,
    ),

    /* ------------------------------------------------------------------ */
    /* Research                                                            */
    /* ------------------------------------------------------------------ */
    tool(
      {
        name: 'research.run_collection',
        description: 'Collect real web/Reddit evidence for a query. Empty provider results stay empty.',
        authority: 'research.collect',
        consequential: true,
        input: z.object({
          query: Text,
          sourceKinds: z.array(z.string()).min(1).default(['web', 'reddit']),
          maxItems: z.number().int().positive().default(10),
        }),
        execute: async (input, ctx) =>
          s.research.collect({
            companyId: ctx.companyId,
            query: input.query,
            sourceKinds: input.sourceKinds,
            maxItems: input.maxItems,
          }),
      },
      s,
    ),
    tool(
      {
        name: 'research.collect',
        description: 'Alias of research.run_collection for manager prompts that use the shorter name.',
        authority: 'research.collect',
        consequential: true,
        input: z.object({
          query: Text,
          sourceKinds: z.array(z.string()).min(1).default(['web']),
          maxItems: z.number().int().positive().default(10),
        }),
        execute: async (input, ctx) =>
          s.research.collect({
            companyId: ctx.companyId,
            query: input.query,
            sourceKinds: input.sourceKinds,
            maxItems: input.maxItems,
          }),
      },
      s,
    ),
    tool(
      {
        name: 'research.search_communities',
        description: 'Search public community discussions (Reddit) and store them as evidence.',
        authority: 'research.collect',
        consequential: true,
        input: z.object({ query: Text, maxItems: z.number().int().positive().default(10) }),
        execute: async (input, ctx) =>
          s.research.collect({
            companyId: ctx.companyId,
            query: input.query,
            sourceKinds: ['reddit'],
            maxItems: input.maxItems,
          }),
      },
      s,
    ),
    tool(
      {
        name: 'research.search_listings',
        description: 'Search public listings/reviews via web search and store evidence.',
        authority: 'research.collect',
        consequential: true,
        input: z.object({ query: Text, maxItems: z.number().int().positive().default(10) }),
        execute: async (input, ctx) =>
          s.research.collect({
            companyId: ctx.companyId,
            query: input.query,
            sourceKinds: ['web'],
            maxItems: input.maxItems,
          }),
      },
      s,
    ),
    tool(
      {
        name: 'research.web_search',
        description: 'Run a web search and persist hits that have real URLs as evidence.',
        authority: 'research.collect',
        consequential: true,
        input: z.object({ query: Text, maxItems: z.number().int().positive().default(10) }),
        execute: async (input, ctx) =>
          s.research.collect({
            companyId: ctx.companyId,
            query: input.query,
            sourceKinds: ['web'],
            maxItems: input.maxItems,
          }),
      },
      s,
    ),
    tool(
      {
        name: 'research.fetch_thread',
        description: 'Re-fetch a previously collected evidence URL. Lowers confidence if the source is gone.',
        authority: 'research.collect',
        consequential: true,
        input: z.object({ evidenceId: Id }),
        execute: async (input) => s.research.refetch(input.evidenceId),
      },
      s,
    ),
    tool(
      {
        name: 'research.fetch_reviews',
        description: 'Collect review-like web results for a product or competitor query.',
        authority: 'research.collect',
        consequential: true,
        input: z.object({ query: Text }),
        execute: async (input, ctx) =>
          s.research.collect({
            companyId: ctx.companyId,
            query: `${input.query} review complaints`,
            sourceKinds: ['web'],
          }),
      },
      s,
    ),
    tool(
      {
        name: 'research.browse',
        description: 'Open a Solari headless-browser session. HTML is not parsed into fake suppliers or quotes.',
        authority: 'research.collect',
        capability: 'research.browser_session',
        consequential: true,
        input: z.object({ startUrl: z.string().url().nullable().default(null) }),
        execute: async (input) => {
          const solari = optCap<SolariAdapter>(s.deps, 'research.browser_session');
          if (!solari) return { sessionId: null, reason: 'research.browser_session is not usable' };
          const session = await solari.createBrowserSession({ recording: false });
          return {
            sessionId: session.sessionId,
            wsEndpoint: session.wsEndpoint ?? null,
            note: input.startUrl
              ? `Session created. Solari's documented create payload has no startUrl; open ${input.startUrl} over wsEndpoint/cdpEndpoint. No HTML was parsed into evidence.`
              : 'Session created. Drive the browser over wsEndpoint/cdpEndpoint. No HTML was parsed into evidence.',
          };
        },
      },
      s,
    ),
    tool(
      {
        name: 'research.record_evidence',
        description: 'Persist an evidence draft that already has a real URL or external id. Refuses model-only claims.',
        authority: 'research.collect',
        consequential: true,
        input: z.object({
          sourceKind: z.string().min(1),
          sourceUrl: z.string().url().nullable(),
          externalId: z.string().nullable(),
          sourceDomain: Text,
          summary: Text,
          excerpt: z.string().nullable().default(null),
        }),
        execute: async (input, ctx) => {
          if (!input.sourceUrl && !input.externalId) {
            return { inserted: false, reason: 'Evidence requires a source URL or external id.' };
          }
          const { row, isNew } = await s.deps.repos.research.evidence.insert(ctx.companyId, {
            sourceKind: EvidenceSourceKind.parse(input.sourceKind),
            sourceUrl: input.sourceUrl,
            externalId: input.externalId,
            sourceDomain: input.sourceDomain,
            retrievedAt: new Date().toISOString(),
            authoredAt: null,
            provenance: { method: 'first_party', system: 'agent_tool', recordId: ctx.runId },
            compliance: {
              robotsAllowed: true,
              robotsCheckedAt: null,
              termsReviewed: false,
              excerptStoragePermitted: Boolean(input.excerpt),
              authorIdentifierRetained: false,
              retentionPolicy: 'standard_365d',
            },
            excerpt: input.excerpt,
            summary: input.summary,
            language: 'en',
            painPointLabels: [],
            categoryLabels: [],
            competitorsMentioned: [],
            sentiment: 0,
            severity: 5,
            purchaseIntent: 'none',
            workaroundDescribed: false,
            willingnessToPayCents: null,
            geography: null,
            engagementScore: null,
            confidence: 0.4,
          });
          return { evidenceId: row.id, isNew };
        },
      },
      s,
    ),
    tool(
      {
        name: 'research.get_evidence',
        description: 'Read stored evidence items for this company.',
        authority: 'research.collect',
        consequential: false,
        input: z.object({ limit: z.number().int().positive().default(25) }),
        execute: async (input, ctx) => s.deps.repos.research.evidence.search(ctx.companyId, { limit: input.limit }),
      },
      s,
    ),
    tool(
      {
        name: 'research.refetch_source',
        description: 'Re-establish a stored evidence URL through the search adapter.',
        authority: 'research.collect',
        consequential: true,
        input: z.object({ evidenceId: Id }),
        execute: async (input) => s.research.refetch(input.evidenceId),
      },
      s,
    ),
    tool(
      {
        name: 'research.update_confidence',
        description: 'Lower or restate confidence on an evidence row with a written reason. Never raise it without a refetch.',
        authority: 'research.collect',
        consequential: true,
        input: z.object({ evidenceId: Id, confidence: z.number().min(0).max(1), reason: Text }),
        execute: async (input) => {
          const row = await s.deps.repos.research.evidence.byId(input.evidenceId);
          const next = Math.min(row.confidence, input.confidence);
          await s.deps.repos.research.evidence.updateConfidence(input.evidenceId, next, input.reason);
          return { evidenceId: input.evidenceId, confidence: next };
        },
      },
      s,
    ),
    tool(
      {
        name: 'research.cluster_pain_points',
        description: 'Cluster collected evidence into pain points and candidate opportunities.',
        authority: 'research.collect',
        consequential: false,
        input: z.object({ minClusterSize: z.number().int().positive().default(3) }),
        execute: async (input, ctx) => s.cluster.cluster({ companyId: ctx.companyId, minClusterSize: input.minClusterSize }),
      },
      s,
    ),
    tool(
      {
        name: 'research.verify_evidence',
        description: 'Refetch the newest evidence items and report how many remain verifiable.',
        authority: 'research.collect',
        consequential: true,
        input: z.object({ limit: z.number().int().positive().default(10) }),
        execute: async (input, ctx) => {
          const rows = await s.deps.repos.research.evidence.search(ctx.companyId, { limit: input.limit });
          const results = [];
          for (const row of rows) {
            results.push(await s.research.refetch(row.id));
          }
          return { checked: results.length, results };
        },
      },
      s,
    ),
    tool(
      {
        name: 'expert.request_review',
        description: 'Launch a Terac General Population study then REST feasibility. Does not invent a verdict.',
        authority: 'expert.engage_paid',
        capability: 'expert.structured_review',
        consequential: true,
        input: z.object({
          subject: z.string().min(1),
          subjectRefId: Id,
          question: Text,
          participantsRequested: z.number().int().positive().default(5),
        }),
        execute: async (input, ctx) =>
          s.experts.request({
            companyId: ctx.companyId,
            subject: input.subject,
            subjectRefId: input.subjectRefId,
            question: input.question,
            participantsRequested: input.participantsRequested,
          }),
      },
      s,
    ),
    tool(
      {
        name: 'expert.engage_paid',
        description: 'Alias of expert.request_review for manager authority names used as tools.',
        authority: 'expert.engage_paid',
        capability: 'expert.structured_review',
        consequential: true,
        input: z.object({ subject: z.string().min(1), subjectRefId: Id, question: Text }),
        execute: async (input, ctx) =>
          s.experts.request({
            companyId: ctx.companyId,
            subject: input.subject,
            subjectRefId: input.subjectRefId,
            question: input.question,
          }),
      },
      s,
    ),

    /* ------------------------------------------------------------------ */
    /* Opportunity                                                         */
    /* ------------------------------------------------------------------ */
    tool(
      {
        name: 'opportunity.list',
        description: 'List opportunities with latest scorecard fields when present.',
        authority: 'research.collect',
        consequential: false,
        input: Empty,
        execute: async (_i, ctx) => s.deps.repos.research.opportunities.ranked(ctx.companyId, 25),
      },
      s,
    ),
    tool(
      {
        name: 'opportunity.create',
        description: 'Create an opportunity from already-clustered pain points. Does not invent demand.',
        authority: 'research.collect',
        consequential: true,
        input: z.object({
          title: Text,
          concept: Text,
          painPointIds: z.array(Id).min(1),
          targetSegment: Text,
          category: Text,
          valueHypothesis: Text,
        }),
        execute: async (input, ctx) =>
          s.deps.repos.research.opportunities.create({
            companyId: ctx.companyId,
            title: input.title,
            concept: input.concept,
            painPointIds: input.painPointIds,
            targetSegment: input.targetSegment,
            category: input.category,
            valueHypothesis: input.valueHypothesis,
          }),
      },
      s,
    ),
    tool(
      {
        name: 'opportunity.score',
        description: 'Write a scorecard from observable evidence. Ungrounded dimensions stay ungrounded.',
        authority: 'research.collect',
        consequential: false,
        input: z.object({ opportunityId: Id }),
        execute: async (input, ctx) =>
          s.score.score({ companyId: ctx.companyId, opportunityId: input.opportunityId }),
      },
      s,
    ),
    tool(
      {
        name: 'opportunity.get_scorecard',
        description: 'Read the latest scorecard for an opportunity.',
        authority: 'research.collect',
        consequential: false,
        input: z.object({ opportunityId: Id }),
        execute: async (input) => s.deps.repos.research.opportunities.latestScorecard(input.opportunityId),
      },
      s,
    ),
    tool(
      {
        name: 'opportunity.select',
        description: 'Select the opportunity the company will pursue. Records the id on the company row.',
        authority: 'research.collect',
        consequential: true,
        input: z.object({ opportunityId: Id, rationale: Text }),
        execute: async (input, ctx) => {
          const { gates } = await loadAndEvaluateSelection(s.deps, input.opportunityId);
          if (!gates.passed) {
            return { ok: false, failures: gates.failures };
          }
          await s.deps.repos.companies.setActive(ctx.companyId, { opportunityId: input.opportunityId });
          await s.deps.repos.research.opportunities.setStage(input.opportunityId, 'ceo_review');
          const cycle = await s.deps.repos.loop.currentOrStart(ctx.companyId);
          await s.deps.repos.loop.recordDecision(cycle.id, 'select', input.rationale);
          return { selected: input.opportunityId };
        },
      },
      s,
    ),
    tool(
      {
        name: 'opportunity.kill',
        description: 'Kill an opportunity with a written reason. Does not delete evidence.',
        authority: 'research.collect',
        consequential: true,
        input: z.object({ opportunityId: Id, reason: Text }),
        execute: async (input) => {
          await s.deps.repos.research.opportunities.setStage(input.opportunityId, 'killed', input.reason);
          return { killed: input.opportunityId };
        },
      },
      s,
    ),
    tool(
      {
        name: 'opportunity.record_dimension',
        description: 'Record a qualitative note against an opportunity. Does not overwrite composite scores.',
        authority: 'research.collect',
        consequential: true,
        input: z.object({ opportunityId: Id, note: Text }),
        execute: async (input, ctx) => {
          await s.deps.repos.audit.append({
            companyId: ctx.companyId,
            kind: 'agent_decision',
            actorId: ctx.actorHandle,
            actorKind: 'specialist_agent',
            action: 'record dimension note',
            subjectType: 'opportunity',
            subjectRefId: input.opportunityId,
            outcome: 'success',
            detail: { note: input.note },
          });
          return { recorded: true };
        },
      },
      s,
    ),
  ];

  tools.push(
    ...sourcingTools(s),
    ...brandSiteTools(s),
    ...growthSupportTools(s),
    ...platformTools(s),
    ...prizeTrackTools(s),
  );

  const have = new Set(tools.map((t) => t.name));
  const missing = allReferencedTools().filter((name) => !have.has(name));
  if (missing.length > 0) {
    throw new Error(`Org tools missing from catalog: ${missing.join(', ')}`);
  }
  return tools;
}

function sourcingTools(s: CompanyToolHost): AgentTool<never, unknown>[] {
  return [
    tool(
      {
        name: 'sourcing.search_suppliers',
        description: 'Search suppliers. Alibaba is vendor-approval blocked; Solari may open a browser but HTML is not parsed into quotes.',
        authority: 'supplier.contact',
        consequential: true,
        input: z.object({
          opportunityId: Id,
          keywords: Text,
          destinationCountry: z.string().length(2),
          maxSuppliers: z.number().int().positive().default(20),
        }),
        execute: async (input, ctx) =>
          s.sourcing.scan({
            companyId: ctx.companyId,
            opportunityId: input.opportunityId,
            keywords: input.keywords,
            destinationCountry: input.destinationCountry,
            maxSuppliers: input.maxSuppliers,
          }),
      },
      s,
    ),
    tool(
      {
        name: 'sourcing.record_supplier',
        description: 'Upsert a supplier that was actually retrieved, with provenance fields required.',
        authority: 'supplier.contact',
        consequential: true,
        input: z.object({
          sourceProvider: Text,
          externalId: Id,
          displayName: Text,
          kind: z.enum([
            'manufacturer',
            'trading_company',
            'contract_manufacturer',
            'private_label_specialist',
            'domestic_wholesaler',
            'print_on_demand',
            'contract_packer',
          ]),
          countryCode: z.string().length(2),
          profileUrl: z.string().url().nullable().default(null),
          discoveredVia: z.enum(['provider_api', 'browser_session', 'human_expert', 'manual_entry']),
        }),
        execute: async (input, ctx) =>
          s.deps.repos.sourcing.suppliers.upsert({
            companyId: ctx.companyId,
            sourceProvider: input.sourceProvider,
            externalId: input.externalId,
            displayName: input.displayName,
            legalName: input.displayName,
            kind: input.kind,
            countryCode: input.countryCode,
            discoveredVia: input.discoveredVia,
            profileUrl: input.profileUrl,
          }),
      },
      s,
    ),
    tool(
      {
        name: 'sourcing.get_supplier',
        description: 'Read a stored supplier row.',
        authority: 'supplier.contact',
        consequential: false,
        input: z.object({ supplierId: Id }),
        execute: async (input) => s.deps.repos.sourcing.suppliers.byId(input.supplierId),
      },
      s,
    ),
    tool(
      {
        name: 'sourcing.update_supplier',
        description: 'Add a verified certification string that was actually checked. Does not invent certifications.',
        authority: 'supplier.contact',
        consequential: true,
        input: z.object({ supplierId: Id, certification: Text }),
        execute: async (input) => {
          await s.deps.repos.sourcing.suppliers.addVerifiedCertification(input.supplierId, input.certification);
          return { supplierId: input.supplierId };
        },
      },
      s,
    ),
    tool(
      {
        name: 'sourcing.draft_rfq',
        description: 'Store RFQ text. Sending is a separate tool and requires approval.',
        authority: 'supplier.contact',
        consequential: false,
        input: z.object({
          opportunityId: Id,
          supplierId: Id,
          messageBody: Text,
          channel: z.enum(['email', 'platform_message', 'phone', 'web_form', 'whatsapp', 'wechat']),
          specification: z.record(z.string(), z.unknown()),
        }),
        execute: async (input, ctx) => {
          const spec = RfqSpecification.parse(input.specification);
          return s.rfq.draft({
            companyId: ctx.companyId,
            opportunityId: input.opportunityId,
            supplierId: input.supplierId,
            specification: spec,
            messageBody: input.messageBody,
            channel: input.channel,
          });
        },
      },
      s,
    ),
    tool(
      {
        name: 'sourcing.send_rfq',
        description: 'Send a drafted RFQ. Requires a human approval id. Missing approval is not a send.',
        authority: 'supplier.contact',
        consequential: true,
        input: z.object({ rfqId: Id, approvalId: Id }),
        execute: async (input) => s.rfq.send({ rfqId: input.rfqId, approvalId: input.approvalId }),
      },
      s,
    ),
    tool(
      {
        name: 'sourcing.check_responses',
        description: 'Poll the provider for quotes on an RFQ. Empty stays empty.',
        authority: 'supplier.contact',
        consequential: true,
        input: z.object({ rfqId: Id }),
        execute: async (input) => s.rfq.pollQuotes({ rfqId: input.rfqId }),
      },
      s,
    ),
    tool(
      {
        name: 'sourcing.parse_quote',
        description: 'Parse a provider quote payload into a stored quote. Refuses estimated numbers.',
        authority: 'supplier.contact',
        consequential: true,
        input: z.object({ rfqId: Id }),
        execute: async (input) => s.quotes.poll(input.rfqId),
      },
      s,
    ),
    tool(
      {
        name: 'sourcing.record_quote',
        description: 'Record a quote the provider actually returned for an RFQ.',
        authority: 'supplier.contact',
        consequential: true,
        input: z.object({ rfqId: Id }),
        execute: async (input) => s.quotes.poll(input.rfqId),
      },
      s,
    ),
    tool(
      {
        name: 'sourcing.build_landed_cost',
        description: 'Build a landed-cost model from a real quote. Incomplete or failing margin economics refuse the build.',
        authority: 'supplier.contact',
        consequential: false,
        input: z.object({
          opportunityId: Id,
          quoteId: Id,
          orderQuantity: z.number().int().positive(),
          destinationCountry: z.string().length(2),
          sellingPriceMinor: z.number().int().positive().nullable().default(null),
        }),
        execute: async (input, ctx) =>
          s.economics.build({
            companyId: ctx.companyId,
            opportunityId: input.opportunityId,
            quoteId: input.quoteId,
            orderQuantity: input.orderQuantity,
            destinationCountry: input.destinationCountry,
            sellingPriceMinor: input.sellingPriceMinor,
          }),
      },
      s,
    ),
    tool(
      {
        name: 'sourcing.request_sample',
        description: 'Record that a sample was requested. Does not invent a supplier confirmation.',
        authority: 'supplier.purchase_sample',
        consequential: true,
        input: z.object({ rfqId: Id, note: Text }),
        execute: async (input, ctx) => {
          await s.deps.repos.audit.append({
            companyId: ctx.companyId,
            kind: 'supplier_contacted',
            actorId: ctx.actorHandle,
            actorKind: 'specialist_agent',
            action: 'sample requested',
            subjectType: 'rfq',
            subjectRefId: input.rfqId,
            outcome: 'success',
            detail: { note: input.note },
          });
          return { recorded: true, purchased: false, reason: 'Sample purchase requires a real supplier payment; this only records intent.' };
        },
      },
      s,
    ),
    tool(
      {
        name: 'sourcing.record_inspection',
        description: 'Record a sample inspection note. Not a QC pass stamp.',
        authority: 'supplier.purchase_sample',
        consequential: true,
        input: z.object({ rfqId: Id, findings: Text, defectsFound: z.boolean() }),
        execute: async (input, ctx) => {
          await s.deps.repos.audit.append({
            companyId: ctx.companyId,
            kind: 'compliance_check',
            actorId: ctx.actorHandle,
            actorKind: 'specialist_agent',
            action: 'sample inspection recorded',
            subjectType: 'rfq',
            subjectRefId: input.rfqId,
            outcome: input.defectsFound ? 'failure' : 'success',
            detail: { findings: input.findings, defectsFound: input.defectsFound },
          });
          return { recorded: true };
        },
      },
      s,
    ),
    tool(
      {
        name: 'finance.compute_contribution',
        description: 'Read the latest landed-cost model and report contribution only when a selling price exists.',
        authority: 'payments.configure',
        consequential: false,
        input: z.object({ opportunityId: Id }),
        execute: async (input) => {
          const model = await s.deps.repos.sourcing.landedCosts.latestForOpportunity(input.opportunityId);
          if (!model) return { complete: false, reason: 'no landed-cost model' };
          return {
            landedUnitCost: model.landed_unit_cost,
            groundedRatio: model.grounded_ratio,
            assumedComponents: model.assumed_components,
            complete: model.assumed_components.length === 0,
          };
        },
      },
      s,
    ),
    tool(
      {
        name: 'fulfilment.get_rate_quote',
        description: 'Does not invent a freight rate. Returns blocked until a carrier quote API is called from fulfilment.',
        authority: 'fulfilment.purchase_label',
        consequential: false,
        input: z.object({ orderId: z.string().nullable().default(null) }),
        execute: async () => ({
          quoted: false,
          reason: 'No freight API quote is attached. Landed-cost freight remains tagged assumption until Shippo returns a rate on a real order.',
        }),
      },
      s,
    ),
    tool(
      {
        name: 'fulfilment.get_tracking',
        description: 'Read shipment tracking for an order from stored carrier status.',
        authority: 'messaging.send_customer',
        consequential: false,
        input: z.object({ orderId: Id }),
        execute: async (input) => s.deps.repos.commerce.shipments.forOrder(input.orderId),
      },
      s,
    ),
  ];
}

function brandSiteTools(s: CompanyToolHost): AgentTool<never, unknown>[] {
  return [
    tool(
      {
        name: 'brand.generate_names',
        description: 'Propose names via the reasoning model. Domain/trademark checks are separate tools.',
        authority: 'brand.publish',
        consequential: false,
        input: z.object({ opportunityId: Id, count: z.number().int().positive().default(8) }),
        execute: async (input, ctx) =>
          s.brand.generateNames({ companyId: ctx.companyId, opportunityId: input.opportunityId, count: input.count }),
      },
      s,
    ),
    tool(
      {
        name: 'brand.check_domains',
        description: 'Check .com availability through Cloudflare. Unavailable provider is blocked, not guessed.',
        authority: 'brand.publish',
        consequential: true,
        input: z.object({ names: z.array(Text).min(1) }),
        execute: async (input) => s.brand.checkDomains({ names: input.names }),
      },
      s,
    ),
    tool(
      {
        name: 'brand.research_trademark_preliminary',
        description: 'Preliminary web-search trademark research with an explicit non-clearance disclaimer.',
        authority: 'brand.publish',
        consequential: true,
        input: z.object({ name: Text }),
        execute: async (input, ctx) =>
          s.brand.researchTrademarkPreliminary({ companyId: ctx.companyId, name: input.name }),
      },
      s,
    ),
    tool(
      {
        name: 'legal.research_trademark_preliminary',
        description: 'Same preliminary trademark search as brand.research_trademark_preliminary, for legal roles.',
        authority: 'legal.publish_policy',
        consequential: true,
        input: z.object({ name: Text }),
        execute: async (input, ctx) =>
          s.brand.researchTrademarkPreliminary({ companyId: ctx.companyId, name: input.name }),
      },
      s,
    ),
    tool(
      {
        name: 'brand.create_identity',
        description: 'Persist a brand identity and mark it active. Not a trademark clearance.',
        authority: 'brand.publish',
        consequential: true,
        input: z.object({
          opportunityId: Id,
          name: Text,
          tagline: Text,
          positioning: Text,
          valueProposition: Text,
          targetSegment: Text,
          toneAttributes: z.array(z.string()).default([]),
        }),
        execute: async (input, ctx) =>
          s.brand.createIdentity({
            companyId: ctx.companyId,
            opportunityId: input.opportunityId,
            name: input.name,
            tagline: input.tagline,
            positioning: input.positioning,
            valueProposition: input.valueProposition,
            targetSegment: input.targetSegment,
            toneAttributes: input.toneAttributes,
            palette: [],
            typography: {},
          }),
      },
      s,
    ),
    tool(
      {
        name: 'brand.update_identity',
        description: 'Rewrite page content from the persisted brand. Does not invent claims.',
        authority: 'brand.publish',
        consequential: true,
        input: z.object({ brandId: Id }),
        execute: async (input) => s.brand.draftPageContent({ brandId: input.brandId }),
      },
      s,
    ),
    tool(
      {
        name: 'brand.get_identity',
        description: 'Read a stored brand row.',
        authority: 'brand.publish',
        consequential: false,
        input: z.object({ brandId: Id }),
        execute: async (input) => s.deps.repos.build.brands.byId(input.brandId),
      },
      s,
    ),
    tool(
      {
        name: 'brand.draft_page_content',
        description: 'Draft storefront copy from persisted brand fields.',
        authority: 'brand.publish',
        consequential: false,
        input: z.object({ brandId: Id, siteId: z.string().nullable().default(null) }),
        execute: async (input) =>
          s.brand.draftPageContent({
            brandId: input.brandId,
            ...(input.siteId ? { siteId: input.siteId } : {}),
          }),
      },
      s,
    ),
    tool(
      {
        name: 'brand.generate_asset',
        description: 'Generate a brand asset via the image provider. Missing credentials return blocked.',
        authority: 'brand.publish',
        capability: 'asset.image_generation',
        consequential: true,
        input: z.object({ brandId: Id, assetKind: AssetKind, prompt: Text, variants: z.number().int().positive().default(2) }),
        execute: async (input, ctx) =>
          s.assets.generate({
            companyId: ctx.companyId,
            brandId: input.brandId,
            assetKind: input.assetKind,
            prompt: input.prompt,
            variants: input.variants,
          }),
      },
      s,
    ),
    tool(
      {
        name: 'site.create_spec',
        description: 'Create a storefront spec row from a brand. Does not publish.',
        authority: 'site.deploy_preview',
        consequential: true,
        input: z.object({ brandId: Id, spec: z.record(z.string(), z.unknown()) }),
        execute: async (input, ctx) =>
          s.site.createSpec({
            companyId: ctx.companyId,
            brandId: input.brandId,
            spec: SiteSpec.parse(input.spec),
          }),
      },
      s,
    ),
    tool(
      {
        name: 'site.generate',
        description: 'Generate storefront code via Lovable. Preview URLs are not production.',
        authority: 'site.deploy_preview',
        capability: 'site.generate',
        consequential: true,
        input: z.object({ siteId: Id, instructions: Text }),
        execute: async (input) => s.site.generate({ siteId: input.siteId, instructions: input.instructions }),
      },
      s,
    ),
    tool(
      {
        name: 'site.iterate',
        description: 'Send an iteration instruction to the site generator.',
        authority: 'site.deploy_preview',
        capability: 'site.iterate',
        consequential: true,
        input: z.object({ siteId: Id, instructions: Text }),
        execute: async (input) => s.site.generate({ siteId: input.siteId, instructions: input.instructions }),
      },
      s,
    ),
    tool(
      {
        name: 'site.export_code',
        description: 'Read generated files from Lovable. Missing files are not claimed as generated.',
        authority: 'site.deploy_preview',
        consequential: false,
        input: z.object({ siteId: Id }),
        execute: async (input) => s.site.exportCode({ siteId: input.siteId }),
      },
      s,
    ),
    tool(
      {
        name: 'site.deploy',
        description: 'Deploy preview (no gating QA) or production (requires a completed QA run id).',
        authority: 'site.deploy_preview',
        consequential: true,
        input: z.object({
          siteId: Id,
          environment: z.enum(['preview', 'production']),
          gatingQaRunId: z.string().nullable().default(null),
        }),
        execute: async (input) => {
          if (input.environment === 'preview') return s.deploy.deployPreview({ siteId: input.siteId });
          if (!input.gatingQaRunId) {
            return { ok: false, reason: 'Production deploy requires gatingQaRunId from a completed QA run.' };
          }
          return s.deploy.deployProduction({ siteId: input.siteId, gatingQaRunId: input.gatingQaRunId });
        },
      },
      s,
    ),
    tool(
      {
        name: 'site.rollback',
        description: 'Roll back to a previous Render deploy recorded on the site.',
        authority: 'site.deploy_production',
        consequential: true,
        input: z.object({ siteId: Id, deploymentId: Id }),
        execute: async (input) => s.deploy.rollback({ siteId: input.siteId, deploymentId: input.deploymentId }),
      },
      s,
    ),
    tool(
      {
        name: 'commerce.create_product',
        description: 'Create a catalogue product. Physical goods must use stripe_direct.',
        authority: 'payments.configure',
        consequential: true,
        input: z.object({
          sku: Text,
          name: Text,
          kind: ProductKind,
          description: Text,
          paymentRoute: PaymentRoute,
          priceMinor: z.number().int().positive(),
          currency: z.string().length(3),
        }),
        execute: async (input, ctx) =>
          s.deps.repos.commerce.products.create({
            companyId: ctx.companyId,
            sku: input.sku,
            name: input.name,
            kind: input.kind,
            description: input.description,
            paymentRoute: input.paymentRoute,
            priceMinor: input.priceMinor,
            currency: input.currency,
          }),
      },
      s,
    ),
    tool(
      {
        name: 'commerce.configure_checkout',
        description: 'Report the live checkout rails: Stripe sessions, hackathon Payment Link, Linq Agent Pay.',
        authority: 'payments.configure',
        consequential: false,
        input: Empty,
        execute: async () => {
          const stripe =
            optCap<StripeAdapter>(s.deps, 'payments.payment_link') ??
            optCap<StripeAdapter>(s.deps, 'payments.checkout.physical');
          const stripeCheckout = s.deps.capabilities.resolveCapability('payments.checkout.physical');
          const paymentLinkCap = s.deps.capabilities.resolveCapability('payments.payment_link');
          const linqPay = s.deps.capabilities.resolveCapability('payments.imessage_checkout');
          const linqLink = s.deps.capabilities.resolveCapability('messaging.imessage_app');
          let liveLink: { id: string; url: string; active: boolean | null } | null = null;
          let paymentLinkBlocked: string | null = null;
          if (stripe) {
            try {
              const link = await stripe.resolveHackathonPaymentLink();
              liveLink = { id: link.id, url: link.url, active: link.active ?? null };
            } catch (error) {
              paymentLinkBlocked = error instanceof Error ? error.message : String(error);
            }
          } else {
            paymentLinkBlocked = paymentLinkCap.remediation ?? `payments.payment_link is ${paymentLinkCap.state}`;
          }
          return {
            stripeCheckout: stripeCheckout.usable,
            hackathonPaymentLink: stripe?.hackathonPaymentLinkUrl() ?? liveLink?.url ?? null,
            hackathonPaymentLinkLive: liveLink,
            hackathonPaymentLinkBlocked: paymentLinkBlocked,
            linqAgentPay: linqPay.usable,
            linqAgentPayState: linqPay.state,
            linqAgentPayRemediation: linqPay.remediation ?? null,
            linqLinkExperience: linqLink.usable,
            linqLinkExperienceState: linqLink.state,
            note:
              'Physical goods settle on Stripe. Dodo/Whop refuse physical goods. ' +
              'The hackathon Payment Link must stay the submitted URL. ' +
              'Linq Agent Pay (2011: no connected Stripe) is not a Payment Link send; use linq.send_link for that.',
          };
        },
      },
      s,
    ),
    tool(
      {
        name: 'commerce.collect_payment',
        description:
          'Collect the order total over Linq (Stripe Checkout link; Agent Pay if connected). Amount comes from the order row, never from the model.',
        authority: 'payments.configure',
        consequential: true,
        input: z.object({
          orderId: Id,
          toHandle: Text,
          description: Text,
        }),
        execute: async (input, ctx) => {
          const stripe =
            optCap<StripeAdapter>(s.deps, 'payments.payment_link') ??
            optCap<StripeAdapter>(s.deps, 'payments.checkout.physical');
          const stripeUrl = stripe?.hackathonPaymentLinkUrl() ?? null;
          const idempotencyKey = `collect:${input.orderId}:${ctx.runId}`;

          try {
            const collected = await s.collect.collect({
              companyId: ctx.companyId,
              orderId: input.orderId,
              toHandle: input.toHandle,
              description: input.description,
              idempotencyKey,
            });
            if (collected.ok) return collected;
            return sendStripeLinkViaLinq(s, {
              toHandle: input.toHandle,
              stripeUrl,
              description: input.description,
              idempotencyKey: `${idempotencyKey}:link`,
              agentPayBlocked: collected.blockedOn ?? {
                capability: 'payments.imessage_checkout',
                reason: 'Linq Agent Pay did not succeed',
              },
            });
          } catch (error) {
            return sendStripeLinkViaLinq(s, {
              toHandle: input.toHandle,
              stripeUrl,
              description: input.description,
              idempotencyKey: `${idempotencyKey}:link`,
              agentPayBlocked: {
                capability: 'payments.imessage_checkout',
                reason: error instanceof Error ? error.message : String(error),
              },
            });
          }
        },
      },
      s,
    ),
    tool(
      {
        name: 'commerce.list_products',
        description:
          'List active catalogue products with real prices. Call this before commerce.issue_invoice so you name a real SKU.',
        authority: 'payments.configure',
        consequential: false,
        input: Empty,
        execute: async (_input, ctx) => {
          const products = await s.deps.repos.commerce.products.listActive(ctx.companyId);
          return products.map((product) => ({
            sku: product.sku,
            name: product.name,
            priceMinor: product.price_minor,
            currency: product.currency,
            paymentRoute: product.payment_route,
          }));
        },
      },
      s,
    ),
    tool(
      {
        name: 'commerce.match_catalog',
        description:
          'Match a customer idea against active catalogue SKUs. Returns real prices only. Empty matches means do not invent a price — tell them we will source it.',
        authority: 'payments.configure',
        consequential: false,
        input: z.object({ idea: Text }),
        execute: async (input, ctx) => {
          const products = await s.deps.repos.commerce.products.listActive(ctx.companyId);
          const matches = matchCatalogProducts(products, input.idea);
          return {
            idea: input.idea,
            matches,
            note:
              matches.length === 0
                ? 'No catalogue match. Do not invent a price. Tell the customer we will source it and invoice only after a real catalogue price exists.'
                : 'Prices are catalogue rows. Offer these SKUs, then call commerce.issue_invoice.',
          };
        },
      },
      s,
    ),
    tool(
      {
        name: 'commerce.issue_invoice',
        description:
          'Create a Stripe hosted invoice at the catalogue price and send it on the Linq thread the customer texted. Amount comes from the product row, never from the model.',
        authority: 'payments.configure',
        capability: 'payments.checkout.physical',
        consequential: true,
        input: z.object({
          toHandle: Text,
          sku: Text.optional(),
          email: z.string().email().optional(),
          chatId: Text.optional(),
          ticketId: Id.optional(),
        }),
        execute: async (input, ctx) =>
          s.smsInvoice.issue({
            companyId: ctx.companyId,
            toHandle: input.toHandle,
            sku: input.sku,
            email: input.email,
            chatId: input.chatId,
            ticketId: input.ticketId,
            idempotencyKey: `invoice:${ctx.companyId}:${input.toHandle}:${input.sku ?? 'default'}:${ctx.runId}`,
          }),
      },
      s,
    ),
    tool(
      {
        name: 'commerce.get_order',
        description: 'Read an order row and line items.',
        authority: 'payments.configure',
        consequential: false,
        input: z.object({ orderId: Id }),
        execute: async (input) => {
          const order = await s.deps.repos.commerce.orders.byId(input.orderId);
          const lines = await s.deps.repos.commerce.orders.lineItems(input.orderId);
          return { order, lines };
        },
      },
      s,
    ),
    tool(
      {
        name: 'commerce.replay_webhook',
        description: 'Re-process a recorded, signature-verified webhook event. Does not accept an unverified body.',
        authority: 'payments.configure',
        consequential: true,
        input: z.object({ webhookEventId: Id }),
        execute: async (input) => s.webhooks.process(input.webhookEventId),
      },
      s,
    ),
    tool(
      {
        name: 'commerce.reconcile_order',
        description: 'Post the sale for one order to the ledger from recorded payment facts.',
        authority: 'payments.configure',
        consequential: true,
        input: z.object({ orderId: Id }),
        execute: async (input) => s.ledger.postSale(input.orderId),
      },
      s,
    ),
    tool(
      {
        name: 'qa.request_gate',
        description: 'Enqueue Replay + payment-state + data-integrity QA against a deployed URL.',
        authority: 'site.deploy_preview',
        consequential: true,
        input: z.object({ siteId: Id, deploymentId: Id, targetUrl: z.string().url() }),
        execute: async (input, ctx) =>
          s.qa.run({
            companyId: ctx.companyId,
            siteId: input.siteId,
            deploymentId: input.deploymentId,
            targetUrl: input.targetUrl,
            kinds: ['autonomous_exploration', 'payment_state', 'data_integrity'],
            blockingForRelease: true,
          }),
      },
      s,
    ),
  ];
}

function growthSupportTools(s: CompanyToolHost): AgentTool<never, unknown>[] {
  return [
    tool(
      {
        name: 'marketing.create_concept',
        description: 'Store a creative concept. Claims must be listed; empty means no objective claims.',
        authority: 'ads.create_campaign',
        consequential: false,
        input: z.object({
          brandId: Id,
          hypothesis: Text,
          angle: Text,
          hook: Text,
          primaryText: Text,
          headline: Text,
          callToAction: Text,
          landingPath: Text,
          platform: z.enum(['meta', 'google']),
          claimsUsed: z.array(z.string()).default([]),
        }),
        execute: async (input, ctx) =>
          s.creative.createConcept({
            companyId: ctx.companyId,
            brandId: input.brandId,
            hypothesis: input.hypothesis,
            angle: input.angle,
            hook: input.hook,
            primaryText: input.primaryText,
            headline: input.headline,
            callToAction: input.callToAction,
            landingPath: input.landingPath,
            platform: input.platform,
            claimsUsed: input.claimsUsed,
          }),
      },
      s,
    ),
    tool(
      {
        name: 'marketing.check_claims',
        description: 'Check concept claims against the brand substantiation register.',
        authority: 'ads.create_campaign',
        consequential: false,
        input: z.object({ conceptId: Id }),
        execute: async (input) => s.creative.checkClaims(input.conceptId),
      },
      s,
    ),
    tool(
      {
        name: 'marketing.define_audience_segment',
        description:
          'Define who a campaign targets, derived from collected evidence. Every cited evidence id must exist for this company; ' +
          'an audience that cannot be traced to evidence is refused. Required before an experiment can be created.',
        // Same delegation as campaign creation: defining who we target is the
        // decision that campaign spend acts on. No external call, no spend.
        authority: 'ads.create_campaign',
        consequential: false,
        input: z.object({
          name: Text,
          description: Text,
          opportunityId: Id.nullable().default(null),
          countries: z.array(z.string().length(2)).min(1),
          regions: z.array(Text).default([]),
          cities: z.array(Text).default([]),
          ageMin: z.number().int().min(13).max(65),
          ageMax: z.number().int().min(13).max(65),
          gender: z.enum(['all', 'male', 'female']).default('all'),
          interests: z.array(Text).default([]),
          languages: z.array(Text).default([]),
          evidenceIds: z.array(Id).min(1),
        }),
        execute: async (input, ctx) =>
          s.audience.defineSegment({
            companyId: ctx.companyId,
            opportunityId: input.opportunityId,
            name: input.name,
            description: input.description,
            countries: input.countries,
            regions: input.regions,
            cities: input.cities,
            ageMin: input.ageMin,
            ageMax: input.ageMax,
            gender: input.gender,
            interests: input.interests,
            languages: input.languages,
            evidenceIds: input.evidenceIds,
          }),
      },
      s,
    ),
    tool(
      {
        name: 'marketing.list_audience_segments',
        description: 'List audience segments defined for this company, with the evidence each was derived from.',
        authority: 'ads.create_campaign',
        consequential: false,
        input: z.object({ status: z.array(z.enum(['draft', 'active', 'retired'])).default([]) }),
        execute: async (input, ctx) =>
          s.audience.list(ctx.companyId, input.status.length > 0 ? input.status : undefined),
      },
      s,
    ),
    tool(
      {
        name: 'marketing.create_experiment',
        description:
          'Create an experiment definition. Requires an audience segment and at least one stop condition — ' +
          'an experiment with no audience cannot launch, and one with no stop condition spends until someone notices. ' +
          'Spend starts only after launch_arm succeeds on the ad platform.',
        authority: 'ads.create_campaign',
        consequential: true,
        input: z.object({
          brandId: Id,
          name: Text,
          hypothesis: Text,
          platform: z.enum(['meta', 'google']),
          objective: ExperimentObjective,
          audienceSegmentId: Id,
          stopConditions: z
            .array(
              z.object({
                kind: z.enum([
                  'max_spend',
                  'max_duration_hours',
                  'min_impressions',
                  'min_conversions',
                  'cac_ceiling',
                  'negative_contribution',
                  'policy_violation',
                ]),
                threshold: z.number(),
                action: z.enum(['pause_arm', 'pause_experiment', 'alert_only', 'escalate_to_ceo']),
              }),
            )
            .min(1),
          totalBudgetMinor: z.number().int().positive(),
          currency: z.string().length(3),
        }),
        execute: async (input, ctx) =>
          s.experiments.createExperiment({
            companyId: ctx.companyId,
            brandId: input.brandId,
            name: input.name,
            hypothesis: input.hypothesis,
            platform: input.platform,
            objective: input.objective,
            audienceSegmentId: input.audienceSegmentId,
            totalBudgetMinor: input.totalBudgetMinor,
            currency: input.currency,
            stopConditions: input.stopConditions,
            attributionModel: 'platform_reported',
          }),
      },
      s,
    ),
    tool(
      {
        name: 'marketing.launch_arm',
        description: 'Create the live ad-platform objects for an arm. Missing credentials leave it not live.',
        authority: 'ads.create_campaign',
        capability: 'ads.campaign_manage',
        consequential: true,
        input: z.object({ armId: Id, landingUrl: z.string().url().nullable().default(null) }),
        execute: async (input) =>
          s.experiments.launchArm({
            armId: input.armId,
            ...(input.landingUrl ? { landingUrl: input.landingUrl } : {}),
          }),
      },
      s,
    ),
    tool(
      {
        name: 'marketing.pause_arm',
        description: 'Pause a live arm on the ad platform.',
        authority: 'ads.create_campaign',
        consequential: true,
        input: z.object({ armId: Id }),
        execute: async (input) => s.experiments.pauseArm({ armId: input.armId }),
      },
      s,
    ),
    tool(
      {
        name: 'marketing.scale_arm',
        description: 'Increase a live arm budget on the ad platform.',
        authority: 'ads.increase_budget',
        consequential: true,
        input: z.object({ armId: Id, dailyBudgetMinor: z.number().int().positive() }),
        execute: async (input) =>
          s.experiments.scaleArm({ armId: input.armId, dailyBudgetMinor: input.dailyBudgetMinor }),
      },
      s,
    ),
    tool(
      {
        name: 'marketing.collect_metrics',
        description: 'Pull platform insights into metric snapshots. CTR/CAC are never invented.',
        authority: 'ads.create_campaign',
        consequential: true,
        input: z.object({
          experimentId: Id,
          windowStartIso: z.string().datetime(),
          windowEndIso: z.string().datetime(),
        }),
        execute: async (input) =>
          s.experiments.collectMetrics({
            experimentId: input.experimentId,
            windowStartIso: input.windowStartIso,
            windowEndIso: input.windowEndIso,
          }),
      },
      s,
    ),
    tool(
      {
        name: 'marketing.decide_arms',
        description: 'Apply arm decisions from recorded snapshots. Insufficient data holds.',
        authority: 'ads.create_campaign',
        consequential: true,
        input: z.object({ experimentId: Id }),
        execute: async (input, ctx) => {
          const unitContributionMinor = await resolveUnitContributionMinor(s.deps, ctx.companyId);
          if (unitContributionMinor == null) {
            return {
              ok: false,
              blockedOn: {
                capability: 'ads.campaign_manage' as Capability,
                reason:
                  'Unit contribution is not modelled from economics; refusing to decide arms with a zero or invented contribution.',
              },
            };
          }
          return s.experiments.decideArms({ experimentId: input.experimentId, unitContributionMinor });
        },
      },
      s,
    ),
    tool(
      {
        name: 'marketing.get_experiment_results',
        description: 'Read recent metric snapshots for an experiment.',
        authority: 'ads.create_campaign',
        consequential: false,
        input: z.object({ experimentId: Id }),
        execute: async (input) => s.deps.repos.growth.metrics.recent('experiment', input.experimentId, 48),
      },
      s,
    ),
    tool(
      {
        name: 'marketing.configure_attribution',
        description: 'Record the attribution model on an experiment. Does not invent conversions.',
        authority: 'ads.create_campaign',
        consequential: false,
        input: z.object({ experimentId: Id }),
        execute: async (input) => s.deps.repos.growth.experiments.byId(input.experimentId),
      },
      s,
    ),
    tool(
      {
        name: 'support.list_tickets',
        description: 'List open support tickets.',
        authority: 'messaging.send_customer',
        consequential: false,
        input: Empty,
        execute: async (_i, ctx) => s.deps.repos.growth.support.listOpen(ctx.companyId),
      },
      s,
    ),
    tool(
      {
        name: 'support.get_order_context',
        description: 'Read order + shipments for a ticket or order id. Status comes from records, never estimates.',
        authority: 'messaging.send_customer',
        consequential: false,
        input: z.object({ orderId: Id }),
        execute: async (input) => {
          const order = await s.deps.repos.commerce.orders.byId(input.orderId);
          const shipments = await s.deps.repos.commerce.shipments.forOrder(input.orderId);
          return { order, shipments };
        },
      },
      s,
    ),
    tool(
      {
        name: 'support.classify_intent',
        description: 'Ingest an inbound message, classify intent, and open/get a ticket.',
        authority: 'messaging.send_customer',
        consequential: true,
        input: z.object({
          channel: z.enum(['sms', 'imessage', 'rcs', 'email']),
          externalChatId: Id,
          body: Text,
          customerHandle: Text,
        }),
        execute: async (input, ctx) =>
          s.support.ingestInbound({
            companyId: ctx.companyId,
            channel: input.channel,
            externalChatId: input.externalChatId,
            body: input.body,
            customerHandle: input.customerHandle,
          }),
      },
      s,
    ),
    tool(
      {
        name: 'support.send_reply',
        description: 'Reply on Linq. Opt-out tickets are not messaged.',
        authority: 'messaging.send_customer',
        capability: 'messaging.imessage',
        consequential: true,
        input: z.object({ ticketId: Id, body: Text }),
        execute: async (input) => s.support.reply({ ticketId: input.ticketId, body: input.body }),
      },
      s,
    ),
    tool(
      {
        name: 'support.issue_refund',
        description: 'Issue a refund through the payment provider for a recorded order.',
        authority: 'payments.refund',
        consequential: true,
        input: z.object({
          orderId: Id,
          amountMinor: z.number().int().positive(),
          reason: Text,
        }),
        execute: async (input, ctx) =>
          s.support.issueRefund({
            orderId: input.orderId,
            amountMinor: input.amountMinor,
            reason: input.reason,
            actorId: ctx.actorHandle,
            actorKind: 'agent',
          }),
      },
      s,
    ),
    tool(
      {
        name: 'support.escalate',
        description: 'Escalate a ticket with a written reason.',
        authority: 'messaging.send_customer',
        consequential: true,
        input: z.object({ ticketId: Id, reason: Text, priority: z.enum(['low', 'normal', 'high', 'urgent']).default('high') }),
        execute: async (input) => {
          await s.deps.repos.growth.support.escalate(input.ticketId, input.reason, input.priority);
          return { ticketId: input.ticketId, escalated: true };
        },
      },
      s,
    ),
    tool(
      {
        name: 'finance.reconcile_payments',
        description: 'Reconcile Stripe charges against local payment rows.',
        authority: 'payments.configure',
        consequential: true,
        input: z.object({ windowDays: z.number().int().positive().default(14) }),
        execute: async (input, ctx) => s.reconciliation.run(ctx.companyId, 'stripe', input.windowDays),
      },
      s,
    ),
    tool(
      {
        name: 'finance.get_ledger',
        description: 'Compute P&L from posted ledger entries for the last 30 days.',
        authority: 'payments.configure',
        consequential: false,
        input: Empty,
        execute: async (_i, ctx) => {
          const to = new Date();
          const from = new Date(to.getTime() - 30 * 86_400_000);
          return s.ledger.profitAndLoss(ctx.companyId, 'USD', from, to);
        },
      },
      s,
    ),
    tool(
      {
        name: 'finance.get_contribution_report',
        description: 'List landed-cost models for the company with grounded ratios.',
        authority: 'payments.configure',
        consequential: false,
        input: Empty,
        execute: async (_i, ctx) => s.deps.repos.sourcing.landedCosts.listForCompany(ctx.companyId),
      },
      s,
    ),
    tool(
      {
        name: 'finance.get_budget_status',
        description: 'List budget windows and remaining spend.',
        authority: 'payments.configure',
        consequential: false,
        input: Empty,
        execute: async (_i, ctx) => s.deps.repos.governance.budgets.list(ctx.companyId),
      },
      s,
    ),
    tool(
      {
        name: 'finance.write_ledger_entry',
        description: 'Post recorded ad or infra spend. Amount must come from a provider object, not an estimate.',
        authority: 'payments.configure',
        consequential: true,
        input: z.object({
          amountMinor: z.number().int().positive(),
          currency: z.string().length(3),
          memo: Text,
          externalId: Id,
        }),
        execute: async (input, ctx) =>
          s.ledger.postSpend({
            companyId: ctx.companyId,
            amountMinor: input.amountMinor,
            currency: input.currency,
            description: input.memo,
            account: 'advertising_spend',
            sourceType: 'agent_tool',
            sourceRefId: input.externalId,
          }),
      },
      s,
    ),
    tool(
      {
        name: 'finance.forecast',
        description: 'Does not invent a forecast. Returns the ledger P&L and says projection requires stated assumptions the CEO must supply.',
        authority: 'payments.configure',
        consequential: false,
        input: Empty,
        execute: async (_i, ctx) => {
          const to = new Date();
          const from = new Date(to.getTime() - 30 * 86_400_000);
          const pnl = await s.ledger.profitAndLoss(ctx.companyId, 'USD', from, to);
          return { historical: pnl, projected: null, reason: 'No forward forecast is computed without explicit CEO assumptions.' };
        },
      },
      s,
    ),
    tool(
      {
        name: 'finance.flag_anomaly',
        description: 'Record a finance anomaly for operators. Does not invent dispute rates.',
        authority: 'payments.configure',
        consequential: true,
        input: z.object({ note: Text }),
        execute: async (input, ctx) => {
          const rate = await s.deps.repos.commerce.orders.disputeRateBps(ctx.companyId, 30);
          await s.deps.repos.audit.append({
            companyId: ctx.companyId,
            kind: 'compliance_check',
            actorId: ctx.actorHandle,
            actorKind: 'specialist_agent',
            action: 'flag anomaly',
            subjectType: 'company',
            subjectRefId: ctx.companyId,
            outcome: 'success',
            detail: { note: input.note, disputeRateBps30d: rate },
          });
          return { disputeRateBps30d: rate };
        },
      },
      s,
    ),
    tool(
      {
        name: 'legal.generate_policy_document',
        description: 'Generate a legal document from real company config. Missing fields refuse boilerplate.',
        authority: 'legal.publish_policy',
        consequential: true,
        input: z.object({ kind: Text, siteId: z.string().nullable().default(null) }),
        execute: async (input, ctx) =>
          s.legal.generate({
            companyId: ctx.companyId,
            kind: input.kind,
            ...(input.siteId ? { siteId: input.siteId } : {}),
          }),
      },
      s,
    ),
    tool(
      {
        name: 'legal.screen_product_category',
        description: 'Web-search category restrictions. Never an approved-for-sale stamp.',
        authority: 'legal.publish_policy',
        consequential: true,
        input: z.object({ category: Text }),
        execute: async (input, ctx) =>
          s.legal.screenProductCategory({ category: input.category }),
      },
      s,
    ),
    tool(
      {
        name: 'legal.check_ad_claims',
        description: 'Check a creative concept against substantiation.',
        authority: 'legal.publish_policy',
        consequential: false,
        input: z.object({ conceptId: Id }),
        execute: async (input) => s.legal.checkAdClaims({ conceptId: input.conceptId }),
      },
      s,
    ),
    tool(
      {
        name: 'legal.check_data_retention',
        description: 'Compare privacy config to declared retention. Does not invent a DPO opinion.',
        authority: 'legal.publish_policy',
        consequential: false,
        input: Empty,
        execute: async (_i, ctx) => s.legal.checkDataRetention({ companyId: ctx.companyId }),
      },
      s,
    ),
    tool(
      {
        name: 'legal.escalate_to_human',
        description: 'Package a legal question for a human. Optionally request a Terac expert review.',
        authority: 'legal.publish_policy',
        consequential: true,
        input: z.object({ question: Text, subjectRefId: z.string().nullable().default(null) }),
        execute: async (input, ctx) =>
          s.legal.escalateToHuman({
            companyId: ctx.companyId,
            kind: 'counsel_review',
            actorId: ctx.actorHandle,
            reason: input.question,
          }),
      },
      s,
    ),
    tool(
      {
        name: 'compliance.scan_pii',
        description: 'Scan text with Pioneer GLiNER2-PII. Missing Pioneer key or inference billing returns blockedOn.',
        authority: 'legal.publish_policy',
        capability: 'compliance.pii_scan',
        consequential: true,
        input: z.object({ text: Text }),
        execute: async (input) => {
          try {
            return await s.compliance.scanPii(input.text);
          } catch (error) {
            return blockedFrom('compliance.pii_scan', error);
          }
        },
      },
      s,
    ),
    tool(
      {
        name: 'compliance.guard_prompt',
        description: 'Run Pioneer GLiGuard on a prompt. Missing Pioneer key returns blocked.',
        authority: 'legal.publish_policy',
        capability: 'compliance.prompt_guard',
        consequential: true,
        input: z.object({ text: Text }),
        execute: async (input) => {
          try {
            return await s.compliance.guardPrompt(input.text);
          } catch (error) {
            return blockedFrom('compliance.prompt_guard', error);
          }
        },
      },
      s,
    ),
  ];
}

function platformTools(s: CompanyToolHost): AgentTool<never, unknown>[] {
  return [
    tool(
      {
        name: 'infra.get_service_health',
        description: 'Read capability usability and queue names. Does not invent green checks.',
        authority: 'infrastructure.provision',
        consequential: false,
        input: Empty,
        execute: async () => ({
          capabilities: s.deps.capabilities.summary(),
          environment: s.deps.environment,
        }),
      },
      s,
    ),
    tool(
      {
        name: 'infra.read_logs',
        description: 'Read recent audit events. This is not a log-shipper query.',
        authority: 'infrastructure.provision',
        consequential: false,
        input: z.object({ limit: z.number().int().positive().default(50) }),
        execute: async (input, ctx) => s.deps.repos.audit.list(ctx.companyId, { limit: input.limit }),
      },
      s,
    ),
    tool(
      {
        name: 'infra.list_deployments',
        description: 'List the current live production deployment if one exists.',
        authority: 'infrastructure.provision',
        consequential: false,
        input: Empty,
        execute: async (_i, ctx) => s.deps.repos.build.deployments.currentLive(ctx.companyId, 'production'),
      },
      s,
    ),
    tool(
      {
        name: 'infra.trigger_deploy',
        description: 'Trigger a Render preview deploy for a site that already has a hosting service id.',
        authority: 'infrastructure.provision',
        capability: 'platform.deploy_control',
        consequential: true,
        input: z.object({ siteId: Id }),
        execute: async (input) => s.deploy.deployPreview({ siteId: input.siteId }),
      },
      s,
    ),
    tool(
      {
        name: 'infra.rollback',
        description: 'Roll back a site to a recorded deployment.',
        authority: 'infrastructure.provision',
        consequential: true,
        input: z.object({ siteId: Id, deploymentId: Id }),
        execute: async (input) => s.deploy.rollback({ siteId: input.siteId, deploymentId: input.deploymentId }),
      },
      s,
    ),
    tool(
      {
        name: 'workflows.start_task',
        description: 'Start a Render Workflows task run (prize-track path). Missing slug returns credentials error.',
        authority: 'infrastructure.provision',
        capability: 'platform.workflows',
        consequential: true,
        input: z.object({
          taskName: z.enum(['tickCompanyLoop', 'runQaGate', 'collectResearch', 'reconcilePayments', 'operateCompany']),
          companyId: z.string().nullable().default(null),
        }),
        execute: async (input, ctx) => {
          const render = optCap<RenderAdapter>(s.deps, 'platform.workflows');
          if (!render) return { started: false, reason: 'platform.workflows is not usable' };
          const run = await render.startTaskRun(input.taskName, [{ companyId: input.companyId ?? ctx.companyId }]);
          return { started: true, taskRunId: run.id };
        },
      },
      s,
    ),
    tool(
      {
        name: 'queue.get_stats',
        description: 'Read queue depths from Redis.',
        authority: 'infrastructure.provision',
        consequential: false,
        input: Empty,
        execute: async () => s.deps.queues.depths(),
      },
      s,
    ),
    tool(
      {
        name: 'provider.get_health',
        description: 'Read capability statuses. live_verified only after a recorded probe.',
        authority: 'infrastructure.provision',
        consequential: false,
        input: Empty,
        execute: async () => s.deps.capabilities.allCapabilityStatuses(),
      },
      s,
    ),
    tool(
      {
        name: 'provider.reset_breaker',
        description: 'This deployment has no provider circuit-breaker reset API. Reports current capability state instead.',
        authority: 'infrastructure.provision',
        consequential: false,
        input: z.object({ provider: Text }),
        execute: async (input) => ({
          reset: false,
          reason: `No breaker-reset endpoint is implemented for ${input.provider}. Check /readiness/providers.`,
          capabilities: s.deps.capabilities.summary(),
        }),
      },
      s,
    ),
    tool(
      {
        name: 'security.scan_secrets',
        description: 'Scan text with Pioneer PII. Does not claim a clean bill if Pioneer is unavailable.',
        authority: 'infrastructure.provision',
        consequential: true,
        input: z.object({ text: Text }),
        execute: async (input) => {
          try {
            return await s.compliance.scanPii(input.text);
          } catch (error) {
            return blockedFrom('compliance.pii_scan', error);
          }
        },
      },
      s,
    ),
    tool(
      {
        name: 'sandbox.create',
        description: 'Create or reattach a Superserve microVM keyed on this agent run. Pause preserves full VM state.',
        authority: 'infrastructure.provision',
        capability: 'compute.persistent_sandbox',
        consequential: true,
        input: Empty,
        execute: async (_i, ctx) => {
          const ss = optCap<SuperserveAdapter>(s.deps, 'compute.persistent_sandbox');
          if (!ss) return { sandboxId: null, reason: 'compute.persistent_sandbox (Superserve) is not usable' };
          const box = await ss.ensureSandboxForAgentRun(ctx.runId, { name: ctx.roleKey });
          await s.deps.repos.agents.runs.attachSandbox(ctx.runId, box.id);
          return { sandboxId: box.id, provider: 'superserve' };
        },
      },
      s,
    ),
    tool(
      {
        name: 'sandbox.exec',
        description: 'Exec a command in the run sandbox. Prefers Superserve; Sandbox0 pause does not keep processes.',
        authority: 'infrastructure.provision',
        consequential: true,
        input: z.object({ command: Text }),
        execute: async (input, ctx) => {
          const run = await s.deps.repos.agents.runs.byId(ctx.runId);
          const ss = optCap<SuperserveAdapter>(s.deps, 'compute.persistent_sandbox');
          if (ss && run.sandbox_id) {
            return ss.execInSandbox(run.sandbox_id, { command: input.command });
          }
          const s0 = optCap<Sandbox0Adapter>(s.deps, 'compute.isolated_execution');
          if (s0 && run.sandbox_id) {
            return s0.exec({ sandboxId: run.sandbox_id, command: input.command });
          }
          return { ran: false, reason: 'No sandbox is attached to this run. Call sandbox.create first.' };
        },
      },
      s,
    ),
    tool(
      {
        name: 'sandbox.set_egress_policy',
        description: 'Set Sandbox0 network policy when that plane is in use. Superserve secrets stay in the VM env.',
        authority: 'infrastructure.provision',
        consequential: true,
        input: z.object({ sandboxId: Id, policy: z.record(z.string(), z.unknown()) }),
        execute: async (input) => {
          const s0 = optCap<Sandbox0Adapter>(s.deps, 'compute.isolated_execution');
          if (!s0 || typeof s0.setNetworkPolicy !== 'function') {
            return { applied: false, reason: 'Sandbox0 network policy is not usable in this deployment.' };
          }
          return s0.setNetworkPolicy(input.sandboxId, input.policy);
        },
      },
      s,
    ),
    tool(
      {
        name: 'sandbox.destroy',
        description: 'Pause the Superserve VM (state preserved) rather than deleting it mid-run.',
        authority: 'infrastructure.provision',
        consequential: true,
        input: z.object({ sandboxId: Id }),
        execute: async (input) => {
          const ss = optCap<SuperserveAdapter>(s.deps, 'compute.persistent_sandbox');
          if (!ss) return { paused: false, reason: 'Superserve is not usable' };
          const paused = await ss.pauseSandbox(input.sandboxId);
          return { paused: true, sandboxId: paused.id, status: paused.status };
        },
      },
      s,
    ),
    tool(
      {
        name: 'incident.open',
        description: 'Open an incident audit event. Does not page a vendor.',
        authority: 'infrastructure.provision',
        consequential: true,
        input: z.object({ title: Text, detail: Text }),
        execute: async (input, ctx) => {
          const row = await s.deps.repos.audit.append({
            companyId: ctx.companyId,
            kind: 'human_intervention',
            actorId: ctx.actorHandle,
            actorKind: 'manager_agent',
            action: `open incident: ${input.title}`,
            subjectType: 'company',
            subjectRefId: ctx.companyId,
            outcome: 'success',
            detail: { title: input.title, detail: input.detail, status: 'open' },
          });
          return { incidentId: row.id };
        },
      },
      s,
    ),
    tool(
      {
        name: 'incident.resolve',
        description: 'Record incident resolution on the audit trail.',
        authority: 'infrastructure.provision',
        consequential: true,
        input: z.object({ incidentId: Id, resolution: Text }),
        execute: async (input, ctx) => {
          await s.deps.repos.audit.append({
            companyId: ctx.companyId,
            kind: 'human_intervention',
            actorId: ctx.actorHandle,
            actorKind: 'manager_agent',
            action: `resolve incident ${input.incidentId}`,
            subjectType: 'audit_event',
            subjectRefId: input.incidentId,
            outcome: 'success',
            detail: { resolution: input.resolution, status: 'resolved' },
          });
          return { resolved: true };
        },
      },
      s,
    ),
    tool(
      {
        name: 'qa.create_project',
        description: 'Create a Replay QA project for a live URL.',
        authority: 'site.deploy_preview',
        capability: 'qa.autonomous_exploration',
        consequential: true,
        input: z.object({ name: Text, url: z.string().url() }),
        execute: async (input) => {
          const replay = optCap<ReplayAdapter>(s.deps, 'qa.autonomous_exploration');
          if (!replay) return { created: false, reason: 'Replay is not usable' };
          const project = await replay.createProject({ name: input.name, targetUrl: input.url });
          return { projectId: project.id };
        },
      },
      s,
    ),
    tool(
      {
        name: 'qa.run_exploration',
        description: 'Run Replay autonomous exploration against a deployment URL. Unexecuted is not a pass.',
        authority: 'site.deploy_preview',
        capability: 'qa.autonomous_exploration',
        consequential: true,
        input: z.object({ siteId: Id, deploymentId: Id, targetUrl: z.string().url() }),
        execute: async (input, ctx) =>
          s.qa.run({
            companyId: ctx.companyId,
            siteId: input.siteId,
            deploymentId: input.deploymentId,
            targetUrl: input.targetUrl,
            kinds: ['autonomous_exploration'],
            blockingForRelease: true,
          }),
      },
      s,
    ),
    tool(
      {
        name: 'qa.get_bugs',
        description: 'List open defects for a site.',
        authority: 'site.deploy_preview',
        consequential: false,
        input: z.object({ siteId: Id }),
        execute: async (input, ctx) => s.deps.repos.build.qa.openDefects(ctx.companyId, input.siteId),
      },
      s,
    ),
    tool(
      {
        name: 'qa.evaluate_gate',
        description: 'Evaluate the production release gate from recorded QA runs.',
        authority: 'site.deploy_preview',
        consequential: false,
        input: z.object({ siteId: Id, deploymentId: Id }),
        execute: async (input, ctx) =>
          s.deps.repos.build.qa.evaluateGate(ctx.companyId, input.siteId, input.deploymentId, 'production'),
      },
      s,
    ),
    tool(
      {
        name: 'qa.block_release',
        description: 'Mark the site release-blocked with a written reason.',
        authority: 'site.deploy_preview',
        consequential: true,
        input: z.object({ siteId: Id, reason: Text }),
        execute: async (input) => s.qa.blockRelease({ siteId: input.siteId, reason: input.reason }),
      },
      s,
    ),
    tool(
      {
        name: 'qa.approve_release',
        description: 'Record intent to approve. Production still re-evaluates the gate before going live.',
        authority: 'site.deploy_production',
        consequential: true,
        input: z.object({ siteId: Id, deploymentId: Id }),
        execute: async (input, ctx) => {
          const actor = await s.deps.repos.governance.actors.requireByHandle(ctx.companyId, ctx.actorHandle);
          return s.qa.approveRelease({
            companyId: ctx.companyId,
            siteId: input.siteId,
            deploymentId: input.deploymentId,
            actorId: actor.id,
          });
        },
      },
      s,
    ),
    tool(
      {
        name: 'qa.run_contract_tests',
        description:
          'Run provider probes (non-destructive). Does not write integration_verifications — apps/verifier is the sole writer of that table.',
        authority: 'infrastructure.provision',
        consequential: true,
        input: Empty,
        execute: async () => {
          const results = await s.deps.providers.probeAll();
          return {
            probed: results.length,
            succeeded: results.filter((r) => r.succeeded).map((r) => r.provider),
            persisted: false,
            reason: 'verifier is the sole writer',
          };
        },
      },
      s,
    ),
    tool(
      {
        name: 'qa.run_e2e',
        description: 'Open a Solari browser session against the target URL. Not a silent pass.',
        authority: 'site.deploy_preview',
        capability: 'research.browser_session',
        consequential: true,
        input: z.object({ targetUrl: z.string().url() }),
        execute: async (input) => {
          const solari = optCap<SolariAdapter>(s.deps, 'research.browser_session');
          if (!solari) return { ran: false, reason: 'Solari browser is not usable' };
          const session = await solari.createBrowserSession({ recording: false });
          return {
            sessionId: session.sessionId,
            targetUrl: input.targetUrl,
            passed: false,
            reason: 'Session started; flow assertions are not claimed.',
          };
        },
      },
      s,
    ),
    tool(
      {
        name: 'qa.run_payment_tests',
        description: 'Exercise in-process payment state-machine checks.',
        authority: 'payments.configure',
        consequential: false,
        input: z.object({ siteId: Id, deploymentId: Id, targetUrl: z.string().url() }),
        execute: async (input, ctx) =>
          s.qa.run({
            companyId: ctx.companyId,
            siteId: input.siteId,
            deploymentId: input.deploymentId,
            targetUrl: input.targetUrl,
            kinds: ['payment_state'],
            blockingForRelease: false,
          }),
      },
      s,
    ),
    tool(
      {
        name: 'qa.run_accessibility',
        description: 'Records that no accessibility runner is wired. Unexecuted is not a pass.',
        authority: 'site.deploy_preview',
        consequential: false,
        input: z.object({ siteId: Id, deploymentId: Id, targetUrl: z.string().url() }),
        execute: async (input, ctx) =>
          s.qa.run({
            companyId: ctx.companyId,
            siteId: input.siteId,
            deploymentId: input.deploymentId,
            targetUrl: input.targetUrl,
            kinds: ['accessibility'],
            blockingForRelease: false,
          }),
      },
      s,
    ),
    tool(
      {
        name: 'qa.run_security_smoke',
        description: 'Records that no storefront security-smoke runner is wired. Unexecuted is not a pass.',
        authority: 'site.deploy_preview',
        consequential: false,
        input: z.object({ siteId: Id, deploymentId: Id, targetUrl: z.string().url() }),
        execute: async (input, ctx) =>
          s.qa.run({
            companyId: ctx.companyId,
            siteId: input.siteId,
            deploymentId: input.deploymentId,
            targetUrl: input.targetUrl,
            kinds: ['security_smoke'],
            blockingForRelease: false,
          }),
      },
      s,
    ),
    tool(
      {
        name: 'qa.run_data_integrity',
        description: 'Run in-process ledger/order integrity checks.',
        authority: 'payments.configure',
        consequential: false,
        input: z.object({ siteId: Id, deploymentId: Id, targetUrl: z.string().url() }),
        execute: async (input, ctx) =>
          s.qa.run({
            companyId: ctx.companyId,
            siteId: input.siteId,
            deploymentId: input.deploymentId,
            targetUrl: input.targetUrl,
            kinds: ['data_integrity'],
            blockingForRelease: false,
          }),
      },
      s,
    ),
  ];
}

function prizeTrackTools(s: CompanyToolHost): AgentTool<never, unknown>[] {
  return [
    tool(
      {
        name: 'linq.send_link',
        description:
          'Send a fixed-price Stripe checkout URL via Linq-hosted `link` experience. Not Agent Pay; a Stripe URL is invalid as agentpay checkout_url. The amount is the catalogue price, not a customer-typed value.',
        authority: 'messaging.send_marketing',
        capability: 'messaging.imessage_app',
        consequential: true,
        input: z.object({
          toHandle: Text,
          title: z.string().default('Pay Zero Human Co'),
          description: Text,
        }),
        execute: async (input, ctx) => {
          const stripe =
            optCap<StripeAdapter>(s.deps, 'payments.payment_link') ??
            optCap<StripeAdapter>(s.deps, 'payments.checkout.physical');
          if (!stripe) {
            const status = s.deps.capabilities.resolveCapability('payments.payment_link');
            return blocked('payments.payment_link', status.remediation ?? `payments.payment_link is ${status.state}`);
          }
          try {
            const link = await stripe.resolveHackathonPaymentLink();
            return sendStripeLinkViaLinq(s, {
              toHandle: input.toHandle,
              stripeUrl: link.url,
              description: input.description,
              title: input.title,
              idempotencyKey: `linq-link:${ctx.companyId}:${ctx.runId}`,
              agentPayBlocked: {
                capability: 'payments.imessage_checkout',
                reason: 'linq.send_link does not use Agent Pay',
              },
            });
          } catch (error) {
            return blockedFrom('payments.payment_link', error);
          }
        },
      },
      s,
    ),
    tool(
      {
        name: 'linq.outreach',
        description:
          'Proactively send the fixed-price checkout link over Linq to configured handles and existing chats. Does not invent recipients. Opt-out is respected.',
        authority: 'messaging.send_marketing',
        capability: 'messaging.imessage_app',
        consequential: true,
        input: Empty,
        execute: async (_i, ctx) => s.outreach.reachOut({ companyId: ctx.companyId, runId: ctx.runId }),
      },
      s,
    ),
    tool(
      {
        name: 'linq.list_experiences',
        description: 'List Linq-hosted iMessage experiences (agentpay, agentcard, link). Empty/blocked is not a fake catalog.',
        authority: 'messaging.send_customer',
        capability: 'messaging.imessage_app',
        consequential: false,
        input: Empty,
        execute: async () => {
          const linq =
            optCap<LinqAdapter>(s.deps, 'messaging.imessage_app') ??
            optCap<LinqAdapter>(s.deps, 'messaging.imessage');
          if (!linq) {
            const status = s.deps.capabilities.resolveCapability('messaging.imessage_app');
            return blocked('messaging.imessage_app', status.remediation ?? `messaging.imessage_app is ${status.state}`);
          }
          try {
            return await linq.listExperiences();
          } catch (error) {
            return blockedFrom('messaging.imessage_app', error);
          }
        },
      },
      s,
    ),
    tool(
      {
        name: 'stripe.get_hackathon_payment_link',
        description: 'Retrieve the submitted organizer Payment Link. Never mints a second URL.',
        authority: 'payments.configure',
        capability: 'payments.payment_link',
        consequential: false,
        input: Empty,
        execute: async () => {
          const stripe =
            optCap<StripeAdapter>(s.deps, 'payments.payment_link') ??
            optCap<StripeAdapter>(s.deps, 'payments.checkout.physical');
          if (!stripe) {
            const status = s.deps.capabilities.resolveCapability('payments.payment_link');
            return blocked('payments.payment_link', status.remediation ?? `payments.payment_link is ${status.state}`);
          }
          try {
            const link = await stripe.resolveHackathonPaymentLink();
            return { ok: true, id: link.id, url: link.url, active: link.active ?? null };
          } catch (error) {
            return blockedFrom('payments.payment_link', error);
          }
        },
      },
      s,
    ),
    tool(
      {
        name: 'band.ensure_room',
        description: 'Create or reuse the company BAND coordination room. Missing Band is blockedOn.',
        authority: 'research.collect',
        capability: 'coordination.agent_mesh',
        consequential: true,
        input: Empty,
        execute: async (_i, ctx) => {
          const band = optCap<BandAdapter>(s.deps, 'coordination.agent_mesh');
          if (!band) {
            const status = s.deps.capabilities.resolveCapability('coordination.agent_mesh');
            return blocked('coordination.agent_mesh', status.remediation ?? `coordination.agent_mesh is ${status.state}`);
          }
          const company = await s.deps.repos.companies.byId(ctx.companyId);
          const config = companyConfig(company);
          if (config.integrations?.bandChatId) {
            return { ok: true, created: false, chatId: config.integrations.bandChatId };
          }
          try {
            const chat = await band.createChat({
              name: `${company.name} coordination`,
              taskId: ctx.companyId,
            });
            await s.deps.repos.companies.updateConfig(ctx.companyId, {
              ...config,
              integrations: { ...config.integrations, bandChatId: chat.id },
            });
            return { ok: true, created: true, chatId: chat.id };
          } catch (error) {
            return blockedFrom('coordination.agent_mesh', error);
          }
        },
      },
      s,
    ),
    tool(
      {
        name: 'terac.list_projects',
        description: 'List Terac projects. Does not invent a study or mark an unfunded draft as launched.',
        authority: 'expert.engage_paid',
        capability: 'expert.structured_review',
        consequential: false,
        input: Empty,
        execute: async () => {
          const terac = optCap<TeracAdapter>(s.deps, 'expert.structured_review');
          if (!terac) {
            const status = s.deps.capabilities.resolveCapability('expert.structured_review');
            return blocked('expert.structured_review', status.remediation ?? `expert.structured_review is ${status.state}`);
          }
          try {
            const page = await terac.listProjects({ limit: 20 });
            return {
              ok: true,
              projects: page.data.map((project) => ({ id: project.id, name: project.name ?? null })),
            };
          } catch (error) {
            return blockedFrom('expert.structured_review', error);
          }
        },
      },
      s,
    ),
  ];
}

async function sendStripeLinkViaLinq(
  s: CompanyToolHost,
  input: {
    readonly toHandle: string;
    readonly stripeUrl: string | null;
    readonly description: string;
    readonly title?: string;
    readonly idempotencyKey: string;
    readonly agentPayBlocked: { capability: Capability; reason: string };
  },
): Promise<unknown> {
  if (!input.stripeUrl) {
    const status = s.deps.capabilities.resolveCapability('payments.payment_link');
    return {
      ok: false,
      blockedOn: input.agentPayBlocked,
      stripeBlockedOn: {
        capability: 'payments.payment_link' as const,
        reason: status.remediation ?? `payments.payment_link is ${status.state}`,
      },
    };
  }
  const linq =
    optCap<LinqAdapter>(s.deps, 'messaging.imessage_app') ??
    optCap<LinqAdapter>(s.deps, 'messaging.imessage');
  if (!linq) {
    const status = s.deps.capabilities.resolveCapability('messaging.imessage_app');
    return {
      ok: false,
      agentPay: false,
      stripePaymentLinkUrl: input.stripeUrl,
      blockedOn: {
        capability: 'messaging.imessage_app' as const,
        reason: status.remediation ?? `messaging.imessage_app is ${status.state}`,
      },
      agentPayBlocked: input.agentPayBlocked,
      note: 'Share the submitted Stripe Payment Link out of band. Agent Pay did not succeed; Linq link experience is not usable.',
    };
  }
  try {
    const sent = await linq.sendLink({
      to: input.toHandle,
      url: input.stripeUrl,
      title: input.title ?? 'Pay Zero Human Co',
      subtitle: input.description,
      button: 'Pay',
      idempotencyKey: input.idempotencyKey,
    });
    return {
      ok: true,
      agentPay: false,
      linqLinkExperience: true,
      stripePaymentLinkUrl: input.stripeUrl,
      linqMessageIds: sent.messageIds,
      agentPayBlocked: input.agentPayBlocked,
      note: 'Agent Pay was not used. Sent the submitted Stripe Payment Link via Linq link experience.',
    };
  } catch (error) {
    return {
      ok: false,
      agentPay: false,
      stripePaymentLinkUrl: input.stripeUrl,
      blockedOn: {
        capability: 'messaging.imessage_app' as const,
        reason: error instanceof Error ? error.message : String(error),
      },
      agentPayBlocked: input.agentPayBlocked,
    };
  }
}

