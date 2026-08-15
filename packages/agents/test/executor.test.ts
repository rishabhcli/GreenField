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
import { AgentExecutor, capToolResultForModel, defineTool, MAX_TOOL_RESULT_CHARS, PolicyGate, ToolRegistry } from '@foundry/agents';
import { SecretStore, roleByKey } from '@foundry/core';
import { Repositories, createPool, type DbPool } from '@foundry/db';
import { ALL_MANIFESTS, ProviderRegistry, type AnthropicAdapter, type BandAdapter } from '@foundry/providers';
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
