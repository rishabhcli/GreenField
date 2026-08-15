/**
 * Zod schemas for the Stripe objects we consume.
 *
 * These are intentionally narrow: they describe the fields this system actually
 * reads, so a Stripe API change that removes one of them fails loudly at the
 * boundary instead of silently producing `undefined` inside a margin
 * calculation. Fields Stripe may omit are modelled as nullish rather than
 * required, because a missing fee is a real state (it arrives later) and must
 * not be confused with a zero fee.
 */

import { z } from 'zod';

export const StripePaymentLink = z.object({
  id: z.string(),
  object: z.literal('payment_link').optional(),
  url: z.string(),
  active: z.boolean().nullish(),
  livemode: z.boolean().optional(),
});
export type StripePaymentLink = z.infer<typeof StripePaymentLink>;

export const StripeBalance = z.object({
  object: z.literal('balance'),
  livemode: z.boolean(),
  available: z.array(z.object({ amount: z.number(), currency: z.string() })),
  pending: z.array(z.object({ amount: z.number(), currency: z.string() })).optional(),
});
export type StripeBalance = z.infer<typeof StripeBalance>;

export const StripeAddress = z.object({
  line1: z.string().nullish(),
  line2: z.string().nullish(),
  city: z.string().nullish(),
  state: z.string().nullish(),
  postal_code: z.string().nullish(),
  country: z.string().nullish(),
});

export const StripeCheckoutSession = z.object({
  id: z.string(),
  object: z.literal('checkout.session'),
  mode: z.string(),
  status: z.string().nullish(),
  payment_status: z.string(),
  url: z.string().nullish(),
  client_reference_id: z.string().nullish(),
  customer_details: z
    .object({
      email: z.string().nullish(),
      name: z.string().nullish(),
      phone: z.string().nullish(),
      address: StripeAddress.nullish(),
    })
    .nullish(),
  // Present only after completion; `collected_information.shipping_details` is
  // the newer location, so both are accepted.
  shipping_details: z.object({ name: z.string().nullish(), address: StripeAddress.nullish() }).nullish(),
  collected_information: z
    .object({ shipping_details: z.object({ name: z.string().nullish(), address: StripeAddress.nullish() }).nullish() })
    .nullish(),
  amount_subtotal: z.number().nullish(),
  amount_total: z.number().nullish(),
  currency: z.string().nullish(),
  total_details: z
    .object({ amount_discount: z.number().nullish(), amount_shipping: z.number().nullish(), amount_tax: z.number().nullish() })
    .nullish(),
  payment_intent: z.union([z.string(), z.object({ id: z.string() })]).nullish(),
  metadata: z.record(z.string(), z.string()).nullish(),
  expires_at: z.number().nullish(),
  livemode: z.boolean().optional(),
});
export type StripeCheckoutSession = z.infer<typeof StripeCheckoutSession>;

export const StripePaymentIntent = z.object({
  id: z.string(),
  object: z.literal('payment_intent'),
  status: z.string(),
  amount: z.number(),
  amount_received: z.number().nullish(),
  currency: z.string(),
  metadata: z.record(z.string(), z.string()).nullish(),
  latest_charge: z.union([z.string(), z.object({ id: z.string() })]).nullish(),
  last_payment_error: z.object({ code: z.string().nullish(), message: z.string().nullish() }).nullish(),
  created: z.number(),
  livemode: z.boolean().optional(),
});
export type StripePaymentIntent = z.infer<typeof StripePaymentIntent>;

export const StripeCharge = z.object({
  id: z.string(),
  object: z.literal('charge'),
  status: z.string(),
  paid: z.boolean(),
  amount: z.number(),
  amount_refunded: z.number(),
  currency: z.string(),
  payment_intent: z.union([z.string(), z.object({ id: z.string() })]).nullish(),
  // Only present once the balance transaction is expanded; null means "not yet
  // known", never "no fee".
  balance_transaction: z
    .union([z.string(), z.object({ id: z.string(), fee: z.number(), net: z.number(), currency: z.string() })])
    .nullish(),
  payment_method_details: z
    .object({ type: z.string().nullish(), card: z.object({ brand: z.string().nullish(), last4: z.string().nullish() }).nullish() })
    .nullish(),
  outcome: z.object({ risk_level: z.string().nullish(), risk_score: z.number().nullish(), type: z.string().nullish() }).nullish(),
  metadata: z.record(z.string(), z.string()).nullish(),
  created: z.number(),
});
export type StripeCharge = z.infer<typeof StripeCharge>;

export const StripeRefund = z.object({
  id: z.string(),
  object: z.literal('refund'),
  status: z.string().nullish(),
  amount: z.number(),
  currency: z.string(),
  charge: z.union([z.string(), z.object({ id: z.string() })]).nullish(),
  payment_intent: z.union([z.string(), z.object({ id: z.string() })]).nullish(),
  reason: z.string().nullish(),
  failure_reason: z.string().nullish(),
  metadata: z.record(z.string(), z.string()).nullish(),
  created: z.number(),
});
export type StripeRefund = z.infer<typeof StripeRefund>;

export const StripeDispute = z.object({
  id: z.string(),
  object: z.literal('dispute'),
  amount: z.number(),
  currency: z.string(),
  status: z.string(),
  reason: z.string(),
  charge: z.union([z.string(), z.object({ id: z.string() })]),
  payment_intent: z.union([z.string(), z.object({ id: z.string() })]).nullish(),
  evidence_details: z
    .object({ due_by: z.number().nullish(), has_evidence: z.boolean(), past_due: z.boolean(), submission_count: z.number() })
    .nullish(),
  created: z.number(),
});
export type StripeDispute = z.infer<typeof StripeDispute>;

export const StripeEarlyFraudWarning = z.object({
  id: z.string(),
  object: z.literal('radar.early_fraud_warning'),
  charge: z.union([z.string(), z.object({ id: z.string() })]),
  fraud_type: z.string(),
  actionable: z.boolean(),
  created: z.number(),
});

export const StripeReview = z.object({
  id: z.string(),
  object: z.literal('review'),
  charge: z.union([z.string(), z.object({ id: z.string() })]).nullish(),
  payment_intent: z.union([z.string(), z.object({ id: z.string() })]).nullish(),
  open: z.boolean(),
  reason: z.string(),
  created: z.number(),
});

/** Envelope common to every Stripe webhook delivery. */
export const StripeEventEnvelope = z.object({
  id: z.string(),
  object: z.literal('event'),
  type: z.string(),
  api_version: z.string().nullish(),
  created: z.number(),
  livemode: z.boolean(),
  data: z.object({ object: z.record(z.string(), z.unknown()) }),
  request: z.object({ id: z.string().nullish(), idempotency_key: z.string().nullish() }).nullish(),
});
export type StripeEventEnvelope = z.infer<typeof StripeEventEnvelope>;

/** Unwraps Stripe's `string | expandedObject` union into an id. */
export function refId(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && 'id' in value) {
    const id = (value as { id: unknown }).id;
    return typeof id === 'string' ? id : null;
  }
  return null;
}
