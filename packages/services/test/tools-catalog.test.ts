import { allReferencedTools } from '@foundry/core';
import { describe, expect, it } from 'vitest';
import type { ToolContext } from '@foundry/agents';
import { buildCompanyTools } from '../src/tools/catalog.js';
import { defaultHackathonCompanyConfig } from '../src/org/default-config.js';

const toolCtx: ToolContext = {
  companyId: 'co_1',
  runId: 'run_1',
  roleKey: 'ceo',
  actorHandle: 'ceo',
  traceId: 't',
  signal: new AbortController().signal,
};

describe('org tool catalog', () => {
  it('registers every tool name referenced by the org chart', () => {
    const tools = buildCompanyTools({} as never);
    const names = new Set(tools.map((tool) => tool.name));
    expect(allReferencedTools().filter((name) => !names.has(name))).toEqual([]);
  });

  it('parses the hackathon default company config', () => {
    const config = defaultHackathonCompanyConfig({
      ownerName: 'Founder',
      ownerEmail: 'founder@example.test',
    });
    expect(config.legalEntity.type).toBe('not_yet_formed');
    expect(config.commerce.baseCurrency).toBe('USD');
    expect(config.legalEntity.registeredName).toBeNull();
  });

  it('registers prize-track tools used by Terac, Stripe, Linq, Band, Pioneer, Replay, Superserve', () => {
    const tools = buildCompanyTools({} as never);
    const names = new Set(tools.map((tool) => tool.name));
    expect(
      [
        'expert.request_review',
        'commerce.configure_checkout',
        'commerce.collect_payment',
        'commerce.issue_invoice',
        'commerce.list_products',
        'commerce.match_catalog',
        'linq.send_link',
        'linq.outreach',
        'linq.list_experiences',
        'stripe.get_hackathon_payment_link',
        'band.post_message',
        'band.ensure_room',
        'compliance.scan_pii',
        'compliance.guard_prompt',
        'qa.create_project',
        'sandbox.create',
        'terac.list_projects',
      ].filter((name) => !names.has(name)),
    ).toEqual([]);
  });

  it('opportunity.select denies when selection gates fail and does not invent a quote', async () => {
    let selected = false;
    const host = {
      deps: {
        repos: {
          companies: {
            setActive: async () => {
              selected = true;
            },
            byId: async () => ({ id: 'co_1', selected_opportunity_id: null }),
          },
          research: {
            opportunities: {
              byId: async () => ({
                id: 'opp_1',
                company_id: 'co_1',
                pain_point_ids: [],
                assumed_selling_price_cents: null,
              }),
              latestScorecard: async () => undefined,
              setStage: async () => {
                throw new Error('must not advance stage when gates fail');
              },
            },
            painPoints: { evidenceIds: async () => [] },
            evidence: { independentSourceCount: async () => 0 },
            expertReviews: { completedFor: async () => undefined },
          },
          sourcing: {
            quotes: { forOpportunity: async () => [] },
            landedCosts: { latestForOpportunity: async () => undefined },
          },
          loop: { currentOrStart: async () => ({ id: 'cyc_1' }), recordDecision: async () => undefined },
        },
      },
    };
    const tool = buildCompanyTools(host as never).find((t) => t.name === 'opportunity.select');
    expect(tool).toBeDefined();
    const result = (await tool!.execute({ opportunityId: 'opp_1', rationale: 'high composite' }, toolCtx)) as {
      ok?: boolean;
      failures?: readonly { gate: string }[];
      selected?: string;
    };
    expect(selected).toBe(false);
    expect(result.selected).toBeUndefined();
    expect(result.ok).toBe(false);
    expect(result.failures?.some((f) => f.gate === 'supplier_quote')).toBe(true);
  });

  it('marketing.decide_arms refuses a hardcoded zero contribution', async () => {
    const contributions: number[] = [];
    const host = {
      experiments: {
        decideArms: async (input: { experimentId: string; unitContributionMinor: number }) => {
          contributions.push(input.unitContributionMinor);
          return { ok: true, data: [] };
        },
      },
      deps: {
        repos: {
          growth: { experiments: { byId: async () => ({ id: 'exp_1', company_id: 'co_1' }) } },
          companies: { byId: async () => ({ id: 'co_1', selected_opportunity_id: 'opp_1' }) },
          commerce: { products: { listActive: async () => [] } },
          research: {
            opportunities: { byId: async () => ({ id: 'opp_1', assumed_selling_price_cents: null }) },
          },
          sourcing: {
            landedCosts: {
              latestForOpportunity: async () => undefined,
              listForCompany: async () => [],
            },
          },
        },
      },
    };
    const tool = buildCompanyTools(host as never).find((t) => t.name === 'marketing.decide_arms');
    expect(tool).toBeDefined();
    const result = (await tool!.execute({ experimentId: 'exp_1' }, toolCtx)) as {
      ok?: boolean;
      blockedOn?: { reason: string };
    };
    expect(contributions).not.toContain(0);
    expect(result.ok).toBe(false);
    expect(result.blockedOn?.reason).toMatch(/contribution/i);
  });
});
