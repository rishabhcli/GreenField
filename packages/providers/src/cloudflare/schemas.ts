/**
 * Zod schemas for the Cloudflare API. Cloudflare wraps every response —
 * success or failure — in the same envelope and returns HTTP 200 even when
 * the operation failed (`success: false`), so `CloudflareEnvelope` models
 * that envelope generically and every call site checks `.success` and
 * `.errors` explicitly rather than trusting the HTTP status alone.
 */

import { z } from 'zod';

export const CloudflareApiErrorDetail = z.object({
  code: z.number(),
  message: z.string(),
});
export type CloudflareApiErrorDetail = z.infer<typeof CloudflareApiErrorDetail>;

export function CloudflareEnvelope<T extends z.ZodTypeAny>(result: T) {
  return z.object({
    success: z.boolean(),
    errors: z.array(CloudflareApiErrorDetail).default([]),
    messages: z.array(z.unknown()).default([]),
    result: result.nullable(),
    result_info: z
      .object({
        page: z.number().optional(),
        per_page: z.number().optional(),
        count: z.number().optional(),
        total_count: z.number().optional(),
      })
      .optional(),
  });
}

export const CloudflareTokenVerifyResult = z.object({
  id: z.string(),
  status: z.string(),
});
export type CloudflareTokenVerifyResult = z.infer<typeof CloudflareTokenVerifyResult>;

export const CloudflareRegistrarDomain = z.object({
  id: z.string(),
  name: z.string(),
  available: z.boolean().optional(),
  can_register: z.boolean().optional(),
  expires_at: z.string().nullable().optional(),
  locked: z.boolean().optional(),
  registrant_contact: z.unknown().optional(),
});
export type CloudflareRegistrarDomain = z.infer<typeof CloudflareRegistrarDomain>;

export const CloudflareZone = z.object({
  id: z.string(),
  name: z.string(),
  status: z.string().optional(),
});
export type CloudflareZone = z.infer<typeof CloudflareZone>;

export const CloudflareDnsRecord = z.object({
  id: z.string(),
  zone_id: z.string().optional(),
  type: z.string(),
  name: z.string(),
  content: z.string(),
  ttl: z.number().optional(),
  proxied: z.boolean().optional(),
});
export type CloudflareDnsRecord = z.infer<typeof CloudflareDnsRecord>;

export const CloudflareDeleteResult = z.object({ id: z.string() });
export type CloudflareDeleteResult = z.infer<typeof CloudflareDeleteResult>;

export const CloudflareTokenVerifyEnvelope = CloudflareEnvelope(CloudflareTokenVerifyResult);
export const CloudflareRegistrarDomainEnvelope = CloudflareEnvelope(CloudflareRegistrarDomain);
export const CloudflareRegistrarDomainListEnvelope = CloudflareEnvelope(z.array(CloudflareRegistrarDomain));
export const CloudflareZoneListEnvelope = CloudflareEnvelope(z.array(CloudflareZone));
export const CloudflareDnsRecordEnvelope = CloudflareEnvelope(CloudflareDnsRecord);
export const CloudflareDnsRecordListEnvelope = CloudflareEnvelope(z.array(CloudflareDnsRecord));
export const CloudflareDeleteResultEnvelope = CloudflareEnvelope(CloudflareDeleteResult);
