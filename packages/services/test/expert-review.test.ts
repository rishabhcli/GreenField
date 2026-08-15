/**
 * Terac expert_validate path: request → poll → webhook ingest → assessment.
 * Missing capability and $0 credit are blocked, never thrown, never invented.
 */

import { describe, expect, it } from 'vitest';
import { CredentialsMissingError, ValidationError } from '@foundry/core';
import type { ServiceDeps } from '../src/deps.js';
import {
  ExpertReviewService,
  expertJobOutcome,
  type ExpertValidateAssessment,
} from '../src/research/expert.js';

const COMPANY = 'co_01M03F7RQW2M6540BY2GZHCFBW';
const QUESTION = 'Would you buy this candle at $24, and what would stop you?';

const UNFUNDED = 'Insufficient balance. Required: $200.00, Available: $0.00.';

function reviewStore() {
  const rows = new Map<string, Record<string, unknown>>();
  const submissions = new Map<string, Record<string, unknown>[]>();
  let seq = 0;
  const stages: { id: string; stage: string }[] = [];

  const expertReviews = {
    create: async (input: {
      companyId: string;
      subject: string;
      subjectRefId: string;
      provider: string;
      question: string;
      rubric: readonly Record<string, unknown>[];
      participantsRequested: number;
    }) => {
      const row = {
        id: `rev_${++seq}`,
        company_id: input.companyId,
        subject: input.subject,
        subject_ref_id: input.subjectRefId,
        provider: input.provider,
        external_engagement_id: null as string | null,
        external_request_id: null as string | null,
        status: 'requested',
        question: input.question,
        rubric: input.rubric,
        participants_requested: input.participantsRequested,
        cost_per_participant_minor: null as number | null,
        currency: null as string | null,
        verdict: 'pending',
        mean_scores: {},
      };
      rows.set(row.id, row);
      return row;
    },
    setExternalIds: async (id: string, refs: { engagementId?: string | null; requestId?: string | null }) => {
      const row = rows.get(id)!;
      if (refs.engagementId) row['external_engagement_id'] = refs.engagementId;
      if (refs.requestId) row['external_request_id'] = refs.requestId;
    },
    setStatus: async (id: string, status: string, cost?: number | null, currency?: string | null) => {
      const row = rows.get(id)!;
      row['status'] = status;
      if (cost !== undefined && cost !== null) row['cost_per_participant_minor'] = cost;
      if (currency !== undefined && currency !== null) row['currency'] = currency;
    },
    setVerdict: async (id: string, verdict: string, meanScores: Record<string, number>) => {
      const row = rows.get(id)!;
      row['verdict'] = verdict;
      row['mean_scores'] = meanScores;
      row['status'] = 'completed';
    },
    byId: async (id: string) => rows.get(id)!,
    listOpen: async (companyId: string) =>
      [...rows.values()].filter(
        (row) =>
          row['company_id'] === companyId &&
          !['completed', 'cancelled', 'failed'].includes(String(row['status'])),
      ),
    completedFor: async (companyId: string, subject: string, subjectRefId: string) =>
      [...rows.values()].find(
        (row) =>
          row['company_id'] === companyId &&
          row['subject'] === subject &&
          row['subject_ref_id'] === subjectRefId &&
          row['status'] === 'completed',
      ),
    recordSubmission: async (input: {
      expertReviewId: string;
      externalSubmissionId: string;
      expertRef: string;
      critique: string;
    }) => {
      const list = submissions.get(input.expertReviewId) ?? [];
      if (list.some((row) => row['external_submission_id'] === input.externalSubmissionId)) return false;
      list.push({
        external_submission_id: input.externalSubmissionId,
        expert_ref: input.expertRef,
        critique: input.critique,
      });
      submissions.set(input.expertReviewId, list);
      return true;
    },
    submissions: async (id: string) => submissions.get(id) ?? [],
  };

  return {
    rows,
    submissions,
    stages,
    expertReviews,
    opportunities: {
      list: async (_companyId: string, wanted?: readonly string[]) => {
        const ids = [...rows.values()].map((row) => ({
          id: String(row['subject_ref_id']),
          title: 'Test opportunity',
          concept: 'test',
          stage: stages.find((s) => s.id === row['subject_ref_id'])?.stage ?? 'scored',
        }));
        const unique = [...new Map(ids.map((o) => [o.id, o])).values()];
        return wanted ? unique.filter((o) => wanted.includes(o.stage)) : unique;
      },
      setStage: async (id: string, stage: string) => {
        stages.push({ id, stage });
      },
      latestScorecard: async () => null,
    },
  };
}

function deps(options: {
  readonly adapter?: unknown;
  readonly missing?: boolean;
  readonly store?: ReturnType<typeof reviewStore>;
  readonly capUsable?: boolean;
}): { deps: ServiceDeps; store: ReturnType<typeof reviewStore> } {
  const store = options.store ?? reviewStore();
  const missing = options.missing === true;
  return {
    store,
    deps: {
      publicBaseUrl: 'https://foundry-api.example.test',
      environment: 'preview',
      repos: {
        research: {
          expertReviews: store.expertReviews,
          opportunities: store.opportunities,
        },
        companies: {
          list: async () => [{ id: COMPANY }],
        },
      },
      providers: {
        forCapability: () =>
          missing
            ? {
                adapter: undefined,
                status: {
                  state: 'blocked_missing_credentials',
                  provider: 'terac',
                  missingSecrets: ['TERAC_API_KEY'],
                  remediation: 'TERAC_API_KEY is not set',
                },
              }
            : {
                adapter: options.adapter,
                status: { state: 'configured_unverified', provider: 'terac', missingSecrets: [] },
              },
        adapter: () => undefined,
      },
      capabilities: {
        resolveCapability: () => ({
          capability: 'expert.structured_review',
          provider: 'terac',
          state: missing || options.capUsable === false ? 'blocked_missing_credentials' : 'configured_unverified',
          usable: missing ? false : options.capUsable !== false,
          remediation: missing || options.capUsable === false ? 'TERAC_API_KEY is not set' : null,
          missingSecrets: missing ? ['TERAC_API_KEY'] : [],
        }),
      },
    } as unknown as ServiceDeps,
  };
}

const restAdapter = {
  launchGeneralPopulationStudy: async () => {
    throw new Error('MCP unavailable in this test; REST path should continue');
  },
  requestFeasibility: async () => ({ id: 'feas_1', status: 'RESPONDED' as const }),
  getFeasibilityRequest: async () => ({ id: 'feas_1', status: 'RESPONDED' as const }),
  getOpportunity: async (id: string) => ({
    id,
    status: id.includes('draft') ? 'draft' : 'in_progress',
    num_participants: 5,
  }),
  listOpportunities: async () => ({ data: [], pagination: { next_cursor: null, has_more: false } }),
  listProjects: async () => ({
    data: [{ id: 'proj_1', name: 'Foundry General Population product feedback' }],
    pagination: { next_cursor: null, has_more: false },
  }),
  createOpportunity: async () => ({
    id: 'opp_draft_1',
    status: 'draft',
    num_participants: 5,
    cost_per_participant_minor: 4000,
    currency: 'usd',
  }),
  launchDraftOpportunity: async () => {
    throw new ValidationError(UNFUNDED, { teracLaunchBlocked: true });
  },
  listSubmissions: async () => ({ data: [], pagination: { next_cursor: null, has_more: false } }),
};

describe('missing capability returns blocked, never throw', () => {
  it('requestReview returns blockedOn when TERAC_API_KEY is missing', async () => {
    const { deps: d } = deps({ missing: true });
    const service = new ExpertReviewService(d);
    const result = await service.requestReview({
      companyId: COMPANY,
      subject: 'opportunity_validity',
      subjectRefId: 'opp_1',
      question: QUESTION,
      rubric: [],
      participantsRequested: 5,
    });
    expect(result.blockedOn?.capability).toBe('expert.structured_review');
    expect(result.blockedOn?.reason).toMatch(/TERAC_API_KEY/);
    expect(result.reviewId).toBeTruthy();
  });

  it('poll returns blockedOn and the job outcome is blocked, not thrown', async () => {
    const store = reviewStore();
    const row = await store.expertReviews.create({
      companyId: COMPANY,
      subject: 'opportunity_validity',
      subjectRefId: 'opp_1',
      provider: 'terac',
      question: QUESTION,
      rubric: [],
      participantsRequested: 5,
    });
    await store.expertReviews.setExternalIds(row.id, { engagementId: 'opp_live' });
    const { deps: d } = deps({ missing: true, store });
    const service = new ExpertReviewService(d);
    const result = await service.poll(row.id);
    expect(result.ok).toBe(false);
    expect(result.blockedOn?.capability).toBe('expert.structured_review');
    const job = expertJobOutcome(result);
    expect(job).toMatchObject({
      status: 'blocked',
      capability: 'expert.structured_review',
    });
    expect(() => {
      if ('status' in job && job.status === 'blocked') return;
      throw new CredentialsMissingError('terac', ['TERAC_API_KEY']);
    }).not.toThrow();
  });
});

describe('$0-credit launch stays blocked', () => {
  it('does not treat an unfunded draft as launched panel results', async () => {
    const { deps: d, store } = deps({ adapter: restAdapter });
    const service = new ExpertReviewService(d);
    const result = await service.requestReview({
      companyId: COMPANY,
      subject: 'opportunity_validity',
      subjectRefId: 'opp_1',
      question: QUESTION,
      rubric: [],
      participantsRequested: 5,
    });
    expect(result.blockedOn?.capability).toBe('expert.structured_review');
    expect(result.blockedOn?.reason).toMatch(/Available: \$0\.00|insufficient balance/i);
    expect(result.externalEngagementId).toBe('opp_draft_1');
    const row = await store.expertReviews.byId(result.reviewId!);
    expect(row['status']).toBe('priced');
    expect(row['verdict']).toBe('pending');
  });

  it('polls feasibility RECEIVED without launching', async () => {
    const store = reviewStore();
    const row = await store.expertReviews.create({
      companyId: COMPANY,
      subject: 'opportunity_validity',
      subjectRefId: 'opp_1',
      provider: 'terac',
      question: QUESTION,
      rubric: [],
      participantsRequested: 5,
    });
    await store.expertReviews.setExternalIds(row.id, { requestId: 'feas_pending' });
    let launched = false;
    const adapter = {
      ...restAdapter,
      getFeasibilityRequest: async () => ({ id: 'feas_pending', status: 'RECEIVED' as const }),
      launchDraftOpportunity: async () => {
        launched = true;
        throw new Error('must not launch before RESPONDED');
      },
    };
    const { deps: d } = deps({ adapter, store });
    const result = await new ExpertReviewService(d).poll(row.id);
    expect(launched).toBe(false);
    expect(result.status).toBe('pricing_pending');
    expect(result.blockedOn).toBeUndefined();
  });
});

describe('reject-one → rejected', () => {
  const rejectSubmission = {
    id: 'sub_reject_1',
    opportunity_id: 'opp_live_1',
    expert_ref: 'expert_9',
    critique: 'I would not buy this. The pain is not real.',
    recommendation: 'reject',
    approved: true,
    submitted_at: '2026-08-15T12:00:00.000Z',
    scores: { demand_evidence_strength: 1 },
    attestations: ['identity_verified'],
    suggested_changes: [],
  };

  it('poll records a complete reject and sets verdict rejected', async () => {
    const store = reviewStore();
    const row = await store.expertReviews.create({
      companyId: COMPANY,
      subject: 'opportunity_validity',
      subjectRefId: 'opp_1',
      provider: 'terac',
      question: QUESTION,
      rubric: [],
      participantsRequested: 5,
    });
    await store.expertReviews.setExternalIds(row.id, { engagementId: 'opp_live_1' });
    const adapter = {
      ...restAdapter,
      listSubmissions: async () => ({
        data: [rejectSubmission],
        pagination: { next_cursor: null, has_more: false },
      }),
    };
    const { deps: d } = deps({ adapter, store });
    const result = await new ExpertReviewService(d).poll(row.id);
    expect(result.verdict).toBe('rejected');
    expect(result.status).toBe('completed');
    const stored = await store.expertReviews.byId(row.id);
    expect(stored['verdict']).toBe('rejected');
    expect(store.submissions.get(row.id)).toHaveLength(1);
  });

  it('skips a submission that has no critique rather than inventing one', async () => {
    const store = reviewStore();
    const row = await store.expertReviews.create({
      companyId: COMPANY,
      subject: 'opportunity_validity',
      subjectRefId: 'opp_1',
      provider: 'terac',
      question: QUESTION,
      rubric: [],
      participantsRequested: 5,
    });
    await store.expertReviews.setExternalIds(row.id, { engagementId: 'opp_live_1' });
    const adapter = {
      ...restAdapter,
      listSubmissions: async () => ({
        data: [
          {
            id: 'sub_incomplete',
            opportunity_id: 'opp_live_1',
            expert_ref: 'expert_9',
            submitted_at: '2026-08-15T12:00:00.000Z',
            scores: {},
            attestations: [],
            suggested_changes: [],
          },
        ],
        pagination: { next_cursor: null, has_more: false },
      }),
    };
    const { deps: d } = deps({ adapter, store });
    const result = await new ExpertReviewService(d).poll(row.id);
    expect(result.verdict).toBeUndefined();
    expect(result.status).toBe('submissions_received');
    expect(store.submissions.get(row.id) ?? []).toHaveLength(0);
    const stored = await store.expertReviews.byId(row.id);
    expect(stored['verdict']).toBe('pending');
  });
});

describe('webhook ingest', () => {
  it('ingests via webhook by polling the named opportunity, then reject-one is rejected', async () => {
    const store = reviewStore();
    const row = await store.expertReviews.create({
      companyId: COMPANY,
      subject: 'opportunity_validity',
      subjectRefId: 'opp_1',
      provider: 'terac',
      question: QUESTION,
      rubric: [],
      participantsRequested: 5,
    });
    await store.expertReviews.setExternalIds(row.id, { engagementId: 'opp_live_1' });
    const adapter = {
      ...restAdapter,
      listSubmissions: async () => ({
        data: [
          {
            id: 'sub_reject_1',
            opportunity_id: 'opp_live_1',
            expert_ref: 'expert_9',
            critique: 'Reject: I would not buy this.',
            recommendation: 'reject',
            approved: true,
            submitted_at: '2026-08-15T12:00:00.000Z',
            scores: { demand_evidence_strength: 1 },
            attestations: [],
            suggested_changes: [],
          },
        ],
        pagination: { next_cursor: null, has_more: false },
      }),
    };
    const { deps: d } = deps({ adapter, store });
    const service = new ExpertReviewService(d);
    const ingested = await service.ingestWebhook({
      event_type: 'submission.status.change',
      opportunity_id: 'opp_live_1',
    });
    expect(ingested.verdict).toBe('rejected');
    expect(ingested.status).toBe('completed');
  });

  it('does not invent a review when the webhook names an unknown opportunity', async () => {
    const { deps: d, store } = deps({ adapter: restAdapter });
    const ingested = await new ExpertReviewService(d).ingestWebhook({
      event_type: 'submission.status.change',
      opportunity_id: 'opp_unknown',
    });
    expect(ingested.ok).toBe(false);
    expect(ingested.blockedOn?.reason).toMatch(/no open expert review/i);
    expect(store.rows.size).toBe(0);
  });
});

describe('assessForLoop re-derives from the artefact', () => {
  it('a completed reject artefact makes expert_validate rejected, not an invented pass', async () => {
    const store = reviewStore();
    const row = await store.expertReviews.create({
      companyId: COMPANY,
      subject: 'opportunity_validity',
      subjectRefId: 'opp_1',
      provider: 'terac',
      question: QUESTION,
      rubric: [],
      participantsRequested: 5,
    });
    await store.expertReviews.setVerdict(row.id, 'rejected', { demand_evidence_strength: 1 });
    await store.opportunities.setStage('opp_1', 'killed');
    const { deps: d } = deps({ adapter: restAdapter, store, capUsable: true });
    const assessment: ExpertValidateAssessment = await new ExpertReviewService(d).assessForLoop(COMPANY);
    expect(assessment.complete).toBe(true);
    expect(assessment.performed).toBe(true);
    expect(assessment.verdict).toBe('rejected');
    expect(assessment.verdict).not.toBe('approved');
  });

  it('an unfunded priced review keeps the phase blocked rather than complete', async () => {
    const store = reviewStore();
    const row = await store.expertReviews.create({
      companyId: COMPANY,
      subject: 'opportunity_validity',
      subjectRefId: 'opp_1',
      provider: 'terac',
      question: QUESTION,
      rubric: [],
      participantsRequested: 5,
    });
    await store.expertReviews.setExternalIds(row.id, { engagementId: 'opp_draft_1' });
    await store.expertReviews.setStatus(row.id, 'priced');
    const { deps: d } = deps({ adapter: restAdapter, store, capUsable: true });
    const assessment = await new ExpertReviewService(d).assessForLoop(COMPANY);
    expect(assessment.complete).toBe(false);
    expect(assessment.performed).toBe(false);
    expect(assessment.blockedOn?.capability).toBe('expert.structured_review');
    expect(assessment.blockedOn?.reason).toMatch(/\$0|credit|unfunded|priced/i);
  });
});
