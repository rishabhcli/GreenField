/**
 * Expert structured review via Terac.
 *
 * If `expert.structured_review` is not usable, this service returns
 * `blockedOn` rather than inventing a verdict. Submissions are recorded only
 * when the provider actually returned a critique, expert identity, and
 * timestamp — the same refusal `toExpertReview` enforces.
 */

import {
  CapabilityUnsupportedError,
  CredentialsMissingError,
  ExpertReviewSubject,
  VendorApprovalRequiredError,
  type Capability,
} from '@foundry/core';
import {
  TeracAdapter,
  buildReviewRubric,
  toExpertReview,
  type TeracOpportunity,
  type TeracSubmission,
} from '@foundry/providers';
import { requireCapability, type ServiceDeps } from '../deps.js';
import { getLogger } from '@foundry/obs';

export interface RequestReviewInput {
  readonly companyId: string;
  readonly subject: string;
  readonly subjectRefId: string;
  readonly question: string;
  readonly rubric: readonly Record<string, unknown>[];
  readonly participantsRequested: number;
}

export interface RequestReviewResult {
  readonly reviewId?: string;
  readonly externalEngagementId?: string | null;
  readonly externalRequestId?: string | null;
  readonly blockedOn?: { capability: Capability; reason: string };
}

export interface PollReviewInput {
  readonly expertReviewId: string;
}

export interface ExpertPollResult {
  readonly ok: boolean;
  readonly reviewId: string;
  readonly status: string;
  readonly verdict?: string;
  readonly blockedOn?: { capability: Capability; reason: string };
}

export class ExpertReviewService {
  constructor(private readonly deps: ServiceDeps) {}

  /**
   * Compatibility wrapper used by marketing creative review.
   * Prefer `requestReview` for the full rubric/participants contract.
   */
  async request(input: {
    readonly companyId: string;
    readonly subjectRefId: string;
    readonly subject: string;
    readonly question: string;
    readonly participantsRequested?: number;
  }): Promise<RequestReviewResult & { ok: boolean }> {
    const parsedSubject = ExpertReviewSubject.safeParse(input.subject);
    const built = parsedSubject.success ? buildReviewRubric(parsedSubject.data) : undefined;
    const result = await this.requestReview({
      companyId: input.companyId,
      subject: input.subject,
      subjectRefId: input.subjectRefId,
      question: input.question,
      rubric: built
        ? built.rubric.map((item) => ({ key: item.key, prompt: item.prompt, scale: item.scale }))
        : [],
      participantsRequested: input.participantsRequested ?? 5,
    });
    return { ...result, ok: result.blockedOn === undefined };
  }

  async requestReview(input: RequestReviewInput): Promise<RequestReviewResult> {
    const row = await this.deps.repos.research.expertReviews.create({
      companyId: input.companyId,
      subject: input.subject,
      subjectRefId: input.subjectRefId,
      provider: 'terac',
      question: input.question,
      rubric: input.rubric,
      participantsRequested: input.participantsRequested,
    });

    let terac: TeracAdapter;
    try {
      terac = requireCapability<TeracAdapter>(this.deps, 'expert.structured_review').adapter;
    } catch (error) {
      const blocked = blockedFrom(error, 'expert.structured_review');
      if (blocked) return { reviewId: row.id, blockedOn: blocked };
      throw error;
    }

    const parsedSubject = ExpertReviewSubject.safeParse(input.subject);
    const built = parsedSubject.success ? buildReviewRubric(parsedSubject.data) : undefined;

    try {
      try {
        const mcp = await terac.launchGeneralPopulationStudy({
          role: 'General Population reviewer',
          task: input.question,
          count: input.participantsRequested,
        });
        getLogger().info({ tool: mcp.tool }, 'Terac MCP feasibility requested for General Population');
      } catch (mcpError) {
        getLogger().warn({ err: mcpError }, 'Terac MCP launch failed; continuing with REST feasibility');
      }

      const feasibility = await terac.requestFeasibility({
        taskDescription: input.question,
        panelDescription: built?.screeningQuestions.join('\n') || input.question,
        submissionCount: input.participantsRequested,
      });
      await this.deps.repos.research.expertReviews.setExternalIds(row.id, { requestId: feasibility.id });

      if (feasibility.status === 'RESPONDED') {
        const engagementId = await this.#launchOpportunity(
          terac,
          row.id,
          input,
          built,
          feasibility.id,
        );
        if (isOpportunitySubject(input.subject)) {
          await this.deps.repos.research.opportunities.setStage(input.subjectRefId, 'expert_review_requested');
        }
        return {
          reviewId: row.id,
          externalEngagementId: engagementId,
          externalRequestId: feasibility.id,
        };
      }

      if (isOpportunitySubject(input.subject)) {
        await this.deps.repos.research.opportunities.setStage(input.subjectRefId, 'expert_review_requested');
      }
      return { reviewId: row.id, externalRequestId: feasibility.id, externalEngagementId: null };
    } catch (error) {
      await this.deps.repos.research.expertReviews.setStatus(row.id, 'failed');
      const blocked = blockedFrom(error, 'expert.structured_review');
      if (blocked) return { reviewId: row.id, blockedOn: blocked };
      throw error;
    }
  }

  async poll(input: PollReviewInput | string): Promise<ExpertPollResult> {
    const expertReviewId = typeof input === 'string' ? input : input.expertReviewId;
    const row = await this.deps.repos.research.expertReviews.byId(expertReviewId);

    if (!row.external_engagement_id && !row.external_request_id) {
      return {
        ok: false,
        reviewId: row.id,
        status: row.status,
        blockedOn: {
          capability: 'expert.structured_review',
          reason: 'Expert review has no Terac engagement or feasibility request id to poll.',
        },
      };
    }

    let terac: TeracAdapter;
    try {
      terac = requireCapability<TeracAdapter>(this.deps, 'expert.structured_review').adapter;
    } catch (error) {
      const blocked = blockedFrom(error, 'expert.structured_review');
      if (blocked) {
        return { ok: false, reviewId: expertReviewId, status: row.status, blockedOn: blocked };
      }
      throw error;
    }

    try {
      if (!row.external_engagement_id) {
        const feasibility = await terac.getFeasibilityRequest(row.external_request_id!);
        if (feasibility.status !== 'RESPONDED') {
          await this.deps.repos.research.expertReviews.setStatus(row.id, 'pricing_pending');
          return { ok: true, reviewId: row.id, status: 'pricing_pending' };
        }
        await this.deps.repos.research.expertReviews.setStatus(row.id, 'priced');
        const parsedSubject = ExpertReviewSubject.safeParse(row.subject);
        await this.#launchOpportunity(
          terac,
          row.id,
          {
            companyId: row.company_id,
            subject: row.subject,
            subjectRefId: row.subject_ref_id,
            question: row.question,
            rubric: row.rubric,
            participantsRequested: row.participants_requested,
          },
          parsedSubject.success ? buildReviewRubric(parsedSubject.data) : undefined,
          row.external_request_id ?? undefined,
        );
        return { ok: true, reviewId: row.id, status: 'launched' };
      }

      const page = await terac.listSubmissions(row.external_engagement_id, { limit: 100 });
      for (const submission of page.data) {
        await this.#recordIfComplete(row.id, submission);
      }

      const recorded = await this.deps.repos.research.expertReviews.submissions(row.id);
      if (recorded.length === 0) {
        const status = page.data.length > 0 ? 'submissions_received' : 'in_progress';
        await this.deps.repos.research.expertReviews.setStatus(row.id, status);
        return { ok: true, reviewId: row.id, status };
      }

      const complete = page.data.filter(isCompleteSubmission);
      if (complete.length === 0) {
        await this.deps.repos.research.expertReviews.setStatus(row.id, 'submissions_received');
        return { ok: true, reviewId: row.id, status: 'submissions_received' };
      }

      const opportunity = {
        id: row.external_engagement_id,
        num_participants: row.participants_requested,
        status: 'in_progress',
        cost_per_participant_minor: row.cost_per_participant_minor,
        currency: row.currency,
      } as TeracOpportunity;

      const derived = toExpertReview(opportunity, complete);
      if (derived.verdict === 'pending') {
        await this.deps.repos.research.expertReviews.setStatus(
          row.id,
          derived.status,
          derived.costPerParticipantMinor,
          derived.currency,
        );
        return { ok: true, reviewId: row.id, status: derived.status };
      }

      await this.deps.repos.research.expertReviews.setVerdict(row.id, derived.verdict, derived.meanScores);
      if (isOpportunitySubject(row.subject)) {
        await this.deps.repos.research.opportunities.setStage(row.subject_ref_id, 'expert_reviewed');
      }
      return { ok: true, reviewId: row.id, status: 'completed', verdict: derived.verdict };
    } catch (error) {
      const blocked = blockedFrom(error, 'expert.structured_review');
      if (blocked) {
        return { ok: false, reviewId: expertReviewId, status: row.status, blockedOn: blocked };
      }
      throw error;
    }
  }

  async #launchOpportunity(
    terac: TeracAdapter,
    reviewId: string,
    input: RequestReviewInput,
    rubric: ReturnType<typeof buildReviewRubric> | undefined,
    feasibilityRequestId?: string,
  ): Promise<string> {
    const projects = await terac.listProjects({ limit: 1 });
    const projectId = projects.data[0]?.id;
    if (!projectId) {
      await this.deps.repos.research.expertReviews.setStatus(reviewId, 'failed');
      throw new CapabilityUnsupportedError(
        'terac',
        'expert.structured_review',
        'Terac returned no projects; create a project in the Terac dashboard before launching a review.',
      );
    }

    const created = await terac.createOpportunity({
      title: input.question.slice(0, 200),
      projectId,
      numParticipants: input.participantsRequested,
      businessType: 'b2c',
      description: input.question.slice(0, 5000),
      screeningQuestions: rubric ? [...rubric.screeningQuestions] : [],
      feasibilityRequestId,
      tasks: [
        {
          sequence: 1,
          taskType: 'review',
          reviewType: input.subject,
          taskUrl: new URL(`/expert-reviews/${reviewId}`, this.deps.publicBaseUrl).toString(),
          durationMinutes: 20,
        },
      ],
    });

    await this.deps.repos.research.expertReviews.setExternalIds(reviewId, { engagementId: created.id });
    await this.deps.repos.research.expertReviews.setStatus(
      reviewId,
      'launched',
      created.cost_per_participant_minor ?? null,
      created.currency ?? null,
    );
    return created.id;
  }

  async #recordIfComplete(expertReviewId: string, submission: TeracSubmission): Promise<void> {
    const critique = submission.critique ?? submission.feedback;
    const expertRef = submission.expert_ref ?? submission.worker_id ?? submission.respondent_id;
    const submittedAt = submission.submitted_at ?? submission.created_at;
    if (!critique || !expertRef || !submittedAt) return;

    await this.deps.repos.research.expertReviews.recordSubmission({
      expertReviewId,
      externalSubmissionId: submission.id,
      expertRef,
      attestations: submission.attestations,
      scores: submission.scores,
      critique,
      recommendation: normaliseRecommendation(submission.recommendation),
      suggestedChanges:
        submission.suggested_changes.length > 0 ? submission.suggested_changes : (submission.suggestedChanges ?? []),
      approved: submission.approved ?? true,
      submittedAt: new Date(submittedAt),
    });
  }
}

function isOpportunitySubject(subject: string): boolean {
  return subject === 'opportunity_validity' || subject === 'opportunity';
}

function isCompleteSubmission(submission: TeracSubmission): boolean {
  const critique = submission.critique ?? submission.feedback;
  const expertRef = submission.expert_ref ?? submission.worker_id ?? submission.respondent_id;
  const submittedAt = submission.submitted_at ?? submission.created_at;
  return Boolean(critique && expertRef && submittedAt);
}

function normaliseRecommendation(value: string | null | undefined): 'approve' | 'approve_with_changes' | 'reject' {
  const v = (value ?? '').toLowerCase().trim();
  if (v === 'approve' || v === 'approved' || v === 'yes') return 'approve';
  if (v === 'reject' || v === 'rejected' || v === 'no') return 'reject';
  return 'approve_with_changes';
}

function blockedFrom(error: unknown, capability: Capability): { capability: Capability; reason: string } | undefined {
  if (
    error instanceof CredentialsMissingError ||
    error instanceof CapabilityUnsupportedError ||
    error instanceof VendorApprovalRequiredError
  ) {
    return { capability, reason: error.message };
  }
  return undefined;
}
