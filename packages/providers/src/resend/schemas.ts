/**
 * Zod schemas for the Resend objects this adapter reads and writes. Narrow by
 * design, same philosophy as `../stripe/schemas.ts`: only the fields actually
 * consumed.
 */

import { z } from 'zod';

export const ResendDomain = z.object({
  id: z.string(),
  name: z.string(),
  status: z.string(),
  region: z.string().optional(),
});
export type ResendDomain = z.infer<typeof ResendDomain>;

export const ResendDomainListResponse = z.object({
  data: z.array(ResendDomain).default([]),
});
export type ResendDomainListResponse = z.infer<typeof ResendDomainListResponse>;

export const ResendSendEmailResponse = z.object({
  id: z.string(),
});
export type ResendSendEmailResponse = z.infer<typeof ResendSendEmailResponse>;

export const ResendEmail = z.object({
  id: z.string(),
  from: z.string().optional(),
  to: z.array(z.string()).optional(),
  subject: z.string().optional(),
  last_event: z.string().optional(),
  created_at: z.string().optional(),
});
export type ResendEmail = z.infer<typeof ResendEmail>;

/** Resend's documented error envelope: `{ statusCode?, name, message }`. */
export const ResendErrorEnvelope = z
  .object({
    statusCode: z.number().optional(),
    name: z.string().optional(),
    message: z.string().optional(),
  })
  .passthrough();
export type ResendErrorEnvelope = z.infer<typeof ResendErrorEnvelope>;

export function extractResendError(body: unknown): ResendErrorEnvelope | undefined {
  const parsed = ResendErrorEnvelope.safeParse(body);
  return parsed.success ? parsed.data : undefined;
}
