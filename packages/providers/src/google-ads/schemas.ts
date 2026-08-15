/**
 * Zod schemas for the Google Ads API (REST) objects this adapter reads and
 * writes, plus the Google OAuth token endpoint. Narrow where the shape is
 * fixed (mutate results, the OAuth token response, the error envelope);
 * intentionally loose for `GoogleAdsRow`, because GAQL's `SELECT` clause
 * determines which fields a row actually contains — a schema that hard-coded
 * one query's fields would reject every other query's results.
 */

import { z } from 'zod';

/* -------------------------------------------------------------------------- */
/* OAuth                                                                       */
/* -------------------------------------------------------------------------- */

export const GoogleOAuthTokenResponse = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().int().positive(),
  token_type: z.string(),
  scope: z.string().optional(),
});
export type GoogleOAuthTokenResponse = z.infer<typeof GoogleOAuthTokenResponse>;

/* -------------------------------------------------------------------------- */
/* GAQL rows                                                                   */
/* -------------------------------------------------------------------------- */

/** One row's shape is entirely determined by the query's `SELECT` clause; validated narrowly only where a field is actually read. */
export const GoogleAdsRow = z.record(z.string(), z.unknown());
export type GoogleAdsRow = z.infer<typeof GoogleAdsRow>;

/** `:search` — a single page. */
export const GoogleAdsSearchResponse = z.object({
  results: z.array(GoogleAdsRow).default([]),
  nextPageToken: z.string().optional(),
  fieldMask: z.string().optional(),
});
export type GoogleAdsSearchResponse = z.infer<typeof GoogleAdsSearchResponse>;

/**
 * `:searchStream` over REST returns one JSON array of batches rather than a
 * true chunked stream once `fetch` has read the whole body — which is exactly
 * what the shared `ProviderHttpClient` does, so this schema models the fully
 * buffered array rather than a streaming protocol.
 */
export const GoogleAdsSearchStreamResponse = z.array(z.object({ results: z.array(GoogleAdsRow).default([]) }));
export type GoogleAdsSearchStreamResponse = z.infer<typeof GoogleAdsSearchStreamResponse>;

/** Metrics sub-object read out of a row by `getMetrics` — validated narrowly since these specific fields are actually consumed. */
export const GoogleAdsMetricsFragment = z.object({
  impressions: z.string().optional(),
  clicks: z.string().optional(),
  costMicros: z.string().optional(),
  conversions: z.number().optional(),
  conversionsValue: z.number().optional(),
});
export type GoogleAdsMetricsFragment = z.infer<typeof GoogleAdsMetricsFragment>;

/* -------------------------------------------------------------------------- */
/* Mutates                                                                     */
/* -------------------------------------------------------------------------- */

export const GoogleAdsMutateResult = z.object({ resourceName: z.string() });
export type GoogleAdsMutateResult = z.infer<typeof GoogleAdsMutateResult>;

export const GoogleAdsMutateResponse = z.object({
  results: z.array(GoogleAdsMutateResult).default([]),
});
export type GoogleAdsMutateResponse = z.infer<typeof GoogleAdsMutateResponse>;

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export const GoogleAdsFailureError = z.object({
  errorCode: z.record(z.string(), z.string()).optional(),
  message: z.string().optional(),
  trigger: z.unknown().optional(),
  location: z.unknown().optional(),
});
export type GoogleAdsFailureError = z.infer<typeof GoogleAdsFailureError>;

export const GoogleAdsErrorEnvelope = z.object({
  error: z
    .object({
      code: z.number().optional(),
      message: z.string(),
      status: z.string().optional(),
      details: z
        .array(
          z
            .object({
              '@type': z.string().optional(),
              errors: z.array(GoogleAdsFailureError).optional(),
              requestId: z.string().optional(),
            })
            .passthrough(),
        )
        .optional(),
    })
    .passthrough(),
});
export type GoogleAdsErrorEnvelope = z.infer<typeof GoogleAdsErrorEnvelope>;

/** First-error summary used for classification and logging, without assuming there is exactly one. */
export function extractGoogleAdsError(
  body: unknown,
): { readonly topMessage: string; readonly status: string | undefined; readonly errorCodes: readonly Record<string, string>[] } | undefined {
  const parsed = GoogleAdsErrorEnvelope.safeParse(body);
  if (!parsed.success) return undefined;
  const errorCodes = (parsed.data.error.details ?? []).flatMap((d) => (d.errors ?? []).map((e) => e.errorCode ?? {}));
  return { topMessage: parsed.data.error.message, status: parsed.data.error.status, errorCodes };
}
