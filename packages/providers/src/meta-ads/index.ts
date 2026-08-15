/**
 * Meta Ads adapter — campaign, ad set, creative and insights management on
 * the Marketing API. Structured like `../stripe/index.ts`: narrow zod
 * schemas in `./schemas.ts`, one adapter class, comments that explain *why*.
 * Every method makes a real HTTP call through the shared `ProviderHttpClient`;
 * with no `META_ADS_ACCESS_TOKEN` configured, `requireSecret` raises a typed
 * `CredentialsMissingError`.
 *
 * Two Marketing-API-specific conventions shape this file:
 *   - Complex params (`special_ad_categories`, `targeting`, `object_story_spec`,
 *     `creative`) are sent as JSON-encoded *string values* inside a
 *     form-encoded body. That is the long-documented Marketing API convention
 *     for nested params, independent of API version, and it is what every
 *     official Meta SDK does under the hood — it is deliberately not sent via
 *     the shared client's bracket-notation form encoder, which would produce
 *     a shape Meta does not accept.
 *   - Every campaign, ad set and ad this adapter creates is left `PAUSED`.
 *     `activateCampaign` / `resumeAdSet` are separate, deliberate calls, so an
 *     agent cannot spend money as a side effect of building a campaign.
 */

import {
  FoundryError,
  Money,
  ProviderAuthError,
  RateLimitError,
  ValidationError,
  newId,
  MetricSnapshot,
} from '@foundry/core';
import { ProviderAdapter, type AdapterContext, type ProbeResult } from '../http/adapter.js';
import { bearerAuth, type ProviderHttpClient } from '../http/client.js';
import { SECRETS, META_ADS_MANIFEST } from '../manifests.js';
import { META_ADS_BASE_URL, META_AUTH_ERROR_CODE, META_MARKETING_API_VERSION, META_RETRYABLE_ERROR_CODES } from './constants.js';
import {
  MetaAccountProbe,
  MetaActionValue,
  MetaAdImageResponse,
  MetaIdResponse,
  MetaInsightsResponse,
  MetaInsightsRow,
  extractMetaError,
} from './schemas.js';

export interface CreateCampaignInput {
  readonly name: string;
  /** e.g. `OUTCOME_SALES` — kept as a plain string rather than a hard-coded enum, because Meta's objective list evolves. */
  readonly objective: string;
  /** Required by Meta on every campaign; pass `[]` when none apply. Never defaulted silently. */
  readonly specialAdCategories: readonly string[];
  readonly buyingType?: string;
}

export interface CreateAdSetInput {
  readonly campaignId: string;
  readonly name: string;
  readonly dailyBudgetMinor?: number;
  readonly lifetimeBudgetMinor?: number;
  readonly billingEvent: string;
  readonly optimizationGoal: string;
  readonly bidAmountMinor?: number;
  readonly targeting: Readonly<Record<string, unknown>>;
  readonly startTime?: string;
  readonly endTime?: string;
}

export interface CreateAdCreativeInput {
  readonly name: string;
  readonly pageId: string;
  readonly imageHash?: string;
  readonly message: string;
  readonly link: string;
  readonly callToActionType?: string;
}

export interface GetInsightsInput {
  readonly objectId: string;
  readonly level: 'account' | 'campaign' | 'adset' | 'ad';
  /** `YYYY-MM-DD`, inclusive — Meta's own date format for `time_range`. */
  readonly since: string;
  readonly until: string;
}

export interface ToMetricSnapshotInput {
  readonly companyId: string;
  readonly scope: MetricSnapshot['scope'];
  readonly scopeRefId: string;
  readonly currency: string;
  readonly windowStart: string;
  readonly windowEnd: string;
}

const PURCHASE_ACTION_TYPES = ['purchase', 'omni_purchase', 'offsite_conversion.fb_pixel_purchase'];
const ADD_TO_CART_ACTION_TYPES = ['add_to_cart', 'omni_add_to_cart', 'offsite_conversion.fb_pixel_add_to_cart'];
const CHECKOUT_ACTION_TYPES = [
  'initiate_checkout',
  'omni_initiated_checkout',
  'offsite_conversion.fb_pixel_initiate_checkout',
];
const LANDING_VIEW_ACTION_TYPES = ['landing_page_view', 'omni_landing_page_view'];

export class MetaAdsAdapter extends ProviderAdapter {
  override readonly manifest = META_ADS_MANIFEST;
  #client: ProviderHttpClient | undefined;

  constructor(ctx: AdapterContext) {
    super(ctx);
  }

  #httpClient(): ProviderHttpClient {
    if (!this.#client) {
      const token = this.requireSecret(SECRETS.metaAdsAccessToken);
      this.#client = this.http(bearerAuth(token), {
        baseUrl: META_ADS_BASE_URL,
        classifyError: (status, body) => this.#classifyError(status, body),
      });
    }
    return this.#client;
  }

  #accountId(): string {
    const raw = this.requireSecret(SECRETS.metaAdsAccountId).reveal();
    return raw.startsWith('act_') ? raw : `act_${raw}`;
  }

  /**
   * Codes 17 ("user request limit reached") and 613 (custom rate-limit hit)
   * are documented throttling and get retried like any other rate limit.
   * Code 190 (expired/invalid token) is terminal until a human re-authorises
   * — retrying it would just burn the retry budget against a token that will
   * never start working again on its own.
   */
  #classifyError(status: number, body: unknown): FoundryError | undefined {
    const error = extractMetaError(body);
    if (!error) return undefined;
    if (error.code === META_AUTH_ERROR_CODE) {
      return new ProviderAuthError('meta_ads', `access token invalid or expired (code 190): ${error.message}`, {
        code: error.code,
        subcode: error.error_subcode,
        fbtraceId: error.fbtrace_id,
      });
    }
    if (error.code !== undefined && META_RETRYABLE_ERROR_CODES.has(error.code)) {
      return new RateLimitError('meta_ads', undefined, {
        code: error.code,
        message: error.message,
        fbtraceId: error.fbtrace_id,
        httpStatus: status,
      });
    }
    return undefined;
  }

  /* ---------------------------------------------------------------------- */
  /* Probe                                                                    */
  /* ---------------------------------------------------------------------- */

  override async probe(): Promise<ProbeResult> {
    const accountId = this.#accountId();
    const res = await this.#httpClient().request(
      {
        method: 'GET',
        path: `/${accountId}`,
        operation: 'account.probe',
        query: { fields: 'account_status,currency,name' },
      },
      MetaAccountProbe,
    );
    return {
      succeeded: true,
      detail: `GET /${accountId}?fields=account_status,currency,name succeeded (${META_MARKETING_API_VERSION})`,
      evidence: {
        endpoint: `GET /${accountId}`,
        apiVersion: META_MARKETING_API_VERSION,
        accountStatus: res.body.account_status,
        currency: res.body.currency,
      },
    };
  }

  /* ---------------------------------------------------------------------- */
  /* Campaign / ad set / creative / ad                                       */
  /* ---------------------------------------------------------------------- */

  /** All campaigns are created PAUSED — see `activateCampaign`. */
  async createCampaign(input: CreateCampaignInput): Promise<{ id: string }> {
    this.assertActivated();
    const res = await this.#httpClient().request(
      {
        method: 'POST',
        path: `/${this.#accountId()}/campaigns`,
        operation: 'campaigns.create',
        form: true,
        body: {
          name: input.name,
          objective: input.objective,
          status: 'PAUSED',
          special_ad_categories: JSON.stringify(input.specialAdCategories),
          ...(input.buyingType ? { buying_type: input.buyingType } : {}),
        },
      },
      MetaIdResponse,
    );
    return res.body;
  }

  async createAdSet(input: CreateAdSetInput): Promise<{ id: string }> {
    this.assertActivated();
    if (!input.dailyBudgetMinor && !input.lifetimeBudgetMinor) {
      throw new ValidationError('createAdSet requires either dailyBudgetMinor or lifetimeBudgetMinor', {
        campaignId: input.campaignId,
      });
    }
    const res = await this.#httpClient().request(
      {
        method: 'POST',
        path: `/${this.#accountId()}/adsets`,
        operation: 'adsets.create',
        form: true,
        body: {
          name: input.name,
          campaign_id: input.campaignId,
          billing_event: input.billingEvent,
          optimization_goal: input.optimizationGoal,
          targeting: JSON.stringify(input.targeting),
          // Inherits PAUSED from the parent campaign in practice, but Meta
          // still honours an explicit status on create, and being explicit
          // here means this is never accidentally live even if a future
          // campaign default changes.
          status: 'PAUSED',
          ...(input.dailyBudgetMinor ? { daily_budget: input.dailyBudgetMinor } : {}),
          ...(input.lifetimeBudgetMinor ? { lifetime_budget: input.lifetimeBudgetMinor } : {}),
          ...(input.bidAmountMinor ? { bid_amount: input.bidAmountMinor } : {}),
          ...(input.startTime ? { start_time: input.startTime } : {}),
          ...(input.endTime ? { end_time: input.endTime } : {}),
        },
      },
      MetaIdResponse,
    );
    return res.body;
  }

  /**
   * `POST /act_{id}/adimages`. Sent as a base64 `bytes` field rather than a
   * multipart file upload — the shared `ProviderHttpClient` only supports
   * JSON and form-urlencoded bodies, and `bytes` is Meta's own documented
   * alternative to a multipart upload, not a workaround. Meta keys the
   * response by whatever field name was used for the upload, which is why
   * this returns the whole `images` record rather than a single hash: the
   * caller knows which key it uploaded under, this method does not assume it.
   */
  async uploadAdImage(input: { readonly bytes: Buffer; readonly fieldName?: string }): Promise<MetaAdImageResponse> {
    this.assertActivated();
    const fieldName = input.fieldName ?? 'bytes';
    const res = await this.#httpClient().request(
      {
        method: 'POST',
        path: `/${this.#accountId()}/adimages`,
        operation: 'adimages.upload',
        form: true,
        body: { [fieldName]: input.bytes.toString('base64') },
      },
      MetaAdImageResponse,
    );
    return res.body;
  }

  async createAdCreative(input: CreateAdCreativeInput): Promise<{ id: string }> {
    this.assertActivated();
    const linkData: Record<string, unknown> = {
      message: input.message,
      link: input.link,
      ...(input.imageHash ? { image_hash: input.imageHash } : {}),
      ...(input.callToActionType ? { call_to_action: { type: input.callToActionType } } : {}),
    };
    const res = await this.#httpClient().request(
      {
        method: 'POST',
        path: `/${this.#accountId()}/adcreatives`,
        operation: 'adcreatives.create',
        form: true,
        body: {
          name: input.name,
          object_story_spec: JSON.stringify({ page_id: input.pageId, link_data: linkData }),
        },
      },
      MetaIdResponse,
    );
    return res.body;
  }

  /** All ads are created PAUSED, same reasoning as `createCampaign`. */
  async createAd(input: { readonly name: string; readonly adSetId: string; readonly creativeId: string }): Promise<{ id: string }> {
    this.assertActivated();
    const res = await this.#httpClient().request(
      {
        method: 'POST',
        path: `/${this.#accountId()}/ads`,
        operation: 'ads.create',
        form: true,
        body: {
          name: input.name,
          adset_id: input.adSetId,
          creative: JSON.stringify({ creative_id: input.creativeId }),
          status: 'PAUSED',
        },
      },
      MetaIdResponse,
    );
    return res.body;
  }

  async updateAdSetBudget(
    adSetId: string,
    input: { readonly dailyBudgetMinor?: number; readonly lifetimeBudgetMinor?: number },
  ): Promise<{ id: string }> {
    this.assertActivated();
    if (!input.dailyBudgetMinor && !input.lifetimeBudgetMinor) {
      throw new ValidationError('updateAdSetBudget requires either dailyBudgetMinor or lifetimeBudgetMinor', { adSetId });
    }
    const res = await this.#httpClient().request(
      {
        method: 'POST',
        path: `/${adSetId}`,
        operation: 'adsets.updateBudget',
        form: true,
        body: {
          ...(input.dailyBudgetMinor ? { daily_budget: input.dailyBudgetMinor } : {}),
          ...(input.lifetimeBudgetMinor ? { lifetime_budget: input.lifetimeBudgetMinor } : {}),
        },
      },
      MetaIdResponse,
    );
    return res.body;
  }

  async pauseAd(adId: string): Promise<{ id: string }> {
    this.assertActivated();
    const res = await this.#httpClient().request(
      { method: 'POST', path: `/${adId}`, operation: 'ads.pause', form: true, body: { status: 'PAUSED' } },
      MetaIdResponse,
    );
    return res.body;
  }

  async pauseAdSet(adSetId: string): Promise<{ id: string }> {
    this.assertActivated();
    const res = await this.#httpClient().request(
      { method: 'POST', path: `/${adSetId}`, operation: 'adsets.pause', form: true, body: { status: 'PAUSED' } },
      MetaIdResponse,
    );
    return res.body;
  }

  async resumeAdSet(adSetId: string): Promise<{ id: string }> {
    this.assertActivated();
    const res = await this.#httpClient().request(
      { method: 'POST', path: `/${adSetId}`, operation: 'adsets.resume', form: true, body: { status: 'ACTIVE' } },
      MetaIdResponse,
    );
    return res.body;
  }

  /**
   * The explicit activation step every campaign needs after `createCampaign`
   * makes it PAUSED. Kept as its own method rather than a create-time flag so
   * turning spend on is always a second, deliberate call an agent has to make
   * — creation alone can never start spending.
   */
  async activateCampaign(campaignId: string): Promise<{ id: string }> {
    this.assertActivated();
    const res = await this.#httpClient().request(
      { method: 'POST', path: `/${campaignId}`, operation: 'campaigns.activate', form: true, body: { status: 'ACTIVE' } },
      MetaIdResponse,
    );
    return res.body;
  }

  async pauseCampaign(campaignId: string): Promise<{ id: string }> {
    this.assertActivated();
    const res = await this.#httpClient().request(
      { method: 'POST', path: `/${campaignId}`, operation: 'campaigns.pause', form: true, body: { status: 'PAUSED' } },
      MetaIdResponse,
    );
    return res.body;
  }

  /* ---------------------------------------------------------------------- */
  /* Insights                                                                 */
  /* ---------------------------------------------------------------------- */

  async getInsights(input: GetInsightsInput): Promise<readonly MetaInsightsRow[]> {
    this.assertActivated();
    const res = await this.#httpClient().request(
      {
        method: 'GET',
        path: `/${input.objectId}/insights`,
        operation: 'insights.get',
        query: {
          level: input.level,
          time_range: JSON.stringify({ since: input.since, until: input.until }),
          fields: 'impressions,reach,clicks,spend,actions,action_values',
        },
      },
      MetaInsightsResponse,
    );
    return res.body.data;
  }

  /**
   * Maps raw Insights rows onto core's `MetricSnapshot`. Only fields Meta
   * actually returned are populated with a real value; `refundsMinor`,
   * `contributionMarginMinor`, `repeatPurchases` and `supportContacts` have no
   * platform-API equivalent at all and are left at the schema's own "not
   * observed" default of 0 — they are never estimated here. A caller that
   * needs them merges this snapshot with a `first_party` or
   * `payment_provider`-sourced one for the same scope.
   */
  toMetricSnapshot(rows: readonly MetaInsightsRow[], input: ToMetricSnapshotInput): MetricSnapshot {
    const allActions: MetaActionValue[] = rows.flatMap((r) => r.actions ?? []);
    const allActionValues: MetaActionValue[] = rows.flatMap((r) => r.action_values ?? []);

    return MetricSnapshot.parse({
      id: newId('metricSnapshot'),
      companyId: input.companyId,
      scope: input.scope,
      scopeRefId: input.scopeRefId,
      source: 'platform_api',
      windowStart: input.windowStart,
      windowEnd: input.windowEnd,
      currency: input.currency,
      impressions: sumIntField(rows, 'impressions'),
      reach: sumIntField(rows, 'reach'),
      clicks: sumIntField(rows, 'clicks'),
      spendMinor: sumMoneyField(rows, input.currency),
      landingPageViews: sumActionCount(allActions, LANDING_VIEW_ACTION_TYPES),
      addToCarts: sumActionCount(allActions, ADD_TO_CART_ACTION_TYPES),
      checkoutStarts: sumActionCount(allActions, CHECKOUT_ACTION_TYPES),
      purchases: sumActionCount(allActions, PURCHASE_ACTION_TYPES),
      revenueMinor: sumActionValueMinor(allActionValues, PURCHASE_ACTION_TYPES, input.currency),
      refundsMinor: 0,
      contributionMarginMinor: 0,
      repeatPurchases: 0,
      supportContacts: 0,
      collectedAt: new Date().toISOString(),
    });
  }
}

/* -------------------------------------------------------------------------- */
/* Aggregation helpers — Meta returns every Insights number as a string       */
/* -------------------------------------------------------------------------- */

function sumIntField(rows: readonly MetaInsightsRow[], field: 'impressions' | 'reach' | 'clicks'): number {
  let total = 0;
  for (const row of rows) {
    const value = row[field];
    if (value !== undefined) total += Number.parseInt(value, 10) || 0;
  }
  return total;
}

/** Sums via `Money`, never floats, even though the source values are already-imprecise platform-reported strings. */
function sumMoneyField(rows: readonly MetaInsightsRow[], currency: string): number {
  const parts: Money[] = [];
  for (const row of rows) {
    if (row.spend !== undefined) parts.push(Money.of(row.spend, currency, 6));
  }
  if (parts.length === 0) return 0;
  return Money.sum(parts, currency).toProviderMinorUnits();
}

function sumActionValueMinor(actionValues: readonly MetaActionValue[], types: readonly string[], currency: string): number {
  const parts: Money[] = [];
  for (const action of actionValues) {
    if (types.includes(action.action_type)) parts.push(Money.of(action.value, currency, 6));
  }
  if (parts.length === 0) return 0;
  return Money.sum(parts, currency).toProviderMinorUnits();
}

/** Action *counts* (not money) — Meta's modelled/off-platform attribution can report fractional counts; rounded once at the end. */
function sumActionCount(actions: readonly MetaActionValue[], types: readonly string[]): number {
  let total = 0;
  for (const action of actions) {
    if (types.includes(action.action_type)) total += Number.parseFloat(action.value) || 0;
  }
  return Math.round(total);
}

export * from './constants.js';
export * from './schemas.js';
