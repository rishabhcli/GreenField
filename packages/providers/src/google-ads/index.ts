/**
 * Google Ads adapter — GAQL search, campaign/ad-group/ad mutation and
 * metrics, on the REST surface of the Google Ads API. Structured like
 * `../stripe/index.ts`: narrow zod schemas in `./schemas.ts`, one adapter
 * class, comments that explain *why*.
 *
 * Auth is the part that differs from every other adapter in this package:
 * Google Ads uses OAuth2 refresh-token exchange rather than a static bearer
 * token, plus two extra headers (`developer-token`, and `login-customer-id`
 * when the account sits under a manager account). `#refreshAccessToken`
 * caches the token until shortly before expiry, and `#call` refreshes it
 * exactly once and retries exactly once after an authentication error —
 * per the manifest's own documented failure behaviour — rather than treating
 * every auth failure as immediately terminal or retrying it indefinitely.
 */

import {
  FoundryError,
  Money,
  ProviderAuthError,
  ProviderContractError,
  RateLimitError,
  ValidationError,
  newId,
  MetricSnapshot,
} from '@foundry/core';
import { ProviderAdapter, type AdapterContext, type ProbeResult } from '../http/adapter.js';
import { ProviderHttpClient, noAuth, type AuthApplier } from '../http/client.js';
import { SECRETS, GOOGLE_ADS_MANIFEST } from '../manifests.js';
import {
  GOOGLE_ADS_API_VERSION,
  GOOGLE_ADS_BASE_URL,
  GOOGLE_ADS_LOGIN_CUSTOMER_ID_SECRET,
  GOOGLE_OAUTH_BASE_URL,
  GOOGLE_OAUTH_TOKEN_PATH,
} from './constants.js';
import {
  GoogleAdsMetricsFragment,
  GoogleAdsMutateResponse,
  GoogleAdsMutateResult,
  GoogleAdsRow,
  GoogleAdsSearchResponse,
  GoogleAdsSearchStreamResponse,
  GoogleOAuthTokenResponse,
  extractGoogleAdsError,
} from './schemas.js';

const TOKEN_REFRESH_BUFFER_MS = 60_000;

export interface ToMetricSnapshotInput {
  readonly companyId: string;
  readonly scope: MetricSnapshot['scope'];
  readonly scopeRefId: string;
  readonly currency: string;
  readonly windowStart: string;
  readonly windowEnd: string;
}

export interface GetMetricsInput {
  readonly resourceType: 'campaign' | 'ad_group' | 'customer';
  /** Resource name to scope to; omit to report across the whole customer. */
  readonly resourceResourceName?: string;
  /** `YYYY-MM-DD`, inclusive. */
  readonly since: string;
  readonly until: string;
}

export interface CreateCampaignInput {
  readonly name: string;
  readonly campaignBudgetResourceName: string;
  /** e.g. `SEARCH`, `DISPLAY` — kept as a plain string; Google's channel-type enum evolves. */
  readonly advertisingChannelType: string;
  readonly networkSettings?: Readonly<Record<string, unknown>>;
}

export interface CreateResponsiveSearchAdInput {
  readonly adGroupResourceName: string;
  /** Google requires 3-15; enforced here as a minimum of 3, the rest is the caller's responsibility. */
  readonly headlines: readonly string[];
  /** Google requires 2-4; enforced here as a minimum of 2. */
  readonly descriptions: readonly string[];
  readonly finalUrls: readonly string[];
}

export class GoogleAdsAdapter extends ProviderAdapter {
  override readonly manifest = GOOGLE_ADS_MANIFEST;
  #client: ProviderHttpClient | undefined;
  #tokenClient: ProviderHttpClient | undefined;
  #cachedToken: { readonly token: string; readonly expiresAtMs: number } | undefined;

  constructor(ctx: AdapterContext) {
    super(ctx);
  }

  #customerId(): string {
    return this.requireSecret(SECRETS.googleAdsCustomerId).reveal().replace(/-/g, '');
  }

  #loginCustomerId(): string | undefined {
    return this.optionalSecret(GOOGLE_ADS_LOGIN_CUSTOMER_ID_SECRET)?.reveal();
  }

  /**
   * Caches the access token until 60s before expiry, so a burst of calls does
   * not re-mint one per request. `force` is used exactly once, by `#call`,
   * immediately after a fresh auth error.
   */
  async #refreshAccessToken(force = false): Promise<string> {
    const now = Date.now();
    if (!force && this.#cachedToken && now < this.#cachedToken.expiresAtMs - TOKEN_REFRESH_BUFFER_MS) {
      return this.#cachedToken.token;
    }
    const clientId = this.requireSecret(SECRETS.googleAdsClientId);
    const clientSecret = this.requireSecret(SECRETS.googleAdsClientSecret);
    const refreshToken = this.requireSecret(SECRETS.googleAdsRefreshToken);

    if (!this.#tokenClient) {
      // A separate client because the token endpoint lives on a different
      // host (`oauth2.googleapis.com`) than the Ads API itself; still routed
      // through `ProviderHttpClient` rather than a bare `fetch`, so retry,
      // breaker and error classification behave the same as every other call.
      this.#tokenClient = new ProviderHttpClient({
        provider: 'google_ads',
        baseUrl: GOOGLE_OAUTH_BASE_URL,
        auth: noAuth(),
        defaultTimeoutMs: 15_000,
      });
    }

    const res = await this.#tokenClient.request(
      {
        method: 'POST',
        path: GOOGLE_OAUTH_TOKEN_PATH,
        operation: 'oauth.refresh',
        form: true,
        body: {
          client_id: clientId.reveal(),
          client_secret: clientSecret.reveal(),
          refresh_token: refreshToken.reveal(),
          grant_type: 'refresh_token',
        },
      },
      GoogleOAuthTokenResponse,
    );
    this.#cachedToken = { token: res.body.access_token, expiresAtMs: now + res.body.expires_in * 1000 };
    return this.#cachedToken.token;
  }

  #authApplier(): AuthApplier {
    return (headers) => {
      // `#call` always awaits `#refreshAccessToken()` before issuing a
      // request, so by the time this synchronous applier runs, a token is
      // guaranteed to be cached. Throwing here rather than sending an
      // unauthenticated call is the honest failure mode if that invariant is
      // ever violated by a future caller that bypasses `#call`.
      if (!this.#cachedToken) {
        throw new ValidationError('Google Ads request attempted before an OAuth access token was obtained');
      }
      headers['authorization'] = `Bearer ${this.#cachedToken.token}`;
      headers['developer-token'] = this.requireSecret(SECRETS.googleAdsDeveloperToken).reveal();
      const loginCustomerId = this.#loginCustomerId();
      if (loginCustomerId) headers['login-customer-id'] = loginCustomerId;
    };
  }

  #httpClient(): ProviderHttpClient {
    if (!this.#client) {
      this.#client = this.http(this.#authApplier(), {
        baseUrl: GOOGLE_ADS_BASE_URL,
        classifyError: (status, body) => this.#classifyError(status, body),
      });
    }
    return this.#client;
  }

  /**
   * `RESOURCE_EXHAUSTED` (quota) is retried like any rate limit.
   * `UNAUTHENTICATED`/an `authenticationError` or `authorizationError` code is
   * reported as an auth error; `#call` treats that as "refresh the token once,
   * then retry once" rather than immediately terminal, per the manifest's
   * documented failure behaviour.
   */
  #classifyError(status: number, body: unknown): FoundryError | undefined {
    const extracted = extractGoogleAdsError(body);
    if (!extracted) return undefined;
    if (extracted.status === 'RESOURCE_EXHAUSTED' || extracted.errorCodes.some((c) => 'quotaError' in c)) {
      return new RateLimitError('google_ads', undefined, { message: extracted.topMessage, httpStatus: status });
    }
    if (
      extracted.status === 'UNAUTHENTICATED' ||
      extracted.errorCodes.some((c) => 'authenticationError' in c || 'authorizationError' in c)
    ) {
      return new ProviderAuthError('google_ads', extracted.topMessage, {
        httpStatus: status,
        errorCodes: extracted.errorCodes,
      });
    }
    return undefined;
  }

  /** Ensures a fresh token, runs `fn`, and on an auth error refreshes once (forced) and retries exactly once. */
  async #call<T>(fn: () => Promise<T>): Promise<T> {
    await this.#refreshAccessToken();
    try {
      return await fn();
    } catch (error) {
      if (error instanceof FoundryError && error.category === 'auth') {
        await this.#refreshAccessToken(true);
        return await fn();
      }
      throw error;
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Probe                                                                    */
  /* ---------------------------------------------------------------------- */

  override async probe(): Promise<ProbeResult> {
    const rows = await this.searchStream('SELECT customer.id FROM customer LIMIT 1');
    return {
      succeeded: true,
      detail: `GoogleAdsService.SearchStream returned ${rows.length} row(s) (API ${GOOGLE_ADS_API_VERSION})`,
      evidence: {
        endpoint: 'POST /customers/{id}/googleAds:searchStream',
        apiVersion: GOOGLE_ADS_API_VERSION,
        rowCount: rows.length,
      },
    };
  }

  /* ---------------------------------------------------------------------- */
  /* GAQL                                                                     */
  /* ---------------------------------------------------------------------- */

  /** `googleAds:search` — one page; use for small, bounded result sets. */
  async search(query: string): Promise<readonly GoogleAdsRow[]> {
    this.assertActivated();
    return this.#call(async () => {
      const res = await this.#httpClient().request(
        { method: 'POST', path: `/customers/${this.#customerId()}/googleAds:search`, operation: 'googleAds.search', body: { query } },
        GoogleAdsSearchResponse,
      );
      return res.body.results;
    });
  }

  /** `googleAds:searchStream` — every batch, flattened; use for reporting-sized result sets. */
  async searchStream(query: string): Promise<readonly GoogleAdsRow[]> {
    this.assertActivated();
    return this.#call(async () => {
      const res = await this.#httpClient().request(
        {
          method: 'POST',
          path: `/customers/${this.#customerId()}/googleAds:searchStream`,
          operation: 'googleAds.searchStream',
          body: { query },
        },
        GoogleAdsSearchStreamResponse,
      );
      return res.body.flatMap((batch) => batch.results);
    });
  }

  /* ---------------------------------------------------------------------- */
  /* Mutates                                                                  */
  /* ---------------------------------------------------------------------- */

  async createCampaignBudget(input: {
    readonly name: string;
    readonly amountMicros: number;
    readonly deliveryMethod?: string;
  }): Promise<GoogleAdsMutateResult> {
    this.assertActivated();
    return this.#call(async () => {
      const res = await this.#httpClient().request(
        {
          method: 'POST',
          path: `/customers/${this.#customerId()}/campaignBudgets:mutate`,
          operation: 'campaignBudgets.mutate.create',
          body: {
            operations: [
              {
                create: {
                  name: input.name,
                  amountMicros: String(input.amountMicros),
                  ...(input.deliveryMethod ? { deliveryMethod: input.deliveryMethod } : {}),
                },
              },
            ],
          },
        },
        GoogleAdsMutateResponse,
      );
      return firstMutateResult(res.body.results, 'campaignBudgets.mutate.create');
    });
  }

  /** Created PAUSED — an explicit status update (not part of this method) is required before it can spend. */
  async createCampaign(input: CreateCampaignInput): Promise<GoogleAdsMutateResult> {
    this.assertActivated();
    return this.#call(async () => {
      const res = await this.#httpClient().request(
        {
          method: 'POST',
          path: `/customers/${this.#customerId()}/campaigns:mutate`,
          operation: 'campaigns.mutate.create',
          body: {
            operations: [
              {
                create: {
                  name: input.name,
                  status: 'PAUSED',
                  advertisingChannelType: input.advertisingChannelType,
                  campaignBudget: input.campaignBudgetResourceName,
                  ...(input.networkSettings ? { networkSettings: input.networkSettings } : {}),
                },
              },
            ],
          },
        },
        GoogleAdsMutateResponse,
      );
      return firstMutateResult(res.body.results, 'campaigns.mutate.create');
    });
  }

  async createAdGroup(input: {
    readonly name: string;
    readonly campaignResourceName: string;
    readonly cpcBidMicros?: number;
  }): Promise<GoogleAdsMutateResult> {
    this.assertActivated();
    return this.#call(async () => {
      const res = await this.#httpClient().request(
        {
          method: 'POST',
          path: `/customers/${this.#customerId()}/adGroups:mutate`,
          operation: 'adGroups.mutate.create',
          body: {
            operations: [
              {
                create: {
                  name: input.name,
                  campaign: input.campaignResourceName,
                  status: 'PAUSED',
                  ...(input.cpcBidMicros ? { cpcBidMicros: String(input.cpcBidMicros) } : {}),
                },
              },
            ],
          },
        },
        GoogleAdsMutateResponse,
      );
      return firstMutateResult(res.body.results, 'adGroups.mutate.create');
    });
  }

  async createResponsiveSearchAd(input: CreateResponsiveSearchAdInput): Promise<GoogleAdsMutateResult> {
    this.assertActivated();
    if (input.headlines.length < 3) {
      throw new ValidationError('Responsive search ads require at least 3 headlines', { count: input.headlines.length });
    }
    if (input.descriptions.length < 2) {
      throw new ValidationError('Responsive search ads require at least 2 descriptions', { count: input.descriptions.length });
    }
    return this.#call(async () => {
      const res = await this.#httpClient().request(
        {
          method: 'POST',
          path: `/customers/${this.#customerId()}/adGroupAds:mutate`,
          operation: 'adGroupAds.mutate.create',
          body: {
            operations: [
              {
                create: {
                  adGroup: input.adGroupResourceName,
                  status: 'PAUSED',
                  ad: {
                    finalUrls: input.finalUrls,
                    responsiveSearchAd: {
                      headlines: input.headlines.map((text) => ({ text })),
                      descriptions: input.descriptions.map((text) => ({ text })),
                    },
                  },
                },
              },
            ],
          },
        },
        GoogleAdsMutateResponse,
      );
      return firstMutateResult(res.body.results, 'adGroupAds.mutate.create');
    });
  }

  async updateCampaignBudget(resourceName: string, amountMicros: number): Promise<GoogleAdsMutateResult> {
    this.assertActivated();
    return this.#call(async () => {
      const res = await this.#httpClient().request(
        {
          method: 'POST',
          path: `/customers/${this.#customerId()}/campaignBudgets:mutate`,
          operation: 'campaignBudgets.mutate.update',
          body: { operations: [{ update: { resourceName, amountMicros: String(amountMicros) }, updateMask: 'amount_micros' }] },
        },
        GoogleAdsMutateResponse,
      );
      return firstMutateResult(res.body.results, 'campaignBudgets.mutate.update');
    });
  }

  async pauseCampaign(resourceName: string): Promise<GoogleAdsMutateResult> {
    this.assertActivated();
    return this.#call(async () => {
      const res = await this.#httpClient().request(
        {
          method: 'POST',
          path: `/customers/${this.#customerId()}/campaigns:mutate`,
          operation: 'campaigns.mutate.pause',
          body: { operations: [{ update: { resourceName, status: 'PAUSED' }, updateMask: 'status' }] },
        },
        GoogleAdsMutateResponse,
      );
      return firstMutateResult(res.body.results, 'campaigns.mutate.pause');
    });
  }

  /* ---------------------------------------------------------------------- */
  /* Metrics                                                                  */
  /* ---------------------------------------------------------------------- */

  async getMetrics(input: GetMetricsInput): Promise<readonly GoogleAdsRow[]> {
    this.assertActivated();
    const idField = input.resourceType === 'customer' ? 'customer.id' : `${input.resourceType}.resource_name`;
    const conditions = [`segments.date BETWEEN '${input.since}' AND '${input.until}'`];
    if (input.resourceResourceName) {
      conditions.push(`${input.resourceType}.resource_name = '${input.resourceResourceName}'`);
    }
    const query =
      `SELECT ${idField}, metrics.impressions, metrics.clicks, metrics.cost_micros, ` +
      `metrics.conversions, metrics.conversions_value FROM ${input.resourceType} WHERE ${conditions.join(' AND ')}`;
    return this.searchStream(query);
  }

  /**
   * Maps GAQL rows onto core's `MetricSnapshot`. Google Ads reports neither
   * reach nor any funnel step between click and conversion (landing page
   * view, add-to-cart, checkout start), and has no concept of refunds, our
   * own contribution margin, repeat-purchase counts or support contacts —
   * every one of those is left at the schema's own "not observed" default of
   * 0 rather than estimated. `metrics.cost_micros` and
   * `metrics.conversions_value` are integers/decimals in *micros*
   * (1,000,000 micros = 1 currency unit) regardless of the currency's own
   * minor-unit exponent, so they are read via `Money.fromMinor(..., scale=6)`
   * and rescaled, never via float division.
   */
  toMetricSnapshot(rows: readonly GoogleAdsRow[], input: ToMetricSnapshotInput): MetricSnapshot {
    let impressions = 0;
    let clicks = 0;
    let purchases = 0;
    const costParts: Money[] = [];
    const revenueParts: Money[] = [];

    for (const row of rows) {
      const parsed = GoogleAdsMetricsFragment.safeParse(row['metrics']);
      if (!parsed.success) continue;
      const metrics = parsed.data;
      if (metrics.impressions) impressions += Number.parseInt(metrics.impressions, 10) || 0;
      if (metrics.clicks) clicks += Number.parseInt(metrics.clicks, 10) || 0;
      if (metrics.costMicros) costParts.push(Money.fromMinor(BigInt(metrics.costMicros), input.currency, 6));
      if (metrics.conversionsValue) revenueParts.push(Money.of(String(metrics.conversionsValue), input.currency, 6));
      if (metrics.conversions) purchases += metrics.conversions;
    }

    return MetricSnapshot.parse({
      id: newId('metricSnapshot'),
      companyId: input.companyId,
      scope: input.scope,
      scopeRefId: input.scopeRefId,
      source: 'platform_api',
      windowStart: input.windowStart,
      windowEnd: input.windowEnd,
      currency: input.currency,
      impressions,
      clicks,
      purchases: Math.round(purchases),
      spendMinor: costParts.length === 0 ? 0 : Money.sum(costParts, input.currency).toProviderMinorUnits(),
      revenueMinor: revenueParts.length === 0 ? 0 : Money.sum(revenueParts, input.currency).toProviderMinorUnits(),
      reach: 0,
      landingPageViews: 0,
      addToCarts: 0,
      checkoutStarts: 0,
      refundsMinor: 0,
      contributionMarginMinor: 0,
      repeatPurchases: 0,
      supportContacts: 0,
      collectedAt: new Date().toISOString(),
    });
  }
}

function firstMutateResult(results: readonly GoogleAdsMutateResult[], operation: string): GoogleAdsMutateResult {
  const first = results[0];
  if (!first) throw new ProviderContractError('google_ads', `${operation} returned no results`, { operation });
  return first;
}

export * from './constants.js';
export * from './schemas.js';
