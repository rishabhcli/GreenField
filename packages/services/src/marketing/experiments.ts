/**
 * Experiments, arm launch, and metric collection.
 *
 * Spend starts only after a real ad-platform create call succeeds. Missing
 * credentials leave the arm not live. Metrics are persisted from adapter
 * insights — CTR/CAC are never invented.
 */

import {
  CapabilityUnsupportedError,
  CredentialsMissingError,
  ValidationError,
  audienceSpecFor,
  type AdPlatform,
  type ArmDecision,
  type Capability,
  type ExperimentObjective,
  type MetricSnapshot,
  type StopCondition,
} from '@foundry/core';
import { companyConfig } from '@foundry/db';
import { GoogleAdsAdapter, MetaAdsAdapter } from '@foundry/providers';
import { optionalCapability, type ServiceDeps, type ServiceOutcome } from '../deps.js';
import { toDomain as segmentToDomain } from './audience.js';

export interface CreateExperimentInput {
  readonly companyId: string;
  readonly brandId: string;
  readonly name: string;
  readonly hypothesis: string;
  readonly platform: AdPlatform;
  readonly objective: ExperimentObjective;
  /**
   * The segment this experiment targets. Resolved into `audience_spec.targeting`
   * at creation, which is what the ad-set builder requires and refuses to invent.
   */
  readonly audienceSegmentId: string;
  readonly totalBudgetMinor: number;
  readonly currency: string;
  readonly stopConditions: readonly StopCondition[];
  readonly attributionModel: 'platform_reported' | 'first_party_click_id' | 'blended';
}

export interface LaunchArmInput {
  readonly armId: string;
  readonly landingUrl?: string;
}

interface AdsLaunchAdapter {
  createCampaign?(input: Record<string, unknown>): Promise<{ id?: string; resourceName?: string }>;
  createCampaignBudget?(input: { name: string; amountMicros: number }): Promise<{ resourceName: string }>;
  createAdSet?(input: Record<string, unknown>): Promise<{ id: string }>;
  activateCampaign?(id: string): Promise<unknown>;
  pauseAd?(id: string): Promise<unknown>;
  pauseAdSet?(id: string): Promise<unknown>;
  pauseCampaign?(id: string): Promise<unknown>;
  updateAdSetBudget?(id: string, input: { dailyBudgetMinor?: number }): Promise<unknown>;
  updateCampaignBudget?(resourceName: string, amountMicros: number): Promise<unknown>;
  getInsights?(input: {
    objectId: string;
    level: string;
    since: string;
    until: string;
  }): Promise<readonly unknown[]>;
  getMetrics?(input: {
    resourceType: string;
    resourceResourceName?: string;
    since: string;
    until: string;
  }): Promise<readonly unknown[]>;
  toMetricSnapshot?(
    rows: readonly unknown[],
    input: {
      companyId: string;
      scope: MetricSnapshot['scope'];
      scopeRefId: string;
      currency: string;
      windowStart: string;
      windowEnd: string;
    },
  ): MetricSnapshot;
}

export class MarketingExperimentService {
  constructor(private readonly deps: ServiceDeps) {}

  async createExperiment(input: CreateExperimentInput): Promise<ServiceOutcome<{ experimentId: string }>> {
    // Resolving the segment here is what makes the experiment launchable. The
    // segment row is company-scoped and evidence-backed, so the targeting written
    // into audience_spec is traceable to research rather than assumed.
    const segment = await this.deps.repos.growth.audience.byId(input.audienceSegmentId);
    if (segment.company_id !== input.companyId) {
      throw new ValidationError('Audience segment belongs to a different company', {
        segmentId: input.audienceSegmentId,
        companyId: input.companyId,
      });
    }
    const audienceSpec = audienceSpecFor(segmentToDomain(segment), input.platform);

    const row = await this.deps.repos.growth.experiments.create({
      companyId: input.companyId,
      brandId: input.brandId,
      name: input.name,
      hypothesis: input.hypothesis,
      platform: input.platform,
      objective: input.objective,
      audienceSpec,
      audienceSegmentId: input.audienceSegmentId,
      totalBudgetMinor: input.totalBudgetMinor,
      currency: input.currency,
      stopConditions: input.stopConditions,
      attributionModel: input.attributionModel,
    });
    return { ok: true, data: { experimentId: row.id } };
  }

  async launchArm(input: LaunchArmInput): Promise<ServiceOutcome<{ armId: string; live: boolean }>> {
    const arm = await this.deps.repos.growth.experiments.armById(input.armId);
    const experiment = await this.deps.repos.growth.experiments.byId(arm.experiment_id);
    const concept = await this.deps.repos.growth.creative.byId(arm.creative_concept_id);

    if (concept.status !== 'human_approved') {
      return {
        ok: false,
        data: { armId: arm.id, live: false },
        blockedOn: {
          capability: 'ads.campaign_manage',
          reason: `Creative ${concept.id} is "${concept.status}", not human_approved. The arm is not live.`,
        },
      };
    }

    const adapter = this.#adsAdapter(experiment.platform);
    if (!adapter) {
      return blocked('ads.campaign_manage', this.#reason('ads.campaign_manage'));
    }

    const landingUrl = input.landingUrl ?? new URL(arm.landing_path, this.deps.publicBaseUrl).toString();

    try {
      if (experiment.platform === 'meta') {
        return await this.#launchMeta(adapter, experiment, arm, landingUrl);
      }
      if (experiment.platform === 'google') {
        return await this.#launchGoogle(adapter, experiment, arm);
      }
      return {
        ok: false,
        data: { armId: arm.id, live: false },
        blockedOn: {
          capability: 'ads.campaign_manage',
          reason: `Platform "${experiment.platform}" has no campaign adapter in this service; arm is not live.`,
        },
      };
    } catch (error) {
      return this.#fromProviderError('ads.campaign_manage', error);
    }
  }

  async pauseArm(input: { armId: string }): Promise<ServiceOutcome<{ armId: string }>> {
    const arm = await this.deps.repos.growth.experiments.armById(input.armId);
    const experiment = await this.deps.repos.growth.experiments.byId(arm.experiment_id);
    const adapter = this.#adsAdapter(experiment.platform);
    if (!adapter) return blocked('ads.campaign_manage', this.#reason('ads.campaign_manage'));

    try {
      if (arm.external_refs.adset_id && adapter.pauseAdSet) await adapter.pauseAdSet(arm.external_refs.adset_id);
      else if (arm.external_refs.ad_id && adapter.pauseAd) await adapter.pauseAd(arm.external_refs.ad_id);
      else if (arm.external_refs.campaign_id && adapter.pauseCampaign) {
        await adapter.pauseCampaign(arm.external_refs.campaign_id);
      } else if (arm.external_refs.campaign_resource_name && adapter.pauseCampaign) {
        await adapter.pauseCampaign(arm.external_refs.campaign_resource_name);
      }
      await this.deps.repos.growth.experiments.setArmStatus(arm.id, 'paused', 'paused via MarketingExperimentService.pauseArm');
      return { ok: true, data: { armId: arm.id } };
    } catch (error) {
      return this.#fromProviderError('ads.campaign_manage', error);
    }
  }

  async scaleArm(input: { armId: string; dailyBudgetMinor: number }): Promise<ServiceOutcome<{
    armId: string;
    dailyBudgetMinor: number;
  }>> {
    const arm = await this.deps.repos.growth.experiments.armById(input.armId);
    const experiment = await this.deps.repos.growth.experiments.byId(arm.experiment_id);
    const company = await this.deps.repos.companies.byId(experiment.company_id);
    const config = companyConfig(company);
    const ceiling = Math.min(config.risk.maxDailyAdSpendMinor, experiment.total_budget_minor);
    const scaled = Math.min(input.dailyBudgetMinor, ceiling, Math.round(arm.daily_budget_minor * 1.5));
    if (scaled <= arm.daily_budget_minor) {
      return {
        ok: false,
        data: { armId: arm.id, dailyBudgetMinor: arm.daily_budget_minor },
        blockedOn: {
          capability: 'ads.campaign_manage',
          reason: `Requested budget ${input.dailyBudgetMinor} is not above current ${arm.daily_budget_minor} after applying spend ceilings (daily cap ${ceiling}).`,
        },
      };
    }

    const adapter = this.#adsAdapter(experiment.platform);
    if (!adapter) return blocked('ads.campaign_manage', this.#reason('ads.campaign_manage'));

    try {
      if (arm.external_refs.adset_id && adapter.updateAdSetBudget) {
        await adapter.updateAdSetBudget(arm.external_refs.adset_id, { dailyBudgetMinor: scaled });
      } else if (arm.external_refs.campaign_budget_resource_name && adapter.updateCampaignBudget) {
        await adapter.updateCampaignBudget(arm.external_refs.campaign_budget_resource_name, scaled * 10_000);
      } else {
        return blocked('ads.campaign_manage', 'Arm has no ad set or campaign budget ref to update');
      }
      await this.deps.repos.growth.experiments.setArmBudget(arm.id, scaled);
      return { ok: true, data: { armId: arm.id, dailyBudgetMinor: scaled } };
    } catch (error) {
      return this.#fromProviderError('ads.campaign_manage', error);
    }
  }

  async collectMetrics(input: {
    experimentId: string;
    windowStartIso: string;
    windowEndIso: string;
  }): Promise<ServiceOutcome<{ snapshots: number }>> {
    const experiment = await this.deps.repos.growth.experiments.byId(input.experimentId);
    const adapter = this.#adsAdapter(experiment.platform, 'ads.metrics_read');
    if (!adapter) return blocked('ads.metrics_read', this.#reason('ads.metrics_read'));
    if (typeof adapter.toMetricSnapshot !== 'function') {
      return blocked(
        'ads.metrics_read',
        'Adapter has no toMetricSnapshot mapper; refusing to invent CTR/CAC from raw rows.',
      );
    }

    const since = input.windowStartIso.slice(0, 10);
    const until = input.windowEndIso.slice(0, 10);
    const arms = await this.deps.repos.growth.experiments.arms(experiment.id);
    let snapshots = 0;

    try {
      for (const arm of arms) {
        const objectId =
          arm.external_refs.adset_id ??
          arm.external_refs.campaign_id ??
          arm.external_refs.campaign_resource_name;
        if (!objectId) continue;

        const rows =
          experiment.platform === 'google' && adapter.getMetrics
            ? await adapter.getMetrics({
                resourceType: 'campaign',
                resourceResourceName: arm.external_refs.campaign_resource_name ?? objectId,
                since,
                until,
              })
            : adapter.getInsights
              ? await adapter.getInsights({
                  objectId,
                  level: arm.external_refs.adset_id ? 'adset' : 'campaign',
                  since,
                  until,
                })
              : [];

        const snapshot = adapter.toMetricSnapshot(rows, {
          companyId: experiment.company_id,
          scope: 'arm',
          scopeRefId: arm.id,
          currency: experiment.currency,
          windowStart: input.windowStartIso,
          windowEnd: input.windowEndIso,
        });
        await this.deps.repos.growth.metrics.upsert(snapshot);
        snapshots += 1;
      }
      return { ok: true, data: { snapshots } };
    } catch (error) {
      return this.#fromProviderError('ads.metrics_read', error);
    }
  }

  async decideArms(input: {
    experimentId: string;
    unitContributionMinor: number;
  }): Promise<ServiceOutcome<readonly { armId: string; decision: ArmDecision }[]>> {
    if (!Number.isFinite(input.unitContributionMinor) || input.unitContributionMinor <= 0) {
      return {
        ok: false,
        blockedOn: {
          capability: 'ads.campaign_manage',
          reason:
            'Unit contribution is not modelled from economics; refusing to decide arms with a zero or invented contribution.',
        },
      };
    }
    const decided = await this.deps.repos.growth.metrics.decideArms(input.experimentId, input.unitContributionMinor);
    const applied: { armId: string; decision: ArmDecision }[] = [];
    for (const row of decided) {
      applied.push({ armId: row.arm.id, decision: row.decision });
      if (row.decision.kind === 'kill') {
        await this.pauseArm({ armId: row.arm.id });
        await this.deps.repos.growth.experiments.setArmStatus(row.arm.id, 'stopped', row.decision.reason);
      } else if (row.decision.kind === 'scale') {
        const next = Math.round(row.arm.daily_budget_minor * row.decision.suggestedBudgetMultiplier);
        await this.scaleArm({ armId: row.arm.id, dailyBudgetMinor: next });
      }
    }
    return { ok: true, data: applied };
  }

  #adsAdapter(platform: string, capability: Capability = 'ads.campaign_manage'): AdsLaunchAdapter | undefined {
    if (platform === 'meta') {
      return optionalCapability<MetaAdsAdapter>(this.deps, capability) as AdsLaunchAdapter | undefined;
    }
    if (platform === 'google') {
      return optionalCapability<GoogleAdsAdapter>(this.deps, capability) as AdsLaunchAdapter | undefined;
    }
    return optionalCapability<AdsLaunchAdapter>(this.deps, capability);
  }

  async #launchMeta(
    adapter: AdsLaunchAdapter,
    experiment: { id: string; name: string; audience_spec: Record<string, unknown>; objective: string },
    arm: { id: string; name: string; daily_budget_minor: number },
    landingUrl: string,
  ): Promise<ServiceOutcome<{ armId: string; live: boolean }>> {
    const targeting = experiment.audience_spec['targeting'];
    if (!targeting || typeof targeting !== 'object') {
      return blocked(
        'ads.campaign_manage',
        'audience_spec.targeting is required to create a Meta ad set; inventing geo/age targeting is forbidden.',
      );
    }
    if (!adapter.createCampaign || !adapter.createAdSet) {
      return blocked('ads.campaign_manage', 'Meta adapter is missing createCampaign/createAdSet');
    }

    const campaign = await adapter.createCampaign({
      name: `${experiment.name}:${arm.name}`,
      objective: 'OUTCOME_SALES',
      specialAdCategories: Array.isArray(experiment.audience_spec['specialAdCategories'])
        ? experiment.audience_spec['specialAdCategories']
        : [],
    });
    const campaignId = campaign.id;
    if (!campaignId) return blocked('ads.campaign_manage', 'Meta createCampaign returned no id');
    await this.deps.repos.growth.experiments.setArmExternalRef(arm.id, 'campaign_id', campaignId);

    const adSet = await adapter.createAdSet({
      campaignId,
      name: arm.name,
      dailyBudgetMinor: arm.daily_budget_minor,
      billingEvent: 'IMPRESSIONS',
      optimizationGoal: 'OFFSITE_CONVERSIONS',
      targeting,
    });
    await this.deps.repos.growth.experiments.setArmExternalRef(arm.id, 'adset_id', adSet.id);
    await this.deps.repos.growth.experiments.setArmExternalRef(arm.id, 'landing_url', landingUrl);

    if (adapter.activateCampaign) await adapter.activateCampaign(campaignId);
    await this.deps.repos.growth.experiments.setArmStatus(arm.id, 'live');
    return { ok: true, data: { armId: arm.id, live: true } };
  }

  async #launchGoogle(
    adapter: AdsLaunchAdapter,
    experiment: { id: string; name: string; currency: string },
    arm: { id: string; name: string; daily_budget_minor: number },
  ): Promise<ServiceOutcome<{ armId: string; live: boolean }>> {
    if (!adapter.createCampaignBudget || !adapter.createCampaign) {
      return blocked('ads.campaign_manage', 'Google Ads adapter is missing createCampaignBudget/createCampaign');
    }
    const budget = await adapter.createCampaignBudget({
      name: `${experiment.name}:${arm.name}:budget`,
      amountMicros: arm.daily_budget_minor * 10_000,
    });
    await this.deps.repos.growth.experiments.setArmExternalRef(arm.id, 'campaign_budget_resource_name', budget.resourceName);

    const campaign = await adapter.createCampaign({
      name: `${experiment.name}:${arm.name}`,
      campaignBudgetResourceName: budget.resourceName,
      advertisingChannelType: 'SEARCH',
    });
    const resourceName = campaign.resourceName ?? campaign.id;
    if (!resourceName) return blocked('ads.campaign_manage', 'Google createCampaign returned no resource name');
    await this.deps.repos.growth.experiments.setArmExternalRef(arm.id, 'campaign_resource_name', resourceName);

    // Google campaigns are created PAUSED; this adapter has no activate method.
    await this.deps.repos.growth.experiments.setArmStatus(arm.id, 'ready');
    return {
      ok: true,
      data: { armId: arm.id, live: false },
    };
  }

  #reason(capability: Capability): string {
    const status = this.deps.providers.forCapability(capability).status;
    return status.remediation ?? `capability state is ${status.state}`;
  }

  #fromProviderError<T>(capability: Capability, error: unknown): ServiceOutcome<T> {
    if (error instanceof CredentialsMissingError || error instanceof CapabilityUnsupportedError) {
      return blocked(capability, error.message);
    }
    throw error;
  }
}

function blocked<T>(capability: Capability, reason: string): ServiceOutcome<T> {
  return { ok: false, blockedOn: { capability, reason } };
}
