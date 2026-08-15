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
  DimensionScore,
  ExpertReviewSubject,
  HumanOverride,
  ValidationError,
  VendorApprovalRequiredError,
  type Capability,
} from '@foundry/core';
import {
  TeracAdapter,
  StripeAdapter,
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
  readonly beforeComposite?: number | null;
  readonly afterComposite?: number | null;
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
      const stimulusUrl = await this.#stimulusUrl();
      try {
        const mcp = await terac.launchGeneralPopulationStudy({
          role: 'General Population reviewer',
          task: input.question,
          count: input.participantsRequested,
          taskUrl: stimulusUrl,
        });
        getLogger().info({ tool: mcp.tool, opportunityId: mcp.opportunityId }, 'Terac General Population study prepared');
        if (mcp.opportunityId) {
          const launch = await this.#tryLaunch(terac, row.id, mcp.opportunityId, mcp.feasibilityId);
          if (isOpportunitySubject(input.subject)) {
            await this.deps.repos.research.opportunities.setStage(input.subjectRefId, 'expert_review_requested');
          }
          return {
            reviewId: row.id,
            externalEngagementId: mcp.opportunityId,
            externalRequestId: mcp.feasibilityId ?? null,
            blockedOn: launch.blockedOn,
          };
        }
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
        const launched = await this.#launchOpportunity(
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
          externalEngagementId: launched.opportunityId,
          externalRequestId: feasibility.id,
          blockedOn: launched.blockedOn,
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
        const launched = await this.#launchOpportunity(
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
        if (launched.blockedOn) {
          return {
            ok: false,
            reviewId: row.id,
            status: 'priced',
            blockedOn: launched.blockedOn,
          };
        }
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
        const applied = await this.#applyHumanRanking(
          row.subject_ref_id,
          derived.verdict,
          row.external_engagement_id,
          typeof recorded[0]?.['expert_ref'] === 'string' ? recorded[0]['expert_ref'] : 'terac-panel',
        );
        if (derived.verdict === 'rejected') {
          await this.deps.repos.research.opportunities.setStage(
            row.subject_ref_id,
            'killed',
            `General Population Terac review rejected the concept (${applied.beforeComposite ?? 'n/a'} → ${applied.afterComposite ?? 'n/a'}).`,
          );
        } else {
          await this.deps.repos.research.opportunities.setStage(row.subject_ref_id, 'expert_reviewed');
        }
        return {
          ok: true,
          reviewId: row.id,
          status: 'completed',
          verdict: derived.verdict,
          beforeComposite: applied.beforeComposite,
          afterComposite: applied.afterComposite,
        };
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

  async #tryLaunch(
    terac: TeracAdapter,
    reviewId: string,
    opportunityId: string,
    feasibilityId?: string,
  ): Promise<{ blockedOn?: { capability: Capability; reason: string } }> {
    await this.deps.repos.research.expertReviews.setExternalIds(reviewId, {
      engagementId: opportunityId,
      ...(feasibilityId ? { requestId: feasibilityId } : {}),
    });
    try {
      const launched = await terac.launchDraftOpportunity(opportunityId);
      await this.deps.repos.research.expertReviews.setStatus(
        reviewId,
        'launched',
        launched.cost_per_participant_minor ?? null,
        launched.currency ?? null,
      );
      return {};
    } catch (error) {
      if (isTeracUnfundedLaunch(error)) {
        await this.deps.repos.research.expertReviews.setStatus(reviewId, 'priced');
        return {
          blockedOn: {
            capability: 'expert.structured_review',
            reason: error instanceof Error ? error.message : 'Terac launch requires org credit',
          },
        };
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
  ): Promise<{ opportunityId: string; blockedOn?: { capability: Capability; reason: string } }> {
    const existing = await terac.listOpportunities({ limit: 25 });
    const reusable = existing.data.find((row) => {
      const status = (row.status ?? '').toLowerCase();
      return status === 'draft' || status === 'launched' || status === 'in_progress' || status === 'active';
    });
    if (reusable) {
      const launch = await this.#tryLaunch(terac, reviewId, reusable.id, reusable.feasibility_request_id ?? feasibilityRequestId);
      return { opportunityId: reusable.id, blockedOn: launch.blockedOn };
    }

    const projects = await terac.listProjects({ limit: 25 });
    const project =
      projects.data.find((row) => row.name?.toLowerCase().includes('general population')) ??
      projects.data[0] ??
      (await terac.createProject({ name: 'Foundry General Population product feedback' }));
    const taskUrl = await this.#stimulusUrl();

    const created = await terac.createOpportunity({
      title: input.question.slice(0, 200),
      projectId: project.id,
      numParticipants: input.participantsRequested,
      businessType: 'b2c',
      unrestrictedAudience: true,
      description: input.question.slice(0, 5000),
      screeningQuestions: rubric ? [...rubric.screeningQuestions] : [
        'Are you answering as a typical consumer rather than a category professional?',
      ],
      feasibilityRequestId,
      tasks: [
        {
          sequence: 1,
          taskType: 'activity',
          reviewType: 'manual_review',
          title: 'Buy / no-buy + price',
          description: input.question.slice(0, 2000),
          durationMinutes: 8,
          ...(taskUrl ? { taskUrl } : {}),
        },
      ],
    });

    const launch = await this.#tryLaunch(terac, reviewId, created.id, feasibilityRequestId);
    return { opportunityId: created.id, blockedOn: launch.blockedOn };
  }

  async #stimulusUrl(): Promise<string | undefined> {
    try {
      const stripe = this.deps.providers.adapter('stripe') as StripeAdapter | undefined;
      if (!stripe?.isConfigured) return undefined;
      const link = await stripe.resolveHackathonPaymentLink();
      return link.url;
    } catch {
      return undefined;
    }
  }

  async #applyHumanRanking(
    opportunityId: string,
    verdict: string,
    engagementId: string,
    expertRef: string,
  ): Promise<{ beforeComposite: number | null; afterComposite: number | null }> {
    const before = await this.deps.repos.research.opportunities.latestScorecard(opportunityId);
    if (!before) {
      return { beforeComposite: null, afterComposite: null };
    }
    const dimensions = before.dimensions.flatMap((row) => {
      const parsed = DimensionScore.safeParse(row);
      return parsed.success ? [parsed.data] : [];
    });
    const existingOverrides = before.overrides.flatMap((row) => {
      const parsed = HumanOverride.safeParse(row);
      return parsed.success ? [parsed.data] : [];
    });
    const overrides = expertVerdictOverrides({
      verdict,
      engagementId,
      expertRef,
      before: dimensions,
      recordedAt: new Date().toISOString(),
    });
    if (overrides.length === 0 || dimensions.length === 0) {
      return { beforeComposite: before.composite, afterComposite: before.composite };
    }
    const after = await this.deps.repos.research.opportunities.writeScorecard({
      opportunityId,
      weightProfile: before.weight_profile,
      dimensions,
      overrides: [...existingOverrides, ...overrides],
    });
    return { beforeComposite: before.composite, afterComposite: after.composite };
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

function isTeracUnfundedLaunch(error: unknown): boolean {
  if (!(error instanceof ValidationError)) return false;
  if (error.context['teracLaunchBlocked'] === true) return true;
  return /insufficient balance/i.test(error.message);
}

const VERDICT_RAW: Record<string, { willingness_to_pay: number; pain_severity: number; safety_regulatory_risk: number }> = {
  approved: { willingness_to_pay: 85, pain_severity: 80, safety_regulatory_risk: 20 },
  approve_with_changes: { willingness_to_pay: 65, pain_severity: 70, safety_regulatory_risk: 35 },
  rejected: { willingness_to_pay: 15, pain_severity: 30, safety_regulatory_risk: 85 },
  inconclusive: { willingness_to_pay: 50, pain_severity: 50, safety_regulatory_risk: 50 },
};

/**
 * Maps a completed General Population Terac verdict onto scorecard overrides.
 * The new scorecard is the after; the previous composite is the before.
 */
export function expertVerdictOverrides(input: {
  readonly verdict: string;
  readonly engagementId: string;
  readonly expertRef: string;
  readonly before: readonly { dimension: string; raw: number }[];
  readonly recordedAt: string;
}): HumanOverride[] {
  const targets = VERDICT_RAW[input.verdict];
  if (!targets) return [];
  const overrides: HumanOverride[] = [];
  for (const dim of input.before) {
    const next = targets[dim.dimension as keyof typeof targets];
    if (next === undefined) continue;
    const parsed = HumanOverride.safeParse({
      dimension: dim.dimension,
      previousRaw: dim.raw,
      newRaw: next,
      rationale: `General Population Terac verdict ${input.verdict} replaced the machine score for ${dim.dimension}.`,
      engagementId: input.engagementId,
      expertRef: input.expertRef,
      recordedAt: input.recordedAt,
    });
    if (parsed.success) overrides.push(parsed.data);
  }
  return overrides;
}
