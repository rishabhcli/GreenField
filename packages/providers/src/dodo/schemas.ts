/**
 * Dodo Payments response contracts.
 *
 * Shapes taken from the documented REST API (verified 2026-08-14/15 in
 * SPONSOR_API_RESEARCH.md). Fields the vendor did not show in a sample are
 * optional so a missing key fails locally rather than inventing a default.
 */

import { z } from 'zod';

export const DodoProduct = z.object({
  product_id: z.string().optional(),
  id: z.string().optional(),
  name: z.string().optional(),
  tax_category: z.string().optional(),
}).passthrough();

export const DodoProductList = z.object({
  items: z.array(DodoProduct).optional(),
}).passthrough();

export const DodoCheckoutSession = z.object({
  session_id: z.string(),
  checkout_url: z.string().nullable().optional(),
  client_secret: z.string().nullable().optional(),
  payment_id: z.string().nullable().optional(),
  publishable_key: z.string().nullable().optional(),
}).passthrough();

export const DodoRefund = z.object({
  refund_id: z.string().optional(),
  id: z.string().optional(),
  payment_id: z.string(),
  status: z.string().optional(),
  amount: z.number().optional(),
}).passthrough();

export const DodoWebhookEnvelope = z.object({
  type: z.string(),
  business_id: z.string().optional(),
  timestamp: z.string().optional(),
  data: z.record(z.string(), z.unknown()).default({}),
}).passthrough();

export type DodoWebhookEnvelope = z.infer<typeof DodoWebhookEnvelope>;

/** Best-effort integer minor units. Dodo samples show integers; a decimal string is converted. */
export function asMinorUnits(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.round(value);
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    if (Number.isFinite(n)) return Math.round(n);
  }
  return undefined;
}

export function refId(data: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const v = data[key];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return undefined;
}
