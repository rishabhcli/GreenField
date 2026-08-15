/**
 * Zod schemas for the Shippo objects this adapter reads and writes. Narrow by
 * design, same philosophy as `../stripe/schemas.ts`: only the fields actually
 * consumed.
 */

import { z } from 'zod';

/** Shippo's list endpoints share this envelope (`{count, next, previous, results}`). */
export function ShippoList<T extends z.ZodTypeAny>(result: T) {
  return z.object({
    count: z.number().optional(),
    next: z.string().nullable().optional(),
    previous: z.string().nullable().optional(),
    results: z.array(result).default([]),
  });
}

export const ShippoAddressInput = z.object({
  name: z.string().optional(),
  company: z.string().optional(),
  street1: z.string(),
  street2: z.string().optional(),
  city: z.string(),
  state: z.string().optional(),
  zip: z.string(),
  country: z.string(),
  phone: z.string().optional(),
  email: z.string().optional(),
});
export type ShippoAddressInput = z.infer<typeof ShippoAddressInput>;

export const ShippoAddress = ShippoAddressInput.extend({
  object_id: z.string(),
  is_complete: z.boolean().optional(),
  validation_results: z
    .object({
      is_valid: z.boolean().optional(),
      messages: z.array(z.object({ source: z.string().optional(), code: z.string().optional(), text: z.string().optional() })).optional(),
    })
    .nullable()
    .optional(),
});
export type ShippoAddress = z.infer<typeof ShippoAddress>;

export const ShippoParcel = z.object({
  length: z.string(),
  width: z.string(),
  height: z.string(),
  distance_unit: z.enum(['cm', 'in']),
  weight: z.string(),
  mass_unit: z.enum(['g', 'kg', 'lb', 'oz']),
});
export type ShippoParcel = z.infer<typeof ShippoParcel>;

export const ShippoRate = z.object({
  object_id: z.string(),
  amount: z.string(),
  currency: z.string(),
  provider: z.string(),
  servicelevel: z.object({ name: z.string(), token: z.string().optional() }).nullable().optional(),
  estimated_days: z.number().nullable().optional(),
  duration_terms: z.string().nullable().optional(),
});
export type ShippoRate = z.infer<typeof ShippoRate>;

export const ShippoMessage = z.object({ source: z.string().optional(), code: z.string().optional(), text: z.string().optional() });
export type ShippoMessage = z.infer<typeof ShippoMessage>;

export const ShippoShipment = z.object({
  object_id: z.string(),
  status: z.string(),
  rates: z.array(ShippoRate).default([]),
  messages: z.array(ShippoMessage).default([]),
});
export type ShippoShipment = z.infer<typeof ShippoShipment>;

export const ShippoTransaction = z.object({
  object_id: z.string(),
  status: z.string(),
  tracking_number: z.string().nullable().optional(),
  tracking_url_provider: z.string().nullable().optional(),
  label_url: z.string().nullable().optional(),
  rate: z.union([z.string(), z.object({ object_id: z.string() })]).nullable().optional(),
  metadata: z.string().nullable().optional(),
  messages: z.array(ShippoMessage).default([]),
});
export type ShippoTransaction = z.infer<typeof ShippoTransaction>;

export const ShippoTrackingHistoryEntry = z.object({
  status: z.string().optional(),
  status_details: z.string().nullable().optional(),
  status_date: z.string().nullable().optional(),
  location: z.unknown().optional(),
});
export type ShippoTrackingHistoryEntry = z.infer<typeof ShippoTrackingHistoryEntry>;

export const ShippoTracking = z.object({
  carrier: z.string().optional(),
  tracking_number: z.string().optional(),
  tracking_status: z
    .object({ status: z.string().optional(), status_details: z.string().nullable().optional(), status_date: z.string().nullable().optional() })
    .nullable()
    .optional(),
  tracking_history: z.array(ShippoTrackingHistoryEntry).default([]),
  eta: z.string().nullable().optional(),
});
export type ShippoTracking = z.infer<typeof ShippoTracking>;

export const ShippoAddressList = ShippoList(ShippoAddress);
export const ShippoTransactionList = ShippoList(ShippoTransaction);
