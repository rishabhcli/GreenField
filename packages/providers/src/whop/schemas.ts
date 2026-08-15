import { z } from 'zod';

export { WHOP_API_VERSION_DATE } from './constants.js';

export const WhopAccount = z.object({
  id: z.string(),
  name: z.string().optional(),
  email: z.string().optional(),
}).passthrough();

export const WhopPlan = z.object({
  id: z.string(),
  product_id: z.string().optional(),
  plan_type: z.string().optional(),
  visibility: z.string().optional(),
}).passthrough();

export const WhopProduct = z.object({
  id: z.string(),
  title: z.string().optional(),
  company_id: z.string().optional(),
  account: z.object({ id: z.string() }).passthrough().optional(),
  visibility: z.string().optional(),
  plans: z.array(WhopPlan).optional(),
}).passthrough();

export const WhopCheckoutConfiguration = z.object({
  id: z.string(),
  purchase_url: z.string().optional(),
  url: z.string().optional(),
  plan_id: z.string().optional(),
  account_id: z.string().optional(),
  company_id: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).passthrough();

export const WhopRefund = z.object({
  id: z.string(),
  payment_id: z.string().optional(),
  status: z.string().optional(),
  amount: z.union([z.number(), z.string()]).optional(),
}).passthrough();

export const WhopPayment = z.object({
  id: z.string(),
  status: z.string().optional(),
  amount: z.union([z.number(), z.string()]).optional(),
  refunded_amount: z.union([z.number(), z.string()]).optional(),
  currency: z.string().optional(),
  company_id: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  refunds: z.array(WhopRefund).optional(),
}).passthrough();

export const WhopWebhookEnvelope = z.object({
  type: z.string().optional(),
  action: z.string().optional(),
  data: z.record(z.string(), z.unknown()).default({}),
  id: z.string().optional(),
}).passthrough();

export type WhopWebhookEnvelope = z.infer<typeof WhopWebhookEnvelope>;

/** Whop documents amounts as major-unit decimals (10.43 → 1043 minor). */
export function asMinorUnits(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.round(value * 100);
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    if (Number.isFinite(n)) return Math.round(n * 100);
  }
  return undefined;
}

/** Inverse of `asMinorUnits` for request bodies (`partial_amount`, plan prices). */
export function asMajorUnits(minor: number): number {
  return Number((minor / 100).toFixed(2));
}
