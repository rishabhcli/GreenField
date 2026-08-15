/**
 * Terac adapter — human expertise on demand.
 *
 * Written against the raw HTTP surface documented at
 * `https://terac.com/docs/developers/reference` (there is no SDK). Every
 * method here makes a real call; with no credentials configured,
 * `requireSecret`/`assertActivated` raise a typed `CredentialsMissingError`
 * naming `TERAC_API_KEY`. That error is the correct output, and nothing in
 * this file substitutes a stub for it.
 *
 * Terac is self-labelled "v2 beta" and several field-level shapes were never
 * shown in a sample payload (see `schemas.ts`). Where that is true, the code
 * says so at the point of uncertainty rather than presenting a guess as fact.
 */

import {
  ConflictError,
  CredentialsMissingError,
  NotFoundError,
  ProviderAuthError,
  ProviderContractError,
  RateLimitError,
  ProviderUnavailableError,
  ValidationError,
  summariseReview,
  type ExpertReview,
  type ExpertReviewSubject,
  type ExpertReviewStatus,
  type FoundryError,
} from '@foundry/core';
import { ProviderAdapter, type AdapterContext, type ProbeResult } from '../http/adapter.js';
import { bearerAuth, type ProviderHttpClient } from '../http/client.js';
import { verifyTeracSignature } from '../http/webhook-verify.js';
import { SECRETS, TERAC_MANIFEST } from '../manifests.js';
import {
  TeracErrorEnvelope,
  TeracFeasibilityRequest,
  TeracOpportunity,
  TeracProject,
  TeracSubmission,
  TeracWebhookSubscription,
  teracPage,
  type TeracPage,
} from './schemas.js';
import { TeracWebhookEnvelope, interpretTeracWebhookEvent, type TeracWebhookResult } from './events.js';
import {
  TERAC_MCP_URL,
  TeracMcpClient,
  mcpResultText,
  parseMcpJsonContent,
  type TeracMcpTool,
  type TeracMcpToolResult,
} from './mcp.js';

/**
 * UNVERIFIED path segment. The research pass confirmed a `getFeasibilityRequest`
 * operation exists (named as both a REST operation and an MCP tool,
 * `terac_get_feasibility_request`) but never pinned down its exact path. This
 * is exported as a reassignable function rather than baked into the method
 * body, so pointing it at the confirmed path once verified is a one-line
 * change, not a refactor.
 */
export let feasibilityRequestPath: (id: string) => string = (id) => `/feasibility/requests/${id}`;

/** Converts Terac's documented `{error:{code,message,details}}` envelope into our taxonomy. */
function classifyTeracError(status: number, body: unknown): FoundryError | undefined {
  const parsed = TeracErrorEnvelope.safeParse(body);
  if (!parsed.success) return undefined; // fall through to the client's generic status-code classifier
  const { code, message, details } = parsed.data.error;
  const context = { code, message, details, status };
  switch (code) {
    case 'BAD_REQUEST':
      return new ValidationError(`Terac rejected the request: ${message}`, context);
    case 'UNAUTHORIZED':
      return new ProviderAuthError('terac', message, context);
    case 'NOT_FOUND':
      return new NotFoundError('terac', message);
    case 'CONFLICT':
      return new ConflictError(`Terac reported a conflict: ${message}`, context);
    case 'RATE_LIMITED':
      return new RateLimitError('terac', undefined, context);
    case 'INTERNAL_SERVER_ERROR':
      return new ProviderUnavailableError('terac', message, context);
    default:
      return undefined;
  }
}

/* -------------------------------------------------------------------------- */
/* Inputs                                                                      */
/* -------------------------------------------------------------------------- */

export interface RequestFeasibilityInput {
  /** 1-10000 characters. */
  readonly taskDescription: string;
  /** 1-10000 characters. */
  readonly panelDescription: string;
  readonly submissionCount?: number;
  readonly timelineHours?: number;
  readonly requestorEmail?: string;
}

export interface CreateOpportunityTaskInput {
  readonly sequence: number;
  /** MCP/REST enum: interview | file_upload | activity */
  readonly taskType: 'interview' | 'file_upload' | 'activity';
  /** MCP/REST enum: auto_approve | manual_review | self_report */
  readonly reviewType: 'auto_approve' | 'manual_review' | 'self_report';
  readonly taskUrl?: string;
  readonly title?: string;
  readonly description?: string;
  readonly durationMinutes?: number;
}

/** Exact required/optional fields per live MCP `terac_create_opportunity` (2026-08-15). */
export interface CreateOpportunityInput {
  /** 1-200 characters. */
  readonly title: string;
  readonly projectId: string;
  /** 1-1000. */
  readonly numParticipants: number;
  readonly businessType: 'b2c' | 'b2b';
  readonly tasks: readonly CreateOpportunityTaskInput[];
  /** <=8000 characters on MCP. */
  readonly description?: string;
  readonly filters?: readonly unknown[];
  /**
   * Required when `filters` is omitted. True = General Population
   * (worldwide, any age, any language). Rejected if sent alongside filters.
   */
  readonly unrestrictedAudience?: boolean;
  readonly screeningQuestions?: readonly string[];
  /** <=200 entries. */
  readonly crossQuotas?: readonly unknown[];
  readonly deviceTypes?: readonly string[];
  /** 5-50000000. */
  readonly expectedDaysToComplete?: number;
  readonly feasibilityRequestId?: string;
}

export interface ListSubmissionsOptions {
  readonly status?: string;
  /** default 25, max 100. */
  readonly limit?: number;
  readonly cursor?: string;
}

export interface ListProjectsOptions {
  readonly limit?: number;
  readonly cursor?: string;
}

/* -------------------------------------------------------------------------- */
/* Adapter                                                                     */
/* -------------------------------------------------------------------------- */

export class TeracAdapter extends ProviderAdapter {
  override readonly manifest = TERAC_MANIFEST;

  constructor(ctx: AdapterContext) {
    super(ctx);
  }

  #client(): ProviderHttpClient {
    const secret = this.requireSecret(SECRETS.teracApiKey);
    return this.http(bearerAuth(secret), { classifyError: classifyTeracError });
  }

  /* --- Probe ------------------------------------------------------------ */

  override async probe(): Promise<ProbeResult> {
    const response = await this.#client().request(
      { method: 'GET', path: '/projects', query: { limit: 1 }, operation: 'projects.list' },
      teracPage(TeracProject),
    );
    return {
      succeeded: true,
      detail: `GET /projects?limit=1 returned ${response.body.data.length} project(s)`,
      evidence: {
        endpoint: 'GET /projects',
        count: response.body.data.length,
        hasMore: response.body.pagination.has_more,
      },
    };
  }

  /* --- Feasibility -------------------------------------------------------- */

  async requestFeasibility(input: RequestFeasibilityInput): Promise<TeracFeasibilityRequest> {
    this.assertActivated();
    if (input.taskDescription.length < 1 || input.taskDescription.length > 10_000) {
      throw new ValidationError('taskDescription must be 1-10000 characters', { length: input.taskDescription.length });
    }
    if (input.panelDescription.length < 1 || input.panelDescription.length > 10_000) {
      throw new ValidationError('panelDescription must be 1-10000 characters', { length: input.panelDescription.length });
    }

    const response = await this.#client().request(
      {
        method: 'POST',
        path: '/feasibility/requests',
        operation: 'feasibility.request',
        body: {
          taskDescription: input.taskDescription,
          panelDescription: input.panelDescription,
          ...(input.submissionCount !== undefined ? { submissionCount: input.submissionCount } : {}),
          ...(input.timelineHours !== undefined ? { timelineHours: input.timelineHours } : {}),
          ...(input.requestorEmail ? { requestorEmail: input.requestorEmail } : {}),
        },
      },
      TeracFeasibilityRequest,
    );
    return response.body;
  }

  /** UNVERIFIED path — see `feasibilityRequestPath` above. */
  async getFeasibilityRequest(id: string): Promise<TeracFeasibilityRequest> {
    this.assertActivated();
    const response = await this.#client().request(
      { method: 'GET', path: feasibilityRequestPath(id), operation: 'feasibility.get' },
      TeracFeasibilityRequest,
    );
    return response.body;
  }

  /* --- Opportunities ------------------------------------------------------ */

  async createOpportunity(input: CreateOpportunityInput): Promise<TeracOpportunity> {
    this.assertActivated();
    if (input.title.length < 1 || input.title.length > 200) {
      throw new ValidationError('title must be 1-200 characters', { length: input.title.length });
    }
    if (!Number.isInteger(input.numParticipants) || input.numParticipants < 1 || input.numParticipants > 1000) {
      throw new ValidationError('num_participants must be an integer between 1 and 1000', {
        numParticipants: input.numParticipants,
      });
    }
    if (input.tasks.length === 0) {
      throw new ValidationError('createOpportunity requires at least one task', { projectId: input.projectId });
    }
    if (input.description !== undefined && input.description.length > 5000) {
      throw new ValidationError('description must be at most 5000 characters', { length: input.description.length });
    }
    if (input.crossQuotas !== undefined && input.crossQuotas.length > 200) {
      throw new ValidationError('cross_quotas accepts at most 200 entries', { count: input.crossQuotas.length });
    }
    if (
      input.expectedDaysToComplete !== undefined &&
      (input.expectedDaysToComplete < 5 || input.expectedDaysToComplete > 50_000_000)
    ) {
      throw new ValidationError('expected_days_to_complete must be between 5 and 50000000', {
        value: input.expectedDaysToComplete,
      });
    }

    const response = await this.#client().request(
      {
        method: 'POST',
        path: '/opportunities',
        operation: 'opportunities.create',
        body: {
          title: input.title,
          project_id: input.projectId,
          num_participants: input.numParticipants,
          business_type: input.businessType,
          tasks: input.tasks.map((t) => ({
            sequence: t.sequence,
            task_type: t.taskType,
            review_type: t.reviewType,
            ...(t.taskUrl ? { task_url: t.taskUrl } : {}),
            ...(t.title ? { title: t.title } : {}),
            ...(t.description ? { description: t.description } : {}),
            ...(t.durationMinutes !== undefined ? { duration_minutes: t.durationMinutes } : {}),
          })),
          ...(input.description ? { description: input.description } : {}),
          ...(input.filters ? { filters: input.filters } : {}),
          ...(input.unrestrictedAudience ? { unrestricted_audience: true } : {}),
          ...(input.screeningQuestions
            ? {
                screening_questions: input.screeningQuestions.map((text, index) => ({
                  key: `q${index}`,
                  text,
                  pick: 'text',
                })),
              }
            : {}),
          ...(input.crossQuotas ? { cross_quotas: input.crossQuotas } : {}),
          ...(input.deviceTypes ? { device_types: input.deviceTypes } : {}),
          ...(input.expectedDaysToComplete !== undefined
            ? { expected_days_to_complete: input.expectedDaysToComplete }
            : {}),
          ...(input.feasibilityRequestId ? { feasibility_request_id: input.feasibilityRequestId } : {}),
        },
      },
      TeracOpportunity,
    );
    return response.body;
  }

  async listOpportunities(options: { readonly limit?: number; readonly cursor?: string } = {}): Promise<TeracPage<TeracOpportunity>> {
    this.assertActivated();
    const response = await this.#client().request(
      {
        method: 'GET',
        path: '/opportunities',
        operation: 'opportunities.list',
        query: { limit: options.limit, cursor: options.cursor },
      },
      teracPage(TeracOpportunity),
    );
    return response.body;
  }

  async getOpportunity(opportunityId: string): Promise<TeracOpportunity> {
    this.assertActivated();
    const response = await this.#client().request(
      {
        method: 'GET',
        path: `/opportunities/${encodeURIComponent(opportunityId)}`,
        operation: 'opportunities.get',
      },
      TeracOpportunity,
    );
    return response.body;
  }

  /**
   * Spends org credit. Live 2026-08-15: General Population draft of 5 at
   * $40 CPI requires $200. MCP `terac_launch_draft_opportunity` returns
   * isError; REST `POST /opportunities/{id}/launch` returns HTTP 412
   * PRECONDITION_FAILED with the same insufficient-balance message.
   */
  async launchDraftOpportunity(opportunityId: string): Promise<TeracOpportunity> {
    this.assertActivated();
    const mcp = await this.mcpCall('terac_launch_draft_opportunity', { opportunityId });
    const text = mcpResultText(mcp.content);
    if (mcp.isError || /insufficient balance/i.test(text)) {
      throw new ValidationError(text || 'Terac refused to launch the draft opportunity', {
        opportunityId,
        teracLaunchBlocked: true,
      });
    }
    return this.getOpportunity(opportunityId);
  }

  /* --- Submissions --------------------------------------------------------- */

  async listSubmissions(
    opportunityId: string,
    options: ListSubmissionsOptions = {},
  ): Promise<TeracPage<TeracSubmission>> {
    this.assertActivated();
    if (options.limit !== undefined && (options.limit < 1 || options.limit > 100)) {
      throw new ValidationError('limit must be between 1 and 100', { limit: options.limit });
    }
    const response = await this.#client().request(
      {
        method: 'GET',
        path: `/opportunities/${encodeURIComponent(opportunityId)}/submissions`,
        operation: 'opportunities.submissions.list',
        query: { status: options.status, limit: options.limit, cursor: options.cursor },
      },
      teracPage(TeracSubmission),
    );
    return response.body;
  }

  /** Walks every page of submissions for an opportunity, using the documented cursor. */
  async *iterateAllSubmissions(
    opportunityId: string,
    options: Omit<ListSubmissionsOptions, 'cursor'> = {},
  ): AsyncGenerator<TeracSubmission, void, void> {
    let cursor: string | undefined;
    for (;;) {
      const page = await this.listSubmissions(opportunityId, { ...options, cursor });
      for (const submission of page.data) yield submission;
      if (!page.pagination.has_more || !page.pagination.next_cursor) return;
      cursor = page.pagination.next_cursor;
    }
  }

  /* --- Projects -------------------------------------------------------------- */

  async createProject(input: { readonly name: string; readonly description?: string }): Promise<TeracProject> {
    this.assertActivated();
    if (input.name.length < 1) {
      throw new ValidationError('createProject requires a name');
    }
    const mcp = await this.mcpCall('terac_create_project', { name: input.name });
    if (mcp.isError) {
      throw new ProviderUnavailableError('terac', 'MCP terac_create_project failed', {
        content: clip(mcp.content),
      });
    }
    const parsed = parseMcpJsonContent(mcp.content);
    const id = typeof parsed?.['id'] === 'string' ? parsed['id'] : null;
    if (!id || !parsed) {
      throw new ProviderContractError('terac', 'terac_create_project did not return an id', {
        content: clip(mcp.content),
      });
    }
    return TeracProject.parse({ id, name: parsed['name'] ?? input.name, ...parsed });
  }

  async getProject(projectId: string): Promise<TeracProject> {
    this.assertActivated();
    const response = await this.#client().request(
      {
        method: 'GET',
        path: `/projects/${encodeURIComponent(projectId)}`,
        operation: 'projects.get',
      },
      TeracProject,
    );
    return response.body;
  }

  async ensureProject(name = 'Foundry General Population product feedback'): Promise<TeracProject> {
    const configured = this.optionalSecret(SECRETS.teracProjectId)?.reveal();
    if (configured) {
      try {
        return await this.getProject(configured);
      } catch {
        // Fall through to list/create rather than invent a project id.
      }
    }
    const existing = await this.listProjects({ limit: 25 });
    const match = configured ? existing.data.find((row) => row.id === configured) : undefined;
    if (match) return match;
    if (existing.data[0]) return existing.data[0];
    return this.createProject({ name });
  }

  async listProjects(options: ListProjectsOptions = {}): Promise<TeracPage<TeracProject>> {
    this.assertActivated();
    const response = await this.#client().request(
      {
        method: 'GET',
        path: '/projects',
        operation: 'projects.list',
        query: { limit: options.limit, cursor: options.cursor },
      },
      teracPage(TeracProject),
    );
    return response.body;
  }

  /* --- Webhook subscriptions --------------------------------------------------- */

  async createWebhookSubscription(
    targetUrl: string,
    eventTypes: readonly string[],
  ): Promise<TeracWebhookSubscription> {
    this.assertActivated();
    if (eventTypes.length === 0) {
      throw new ValidationError('createWebhookSubscription requires at least one event type', { targetUrl });
    }
    const response = await this.#client().request(
      {
        method: 'POST',
        path: '/hooks/subscriptions',
        operation: 'hooks.subscriptions.create',
        body: { target_url: targetUrl, event_types: eventTypes },
      },
      TeracWebhookSubscription,
    );
    return response.body;
  }

  /** Confirms a subscription (empty body) after answering the signed ping. */
  async confirmWebhookSubscription(subscriptionId: string): Promise<TeracWebhookSubscription> {
    this.assertActivated();
    const response = await this.#client().request(
      {
        method: 'POST',
        path: `/hooks/subscriptions/${encodeURIComponent(subscriptionId)}`,
        operation: 'hooks.subscriptions.confirm',
        body: {},
      },
      TeracWebhookSubscription,
    );
    return response.body;
  }

  /* --- Webhooks (inbound) ------------------------------------------------------ */

  /**
   * Verifies and parses an inbound webhook, then classifies it via the
   * defensive envelope in `events.ts`. See that module's header for why the
   * result is a refresh signal rather than trusted webhook-body data.
   */
  verifyWebhook(
    rawBody: Buffer | string,
    headers: Record<string, string | string[] | undefined>,
  ): { readonly envelope: TeracWebhookEnvelope; readonly timestampSeconds: number; readonly eventId: string | null; readonly result: TeracWebhookResult } {
    const secret = this.requireSecret(SECRETS.teracWebhookSecret);
    const verification = verifyTeracSignature({ rawBody, headers, secret });

    const parsed = TeracWebhookEnvelope.safeParse(
      JSON.parse(typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8')),
    );
    if (!parsed.success) {
      throw new ProviderContractError(
        'terac',
        `webhook body did not match the defensive event envelope: ${parsed.error.message}`,
      );
    }

    return {
      envelope: parsed.data,
      timestampSeconds: verification.timestampSeconds,
      eventId: verification.eventId,
      result: interpretTeracWebhookEvent(parsed.data),
    };
  }

  /* --- MCP (hackathon submission path) ----------------------------------- */

  mcpClient(): TeracMcpClient {
    const secret = this.requireSecret(SECRETS.teracApiKey);
    return new TeracMcpClient(TERAC_MCP_URL, secret.reveal());
  }

  async mcpCall(tool: TeracMcpTool | string, args: Record<string, unknown> = {}): Promise<TeracMcpToolResult> {
    this.assertActivated();
    return this.mcpClient().callTool(tool, args);
  }

  /** Non-destructive MCP handshake used by live verification. */
  async mcpListTools(): Promise<unknown> {
    this.assertActivated();
    return this.mcpClient().listTools();
  }

  /**
   * General Population path: ensure a project exists, price via MCP feasibility,
   * then create an unrestricted-audience DRAFT. Launch is a separate call —
   * it spends org credit and must not be implied by a successful draft.
   */
  async launchGeneralPopulationStudy(input: {
    readonly role: string;
    readonly task: string;
    readonly count: number;
    readonly projectId?: string;
    readonly taskUrl?: string;
  }): Promise<{
    readonly tool: string;
    readonly content: unknown;
    readonly projectId?: string;
    readonly feasibilityId?: string;
    readonly opportunityId?: string;
  }> {
    this.assertActivated();
    const mcp = this.mcpClient();
    const project = input.projectId
      ? await this.getProject(input.projectId)
      : await this.ensureProject();
    const listed = await this.listOpportunities({ limit: 25 });
    const reusable = listed.data.find((row) => {
      const status = (row.status ?? '').toLowerCase();
      return status === 'draft' || status === 'launched' || status === 'in_progress' || status === 'active';
    });
    if (reusable) {
      return {
        tool: 'terac_list_opportunities',
        content: reusable,
        projectId: project.id,
        feasibilityId: reusable.feasibility_request_id ?? undefined,
        opportunityId: reusable.id,
      };
    }
    const feasibility = await mcp.callTool('terac_request_feasibility', {
      taskDescription: input.task,
      panelDescription: `${input.role}. Audience: General Population (unrestricted — worldwide, any age, any language; do not restrict to a specialist niche).`,
      submissionCount: input.count,
    });
    const feasibilityJson = parseMcpJsonContent(feasibility.content);
    const feasibilityId =
      typeof feasibilityJson?.['id'] === 'string' ? feasibilityJson['id'] : undefined;
    const created = await this.createOpportunity({
      title: input.task.slice(0, 200),
      projectId: project.id,
      numParticipants: input.count,
      businessType: 'b2c',
      unrestrictedAudience: true,
      description: input.task.slice(0, 5000),
      feasibilityRequestId: feasibilityId,
      tasks: [
        {
          sequence: 1,
          taskType: 'activity',
          reviewType: 'manual_review',
          title: 'Buy / no-buy + price',
          description: input.task.slice(0, 2000),
          durationMinutes: 8,
          ...(input.taskUrl ? { taskUrl: input.taskUrl } : {}),
        },
      ],
    });
    return {
      tool: 'terac_create_opportunity',
      content: created,
      projectId: project.id,
      feasibilityId,
      opportunityId: created.id,
    };
  }
}

/* -------------------------------------------------------------------------- */
/* Domain bridge — free functions                                              */
/*                                                                              */
/* Pure, need no adapter state (no secrets, no HTTP), and are exported         */
/* directly rather than duplicated as identically-named adapter methods —     */
/* the same separation Stripe's own adapter uses for                          */
/* `mapStripeEventToOrderTransition` (a free function; the adapter's own      */
/* `interpretEvent` method is deliberately a different, shorter name so the   */
/* two are never confused).                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The Terac-derived slice of `ExpertReview`. Deliberately NOT a full
 * `ExpertReview`: fields like `id`, `companyId`, `subject`, `subjectRefId`,
 * `question`, `rubric` and `requestedAt` are our own business context, fixed
 * before the opportunity was ever created, and Terac's API has no knowledge
 * of them — synthesising them here would mean inventing data this bridge
 * cannot actually know. The caller (the service that owns the `ExpertReview`
 * row) merges this return value with the context it already holds.
 */
export interface TeracDerivedReviewFields {
  readonly externalEngagementId: string;
  readonly status: ExpertReviewStatus;
  readonly participantsRequested: number;
  readonly costPerParticipantMinor: number | null;
  readonly currency: string | null;
  readonly submissions: ExpertReview['submissions'];
  readonly verdict: ExpertReview['verdict'];
  readonly meanScores: Record<string, number>;
  readonly completedAt: string | null;
}

/**
 * Maps a Terac opportunity + its submissions onto the Terac-derived slice of
 * core's `ExpertReview`, using `summariseReview` for the aggregate verdict.
 */
export function toExpertReview(
  opportunity: TeracOpportunity,
  submissions: readonly TeracSubmission[],
): TeracDerivedReviewFields {
  const mapped = submissions.map((s) => submissionToReviewEntry(s));
  const { verdict, meanScores } = summariseReview(mapped);
  const completedAt =
    mapped.length > 0 && verdict !== 'pending'
      ? mapped.reduce((latest, s) => (s.submittedAt > latest ? s.submittedAt : latest), mapped[0]!.submittedAt)
      : null;

  return {
    externalEngagementId: opportunity.id,
    status: mapOpportunityStatus(opportunity, submissions),
    participantsRequested: opportunity.num_participants ?? submissions.length,
    costPerParticipantMinor: opportunity.cost_per_participant_minor ?? null,
    currency: opportunity.currency ?? null,
    submissions: mapped,
    verdict,
    meanScores,
    completedAt,
  };
}

function submissionToReviewEntry(s: TeracSubmission): ExpertReview['submissions'][number] {
  const expertRef = s.expert_ref ?? s.worker_id ?? s.respondent_id;
  if (!expertRef) {
    throw new ProviderContractError(
      'terac',
      `submission ${s.id} carried no expert identifier under any of the aliases this adapter checks ` +
        `(expert_ref, worker_id, respondent_id)`,
      { submissionId: s.id },
    );
  }
  const critique = s.critique ?? s.feedback;
  if (!critique) {
    // The written critique IS the paid deliverable. An empty one is a
    // contract violation worth failing loudly on, not a placeholder to paper
    // over — a placeholder here would be exactly the "fabricated expert
    // feedback" this integration must never produce.
    throw new ProviderContractError('terac', `submission ${s.id} has no critique/feedback text`, {
      submissionId: s.id,
    });
  }
  const submittedAt = s.submitted_at ?? s.created_at;
  if (!submittedAt) {
    throw new ProviderContractError('terac', `submission ${s.id} has no submitted_at/created_at timestamp`, {
      submissionId: s.id,
    });
  }

  return {
    externalSubmissionId: s.id,
    expertRef,
    attestations: s.attestations,
    scores: s.scores,
    critique,
    recommendation: normaliseRecommendation(s.recommendation),
    suggestedChanges: s.suggested_changes.length > 0 ? s.suggested_changes : (s.suggestedChanges ?? []),
    submittedAt,
    // Terac bills per verified completion — a submission that failed its own
    // review is documented not to bill. Absent an explicit flag we assume a
    // submission returned by the API is the kind that counts, since the
    // endpoint is documented to return submissions, not rejected attempts.
    approved: s.approved ?? true,
  };
}

/**
 * UNVERIFIED: Terac's exact recommendation vocabulary on the wire was never
 * shown. An unrecognised value is mapped to `approve_with_changes` rather than
 * to either extreme: silently promoting an unclear signal to a clean
 * `approve` would misrepresent the expert's judgement in the direction that
 * risks spending money on something they did not actually endorse, and
 * collapsing it to `reject` would discard genuinely useful paid feedback.
 * Both would be a form of fabrication; the neutral middle ground is the only
 * honest default.
 */
function normaliseRecommendation(value: string | null | undefined): 'approve' | 'approve_with_changes' | 'reject' {
  const v = (value ?? '').toLowerCase().trim();
  if (v === 'approve' || v === 'approved' || v === 'yes') return 'approve';
  if (v === 'reject' || v === 'rejected' || v === 'no') return 'reject';
  return 'approve_with_changes';
}

/**
 * UNVERIFIED: Terac's opportunity status vocabulary was never published as an
 * enum. This keyword-matches the raw string and otherwise falls back on
 * whether any submissions have arrived yet, rather than asserting a specific
 * unconfirmed value.
 */
function mapOpportunityStatus(
  opportunity: TeracOpportunity,
  submissions: readonly TeracSubmission[],
): ExpertReviewStatus {
  const raw = (opportunity.status ?? '').toLowerCase();
  if (/cancel/.test(raw)) return 'cancelled';
  if (/fail|error/.test(raw)) return 'failed';
  if (/complet|closed|finished/.test(raw)) return 'completed';
  if (submissions.length > 0) return 'submissions_received';
  if (/launch|active|running|live|in.?progress/.test(raw)) return 'in_progress';
  return 'launched';
}

/* -------------------------------------------------------------------------- */
/* Review rubrics                                                              */
/* -------------------------------------------------------------------------- */

export interface TeracRubricItem {
  readonly key: string;
  readonly prompt: string;
  readonly scale: 'boolean' | '1_5' | '1_10';
}

export interface TeracReviewRubric {
  readonly rubric: readonly TeracRubricItem[];
  readonly screeningQuestions: readonly string[];
}

/**
 * Rubric + screening questions per review subject.
 *
 * These prompts ARE the product: a paid human expert reads them and their
 * answer is what real spend gets committed on the basis of. A vague prompt
 * ("rate this 1-5") produces a vague, low-value answer no matter how good the
 * expert is. Every prompt below asks a specific question a domain expert can
 * answer from direct inspection of the attached evidence, and the screening
 * questions are chosen to route the opportunity to someone who can actually
 * answer it, rather than an arbitrary panellist.
 */
export function buildReviewRubric(subject: ExpertReviewSubject): TeracReviewRubric {
  switch (subject) {
    case 'opportunity_validity':
      return {
        rubric: [
          {
            key: 'demand_evidence_strength',
            scale: '1_5',
            prompt:
              'Based on the attached evidence (search trend data, competitor listings, customer complaints or forum threads), how strong is the evidence of real, current buyer demand for this product or niche? 1 = no credible evidence of demand beyond the requester\'s own assumption, 5 = strong, multi-source evidence of urgent, unmet demand.',
          },
          {
            key: 'competitive_white_space',
            scale: '1_5',
            prompt:
              'How saturated is this niche with credible, well-reviewed competitors already serving this demand? 1 = extremely saturated with entrenched incumbents and no visible gap, 5 = clear white space with no strong incumbent solving this well.',
          },
          {
            key: 'launchable_in_90_days',
            scale: 'boolean',
            prompt:
              'Given the resources, budget and team described, could a focused small team plausibly launch a sellable version of this product and land its first paying customers within roughly 90 days?',
          },
          {
            key: 'disqualifying_red_flag',
            scale: 'boolean',
            prompt:
              'Is there any legal, regulatory, platform-policy, safety or reputational red flag in this category or niche that should stop this opportunity outright, regardless of how strong the demand looks?',
          },
        ],
        screeningQuestions: [
          'Do you have professional experience (retail buying, category management, marketing, or supply chain) in this specific product category within the last 3 years?',
          'Have you personally researched, purchased, or used a product in this category in the last 12 months?',
        ],
      };

    case 'evidence_quality':
      return {
        rubric: [
          {
            key: 'source_credibility',
            scale: '1_5',
            prompt:
              'How credible and independent are the sources behind this evidence set (e.g. verified-purchase reviews and multiple unrelated forums, versus a single unverified social post)? 1 = low-credibility or unverifiable sources, 5 = multiple independent, verifiable, high-credibility sources.',
          },
          {
            key: 'sufficiency_for_spend',
            scale: '1_5',
            prompt:
              'Is there enough independent evidence here to justify spending real marketing budget testing this hypothesis, or does it rest on one or two anecdotes being over-generalized? 1 = clearly insufficient to justify spend, 5 = clearly sufficient.',
          },
          {
            key: 'shows_cherry_picking',
            scale: 'boolean',
            prompt:
              'Does this evidence set show signs of cherry-picking — for example, only positive signals were captured with no attempt to look for disconfirming evidence (negative reviews, low search interest, prior failed competitors)?',
          },
          {
            key: 'confidence_in_conclusion',
            scale: '1_5',
            prompt: 'Overall, how much confidence would you personally place in the conclusion this evidence is being used to support?',
          },
        ],
        screeningQuestions: [
          'Have you worked in a research, market intelligence, or data analysis role where evaluating the strength of evidence was part of your job?',
        ],
      };

    case 'ad_creative':
      return {
        rubric: [
          {
            key: 'policy_compliance',
            scale: 'boolean',
            prompt:
              'Does this ad creative (copy, imagery, and any claims made) appear to violate Meta or Google advertising policy, or make a health, financial, or performance claim that is not clearly substantiated?',
          },
          {
            key: 'honesty_no_misleading_claims',
            scale: '1_5',
            prompt:
              'Would a reasonable member of the target audience come away from this ad with an accurate impression of what the product does and costs? 1 = clearly misleading, 5 = fully honest and accurate.',
          },
          {
            key: 'persuasiveness_for_audience',
            scale: '1_5',
            prompt:
              'For the stated target audience, how persuasive and attention-grabbing is this creative compared to typical ads they see in this category? 1 = ignorable, 5 = highly compelling.',
          },
          {
            key: 'brand_fit',
            scale: '1_5',
            prompt: 'How consistent is the tone, imagery and voice of this creative with the brand identity materials attached?',
          },
          {
            key: 'offer_and_cta_clarity',
            scale: '1_5',
            prompt: 'Is it immediately clear what is being offered and what action the viewer should take next?',
          },
        ],
        screeningQuestions: [
          'Do you have professional experience writing or reviewing paid social or search ad creative, ideally including compliance review?',
        ],
      };

    case 'landing_page':
      return {
        rubric: [
          {
            key: 'trust_signals_present',
            scale: '1_5',
            prompt:
              'How adequate are the trust signals on this page (reviews, secure-checkout indicators, real contact information, clear return/refund policy) for a first-time visitor deciding whether to trust this store with a payment?',
          },
          {
            key: 'mobile_usability',
            scale: '1_5',
            prompt:
              'Using a phone-sized viewport, how usable is this page — can you read the copy, see the product, and find the buy button without pinching or awkward scrolling?',
          },
          {
            key: 'checkout_path_clarity',
            scale: '1_5',
            prompt:
              'From this page, how clear and friction-free is the path to completing a purchase (price, shipping cost, and next step all visible or one click away)?',
          },
          {
            key: 'claims_substantiated',
            scale: 'boolean',
            prompt:
              'Are any specific claims on the page (e.g. "clinically proven", "#1 rated", specific quantitative benefits) backed by something on or linked from the page, or are they unsubstantiated?',
          },
          {
            key: 'would_personally_buy',
            scale: 'boolean',
            prompt:
              'If you were genuinely in the target market and needed this product today, would you complete a purchase on this page as it stands right now?',
          },
        ],
        screeningQuestions: [
          'Have you worked in conversion rate optimization, e-commerce UX, or as a professional online shopper/mystery shopper?',
        ],
      };

    case 'brand_identity':
      return {
        rubric: [
          {
            key: 'name_memorability',
            scale: '1_5',
            prompt: 'How memorable and easy to spell/pronounce is this brand name for the target market?',
          },
          {
            key: 'visual_distinctiveness',
            scale: '1_5',
            prompt:
              'How distinctive is this logo and visual identity compared to the leading 3-5 competitors in this category — would a shopper confuse it with an existing brand?',
          },
          {
            key: 'perceived_trademark_conflict_risk',
            scale: '1_5',
            prompt:
              'Based on a quick search of this name and category, how likely does it look that this name or logo conflicts with an existing registered trademark? (This is a plausibility screen, not a substitute for formal trademark counsel.)',
          },
          {
            key: 'category_fit',
            scale: '1_5',
            prompt: 'Does the visual identity signal the right category and price point (e.g. does a premium-positioned product look premium)?',
          },
        ],
        screeningQuestions: [
          'Do you have professional experience in brand design, brand strategy, or trademark/IP screening?',
        ],
      };

    case 'packaging':
      return {
        rubric: [
          {
            key: 'shelf_standout',
            scale: '1_5',
            prompt: 'Placed next to 3-5 typical competitor products in this category, how much does this packaging stand out for the right reasons?',
          },
          {
            key: 'perceived_quality_for_price',
            scale: '1_5',
            prompt: 'Does the packaging make the product feel worth its price, or does it undersell/oversell relative to the price point?',
          },
          {
            key: 'unboxing_experience',
            scale: '1_5',
            prompt:
              'How good is the physical experience of opening this packaging and retrieving the product — is it easy, satisfying, and free of frustration (excess plastic, hard-to-open seals)?',
          },
          {
            key: 'required_labeling_present',
            scale: 'boolean',
            prompt:
              'Does the packaging include the labeling, warnings, ingredient list, or safety/compliance information that is legally required for this specific product category and target market?',
          },
          {
            key: 'transit_damage_risk',
            scale: '1_5',
            prompt: 'How well does this packaging appear likely to protect the product during standard parcel-carrier shipping? 1 = high risk of damage, 5 = well protected.',
          },
        ],
        screeningQuestions: [
          'Do you have professional experience in packaging design, structural packaging engineering, or retail compliance/labeling for physical consumer products?',
        ],
      };

    case 'pricing':
      return {
        rubric: [
          {
            key: 'price_matches_perceived_value',
            scale: '1_5',
            prompt:
              'Based on the product, packaging, and brand materials attached, does the proposed price feel justified to a target customer, or does it feel over- or under-priced?',
          },
          {
            key: 'competitive_position',
            scale: '1_5',
            prompt: 'Compared to the 2-3 closest comparable products you know of in this category, how does this price position the product (too expensive, too cheap, well-positioned)?',
          },
          {
            key: 'margin_sustainability_confidence',
            scale: '1_5',
            prompt: 'Given the stated cost basis, how confident are you that this price supports a sustainable business once realistic customer acquisition cost and returns are accounted for?',
          },
          {
            key: 'discount_dependent_appeal',
            scale: 'boolean',
            prompt: 'Does this pricing only look attractive because of a promotional discount, such that it would likely convert poorly once shown at full price?',
          },
        ],
        screeningQuestions: [
          'Do you have professional experience in retail pricing strategy, merchandising, or e-commerce unit economics?',
        ],
      };

    case 'category_compliance':
      return {
        rubric: [
          {
            key: 'requirements_identification_completeness',
            scale: '1_5',
            prompt: 'How complete is the identification of category-specific regulatory or certification requirements (e.g. safety standards, restricted ingredients, required disclosures) for this product and its target market?',
          },
          {
            key: 'major_compliance_gap_present',
            scale: 'boolean',
            prompt: 'Is there a specific certification, labeling requirement, or restricted-ingredient rule for this category that appears to be missing or unaddressed?',
          },
          {
            key: 'ad_platform_policy_risk',
            scale: '1_5',
            prompt: 'How likely is it that advertising this specific product on Meta or Google would trigger a policy rejection or account-level restriction, based on the category and any claims made?',
          },
          {
            key: 'confidence_in_assessment',
            scale: '1_5',
            prompt: 'How confident are you in this compliance assessment given the information provided?',
          },
        ],
        screeningQuestions: [
          'Do you have professional experience in regulatory compliance, product safety, or advertising policy review for this or a closely related product category?',
        ],
      };

    case 'supplier_quote':
      return {
        rubric: [
          {
            key: 'price_plausibility',
            scale: '1_5',
            prompt:
              'Given the specification, materials, and minimum order quantity described, is this per-unit price plausible for this product category and manufacturing region? 1 = implausible (too good or too bad to be true), 5 = plausible and in line with what you would expect.',
          },
          {
            key: 'supplier_credibility_signals',
            scale: '1_5',
            prompt: 'Based on the supplier profile, communication, and any certifications or references provided, how credible does this supplier appear as a manufacturing partner?',
          },
          {
            key: 'quote_spec_completeness',
            scale: '1_5',
            prompt: 'Does the quote actually cover everything that was requested (materials, tolerances, quantities, packaging, timeline), or are important items missing or ambiguous?',
          },
          {
            key: 'hidden_cost_risk',
            scale: 'boolean',
            prompt: 'Based on your experience, are there likely additional costs not reflected in this quote (tooling/mold fees, sample fees, certification, inland freight) that a buyer should budget for before agreeing?',
          },
        ],
        screeningQuestions: [
          'Do you have professional experience in sourcing, procurement, or supply chain management for physical consumer goods manufactured in this region?',
        ],
      };

    case 'legal_escalation':
      return {
        rubric: [
          {
            key: 'exposure_severity',
            scale: '1_5',
            prompt:
              'If the assumption behind this question turns out to be wrong, how severe is the resulting legal or regulatory exposure to the business (e.g. a minor administrative fix versus significant liability or a forced shutdown of a product line)?',
          },
          {
            key: 'requires_licensed_counsel',
            scale: 'boolean',
            prompt: 'Does answering this question properly require a licensed attorney in a specific jurisdiction and specialty, rather than general business judgement or a non-lawyer\'s informed opinion?',
          },
          {
            key: 'safe_to_proceed_with_mitigation',
            scale: 'boolean',
            prompt: 'Is there a concrete mitigation (a disclosure, a policy change, a specific contract clause) that would let the business proceed now while formal counsel is engaged, or must activity stop until a lawyer weighs in?',
          },
          {
            key: 'confidence_in_assessment',
            scale: '1_5',
            prompt: 'How confident are you in this assessment given only the information provided?',
          },
        ],
        screeningQuestions: [
          'Are you a licensed attorney (or a paralegal/law clerk working directly under one) in a jurisdiction relevant to this question?',
          'If not currently licensed, do you have direct, relevant regulatory or compliance experience in this specific area?',
        ],
      };
  }
}

export { TERAC_MCP_URL, TeracMcpClient, TERAC_MCP_TOOLS, parseMcpJsonContent, mcpResultText } from './mcp.js';
export { CredentialsMissingError };
export * from './schemas.js';
export * from './events.js';

function clip(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text ? text.slice(0, 400) : '';
}
