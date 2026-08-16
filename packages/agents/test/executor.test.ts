/**
 * Agent executor: startup failures must be terminal, tool results must not
 * silently overflow the context window, and metrics must count each run once.
 *
 * The BAND-stranding case needs a real `agent_runs` row, so it follows the
 * policy-gate suite's Postgres setup. Truncation is a pure function and does
 * not.
 */

import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AgentExecutor,
  capToolResultForModel,
  defineTool,
  MAX_BARREN_ITERATIONS,
  MAX_TOOL_RESULT_CHARS,
  PolicyGate,
  ToolRegistry,
  UnproductiveLoopDetector,
} from '@foundry/agents';
import { SecretStore, roleByKey } from '@foundry/core';
import { Repositories, createPool, type DbPool } from '@foundry/db';
import { ALL_MANIFESTS, AnthropicAdapter, ProviderRegistry, type BandAdapter, type CompletionUsage } from '@foundry/providers';
import { z } from 'zod';

describe('capToolResultForModel', () => {
  it('returns the payload unchanged when it fits', () => {
    const full = 'short result';
    expect(capToolResultForModel(full)).toEqual({ content: full, omittedChars: 0 });
  });

  it('tells the model that truncation happened and how much was omitted', () => {
    const full = 'x'.repeat(MAX_TOOL_RESULT_CHARS + 4_000);
    const capped = capToolResultForModel(full);
    expect(capped.content.length).toBeLessThanOrEqual(MAX_TOOL_RESULT_CHARS);
    expect(capped.content).toMatch(/truncated/i);
    expect(capped.content).toMatch(/4000/);
    expect(capped.content).toMatch(/audit trail/i);
    expect(capped.omittedChars).toBeGreaterThan(0);
    expect(capped.content.startsWith('x')).toBe(true);
  });

  it('never silently slices: a truncated result is not a prefix of the original alone', () => {
    const full = 'abcdefghij'.repeat(3_000);
    const capped = capToolResultForModel(full);
    expect(full.startsWith(capped.content)).toBe(false);
    expect(capped.content.includes('[truncated:')).toBe(true);
  });
});

describe('UnproductiveLoopDetector', () => {
  const call = (name: string, input: unknown, result: string) => ({ name, input, result });

  it('lets an iteration through when any call returned something new', () => {
    const detector = new UnproductiveLoopDetector();
    expect(detector.observe([call('search', { q: 'a' }, '["hit"]')])).toBeNull();
    expect(detector.observe([call('search', { q: 'b' }, '["other"]')])).toBeNull();
  });

  it('does not judge an iteration that made no tool call', () => {
    const detector = new UnproductiveLoopDetector(1);
    expect(detector.observe([])).toBeNull();
    expect(detector.observe([])).toBeNull();
  });

  it('treats the same tool with different arguments as new work', () => {
    const detector = new UnproductiveLoopDetector(2);
    expect(detector.observe([call('search', { q: 'a' }, 'same')])).toBeNull();
    expect(detector.observe([call('search', { q: 'b' }, 'same')])).toBeNull();
    expect(detector.observe([call('search', { q: 'c' }, 'same')])).toBeNull();
  });

  it('stops once nothing new arrives for the whole streak, and names the tool', () => {
    const detector = new UnproductiveLoopDetector();
    const repeat = () => detector.observe([call('cluster.read', { id: 1 }, '{"clusters":[]}')]);

    expect(repeat(), 'first call is new').toBeNull();
    for (let i = 1; i < MAX_BARREN_ITERATIONS; i += 1) {
      expect(repeat(), `barren iteration ${i} is under the limit`).toBeNull();
    }
    const reason = repeat();
    expect(reason).toContain('cluster.read');
    expect(reason).toMatch(/no progress/i);
    expect(reason).toContain(String(MAX_BARREN_ITERATIONS));
  });

  it('resets the streak when new information arrives, so a slow run is not cut short', () => {
    const detector = new UnproductiveLoopDetector(2);
    expect(detector.observe([call('read', {}, 'x')])).toBeNull();
    expect(detector.observe([call('read', {}, 'x')])).toBeNull();
    // One novel result in a mixed iteration is enough to count as progress.
    expect(detector.observe([call('read', {}, 'x'), call('read', {}, 'y')])).toBeNull();
    expect(detector.observe([call('read', {}, 'x')])).toBeNull();
    expect(detector.observe([call('read', {}, 'y')])).not.toBeNull();
  });

  it('distinguishes results that differ only late in a long payload', () => {
    const detector = new UnproductiveLoopDetector(1);
    const long = 'z'.repeat(20_000);
    expect(detector.observe([call('dump', {}, `${long}a`)])).toBeNull();
    expect(detector.observe([call('dump', {}, `${long}b`)])).toBeNull();
  });
});

const TEST_DB = `foundry_executor_${Date.now()}`;
const TEST_URL = `postgres://localhost:5432/${TEST_DB}`;

let pool: DbPool;
let repos: Repositories;
let available = false;
let companyId: string;
let gate: PolicyGate;

beforeAll(async () => {
  try {
    execFileSync('pg_isready', ['-q'], { stdio: 'pipe' });
    execFileSync('createdb', [TEST_DB], { stdio: 'pipe' });
    available = true;
  } catch {
    console.warn('\n[executor] No reachable PostgreSQL; skipping DB-backed executor tests.\n');
    return;
  }

  const dir = join(import.meta.dirname, '..', '..', 'db', 'src', 'migrations');
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    execFileSync('psql', ['-q', '-v', 'ON_ERROR_STOP=1', '-d', TEST_DB, '-f', join(dir, file)], { stdio: 'pipe' });
  }

  pool = createPool({ connectionString: TEST_URL, applicationName: 'foundry-executor-test', maxConnections: 4 });
  repos = new Repositories(pool);
  const company = await repos.companies.create({
    name: 'Executor Co',
    mission: 'test the executor',
    config: minimalConfig(),
  });
  companyId = company.id;
  const providers = new ProviderRegistry({
    context: {
      secrets: new SecretStore({ get: () => undefined }),
      environment: 'preview',
      publicBaseUrl: 'https://example.test',
    },
    factories: {},
    manifests: ALL_MANIFESTS,
  });
  gate = new PolicyGate(repos, providers, { approvalThresholdsMinor: {} });
  // The gate resolves the caller by handle; without a row every tool call
  // throws before it runs, which is a different test than the ones below.
  await repos.governance.actors.upsert({
    companyId,
    kind: 'specialist_agent',
    handle: 'community_researcher',
    roleKey: 'community_researcher',
    authorities: [...(roleByKey('community_researcher')?.authorities ?? [])],
    spendCeilingMinor: null,
  });
});

afterAll(async () => {
  if (pool) await pool.end();
  if (available) {
    try {
      execFileSync('dropdb', ['--if-exists', TEST_DB], { stdio: 'pipe' });
    } catch {
      /* best-effort */
    }
  }
});

const maybe = (name: string, fn: () => Promise<void>) =>
  it(name, async () => {
    if (!available) {
      expect(available, 'PostgreSQL was not reachable — this test did not run').toBe(false);
      return;
    }
    await fn();
  });

describe('BAND claim failure leaves a terminal run', () => {
  maybe('a missing BAND assignment fails the row instead of leaving it running', async () => {
    const run = await repos.agents.runs.create({
      companyId,
      roleKey: 'community_researcher',
      objective: 'must-not-strand',
    });
    const band = {
      markMessageProcessing: async () => {
        throw new Error('should not claim without an assignment');
      },
    } as unknown as BandAdapter;
    const llm = {
      runToolLoop: async () => {
        throw new Error('LLM must not run');
      },
    } as unknown as AnthropicAdapter;

    const executor = new AgentExecutor({
      repos,
      llm,
      tools: toolsForRole('community_researcher'),
      gate,
      band,
    });

    await expect(
      executor.run({
        runId: run.id,
        companyId,
        roleKey: 'community_researcher',
        objective: 'must-not-strand',
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/BAND/);

    const row = await repos.agents.runs.byId(run.id);
    expect(row.status).not.toBe('running');
    expect(row.status).toBe('failed');
    expect(row.finished_at).not.toBeNull();
    expect(row.error ?? '').toMatch(/BAND/i);
  });
});

/* -------------------------------------------------------------------------- */
/* Long runs                                                                   */
/* -------------------------------------------------------------------------- */

const ROLE = 'community_researcher';
const TOOL = roleByKey(ROLE)!.tools[0]!;
const COST_PER_TURN_MINOR = 3;

type StubTurn =
  | { readonly kind: 'tool'; readonly input: unknown; readonly text: string; readonly usage?: Partial<CompletionUsage> }
  | { readonly kind: 'final'; readonly text: string; readonly usage?: Partial<CompletionUsage> }
  | { readonly kind: 'throw'; readonly error: Error };

/**
 * A real `AnthropicAdapter` with only the HTTP call replaced.
 *
 * `runToolLoop` — the iteration cap, the stop hook, the per-step callback — is
 * the shipped implementation, because that is the code under test. Re-writing
 * the loop in the fixture would test the fixture.
 */
function stubLlm(turns: readonly StubTurn[]): { llm: AnthropicAdapter; completions: () => number } {
  const adapter = new AnthropicAdapter({
    secrets: new SecretStore({ get: () => undefined }),
    environment: 'preview',
    publicBaseUrl: 'https://example.test',
  });
  let index = 0;

  (adapter as unknown as { complete: () => Promise<unknown> }).complete = async () => {
    const turn = turns[Math.min(index, turns.length - 1)]!;
    index += 1;
    if (turn.kind === 'throw') throw turn.error;

    const usage = {
      inputTokens: 100,
      outputTokens: 20,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      costMinorUsd: COST_PER_TURN_MINOR,
      ...turn.usage,
    };
    if (turn.kind === 'final') {
      return {
        model: 'stub', content: [{ type: 'text', text: turn.text }], text: turn.text,
        stopReason: 'end_turn', refusal: null, toolUses: [], usage,
      };
    }
    const id = `toolu_${index}`;
    return {
      model: 'stub',
      content: [
        { type: 'text', text: turn.text },
        { type: 'tool_use', id, name: TOOL, input: turn.input },
      ],
      text: turn.text,
      stopReason: 'tool_use',
      refusal: null,
      toolUses: [{ id, name: TOOL, input: turn.input }],
      usage,
    };
  };

  return { llm: adapter, completions: () => index };
}

function executorFor(llm: AnthropicAdapter): AgentExecutor {
  // No BAND: this suite is about what the loop does, not about the handoff.
  return new AgentExecutor({ repos, llm, tools: toolsForRole(ROLE), gate });
}

describe('a long run degrades instead of dying', () => {
  maybe('stops a loop that stops making progress, and says so truthfully', async () => {
    const run = await repos.agents.runs.create({ companyId, roleKey: ROLE, objective: 'spin forever' });
    // Every turn is the same call with the same arguments, so every result after
    // the first is one the model has already been shown.
    const { llm, completions } = stubLlm([{ kind: 'tool', input: { q: 'same' }, text: 'looking again' }]);

    const outcome = await executorFor(llm).run({
      runId: run.id,
      companyId,
      roleKey: ROLE,
      objective: 'spin forever',
      signal: new AbortController().signal,
    });

    expect(outcome.status).toBe('failed');
    expect(outcome.blockedReason).toMatch(/no progress/i);
    expect(outcome.blockedReason).toContain(TOOL);
    // One productive turn plus the barren streak, and then it stops — well
    // short of the 20-iteration cap it would otherwise have run to.
    expect(outcome.iterations).toBe(MAX_BARREN_ITERATIONS + 1);
    expect(completions()).toBe(MAX_BARREN_ITERATIONS + 1);
    expect(outcome.costMinorUsd).toBe(COST_PER_TURN_MINOR * (MAX_BARREN_ITERATIONS + 1));

    const row = await repos.agents.runs.byId(run.id);
    expect(row.status).toBe('failed');
    expect(row.finished_at).not.toBeNull();
    expect(row.cost_minor_usd).toBe(outcome.costMinorUsd);
    const output = row.output as Record<string, unknown>;
    expect(output['blocked'], 'a run that stopped short is blocked, not crashed').toBe(true);
    expect(output['kind']).toBe('no_progress');
    expect(output['partialText']).toBe('looking again');
  });

  maybe('will not start a turn it cannot finish before deadline_at', async () => {
    const run = await repos.agents.runs.create({ companyId, roleKey: ROLE, objective: 'already overdue' });
    const { llm, completions } = stubLlm([{ kind: 'final', text: 'must never run' }]);

    const outcome = await executorFor(llm).run({
      runId: run.id,
      companyId,
      roleKey: ROLE,
      objective: 'already overdue',
      deadlineAt: new Date(Date.now() - 60_000).toISOString(),
      signal: new AbortController().signal,
    });

    expect(completions(), 'no tokens are spent on a run that is already out of time').toBe(0);
    expect(outcome.status).toBe('timed_out');
    expect(outcome.blockedReason).toMatch(/deadline/i);
    expect(outcome.costMinorUsd).toBe(0);

    const row = await repos.agents.runs.byId(run.id);
    expect(row.status).toBe('timed_out');
    expect((row.output as Record<string, unknown>)['kind']).toBe('deadline');
  });

  maybe('a malformed deadline does not stop the run', async () => {
    const run = await repos.agents.runs.create({ companyId, roleKey: ROLE, objective: 'bad deadline' });
    const { llm } = stubLlm([{ kind: 'final', text: 'ran anyway' }]);

    const outcome = await executorFor(llm).run({
      runId: run.id,
      companyId,
      roleKey: ROLE,
      objective: 'bad deadline',
      deadlineAt: 'not-a-timestamp',
      signal: new AbortController().signal,
    });

    expect(outcome.status).toBe('succeeded');
    expect(outcome.finalText).toBe('ran anyway');
  });

  maybe('a crash mid-loop reports the iterations and cost already spent', async () => {
    const run = await repos.agents.runs.create({ companyId, roleKey: ROLE, objective: 'die at turn three' });
    const { llm } = stubLlm([
      { kind: 'tool', input: { step: 1 }, text: 'first finding' },
      { kind: 'tool', input: { step: 2 }, text: 'second finding' },
      // Exactly what killed run_01M03WYC2BKWWN5KGGBXWMT2YP: the provider gave
      // up on a request seventeen turns into a run that had done real work.
      { kind: 'throw', error: new Error('Provider "anthropic" is unavailable: messages.create: Request timed out.') },
    ]);

    const outcome = await executorFor(llm).run({
      runId: run.id,
      companyId,
      roleKey: ROLE,
      objective: 'die at turn three',
      signal: new AbortController().signal,
    });

    expect(outcome.status).toBe('failed');
    expect(outcome.iterations, 'two turns completed before the crash').toBe(2);
    expect(outcome.costMinorUsd).toBe(COST_PER_TURN_MINOR * 2);
    expect(outcome.finalText, 'the last thing the run managed to say is not thrown away').toBe('second finding');
    expect(outcome.blockedReason).toMatch(/timed out/i);

    const row = await repos.agents.runs.byId(run.id);
    expect(row.status).toBe('failed');
    // The row was already being updated per step, and the returned outcome now
    // agrees with it instead of reporting zero.
    expect(row.cost_minor_usd).toBe(outcome.costMinorUsd);
    expect(row.tool_call_count).toBe(2);
    expect((row.output as Record<string, unknown>)['iterations']).toBe(2);

    const messages = await repos.agents.messages.forRun(run.id);
    expect(
      messages.filter((m) => m.role === 'tool_result').length,
      'every tool result reached the database before the crash',
    ).toBe(2);
  });
});

describe('usage accounting on the run row', () => {
  maybe('input_tokens sums uncached, cache-write and cache-read tokens across steps', async () => {
    const run = await repos.agents.runs.create({ companyId, roleKey: ROLE, objective: 'count every prompt token' });
    // The shape prompt caching produces: the first turn writes the cache, the
    // second reads it back, and Anthropic's inputTokens carries only the tiny
    // uncached delta. Recording that delta alone is the production bug where a
    // 21-tool-call run reported input_tokens=28 next to a 30-cent cost.
    const { llm } = stubLlm([
      {
        kind: 'tool',
        input: { q: 'first' },
        text: 'cold cache',
        usage: { inputTokens: 3, outputTokens: 100, cacheCreationInputTokens: 5_000, cacheReadInputTokens: 0, costMinorUsd: 7 },
      },
      {
        kind: 'final',
        text: 'warm cache',
        usage: { inputTokens: 1, outputTokens: 200, cacheCreationInputTokens: 40, cacheReadInputTokens: 5_000, costMinorUsd: 3 },
      },
    ]);

    const outcome = await executorFor(llm).run({
      runId: run.id,
      companyId,
      roleKey: ROLE,
      objective: 'count every prompt token',
      signal: new AbortController().signal,
    });

    expect(outcome.status).toBe('succeeded');
    expect(outcome.costMinorUsd, 'cost stays exactly what the adapter computed').toBe(7 + 3);

    const row = await repos.agents.runs.byId(run.id);
    expect(row.input_tokens, 'all prompt-side components, both steps').toBe(3 + 5_000 + 0 + (1 + 40 + 5_000));
    expect(row.output_tokens).toBe(100 + 200);
    expect(row.cost_minor_usd).toBe(7 + 3);
    expect(row.tool_call_count).toBe(1);
  });
});

function toolsForRole(roleKey: string): ToolRegistry {
  const registry = new ToolRegistry();
  const role = roleByKey(roleKey);
  if (!role) throw new Error(`unknown role ${roleKey}`);
  for (const name of role.tools) {
    registry.register(
      defineTool({
        name,
        description: `Stub ${name}.`,
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
    legalEntity: {
      type: 'not_yet_formed',
      registeredName: null,
      registrationNumber: null,
      taxId: null,
      jurisdiction: null,
      registeredAddress: null,
    },
    contact: {
      supportEmail: 'support@example.com',
      supportPhone: null,
      supportMessagingHandle: null,
      physicalAddressDisclosed: false,
    },
    commerce: {
      baseCurrency: 'USD',
      sellsTo: ['US'],
      shipsFrom: ['US'],
      returnWindowDays: 30,
      restockingFeeBps: 0,
      whoPaysReturnShipping: 'depends_on_reason',
      warrantyOffered: false,
      warrantyTermMonths: null,
      taxCollectionEnabled: false,
      taxProvider: null,
    },
    privacy: {
      dataController: null,
      personalDataCategories: ['contact'],
      retentionDays: 365,
      analyticsEnabled: false,
      cookiesUsed: ['strictly_necessary'],
      consentRequiredRegions: ['EU'],
      dpoContact: null,
      subprocessors: [],
    },
    messaging: {
      marketingMessagingEnabled: false,
      consentLanguage: null,
      messageFrequencyDisclosure: null,
      optOutInstructions: null,
      helpInstructions: null,
    },
    risk: {
      maxOrderValueMinor: 50_000,
      maxDailyOrdersBeforeReview: 100,
      agentRefundLimitMinor: 5_000,
      maxSupplierPurchaseWithoutHumanMinor: 20_000,
      maxDailyAdSpendMinor: 50_000,
    },
  };
}
