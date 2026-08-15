/**
 * Creative concepts and the claims / human-review gates before spend.
 *
 * Claims are listed on create and checked against the brand register. Arms
 * cannot go live without `human_approved` — the database trigger enforces
 * that even if this service is bypassed.
 */

import type { AdPlatform, Capability } from '@foundry/core';
import type { ConceptRow } from '@foundry/db';
import { optionalCapability, type ServiceDeps, type ServiceOutcome } from '../deps.js';
import { ExpertReviewService } from '../research/expert.js';

export interface CreateConceptInput {
  readonly companyId: string;
  readonly brandId: string;
  readonly hypothesis: string;
  readonly angle: string;
  readonly hook: string;
  readonly primaryText: string;
  readonly headline: string;
  readonly callToAction: string;
  readonly landingPath: string;
  readonly platform: AdPlatform;
  readonly description?: string | null;
  readonly assetIds?: readonly string[];
  /** Objective claims used in the copy. Must be listed; an empty list means no claims. */
  readonly claimsUsed: readonly string[];
}

export class MarketingCreativeService {
  constructor(private readonly deps: ServiceDeps) {}

  async createConcept(input: CreateConceptInput): Promise<ServiceOutcome<ConceptRow>> {
    const row = await this.deps.repos.growth.creative.create({
      companyId: input.companyId,
      brandId: input.brandId,
      hypothesis: input.hypothesis,
      angle: input.angle,
      hook: input.hook,
      primaryText: input.primaryText,
      headline: input.headline,
      callToAction: input.callToAction,
      landingPath: input.landingPath,
      platform: input.platform,
      description: input.description,
      assetIds: input.assetIds,
      claimsUsed: input.claimsUsed,
    });
    return { ok: true, data: row };
  }

  async checkClaims(conceptId: string): Promise<ServiceOutcome<{ ok: boolean; unsupported: readonly string[] }>> {
    const result = await this.deps.repos.growth.creative.checkClaims(conceptId);
    return { ok: true, data: result };
  }

  async requestHumanReview(input: {
    conceptId: string;
    companyId: string;
  }): Promise<ServiceOutcome<{ reviewId?: string; conceptId: string }>> {
    const claims = await this.deps.repos.growth.creative.checkClaims(input.conceptId);
    if (!claims.ok) {
      return {
        ok: false,
        data: { conceptId: input.conceptId },
      };
    }

    const concept = await this.deps.repos.growth.creative.byId(input.conceptId);
    const experts = new ExpertReviewService(this.deps);
    const requested = await experts.request({
      companyId: input.companyId,
      subjectRefId: input.conceptId,
      subject: 'ad_creative',
      question: `Review ad creative "${concept.headline}" / ${concept.hook} for policy, claims, and spend readiness.`,
    });

    if (!requested.ok || requested.blockedOn) {
      const terac = optionalCapability<unknown>(this.deps, 'expert.structured_review');
      if (!terac) {
        return blocked('expert.structured_review', requested.blockedOn?.reason ?? this.#reason('expert.structured_review'));
      }
      return { ok: false, blockedOn: requested.blockedOn, data: { conceptId: input.conceptId, reviewId: requested.reviewId } };
    }

    if (requested.reviewId) {
      await this.deps.repos.growth.creative.requestReview(input.conceptId, requested.reviewId);
    }
    return { ok: true, data: { conceptId: input.conceptId, reviewId: requested.reviewId } };
  }

  #reason(capability: Capability): string {
    const status = this.deps.providers.forCapability(capability).status;
    return status.remediation ?? `capability state is ${status.state}`;
  }
}

function blocked<T>(capability: Capability, reason: string): ServiceOutcome<T> {
  return { ok: false, blockedOn: { capability, reason } };
}
