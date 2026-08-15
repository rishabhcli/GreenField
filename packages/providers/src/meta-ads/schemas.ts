/**
 * Zod schemas for the Meta Marketing API objects this adapter reads and
 * writes. Narrow by design, same philosophy as `../stripe/schemas.ts`: only
 * the fields actually consumed, so a Graph API change that drops one of them
 * fails loudly at the boundary instead of quietly producing `undefined`
 * inside a spend or metrics calculation.
 *
 * Meta returns every Insights numeric field as a *string*, including spend,
 * impressions and reach — that is documented Graph API behaviour, not a
 * modelling choice here, so those fields are typed `z.string()` and converted
 * explicitly at the call site.
 */

import { z } from 'zod';

export const MetaAccountProbe = z.object({
  id: z.string(),
  account_status: z.number().int(),
  currency: z.string(),
  name: z.string().optional(),
});
export type MetaAccountProbe = z.infer<typeof MetaAccountProbe>;

/** Nearly every mutating Marketing API call returns just `{ id }`. */
export const MetaIdResponse = z.object({ id: z.string() });
export type MetaIdResponse = z.infer<typeof MetaIdResponse>;

/**
 * `POST /act_{id}/adimages` keys the result by whatever field name the bytes
 * were uploaded under, so the key itself is not fixed — only the per-entry
 * shape (`hash`, and sometimes `url`) is documented.
 */
export const MetaAdImageResponse = z.object({
  images: z.record(z.string(), z.object({ hash: z.string(), url: z.string().optional() })),
});
export type MetaAdImageResponse = z.infer<typeof MetaAdImageResponse>;

export const MetaActionValue = z.object({ action_type: z.string(), value: z.string() });
export type MetaActionValue = z.infer<typeof MetaActionValue>;

export const MetaInsightsRow = z.object({
  date_start: z.string().optional(),
  date_stop: z.string().optional(),
  impressions: z.string().optional(),
  reach: z.string().optional(),
  clicks: z.string().optional(),
  spend: z.string().optional(),
  actions: z.array(MetaActionValue).optional(),
  action_values: z.array(MetaActionValue).optional(),
});
export type MetaInsightsRow = z.infer<typeof MetaInsightsRow>;

export const MetaInsightsResponse = z.object({
  data: z.array(MetaInsightsRow),
  paging: z
    .object({
      cursors: z.object({ before: z.string().optional(), after: z.string().optional() }).optional(),
      next: z.string().optional(),
    })
    .optional(),
});
export type MetaInsightsResponse = z.infer<typeof MetaInsightsResponse>;

/** Graph API's standard error envelope, present on every non-2xx response. */
export const MetaErrorEnvelope = z.object({
  error: z
    .object({
      message: z.string(),
      type: z.string().optional(),
      code: z.number().optional(),
      error_subcode: z.number().optional(),
      fbtrace_id: z.string().optional(),
    })
    .passthrough(),
});
export type MetaErrorEnvelope = z.infer<typeof MetaErrorEnvelope>;

export function extractMetaError(body: unknown): MetaErrorEnvelope['error'] | undefined {
  const parsed = MetaErrorEnvelope.safeParse(body);
  return parsed.success ? parsed.data.error : undefined;
}
