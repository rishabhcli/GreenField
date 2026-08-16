/**
 * Recovery from a blocked cycle.
 *
 * A `blocked` loop cycle is a claim about the world at the moment it was
 * written: "this phase cannot proceed because a capability is unavailable".
 * The normal resolution of that claim is that the credential gets issued and
 * `apps/verifier` records a passing probe, so the capability turns usable.
 *
 * These tests pin the consequence: the very next tick must retract the stored
 * block. `advance` — the only other writer that clears `blocked_reason` — runs
 * solely when a phase is *complete*, so without an explicit retraction a cycle
 * that has become unblocked but is still mid-phase keeps reporting a credential
 * that is present and verified as the reason the company is stuck. That row is
 * read by `GET /api/company/loop`, `/readiness` and the CEO's own
 * `company.status` tool, so a stale block does not just look wrong, it sends
 * the organisation to fix a problem that no longer exists.
 *
 * The inverse is pinned too: a capability that is still genuinely unavailable
 * must stay blocked. Recovery may never be an unconditional clear.
 */

import { describe, expect, it } from 'vitest';
import type { Capability } from '@foundry/core';
import type { ServiceDeps } from '../src/deps.js';
import { LoopOrchestrator } from '../src/loop/orchestrator.js';

const COMPANY = 'co_01M03F7RQW2M6540BY2GZHCFBW';
const CYCLE = 'task_01M03F84J1T2EVH9BNN0A66WG3';

/** The exact remediation the live cycle was pinned on before the key was set. */
const STALE_REMEDIATION =
  'Set the following environment variables on the Render service, then re-run the verification harness:\n' +
  '  - BRAVE_SEARCH_API_KEY: Brave Search API subscription token';

function cap(capability: Capability, usable: boolean) {
  return {
    capability,
    provider: capability === 'research.web_search' ? 'brave_search' : 'solari',
    state: usable ? 'live_verified' : 'blocked_missing_credentials',
    usable,
    evidence: null,
    remediation: usable ? null : STALE_REMEDIATION,
    missingSecrets: usable ? [] : ['BRAVE_SEARCH_API_KEY'],
    lastVerifiedAt: usable ? new Date('2026-08-16T00:07:59.031Z') : null,
    alternatives: [],
  };
}

interface Harness {
  readonly loop: LoopOrchestrator;
  readonly unblocked: string[];
  readonly blocked: { cycleId: string; reason: string; capability: string | null }[];
  readonly advanced: string[];
  readonly enqueued: string[];
  readonly dispatched: string[];
}

function harness(options: {
  /** Persisted status of the cycle this tick reads. */
  readonly cycleStatus: 'running' | 'blocked';
  readonly evidenceCount: number;
  readonly opportunityCount: number;
  readonly webUsable: boolean;
  readonly browserUsable: boolean;
}): Harness {
  const unblocked: string[] = [];
  const blocked: { cycleId: string; reason: string; capability: string | null }[] = [];
  const advanced: string[] = [];
  const enqueued: string[] = [];
  const dispatched: string[] = [];

  let status = options.cycleStatus;
  const cycleRow = () => ({
    id: CYCLE,
    company_id: COMPANY,
    cycle_number: 1,
    phase: 'discover',
    status,
    blocked_reason: status === 'blocked' ? `discover: ${STALE_REMEDIATION}` : null,
    blocked_on_capability: status === 'blocked' ? 'research.web_search' : null,
    phase_outputs: {},
    ceo_decision: null,
    ceo_decision_rationale: null,
    started_at: new Date('2026-08-15T19:44:13.592Z'),
    phase_entered_at: new Date('2026-08-15T19:44:16.171Z'),
    completed_at: null,
  });

  const deps = {
    repos: {
      // `tryAdvisoryLock` runs `pg_try_advisory_lock` on a pooled client; the
      // tick body only executes when it is granted, so the fake must grant it.
      pool: {
        connect: async () => ({
          query: async () => ({ rows: [{ pg_try_advisory_lock: true }] }),
          release: () => undefined,
        }),
      },
      loop: {
        currentOrStart: async () => cycleRow(),
        block: async (cycleId: string, reason: string, capability: string | null) => {
          status = 'blocked';
          blocked.push({ cycleId, reason, capability });
        },
        unblock: async (cycleId: string) => {
          status = 'running';
          unblocked.push(cycleId);
        },
        advance: async (cycleId: string) => {
          advanced.push(cycleId);
          return { cycle: { ...cycleRow(), phase: 'score', status: 'running' }, wrapped: false };
        },
      },
      governance: { killSwitches: { engagedScopes: async () => [] as string[] } },
      companies: {
        byId: async () => ({ id: COMPANY, selected_opportunity_id: null, active_site_id: null }),
      },
      research: {
        evidence: {
          search: async () => Array.from({ length: options.evidenceCount }, (_, i) => ({ id: `ev_${i + 1}` })),
        },
        opportunities: {
          list: async () => Array.from({ length: options.opportunityCount }, (_, i) => ({ id: `opp_${i + 1}` })),
        },
      },
    },
    queues: {
      enqueue: async (name: string) => {
        enqueued.push(name);
      },
    },
    dispatcher: {
      dispatch: async (request: { toRoleKey: string }) => {
        dispatched.push(request.toRoleKey);
        return { runId: 'run_1', roleKey: request.toRoleKey, model: 'test', queuedAt: '' };
      },
      enqueueSystem: async (request: { toRoleKey: string }) => {
        dispatched.push(request.toRoleKey);
        return { runId: 'run_1', roleKey: request.toRoleKey, model: 'test', queuedAt: '' };
      },
    },
    capabilities: {
      resolveCapability: (capability: Capability) => {
        if (capability === 'research.web_search') return cap(capability, options.webUsable);
        if (capability === 'research.browser_session') return cap(capability, options.browserUsable);
        return cap(capability, false);
      },
      summary: () => ({ liveVerified: 0, configuredUnverified: 0, blocked: 0, unsupported: 0, total: 0 }),
    },
  } as unknown as ServiceDeps;

  return { loop: new LoopOrchestrator(deps), unblocked, blocked, advanced, enqueued, dispatched };
}

describe('loop cycle recovery from blocked', () => {
  it('retracts a stale block once the capability it named is usable again', async () => {
    // The live shape of the bug: the cycle was blocked on research.web_search
    // when BRAVE_SEARCH_API_KEY was unset. The key is now present, the probe
    // passed, and evidence has been collected — but clustering has not produced
    // an opportunity yet, so the phase is still incomplete and `advance` (which
    // is what otherwise clears the block) will not run.
    const h = harness({
      cycleStatus: 'blocked',
      evidenceCount: 221,
      opportunityCount: 0,
      webUsable: true,
      browserUsable: true,
    });

    const result = await h.loop.tick(COMPANY);

    expect(h.unblocked).toEqual([CYCLE]);
    expect(h.blocked).toEqual([]);
    expect(result.action).toBe('started_work');
    expect(result.blockedOnCapability).toBeUndefined();
    // Recovery is not merely cosmetic: the phase's work is put back in flight.
    expect(h.enqueued).toContain('research.cluster');
    expect(h.dispatched).toContain('research_manager');
  });

  it('advances a previously blocked cycle whose phase is now complete', async () => {
    const h = harness({
      cycleStatus: 'blocked',
      evidenceCount: 221,
      opportunityCount: 4,
      webUsable: true,
      browserUsable: true,
    });

    const result = await h.loop.tick(COMPANY);

    expect(h.unblocked).toEqual([CYCLE]);
    expect(h.advanced).toEqual([CYCLE]);
    expect(result.action).toBe('advanced');
    expect(result.nextPhase).toBe('score');
  });

  it('keeps the cycle blocked while the capability is genuinely unavailable', async () => {
    // The correct state when credentials really are missing. Recovery must not
    // be an unconditional clear, or "blocked" stops meaning anything.
    const h = harness({
      cycleStatus: 'blocked',
      evidenceCount: 0,
      opportunityCount: 0,
      webUsable: false,
      browserUsable: false,
    });

    const result = await h.loop.tick(COMPANY);

    expect(h.unblocked).toEqual([]);
    expect(result.action).toBe('blocked');
    expect(result.blockedOnCapability).toBe('research.browser_session' satisfies Capability);
    expect(h.blocked).toHaveLength(1);
    expect(h.dispatched).toEqual([]);
  });

  it('does not write an unblock on a cycle that was never blocked', async () => {
    const h = harness({
      cycleStatus: 'running',
      evidenceCount: 221,
      opportunityCount: 0,
      webUsable: true,
      browserUsable: true,
    });

    await h.loop.tick(COMPANY);

    expect(h.unblocked).toEqual([]);
  });
});
