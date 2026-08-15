/**
 * Build-phase honesty: a spec_drafted site is not a built storefront, and the
 * commerce manager owns site.create_spec — not engineering.
 */

import { describe, expect, it } from 'vitest';
import type { Capability, LoopPhase } from '@foundry/core';
import type { ServiceDeps } from '../src/deps.js';
import { LoopOrchestrator } from '../src/loop/orchestrator.js';

const COMPANY = 'co_01M03F7RQW2M6540BY2GZHCFBW';
const CYCLE = 'cyc_01BUILDTEST00000000000000';
const SITE = 'site_01BUILDTEST0000000000000';

function cap(capability: Capability, usable: boolean) {
  return {
    capability,
    provider: 'test',
    state: usable ? 'live_verified' : 'blocked_missing_credentials',
    usable,
    evidence: null,
    remediation: `${capability} blocked`,
    missingSecrets: usable ? [] : ['KEY'],
    lastVerifiedAt: null,
    alternatives: [],
  };
}

interface BuildHarness {
  readonly loop: LoopOrchestrator;
  readonly dispatched: Array<{ toRoleKey: string }>;
  readonly enqueued: Array<{ queue: string; payload: Record<string, unknown> }>;
  readonly setPhaseCalls: string[];
}

function buildHarness(options: {
  readonly activeSiteId?: string | null;
  readonly siteStatus?: string;
  readonly succeededBuild?: boolean;
  readonly siteGenerateUsable?: boolean;
  readonly evidenceCount?: number;
  readonly killSwitch?: boolean;
  readonly cyclePhase?: LoopPhase;
}): BuildHarness {
  const dispatched: Array<{ toRoleKey: string }> = [];
  const enqueued: Array<{ queue: string; payload: Record<string, unknown> }> = [];
  const setPhaseCalls: string[] = [];
  const cycle = {
    id: CYCLE,
    cycle_number: 1,
    phase: options.cyclePhase ?? 'build',
    status: 'running',
    ceo_decision: null,
  };

  const deps = {
    repos: {
      pool: {
        connect: async () => ({
          query: async (sql: string) => {
            if (String(sql).includes('pg_try_advisory_lock')) {
              return { rows: [{ pg_try_advisory_lock: true }] };
            }
            return { rows: [] };
          },
          release: () => undefined,
        }),
      },
      companies: {
        byId: async () => ({
          id: COMPANY,
          active_site_id: options.activeSiteId ?? null,
          selected_opportunity_id: null,
        }),
      },
      loop: {
        currentOrStart: async () => cycle,
        setPhase: async (_id: string, phase: LoopPhase) => {
          setPhaseCalls.push(phase);
          cycle.phase = phase;
        },
        unblock: async () => undefined,
        block: async () => undefined,
        advance: async () => ({ cycle: { ...cycle, phase: 'qa' }, wrapped: false }),
      },
      governance: {
        killSwitches: { engagedScopes: async () => (options.killSwitch ? ['all'] : []) },
      },
      build: {
        sites: {
          byId: async () => ({
            id: SITE,
            status: options.siteStatus ?? 'spec_drafted',
            hosting_service_id: null,
          }),
          latestSucceededBuild: async () =>
            options.succeededBuild ? { id: 'sbl_1', status: 'succeeded' } : undefined,
        },
      },
      research: {
        evidence: {
          search: async () =>
            Array.from({ length: options.evidenceCount ?? 0 }, (_, i) => ({ id: `ev_${i + 1}` })),
        },
      },
      commerce: {
        orders: {
          listByStatus: async () => [],
        },
      },
    },
    capabilities: {
      summary: () => ({ usable: [], blocked: [] }),
      resolveCapability: (capability: Capability) => cap(capability, options.siteGenerateUsable ?? true),
    },
    dispatcher: {
      dispatch: async (input: { toRoleKey: string }) => {
        dispatched.push(input);
      },
      enqueueSystem: async (input: { toRoleKey: string }) => {
        dispatched.push(input);
      },
    },
    queues: {
      enqueue: async (queue: string, payload: Record<string, unknown>) => {
        enqueued.push({ queue, payload });
        return `${queue}.job`;
      },
    },
  } as unknown as ServiceDeps;

  return { loop: new LoopOrchestrator(deps), dispatched, enqueued, setPhaseCalls };
}

describe('assessBuild', () => {
  it('does not complete when active_site_id is set but the site is only spec_drafted', async () => {
    const { loop } = buildHarness({ activeSiteId: SITE, siteStatus: 'spec_drafted' });
    const assessment = await loop.assess(COMPANY, 'build');
    expect(assessment.complete).toBe(false);
    expect(assessment.detail).toMatch(/spec_drafted|waiting|in progress/i);
  });

  it('completes when the site status is generated', async () => {
    const { loop } = buildHarness({ activeSiteId: SITE, siteStatus: 'generated' });
    const assessment = await loop.assess(COMPANY, 'build');
    expect(assessment.complete).toBe(true);
    expect(assessment.outputs).toMatchObject({ build: { siteId: SITE } });
  });

  it('completes when a succeeded build row exists even if status is still generating', async () => {
    const { loop } = buildHarness({
      activeSiteId: SITE,
      siteStatus: 'generating',
      succeededBuild: true,
    });
    const assessment = await loop.assess(COMPANY, 'build');
    expect(assessment.complete).toBe(true);
  });
});

describe('drive build', () => {
  it('dispatches commerce_manager, not engineering_manager, when no site exists', async () => {
    const { loop, dispatched } = buildHarness({ activeSiteId: null });
    await loop.drive(COMPANY, CYCLE, 'build');
    expect(dispatched.map((d) => d.toRoleKey)).toEqual(['commerce_manager']);
    expect(dispatched.map((d) => d.toRoleKey)).not.toContain('engineering_manager');
  });

  it('enqueues a preview site.deploy once the site is generatable', async () => {
    const { loop, enqueued } = buildHarness({ activeSiteId: SITE, siteStatus: 'generated' });
    await loop.drive(COMPANY, CYCLE, 'build');
    const preview = enqueued.find((job) => job.queue === 'site.deploy');
    expect(preview).toBeDefined();
    expect(preview?.payload).toMatchObject({
      siteId: SITE,
      environment: 'preview',
      idempotencyKey: `${CYCLE}:build:preview`,
    });
  });
});

describe('drive discover clustering', () => {
  it('enqueues research.cluster after evidence exists so opportunities do not wait on the agent tool', async () => {
    const { loop, enqueued } = buildHarness({ evidenceCount: 2, cyclePhase: 'discover' });
    await loop.drive(COMPANY, CYCLE, 'discover');
    const cluster = enqueued.find((job) => job.queue === 'research.cluster');
    expect(cluster).toBeDefined();
    expect(cluster?.payload.idempotencyKey).toBe(`${CYCLE}:discover:cluster`);
  });
});

describe('forcePhase', () => {
  it('sets the cycle phase under the tick lock before assessing', async () => {
    const { loop, setPhaseCalls } = buildHarness({
      cyclePhase: 'observe',
      activeSiteId: SITE,
      siteStatus: 'spec_drafted',
      siteGenerateUsable: true,
    });
    const result = await loop.tick(COMPANY, { forcePhase: 'build' });
    expect(setPhaseCalls).toEqual(['build']);
    expect(result.phase).toBe('build');
    expect(result.action).not.toBe('skipped_locked');
  });
});
