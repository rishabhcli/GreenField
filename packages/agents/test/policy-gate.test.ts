/**
 * Policy gate and org dispatch, against a real database.
 *
 * These are the controls standing between an autonomous agent and the
 * company's bank account, so they are tested against real concurrency and real
 * constraints rather than mocks: budget must be reserved before the action runs
 * and released when it fails, a denial must be a value the agent can read, and
 * the chain of command must be enforced in code rather than in the prompt.
 */

import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CapabilityRegistry,
  PolicyDeniedError,
  SecretStore,
  roleByKey,
  type Capability,
} from '@foundry/core';
import { Repositories, createPool, type DbPool } from '@foundry/db';
import {
  AgentExecutor,
  OrgDispatcher,
  PolicyGate,
  ToolRegistry,
  defineTool,
  executeToolCall,
} from '@foundry/agents';
import { ALL_MANIFESTS, ProviderRegistry, type AnthropicAdapter, type BandAdapter } from '@foundry/providers';
import { z } from 'zod';

const TEST_DB = `foundry_agents_${Date.now()}`;
const TEST_URL = `postgres://localhost:5432/${TEST_DB}`;

let pool: DbPool;
let repos: Repositories;
let providers: ProviderRegistry;
let gate: PolicyGate;
let available = false;
let companyId: string;

beforeAll(async () => {
  try {
    execFileSync('pg_isready', ['-q'], { stdio: 'pipe' });
    execFileSync('createdb', [TEST_DB], { stdio: 'pipe' });
    available = true;
  } catch {
    console.warn('\n[agents] No reachable PostgreSQL; skipping policy gate tests.\n');
    return;
  }

  const dir = join(import.meta.dirname, '..', '..', 'db', 'src', 'migrations');
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    execFileSync('psql', ['-q', '-v', 'ON_ERROR_STOP=1', '-d', TEST_DB, '-f', join(dir, file)], { stdio: 'pipe' });
  }

  pool = createPool({ connectionString: TEST_URL, applicationName: 'foundry-agents-test', maxConnections: 8 });
  repos = new Repositories(pool);

  const company = await repos.companies.create({ name: 'Gate Co', mission: 'test the gate', config: minimalConfig() });
  companyId = company.id;

  // No credentials are set, so every capability is correctly blocked. That is
  // exactly the state we want to assert against.
  providers = new ProviderRegistry({
    context: { secrets: new SecretStore({ get: () => undefined }), environment: 'preview', publicBaseUrl: 'https://example.test' },
    factories: {},
    manifests: ALL_MANIFESTS,
  });

  gate = new PolicyGate(repos, providers, {
    approvalThresholdsMinor: { 'ads.create_campaign': 100_00, 'supplier.contact': 0 },
  });

  await repos.governance.actors.upsert({
    companyId,
    kind: 'manager_agent',
    handle: 'growth_manager',
    roleKey: 'growth_manager',
    authorities: ['ads.create_campaign', 'ads.increase_budget'],
    spendCeilingMinor: 50_00,
  });
  await repos.governance.actors.upsert({
    companyId,
    kind: 'specialist_agent',
    handle: 'community_researcher',
    roleKey: 'community_researcher',
    authorities: ['research.collect'],
    spendCeilingMinor: null,
  });
  await repos.governance.actors.upsert({
    companyId,
    kind: 'ceo_agent',
    handle: 'ceo',
    roleKey: 'ceo',
    authorities: ['finance.move_funds', 'ads.create_campaign'],
    spendCeilingMinor: 250_00,
  });
  await repos.governance.budgets.upsert({
    companyId, scope: 'advertising', window: 'daily', limitMinor: 100_00, currency: 'USD',
  });
}, 60_000);

afterAll(async () => {
  if (!available) return;
  await pool?.end();
  try {
    execFileSync('dropdb', ['--force', TEST_DB], { stdio: 'pipe' });
  } catch { /* leave it behind rather than failing the suite */ }
});

const maybe = (name: string, fn: () => Promise<void>, timeout?: number) =>
  it(name, async () => {
    if (!available) {
      expect(available, 'PostgreSQL was not reachable — this test did not run').toBe(false);
      return;
    }
    await fn();
  }, timeout);

/* -------------------------------------------------------------------------- */

describe('authority enforcement', () => {
  maybe('refuses an authority the actor does not hold', async () => {
    const result = await gate.evaluate({
      companyId,
      actorHandle: 'community_researcher',
      authority: 'supplier.purchase_production',
      action: 'order 5000 units',
    });
    expect(result.outcome).toBe('deny');
    if (result.outcome === 'deny') {
      expect(result.explanation).toContain('Refused');
      expect(result.reasons[0]?.code).toBe('authority_not_held');
    }
  });

  maybe('refuses a human-only authority even to the CEO agent', async () => {
    const result = await gate.evaluate({
      companyId,
      actorHandle: 'ceo',
      authority: 'finance.move_funds',
      action: 'wire funds to supplier',
      amountMinor: 100,
      currency: 'USD',
    });
    expect(result.outcome).toBe('deny');
    if (result.outcome === 'deny') {
      expect(result.reasons[0]?.code).toBe('human_only_authority');
    }
  });

  maybe('records every decision in the audit log', async () => {
    const before = await repos.audit.list(companyId, { kind: 'policy_decision' });
    await gate.evaluate({
      companyId, actorHandle: 'community_researcher', authority: 'ads.create_campaign', action: 'x',
    });
    const after = await repos.audit.list(companyId, { kind: 'policy_decision' });
    expect(after.length).toBeGreaterThan(before.length);
  });
});

/* -------------------------------------------------------------------------- */

describe('capability availability', () => {
  maybe('refuses when the required provider is not activated', async () => {
    const result = await gate.evaluate({
      companyId,
      actorHandle: 'growth_manager',
      authority: 'ads.create_campaign',
      action: 'launch meta campaign',
      capability: 'ads.campaign_manage' as Capability,
    });
    expect(result.outcome).toBe('deny');
    if (result.outcome === 'deny') {
      // The refusal must tell an operator exactly what to do about it.
      expect(result.explanation).toContain('not available');
      expect(result.explanation).toMatch(/META_ADS_ACCESS_TOKEN|environment variable/i);
    }
  });

  maybe('every capability is currently blocked, since no credentials exist', () => {
    const registry = new CapabilityRegistry({
      manifests: ALL_MANIFESTS,
      secrets: new SecretStore({ get: () => undefined }),
    });
    const usable = registry.allCapabilityStatuses().filter((s) => s.usable);
    expect(usable, `unexpectedly usable: ${usable.map((s) => s.capability).join(', ')}`).toHaveLength(0);
    return Promise.resolve();
  });
});

/* -------------------------------------------------------------------------- */

describe('kill switches', () => {
  maybe('an engaged switch blocks the whole scope', async () => {
    await repos.governance.killSwitches.engage(companyId, 'ad_spend', 'testing the brake', 'operator');
    const result = await gate.evaluate({
      companyId, actorHandle: 'growth_manager', authority: 'ads.create_campaign', action: 'launch',
    });
    expect(result.outcome).toBe('deny');
    if (result.outcome === 'deny') expect(result.reasons[0]?.code).toBe('kill_switch_engaged');

    await repos.governance.killSwitches.release(companyId, 'ad_spend', 'operator');
    const after = await gate.evaluate({
      companyId, actorHandle: 'growth_manager', authority: 'ads.create_campaign', action: 'launch',
    });
    expect(after.outcome).not.toBe('deny');
  });

  maybe('the global switch blocks everything', async () => {
    await repos.governance.killSwitches.engage(companyId, 'all', 'full stop', 'operator');
    const result = await gate.evaluate({
      companyId, actorHandle: 'community_researcher', authority: 'research.collect', action: 'collect',
    });
    expect(result.outcome).toBe('deny');
    await repos.governance.killSwitches.release(companyId, 'all', 'operator');
  });
});

/* -------------------------------------------------------------------------- */

describe('budget reservation', () => {
  maybe('reserves on allow and settles on success', async () => {
    const before = (await repos.governance.budgets.forScope(companyId, 'advertising'))[0]!;

    const result = await gate.evaluate({
      companyId,
      actorHandle: 'growth_manager',
      authority: 'ads.create_campaign',
      action: 'launch arm A',
      amountMinor: 20_00,
      currency: 'USD',
      budgetScope: 'advertising',
    });
    expect(result.outcome).toBe('allow');
    if (result.outcome !== 'allow') return;

    const reserved = (await repos.governance.budgets.forScope(companyId, 'advertising'))[0]!;
    expect(reserved.reserved_minor).toBe(before.reserved_minor + 20_00);

    await result.settle(18_00);
    const settled = (await repos.governance.budgets.forScope(companyId, 'advertising'))[0]!;
    expect(settled.reserved_minor).toBe(before.reserved_minor);
    expect(settled.spent_minor).toBe(before.spent_minor + 18_00);
  });

  maybe('releases the reservation when the action throws', async () => {
    const before = (await repos.governance.budgets.forScope(companyId, 'advertising'))[0]!;

    await expect(
      gate.guard(
        {
          companyId,
          actorHandle: 'growth_manager',
          authority: 'ads.create_campaign',
          action: 'launch arm B',
          amountMinor: 10_00,
          currency: 'USD',
          budgetScope: 'advertising',
        },
        async () => {
          throw new Error('meta API returned 500');
        },
      ),
    ).rejects.toThrow('meta API returned 500');

    const after = (await repos.governance.budgets.forScope(companyId, 'advertising'))[0]!;
    // The money must go back — a failing provider must not eat the day's budget.
    expect(after.reserved_minor).toBe(before.reserved_minor);
    expect(after.spent_minor).toBe(before.spent_minor);
  });

  maybe('concurrent gate calls cannot over-commit the budget', async () => {
    await repos.governance.budgets.upsert({
      companyId, scope: 'sampling', window: 'daily', limitMinor: 50_00, currency: 'USD',
    });
    await repos.governance.actors.upsert({
      companyId, kind: 'manager_agent', handle: 'sourcing_manager', roleKey: 'sourcing_manager',
      authorities: ['supplier.purchase_sample'], spendCeilingMinor: 500_00,
    });

    // Ten concurrent 10.00 requests against a 50.00 budget.
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        gate.evaluate({
          companyId,
          actorHandle: 'sourcing_manager',
          authority: 'supplier.purchase_sample',
          action: `sample order ${i}`,
          amountMinor: 10_00,
          currency: 'USD',
          budgetScope: 'sampling',
        }),
      ),
    );

    const allowed = results.filter((r) => r.outcome === 'allow');
    expect(allowed).toHaveLength(5);

    const budget = (await repos.governance.budgets.forScope(companyId, 'sampling'))[0]!;
    expect(budget.reserved_minor + budget.spent_minor).toBeLessThanOrEqual(budget.limit_minor);
  }, 30_000);
});

/* -------------------------------------------------------------------------- */

describe('approval thresholds', () => {
  maybe('opens an approval request above the threshold rather than proceeding', async () => {
    const result = await gate.evaluate({
      companyId,
      actorHandle: 'growth_manager',
      authority: 'ads.create_campaign',
      action: 'launch a large campaign',
      amountMinor: 40_00,
      currency: 'USD',
      budgetScope: 'advertising',
      // Above the actor's 50.00 ceiling via a second call below; here the
      // threshold path is exercised by the zero-threshold authority.
    });
    // 40.00 is under both the ceiling and the threshold, so this one proceeds.
    expect(result.outcome).toBe('allow');
    if (result.outcome === 'allow') await result.release();

    await repos.governance.actors.upsert({
      companyId, kind: 'specialist_agent', handle: 'supplier_outreach', roleKey: 'supplier_outreach',
      authorities: ['supplier.contact'], spendCeilingMinor: null,
    });
    const needsApproval = await gate.evaluate({
      companyId,
      actorHandle: 'supplier_outreach',
      authority: 'supplier.contact',
      action: 'send RFQ to Ningbo Plastics',
      subjectRefId: 'rfq_test',
      riskNotes: ['first contact with this supplier'],
    });
    // supplier.contact has a zero threshold: any outbound contact needs a human.
    expect(needsApproval.outcome).toBe('require_approval');
    if (needsApproval.outcome === 'require_approval') {
      expect(needsApproval.explanation).toContain('human approval');
      const pending = await repos.governance.approvals.listPending(companyId);
      expect(pending.map((p) => p.id)).toContain(needsApproval.approvalId);
    }
  });

  maybe('an approved request unblocks the same action', async () => {
    const pending = await repos.governance.approvals.listPending(companyId);
    const target = pending.find((p) => p.authority === 'supplier.contact');
    expect(target).toBeDefined();

    await repos.governance.approvals.decide(target!.id, 'approved', 'owner@example.com', 'supplier vetted');

    const retry = await gate.evaluate({
      companyId,
      actorHandle: 'supplier_outreach',
      authority: 'supplier.contact',
      action: 'send RFQ to Ningbo Plastics',
      subjectRefId: 'rfq_test',
    });
    expect(retry.outcome).toBe('allow');
    if (retry.outcome === 'allow') {
      expect(retry.reasons.some((r) => r.code === 'existing_approval_valid')).toBe(true);
    }
  });
});

/* -------------------------------------------------------------------------- */

describe('tool execution through the gate', () => {
  maybe('a denied tool returns a readable reason instead of throwing', async () => {
    const registry = new ToolRegistry();
    let executed = false;

    registry.register(
      defineTool({
        name: 'test.spend',
        description: 'Spends money. Call this when you need to test the gate.',
        inputSchema: z.object({ amountMinor: z.number() }),
        authority: 'supplier.purchase_production',
        consequential: true,
        describeAction: (i) => `spend ${i.amountMinor}`,
        estimateSpend: (i) => ({ amountMinor: i.amountMinor, currency: 'USD', budgetScope: 'inventory' as const }),
        execute: async () => {
          executed = true;
          return { done: true };
        },
      }),
    );

    const result = await executeToolCall(
      registry,
      gate,
      { name: 'test.spend', input: { amountMinor: 100 } },
      {
        companyId, runId: 'run_test', roleKey: 'community_researcher', actorHandle: 'community_researcher',
        traceId: 't', signal: new AbortController().signal,
      },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe('denied');
    // The tool body must never have run.
    expect(executed).toBe(false);
  });

  maybe('invalid tool input is reported without touching the gate', async () => {
    const registry = new ToolRegistry();
    registry.register(
      defineTool({
        name: 'test.typed',
        description: 'Requires a number. Call this to test validation.',
        inputSchema: z.object({ count: z.number().int().positive() }),
        authority: 'research.collect',
        consequential: false,
        describeAction: () => 'typed call',
        execute: async () => ({ ok: true }),
      }),
    );

    const result = await executeToolCall(
      registry, gate, { name: 'test.typed', input: { count: 'not a number' } },
      { companyId, runId: 'r', roleKey: 'community_researcher', actorHandle: 'community_researcher', traceId: 't', signal: new AbortController().signal },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe('invalid_input');
  });

  maybe('an unknown tool lists what is available', async () => {
    const registry = new ToolRegistry();
    const result = await executeToolCall(
      registry, gate, { name: 'nope', input: {} },
      { companyId, runId: 'r', roleKey: 'x', actorHandle: 'community_researcher', traceId: 't', signal: new AbortController().signal },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('No tool named');
  });
});

describe('tool registry validation', () => {
  it('rejects a tool whose schema is not strict-compatible', () => {
    const registry = new ToolRegistry();
    expect(() =>
      registry.register({
        name: 'bad',
        description: 'x',
        inputSchema: z.object({}),
        jsonSchema: { type: 'object', properties: {} },
        authority: 'research.collect',
        consequential: false,
        describeAction: () => 'x',
        execute: async () => ({}),
      }),
    ).toThrow(/additionalProperties/);
  });

  it('generates strict-compatible JSON Schema from zod', () => {
    const tool = defineTool({
      name: 'gen',
      description: 'x',
      inputSchema: z.object({ a: z.string(), b: z.number().optional() }),
      authority: 'research.collect',
      consequential: false,
      describeAction: () => 'x',
      execute: async () => ({}),
    });
    expect(tool.jsonSchema['additionalProperties']).toBe(false);
    // Strict mode requires every property listed as required.
    expect(tool.jsonSchema['required']).toEqual(expect.arrayContaining(['a', 'b']));
  });

  it('refuses a duplicate tool name', () => {
    const registry = new ToolRegistry();
    const tool = defineTool({
      name: 'dup', description: 'x', inputSchema: z.object({ a: z.string() }),
      authority: 'research.collect', consequential: false, describeAction: () => 'x', execute: async () => ({}),
    });
    registry.register(tool);
    expect(() => registry.register(tool)).toThrow(/already registered/);
  });
});

/* -------------------------------------------------------------------------- */

describe('org dispatch chain of command', () => {
  maybe('a manager may dispatch its own specialist', async () => {
    const dispatcher = new OrgDispatcher(repos, fakeQueues(), stubBand());
    const result = await dispatcher.dispatch({
      companyId, fromRoleKey: 'research_manager', toRoleKey: 'community_researcher',
      objective: 'collect evidence on X', traceId: 't',
    });
    expect(result.roleKey).toBe('community_researcher');
    expect(result.model).toBe('claude-sonnet-5');
  });

  maybe('a manager may not dispatch another manager’s specialist', async () => {
    const dispatcher = new OrgDispatcher(repos, fakeQueues());
    await expect(
      dispatcher.dispatch({
        companyId, fromRoleKey: 'research_manager', toRoleKey: 'meta_ads_operator',
        objective: 'launch ads', traceId: 't',
      }),
    ).rejects.toThrow(PolicyDeniedError);
  });

  maybe('a specialist may not delegate at all', async () => {
    const dispatcher = new OrgDispatcher(repos, fakeQueues());
    await expect(
      dispatcher.dispatch({
        companyId, fromRoleKey: 'community_researcher', toRoleKey: 'review_miner',
        objective: 'mine reviews', traceId: 't',
      }),
    ).rejects.toThrow(/do not delegate/);
  });

  maybe('the CEO may dispatch managers but not specialists directly', async () => {
    const dispatcher = new OrgDispatcher(repos, fakeQueues(), stubBand());
    await expect(
      dispatcher.dispatch({ companyId, fromRoleKey: 'ceo', toRoleKey: 'research_manager', objective: 'find opportunities', traceId: 't' }),
    ).resolves.toBeDefined();
    await expect(
      dispatcher.dispatch({ companyId, fromRoleKey: 'ceo', toRoleKey: 'community_researcher', objective: 'collect', traceId: 't' }),
    ).rejects.toThrow(PolicyDeniedError);
  });

  maybe('dispatch refuses when BAND is not wired and never enqueues', async () => {
    const tracked = trackingQueues();
    const dispatcher = new OrgDispatcher(repos, tracked.queues);
    await expect(
      dispatcher.dispatch({
        companyId, fromRoleKey: 'research_manager', toRoleKey: 'community_researcher',
        objective: 'collect evidence on X', traceId: 't',
      }),
    ).rejects.toThrow(/BAND/);
    expect(tracked.calls, 'enqueue must not run without a BAND room').toHaveLength(0);
  });

  maybe('enqueueSystem also refuses when BAND is not wired', async () => {
    const tracked = trackingQueues();
    const dispatcher = new OrgDispatcher(repos, tracked.queues);
    await expect(
      dispatcher.enqueueSystem({
        companyId, toRoleKey: 'ceo', objective: 'start the loop', traceId: 't',
      }),
    ).rejects.toThrow(/BAND/);
    expect(tracked.calls).toHaveLength(0);
  });

  maybe('removing the room (sendMessage fails) breaks dispatch and does not enqueue', async () => {
    const tracked = trackingQueues();
    const objective = `band-room-gone-${Date.now()}`;
    const band = {
      getMe: async () => ({ id: 'agt_test', handle: 'foundry-dispatch' }),
      createChat: async () => ({ id: 'chat_test' }),
      sendMessage: async () => {
        throw new Error('BAND room gone');
      },
    } as unknown as BandAdapter;
    const dispatcher = new OrgDispatcher(repos, tracked.queues, { band });
    await expect(
      dispatcher.dispatch({
        companyId, fromRoleKey: 'research_manager', toRoleKey: 'community_researcher',
        objective, traceId: 't',
      }),
    ).rejects.toThrow(/room gone/);
    expect(tracked.calls).toHaveLength(0);
    const leftover = (await repos.agents.runs.listActive(companyId)).filter((r) => r.objective === objective);
    expect(leftover, 'failed handoff must not leave a queued run').toHaveLength(0);
  });

  maybe('@mention is posted before enqueue and the run stores the BAND assignment', async () => {
    const events: string[] = [];
    const tracked = trackingQueues(events);
    let sent: { recipients: readonly string[]; body: string } | undefined;
    const band = {
      getMe: async () => ({ id: 'agt_test', handle: 'foundry-dispatch' }),
      createChat: async () => {
        events.push('createChat');
        return { id: 'chat_test' };
      },
      sendMessage: async (_chatId: string, input: { recipients: readonly string[]; body: string }) => {
        events.push('sendMessage');
        sent = input;
        return { id: 'msg_test' };
      },
    } as unknown as BandAdapter;
    const dispatcher = new OrgDispatcher(repos, tracked.queues, { band });
    const result = await dispatcher.dispatch({
      companyId, fromRoleKey: 'research_manager', toRoleKey: 'community_researcher',
      objective: 'handoff-before-enqueue', traceId: 't',
    });
    expect(sent?.recipients).toEqual(['foundry-dispatch']);
    expect(sent?.body).toContain('DISPATCH');
    expect(events.indexOf('sendMessage')).toBeGreaterThanOrEqual(0);
    expect(events.indexOf('sendMessage')).toBeLessThan(events.indexOf('enqueue'));
    const run = await repos.agents.runs.byId(result.runId);
    expect(run.coordination_room_id).toBe('chat_test');
    expect(run.input_refs['bandChatId']).toBe('chat_test');
    expect(run.input_refs['bandMessageId']).toBe('msg_test');
  });
});

describe('BAND handoff drives start', () => {
  maybe('start without a BAND assignment throws and never calls the LLM', async () => {
    let llmCalls = 0;
    let claims = 0;
    const tools = toolsForRole('community_researcher');
    const band = {
      markMessageProcessing: async () => {
        claims += 1;
        return { id: 'msg_test' };
      },
    } as unknown as BandAdapter;
    const llm = {
      runToolLoop: async () => {
        llmCalls += 1;
        throw new Error('LLM must not run before a BAND claim');
      },
    } as unknown as AnthropicAdapter;

    const run = await repos.agents.runs.create({
      companyId,
      roleKey: 'community_researcher',
      objective: 'start-without-room',
    });
    const executor = new AgentExecutor({ repos, llm, tools, gate, band });
    await expect(
      executor.run({
        runId: run.id,
        companyId,
        roleKey: 'community_researcher',
        objective: 'start-without-room',
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/BAND/);
    expect(llmCalls, 'LLM must not run when the room assignment is missing').toBe(0);
    expect(claims, 'nothing to claim without a message id').toBe(0);
  });

  maybe('executor claims the BAND message before the LLM runs', async () => {
    const events: string[] = [];
    const tracked = trackingQueues(events);
    const band = {
      getMe: async () => ({ id: 'agt_test', handle: 'foundry-dispatch' }),
      createChat: async () => ({ id: 'chat_test' }),
      sendMessage: async () => {
        events.push('sendMessage');
        return { id: 'msg_test' };
      },
      markMessageProcessing: async () => {
        events.push('claim');
        return { id: 'msg_test' };
      },
      markMessageProcessed: async () => {
        events.push('processed');
        return { id: 'msg_test' };
      },
      markMessageFailed: async () => {
        events.push('failed');
        return { id: 'msg_test' };
      },
    } as unknown as BandAdapter;
    const dispatcher = new OrgDispatcher(repos, tracked.queues, { band });
    const dispatched = await dispatcher.dispatch({
      companyId, fromRoleKey: 'research_manager', toRoleKey: 'community_researcher',
      objective: 'claim-before-llm', traceId: 't',
    });

    const llm = {
      runToolLoop: async () => {
        events.push('llm');
        return {
          finalText: 'claimed then ran',
          stopReason: 'end_turn',
          refusal: null,
          iterations: 1,
          usage: {
            inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, costMinorUsd: 0,
          },
          messages: [],
        };
      },
    } as unknown as AnthropicAdapter;

    const executor = new AgentExecutor({
      repos, llm, tools: toolsForRole('community_researcher'), gate, band,
    });
    const outcome = await executor.run({
      runId: dispatched.runId,
      companyId,
      roleKey: 'community_researcher',
      objective: 'claim-before-llm',
      signal: new AbortController().signal,
    });
    expect(outcome.status).toBe('succeeded');
    expect(events.indexOf('sendMessage')).toBeLessThan(events.indexOf('enqueue'));
    expect(events.indexOf('claim')).toBeGreaterThan(events.indexOf('enqueue'));
    expect(events.indexOf('claim')).toBeLessThan(events.indexOf('llm'));
  });
});

/* -------------------------------------------------------------------------- */

/** Minimal queue stand-in: dispatch is tested for its rules, not its transport. */
function fakeQueues(): { enqueue: (...args: unknown[]) => Promise<string> } & Record<string, unknown> {
  return trackingQueues().queues;
}

function trackingQueues(events?: string[]): {
  queues: { enqueue: (...args: unknown[]) => Promise<string> } & Record<string, unknown>;
  calls: unknown[][];
} {
  const calls: unknown[][] = [];
  return {
    calls,
    queues: {
      enqueue: async (...args: unknown[]) => {
        calls.push(args);
        events?.push('enqueue');
        return 'job_1';
      },
    } as never,
  };
}

/** BAND room is the handoff. Successful dispatch tests must post into a room. */
function stubBand(): { band: BandAdapter } {
  return {
    band: {
      getMe: async () => ({ id: 'agt_test', handle: 'foundry-dispatch' }),
      createChat: async () => ({ id: 'chat_test' }),
      sendMessage: async () => ({ id: 'msg_test' }),
      markMessageProcessing: async () => ({ id: 'msg_test' }),
      markMessageProcessed: async () => ({ id: 'msg_test' }),
      markMessageFailed: async () => ({ id: 'msg_test' }),
    } as unknown as BandAdapter,
  };
}

function toolsForRole(roleKey: string): ToolRegistry {
  const registry = new ToolRegistry();
  const role = roleByKey(roleKey);
  if (!role) throw new Error(`unknown role ${roleKey}`);
  for (const name of role.tools) {
    registry.register(
      defineTool({
        name,
        description: `Stub ${name}. Call only in BAND handoff tests.`,
        inputSchema: z.object({}),
        authority: 'research.collect',
        consequential: false,
        describeAction: () => name,
        execute: async () => ({ ok: true }),
      }),
    );
  }
  return registry;
}

function minimalConfig(): unknown {
  return {
    owner: { name: 'Operator', email: 'owner@example.com', delegatedAuthorities: [], delegationRecordedAt: null },
    legalEntity: { type: 'not_yet_formed', registeredName: null, registrationNumber: null, taxId: null, jurisdiction: null, registeredAddress: null },
    contact: { supportEmail: 'support@example.com', supportPhone: null, supportMessagingHandle: null, physicalAddressDisclosed: false },
    commerce: {
      baseCurrency: 'USD', sellsTo: ['US'], shipsFrom: ['US'], returnWindowDays: 30, restockingFeeBps: 0,
      whoPaysReturnShipping: 'depends_on_reason', warrantyOffered: false, warrantyTermMonths: null,
      taxCollectionEnabled: false, taxProvider: null,
    },
    privacy: {
      dataController: null, personalDataCategories: ['contact'], retentionDays: 365, analyticsEnabled: false,
      cookiesUsed: ['strictly_necessary'], consentRequiredRegions: ['EU'], dpoContact: null, subprocessors: [],
    },
    messaging: {
      marketingMessagingEnabled: false, consentLanguage: null, messageFrequencyDisclosure: null,
      optOutInstructions: null, helpInstructions: null,
    },
    risk: {
      maxOrderValueMinor: 50_000, maxDailyOrdersBeforeReview: 100, agentRefundLimitMinor: 5_000,
      maxSupplierPurchaseWithoutHumanMinor: 20_000, maxDailyAdSpendMinor: 50_000,
    },
  };
}
