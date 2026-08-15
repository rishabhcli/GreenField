/**
 * Zod schemas for the Linq V3 objects this adapter reads and writes.
 *
 * `LinqSendMessageResponse` and the phone-number shape are transcribed directly
 * from the vendor research (`docs/research/SPONSOR_API_RESEARCH.md` section 6,
 * verified 2026-08-14) and are as narrow as Stripe's: only fields we actually
 * consume. The chat/message read-model schemas below them go a little further
 * than what that research doc quotes verbatim — it confirms the endpoints, the
 * cursor/limit pagination envelope, and the send-response shape, but not every
 * field of a chat or message object. Those two schemas are the same REST
 * resource family as the confirmed objects (same pagination envelope, same
 * id/handle conventions) and are marked below; treat them as a best documented
 * reading, not a verbatim quote, and reconcile against a real response before
 * depending on a field not listed here.
 */

import { z } from 'zod';

/* -------------------------------------------------------------------------- */
/* Phone numbers — GET /v3/phone_numbers, PUT /v3/phone_numbers/{id}           */
/* -------------------------------------------------------------------------- */

/** Documented values only (research doc section 6, "Phone numbers"). */
export const LinqPhoneNumberStatus = z.enum(['ACTIVE', 'FLAGGED']);
export type LinqPhoneNumberStatus = z.infer<typeof LinqPhoneNumberStatus>;

export const LinqPhoneNumberReputation = z.enum(['HEALTHY', 'AT_RISK', 'CRITICAL']);
export type LinqPhoneNumberReputation = z.infer<typeof LinqPhoneNumberReputation>;

export const LinqPhoneNumber = z.object({
  id: z.string().min(1),
  number: z.string().min(1),
  status: LinqPhoneNumberStatus,
  reputation: LinqPhoneNumberReputation,
  forwarding_number: z.string().nullable().optional(),
});
export type LinqPhoneNumber = z.infer<typeof LinqPhoneNumber>;

/** The endpoint's exact envelope (flat array vs `{data:[]}`) is unconfirmed; both are accepted. */
export const LinqPhoneNumberList = z.union([
  z.array(LinqPhoneNumber),
  z.object({ data: z.array(LinqPhoneNumber), next_cursor: z.string().nullable().optional() }),
]);
export type LinqPhoneNumberList = z.infer<typeof LinqPhoneNumberList>;

export function phoneNumbersOf(list: LinqPhoneNumberList): readonly LinqPhoneNumber[] {
  return Array.isArray(list) ? list : list.data;
}

/* -------------------------------------------------------------------------- */
/* Messaging — POST /v3/messages                                              */
/* -------------------------------------------------------------------------- */

export const LinqMessagePartInput = z.object({
  type: z.enum(['text', 'media', 'link', 'imessage_app']),
  value: z.string().optional(),
  url: z.string().optional(),
  attachment_id: z.string().optional(),
});
export type LinqMessagePartInput = z.infer<typeof LinqMessagePartInput>;

/** `POST /v3/messages` response — 202 Accepted. Fields quoted verbatim from the research doc. */
export const LinqSendMessageResponse = z.object({
  chat_id: z.string().min(1),
  message_ids: z.array(z.string()),
  from_selection: z.object({ from: z.string(), reason: z.string() }),
  created_chat: z.boolean(),
  trace_id: z.string(),
});
export type LinqSendMessageResponse = z.infer<typeof LinqSendMessageResponse>;

/* -------------------------------------------------------------------------- */
/* Chats & messages — best-documented reading, see file header                */
/* -------------------------------------------------------------------------- */

export const LinqMessage = z.object({
  id: z.string().min(1),
  chat_id: z.string().nullable().optional(),
  from: z.string().nullable().optional(),
  to: z.array(z.string()).nullable().optional(),
  parts: z.array(LinqMessagePartInput).nullable().optional(),
  /** Which transport actually carried it — reported, per the research doc, in `from_selection` on send; assumed mirrored here on read. */
  service: z.string().nullable().optional(),
  status: z.string().nullable().optional(),
  created_at: z.string().nullable().optional(),
});
export type LinqMessage = z.infer<typeof LinqMessage>;

export const LinqMessageList = z.object({
  data: z.array(LinqMessage),
  next_cursor: z.string().nullable().optional(),
});
export type LinqMessageList = z.infer<typeof LinqMessageList>;

export const LinqChat = z.object({
  id: z.string().min(1),
  participants: z.array(z.string()).nullable().optional(),
  /** Only `"OPTED_OUT"` is documented; every other value is passed through as-is. */
  health_status: z.string().nullable().optional(),
  created_at: z.string().nullable().optional(),
});
export type LinqChat = z.infer<typeof LinqChat>;

export const LinqChatList = z.object({
  data: z.array(LinqChat),
  next_cursor: z.string().nullable().optional(),
});
export type LinqChatList = z.infer<typeof LinqChatList>;

/* -------------------------------------------------------------------------- */
/* Blocked handles — GET/POST /v3/blocked_handles, DELETE .../{handle}         */
/* -------------------------------------------------------------------------- */

export const LinqBlockedHandle = z.object({
  handle: z.string().min(1),
  reason: z.string().nullable().optional(),
  created_at: z.string().nullable().optional(),
});
export type LinqBlockedHandle = z.infer<typeof LinqBlockedHandle>;

export const LinqBlockedHandleList = z.union([
  z.array(LinqBlockedHandle),
  z.object({ data: z.array(LinqBlockedHandle), next_cursor: z.string().nullable().optional() }),
]);
export type LinqBlockedHandleList = z.infer<typeof LinqBlockedHandleList>;

export function blockedHandlesOf(list: LinqBlockedHandleList): readonly LinqBlockedHandle[] {
  return Array.isArray(list) ? list : list.data;
}

/* -------------------------------------------------------------------------- */
/* Attachments & capability checks                                            */
/* -------------------------------------------------------------------------- */

export const LinqAttachmentUploadResponse = z.object({
  attachment_id: z.string().min(1),
  url: z.string().nullable().optional(),
});
export type LinqAttachmentUploadResponse = z.infer<typeof LinqAttachmentUploadResponse>;

/** `POST /v3/capability_checks` — what a given `to` handle can receive (e.g. iMessage vs SMS-only). */
export const LinqCapabilityCheckResponse = z.object({
  to: z.string().optional(),
  capabilities: z.array(z.string()).default([]),
  preferred_service: z.string().nullable().optional(),
});
export type LinqCapabilityCheckResponse = z.infer<typeof LinqCapabilityCheckResponse>;

/* -------------------------------------------------------------------------- */
/* Voice — UNVERIFIED, see index.ts                                           */
/* -------------------------------------------------------------------------- */

/**
 * UNVERIFIED. The OpenAPI spec's "Calls" tag truncated on fetch and no
 * `call.*` payload example is published anywhere the research pass found.
 * This schema is deliberately the loosest one in this file — just an id and a
 * passthrough bag — so a real response is recorded rather than rejected the
 * first time this capability is actually exercised.
 */
export const LinqCallResponse = z
  .object({
    call_id: z.string().min(1).optional(),
    id: z.string().min(1).optional(),
    status: z.string().nullable().optional(),
  })
  .passthrough();
export type LinqCallResponse = z.infer<typeof LinqCallResponse>;

/* -------------------------------------------------------------------------- */
/* Error envelope                                                              */
/* -------------------------------------------------------------------------- */

/**
 * No JSON error sample is published; this mirrors the shape every other
 * documented-error provider in this codebase uses (`{error:{code,message}}`)
 * and is deliberately forgiving (`.passthrough()`, optional fields) so a
 * differently-shaped real error body still parses instead of throwing inside
 * error handling itself.
 */
export const LinqErrorEnvelope = z
  .object({
    error: z
      .object({
        code: z.union([z.number(), z.string()]).optional(),
        message: z.string().optional(),
      })
      .passthrough()
      .optional(),
    code: z.union([z.number(), z.string()]).optional(),
    message: z.string().optional(),
  })
  .passthrough();
export type LinqErrorEnvelope = z.infer<typeof LinqErrorEnvelope>;

/** Best-effort extraction of Linq's numeric/string error code from an unknown error body. */
export function extractLinqErrorCode(body: unknown): number | string | undefined {
  const parsed = LinqErrorEnvelope.safeParse(body);
  if (!parsed.success) return undefined;
  return parsed.data.error?.code ?? parsed.data.code;
}

export function extractLinqErrorMessage(body: unknown): string | undefined {
  const parsed = LinqErrorEnvelope.safeParse(body);
  if (!parsed.success) return undefined;
  return parsed.data.error?.message ?? parsed.data.message;
}
