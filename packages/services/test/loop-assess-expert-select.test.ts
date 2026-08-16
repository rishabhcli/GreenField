/**
 * expert_validate must not be pinned by review rows that can never complete.
 * Requesting a review moves the opportunity to `expert_review_requested`, so a
 * `scored`-only assessment goes blind after the drive step; `priced` is a live
 * Terac response proving the study is unfunded; an unanswered pricing request
 * past the deadline has shown no evidence Terac will ever respond. The escape
 * completes the phase with `performed: false` and the exact reason — it never
 * invents a verdict and never closes the review rows (the fakes here expose no
 * setStatus/setStage, so any write attempt fails the test). Select must then
 * accept the stage the caveat path leaves behind.
 */

import { describe, expect, it } from 'vitest';
import type { Capability } from '@foundry/core';
import type { ServiceDeps } from '../src/deps.js';
import { LoopOrchestrator } from '../src/loop/orchestrator.js';
import { TERAC_STUDY_BLOCKER } from '../src/org/prize-tracks.js';

const COMPANY = 'co_01M03F7RQW2M6540BY2GZHCFBW';
const HOUR_MS = 60 * 60 * 1000;
const CAVEAT = 'opportunity selection is unvalidated by human experts';

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

interface FakeOpportunity {
  readonly id: string;
  readonly stage: string;
}

interface FakeReview {
  readonly id: string;
  readonly status: string;
  readonly requested_at?: Date | null;
  readonly created_at?: Date | null;
}

function orchestrator(options: {
  readonly opportunities?: readonly FakeOpportunity[];
  readonly openReviews?: readonly FakeReview[];
  readonly expertUsable?: boolean;
  readonly selectedOpportunityId?: string | null;
}): LoopOrchestrator {
  const deps = {
    repos: {
      companies: {
        byId: async () => ({
          id: COMPANY,
          selected_opportunity_id: options.selectedOpportunityId ?? null,
          active_site_id: null,
        }),
      },
      research: {
        opportunities: {
          list: async (_companyId: string, stages: readonly string[]) =>
            (options.opportunities ?? []).filter((o) => stages.includes(o.stage)),
        },
        expertReviews: {
          listOpen: async () => options.openReviews ?? [],
        },
      },
    },
    capabilities: {
      resolveCapability: (capability: Capability) => cap(capability, options.expertUsable ?? true),
    },
  } as unknown as ServiceDeps;
  return new LoopOrchestrator(deps);
}

function requested(count: number): FakeOpportunity[] {
  return Array.from({ length: count }, (_, i) => ({ id: `opp_${i + 1}`, stage: 'expert_review_requested' }));
}

function reviews(count: number, status: string, requestedAt: Date | null): FakeReview[] {
  return Array.from({ length: count }, (_, i) => ({ id: `rev_${i + 1}`, status, requested_at: requestedAt }));
}

describe('assessExpertValidate deadlock escapes', () => {
  it('is not blind to candidates whose stage moved to expert_review_requested', async () => {
    const loop = orchestrator({
      opportunities: requested(16),
      openReviews: reviews(16, 'pricing_pending', new Date(Date.now() - 60_000)),
    });
    const assessment = await loop.assess(COMPANY, 'expert_validate');
    expect(assessment.detail).not.toMatch(/nothing to validate/i);
    expect(assessment.complete).toBe(false);
    expect(assessment.detail).toMatch(/still open/i);
  });

  it('completes with performed:false and the exact Terac blocker when every open review is priced', async () => {
    const loop = orchestrator({
      opportunities: requested(16),
      openReviews: reviews(16, 'priced', new Date(Date.now() - 10 * 60_000)),
    });
    const assessment = await loop.assess(COMPANY, 'expert_validate');
    expect(assessment.complete).toBe(true);
    expect(assessment.blockedOn).toBeUndefined();
    expect(assessment.outputs).toMatchObject({
      expert_validate: { performed: false, reason: TERAC_STUDY_BLOCKER, caveat: CAVEAT },
    });
  });

  it('stays incomplete while a pricing_pending review is fresher than the deadline', async () => {
    const loop = orchestrator({
      opportunities: requested(2),
      openReviews: reviews(2, 'pricing_pending', new Date(Date.now() - 59 * 60_000)),
    });
    const assessment = await loop.assess(COMPANY, 'expert_validate');
    expect(assessment.complete).toBe(false);
    expect(assessment.blockedOn).toBeUndefined();
    expect(assessment.detail).toMatch(/2 of 2 expert reviews still open/);
  });

  it('completes with performed:false once pricing_pending reviews outlive the deadline', async () => {
    const loop = orchestrator({
      opportunities: requested(16),
      openReviews: reviews(16, 'pricing_pending', new Date(Date.now() - 2 * HOUR_MS)),
    });
    const assessment = await loop.assess(COMPANY, 'expert_validate');
    expect(assessment.complete).toBe(true);
    const outputs = assessment.outputs?.['expert_validate'] as Record<string, unknown>;
    expect(outputs['performed']).toBe(false);
    expect(outputs['caveat']).toBe(CAVEAT);
    expect(outputs['reason']).toMatch(/did not respond to 16 feasibility pricing request\(s\) within 60 minutes/);
    expect(outputs['reason']).not.toBe(TERAC_STUDY_BLOCKER);
  });

  it('a completed review takes precedence: performed:true even while other reviews are open', async () => {
    const loop = orchestrator({
      opportunities: [{ id: 'opp_1', stage: 'expert_reviewed' }, ...requested(15)],
      openReviews: reviews(15, 'pricing_pending', new Date(Date.now() - 2 * HOUR_MS)),
    });
    const assessment = await loop.assess(COMPANY, 'expert_validate');
    expect(assessment.complete).toBe(true);
    expect(assessment.outputs).toMatchObject({
      expert_validate: { performed: true, reviewedOpportunities: 1 },
    });
  });

  it('prefers the proven funding blocker when priced and stale-pending reviews are mixed', async () => {
    const loop = orchestrator({
      opportunities: requested(3),
      openReviews: [
        ...reviews(1, 'priced', new Date(Date.now() - 2 * HOUR_MS)),
        ...reviews(2, 'pricing_pending', new Date(Date.now() - 2 * HOUR_MS)),
      ],
    });
    const assessment = await loop.assess(COMPANY, 'expert_validate');
    expect(assessment.complete).toBe(true);
    expect(assessment.outputs).toMatchObject({
      expert_validate: { performed: false, reason: TERAC_STUDY_BLOCKER },
    });
  });

  it('falls back to created_at when requested_at is null', async () => {
    const loop = orchestrator({
      opportunities: requested(1),
      openReviews: [
        { id: 'rev_1', status: 'pricing_pending', requested_at: null, created_at: new Date(Date.now() - 2 * HOUR_MS) },
      ],
    });
    const assessment = await loop.assess(COMPANY, 'expert_validate');
    expect(assessment.complete).toBe(true);
    expect(assessment.outputs).toMatchObject({ expert_validate: { performed: false } });
  });

  it('treats a review with no readable timestamp as still progressing', async () => {
    const loop = orchestrator({
      opportunities: requested(1),
      openReviews: [{ id: 'rev_1', status: 'pricing_pending', requested_at: null, created_at: null }],
    });
    const assessment = await loop.assess(COMPANY, 'expert_validate');
    expect(assessment.complete).toBe(false);
  });

  it('keeps waiting on a launched study no matter how old: engagement is not silence', async () => {
    const loop = orchestrator({
      opportunities: requested(1),
      openReviews: reviews(1, 'launched', new Date(Date.now() - 20 * HOUR_MS)),
    });
    const assessment = await loop.assess(COMPANY, 'expert_validate');
    expect(assessment.complete).toBe(false);
    expect(assessment.detail).toMatch(/still open/i);
  });

  it('still completes with the remediation reason when the capability itself is unusable', async () => {
    const loop = orchestrator({
      opportunities: requested(4),
      openReviews: reviews(4, 'pricing_pending', new Date(Date.now() - 60_000)),
      expertUsable: false,
    });
    const assessment = await loop.assess(COMPANY, 'expert_validate');
    expect(assessment.complete).toBe(true);
    expect(assessment.outputs).toMatchObject({
      expert_validate: { performed: false, reason: expect.stringMatching(/blocked/), caveat: CAVEAT },
    });
  });
});

describe('assessSelect stage acceptance', () => {
  it('accepts candidates at stage expert_review_requested left behind by the caveat path', async () => {
    const loop = orchestrator({ opportunities: requested(16) });
    const assessment = await loop.assess(COMPANY, 'select');
    expect(assessment.complete).toBe(false);
    expect(assessment.detail).toMatch(/awaiting the CEO selection decision/);
    expect(assessment.detail).not.toMatch(/no opportunity passed/);
  });

  it('reports no candidates when nothing is in a selectable stage', async () => {
    const loop = orchestrator({ opportunities: [{ id: 'opp_1', stage: 'killed' }] });
    const assessment = await loop.assess(COMPANY, 'select');
    expect(assessment.complete).toBe(false);
    expect(assessment.detail).toMatch(/no opportunity passed the selection gates/);
  });

  it('completes once an opportunity has been selected', async () => {
    const loop = orchestrator({ opportunities: requested(16), selectedOpportunityId: 'opp_7' });
    const assessment = await loop.assess(COMPANY, 'select');
    expect(assessment.complete).toBe(true);
    expect(assessment.outputs).toMatchObject({ select: { opportunityId: 'opp_7' } });
  });
});
