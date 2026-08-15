/**
 * Terac domain bridge tests.
 *
 * Fixtures are built by parsing plain objects through the real
 * `TeracOpportunity`/`TeracSubmission` zod schemas, so defaults (e.g. an
 * absent `attestations` becoming `[]`) behave exactly as they would against a
 * real HTTP response, not just against a hand-typed TS object.
 *
 * The important tests here are the refusal paths: this bridge must fail
 * loudly rather than fabricate a critique, an expert identity, or a
 * submission timestamp that the wire payload did not actually provide — that
 * is the literal difference between a real integration and a fake one.
 */

import { describe, expect, it } from 'vitest';
import { ExpertReviewSubject } from '@foundry/core';
import { buildReviewRubric, toExpertReview } from '../src/terac/index.js';
import { TeracOpportunity, TeracSubmission } from '../src/terac/schemas.js';

function opportunity(overrides: Record<string, unknown> = {}) {
  return TeracOpportunity.parse({
    id: 'opp_test_1',
    project_id: 'proj_test_1',
    title: 'Validate DTC candle niche',
    business_type: 'b2c',
    num_participants: 25,
    status: 'launched',
    ...overrides,
  });
}

function submission(overrides: Record<string, unknown> = {}) {
  return TeracSubmission.parse({
    id: 'sub_test_1',
    opportunity_id: 'opp_test_1',
    expert_ref: 'expert_42',
    attestations: ['identity_verified', 'category_experience'],
    scores: { demand_evidence_strength: 4 },
    critique: 'Strong evidence of demand from three independent, verifiable sources.',
    recommendation: 'approve',
    suggested_changes: [],
    approved: true,
    submitted_at: '2026-08-10T12:00:00.000Z',
    ...overrides,
  });
}

/* -------------------------------------------------------------------------- */

describe('toExpertReview', () => {
  it('maps approved submissions into a passing verdict with mean scores', () => {
    const result = toExpertReview(opportunity(), [
      submission({ id: 's1', scores: { q: 5 }, recommendation: 'approve' }),
      submission({ id: 's2', scores: { q: 3 }, recommendation: 'approve' }),
    ]);
    expect(result.verdict).toBe('approved');
    expect(result.meanScores['q']).toBe(4);
    expect(result.submissions).toHaveLength(2);
    expect(result.externalEngagementId).toBe('opp_test_1');
    expect(result.participantsRequested).toBe(25);
  });

  it('a single reject from an approved submission is enough to block the verdict', () => {
    const result = toExpertReview(opportunity(), [
      submission({ id: 's1', recommendation: 'reject', approved: true }),
    ]);
    expect(result.verdict).toBe('rejected');
  });

  it('derives status from submissions presence when the opportunity status text is uninformative', () => {
    const result = toExpertReview(opportunity({ status: 'unknown_wire_value' }), [submission()]);
    expect(result.status).toBe('submissions_received');
  });

  it('maps cancelled, failed and completed opportunity statuses via keyword matching', () => {
    expect(toExpertReview(opportunity({ status: 'CANCELLED' }), []).status).toBe('cancelled');
    expect(toExpertReview(opportunity({ status: 'failed_to_launch' }), []).status).toBe('failed');
    expect(toExpertReview(opportunity({ status: 'completed' }), []).status).toBe('completed');
  });

  it('does not treat an unfunded draft as launched panel results', () => {
    const result = toExpertReview(opportunity({ status: 'draft' }), []);
    expect(result.status).toBe('priced');
    expect(result.verdict).toBe('pending');
    expect(result.submissions).toHaveLength(0);
  });

  it('falls back to launched when nothing matches and no submissions exist yet', () => {
    expect(toExpertReview(opportunity({ status: 'unknown_wire_value' }), []).status).toBe('launched');
  });

  it('normalises an unrecognised recommendation to approve_with_changes rather than guessing approve or reject', () => {
    const result = toExpertReview(opportunity(), [submission({ recommendation: 'thumbs_up_ish' })]);
    expect(result.submissions[0]?.recommendation).toBe('approve_with_changes');
  });

  it('falls back through expert identifier aliases (expert_ref -> worker_id -> respondent_id)', () => {
    const byWorkerId = toExpertReview(opportunity(), [submission({ expert_ref: undefined, worker_id: 'worker_9' })]);
    expect(byWorkerId.submissions[0]?.expertRef).toBe('worker_9');

    const byRespondentId = toExpertReview(opportunity(), [
      submission({ expert_ref: undefined, worker_id: undefined, respondent_id: 'resp_3' }),
    ]);
    expect(byRespondentId.submissions[0]?.expertRef).toBe('resp_3');
  });

  it('refuses to fabricate a critique when the wire payload has none, under any alias', () => {
    expect(() => toExpertReview(opportunity(), [submission({ critique: undefined, feedback: undefined })])).toThrow(
      /no critique\/feedback text/,
    );
  });

  it('refuses to fabricate an expert identity when the wire payload has none, under any alias', () => {
    expect(() =>
      toExpertReview(opportunity(), [
        submission({ expert_ref: undefined, worker_id: undefined, respondent_id: undefined }),
      ]),
    ).toThrow(/no expert identifier/);
  });

  it('refuses to fabricate a submission timestamp when the wire payload has none', () => {
    expect(() =>
      toExpertReview(opportunity(), [submission({ submitted_at: undefined, created_at: undefined })]),
    ).toThrow(/no submitted_at\/created_at/);
  });

  it('completedAt stays null while the verdict is still pending', () => {
    const result = toExpertReview(opportunity(), [submission({ approved: false })]);
    expect(result.verdict).toBe('pending');
    expect(result.completedAt).toBeNull();
  });

  it('completedAt is the latest submission timestamp once a verdict is reached', () => {
    const result = toExpertReview(opportunity(), [
      submission({ id: 's1', submitted_at: '2026-08-01T00:00:00.000Z' }),
      submission({ id: 's2', submitted_at: '2026-08-05T00:00:00.000Z' }),
    ]);
    expect(result.completedAt).toBe('2026-08-05T00:00:00.000Z');
  });

  it('passes through cost and currency when present, and reports null rather than a fabricated zero when absent', () => {
    const withCost = toExpertReview(opportunity({ cost_per_participant_minor: 500, currency: 'usd' }), []);
    expect(withCost.costPerParticipantMinor).toBe(500);
    expect(withCost.currency).toBe('usd');

    const without = toExpertReview(opportunity(), []);
    expect(without.costPerParticipantMinor).toBeNull();
    expect(without.currency).toBeNull();
  });

  it('an empty submissions array is a pending review, not an error', () => {
    const result = toExpertReview(opportunity(), []);
    expect(result.verdict).toBe('pending');
    expect(result.submissions).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */

describe('buildReviewRubric', () => {
  it('returns a non-empty, well-formed rubric and at least one screening question for every subject', () => {
    for (const subject of ExpertReviewSubject.options) {
      const { rubric, screeningQuestions } = buildReviewRubric(subject);
      expect(rubric.length, `subject ${subject} has an empty rubric`).toBeGreaterThan(0);
      expect(screeningQuestions.length, `subject ${subject} has no screening questions`).toBeGreaterThan(0);
      for (const item of rubric) {
        expect(item.key.length).toBeGreaterThan(0);
        // A real question a domain expert can act on, not a placeholder stub.
        expect(item.prompt.length).toBeGreaterThan(30);
        expect(['1_5', '1_10', 'boolean']).toContain(item.scale);
      }
    }
  });

  it('uses unique rubric keys within each subject', () => {
    for (const subject of ExpertReviewSubject.options) {
      const { rubric } = buildReviewRubric(subject);
      const keys = rubric.map((r) => r.key);
      expect(new Set(keys).size).toBe(keys.length);
    }
  });

  it('includes at least one boolean go/no-go item for the highest-stakes subjects', () => {
    for (const subject of ['opportunity_validity', 'category_compliance', 'legal_escalation'] as const) {
      const { rubric } = buildReviewRubric(subject);
      expect(rubric.some((r) => r.scale === 'boolean')).toBe(true);
    }
  });

  it('routes legal_escalation screening toward licensure, not general business judgement', () => {
    const { screeningQuestions } = buildReviewRubric('legal_escalation');
    expect(screeningQuestions.join(' ').toLowerCase()).toMatch(/licen/);
  });
});
