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

/** Live 2026-08-15: `{ phone_numbers: [{ id, phone_number, reputation:{status}, forwarding_number }] }`. */
export const LinqPhoneNumber = z
  .object({
    id: z.string().min(1),
    phone_number: z.string().min(1).optional(),
    number: z.string().min(1).optional(),
    status: z.string().optional(),
    reputation: z.unknown().optional(),
    forwarding_number: z.string().nullable().optional(),
  })
  .passthrough();
export type LinqPhoneNumber = z.infer<typeof LinqPhoneNumber>;

export const LinqPhoneNumberList = z.union([
  z.array(LinqPhoneNumber),
  z.object({ data: z.array(LinqPhoneNumber), next_cursor: z.string().nullable().optional() }).passthrough(),
  z.object({ phone_numbers: z.array(LinqPhoneNumber) }).passthrough(),
]);
export type LinqPhoneNumberList = z.infer<typeof LinqPhoneNumberList>;

export function phoneNumbersOf(list: LinqPhoneNumberList): readonly LinqPhoneNumber[] {
  if (Array.isArray(list)) return list;
  if ('phone_numbers' in list && Array.isArray(list.phone_numbers)) return list.phone_numbers;
  if ('data' in list && Array.isArray(list.data)) return list.data;
  return [];
}

export function e164Of(n: LinqPhoneNumber): string | undefined {
  return n.phone_number ?? n.number;
}

export function reputationStatusOf(n: LinqPhoneNumber): string | undefined {
  if (typeof n.status === 'string') return n.status;
  const rep = n.reputation;
  if (typeof rep === 'string') return rep;
  if (rep && typeof rep === 'object' && 'status' in rep && typeof (rep as { status: unknown }).status === 'string') {
    return (rep as { status: string }).status;
  }
  return undefined;
}

/* -------------------------------------------------------------------------- */
/* Messaging — POST /v3/messages                                              */
/* -------------------------------------------------------------------------- */

export const LinqMessagePartInput = z.object({
  type: z.enum(['text', 'media', 'link', 'imessage_app']),
  value: z.string().optional(),
  url: z.string().optional(),
  attachment_id: z.string().optional(),
  fallback_text: z.string().optional(),
  app: z
    .object({
      name: z.string(),
      team_id: z.string(),
      bundle_id: z.string(),
    })
    .optional(),
  layout: z
    .object({
      caption: z.string().optional(),
      subcaption: z.string().optional(),
      trailing_caption: z.string().optional(),
      trailing_subcaption: z.string().optional(),
      image_url: z.string().optional(),
    })
    .optional(),
});
export type LinqMessagePartInput = z.infer<typeof LinqMessagePartInput>;

/**
 * `POST /v3/messages` and `POST /v3/chats/{id}/messages` 202 bodies.
 * Live 2026-08-15: `{ chat_id, created_new_chat, from, from_selection:{reason}, message:{id} }`
 * on auto-select send; chat-path send is `{ chat_id, message:{id} }` only. The
 * research-doc `message_ids` / `created_chat` / `trace_id` fields are optional.
 */
export const LinqSendMessageResponse = z
  .object({
    chat_id: z.string().min(1),
    message_ids: z.array(z.string()).optional(),
    message: z.object({ id: z.string().min(1) }).passthrough().optional(),
    from: z.string().optional(),
    from_selection: z
      .object({
        from: z.string().optional(),
        reason: z.string().optional(),
        reused_existing_chat: z.boolean().optional(),
      })
      .passthrough()
      .optional(),
    created_chat: z.boolean().optional(),
    created_new_chat: z.boolean().optional(),
    trace_id: z.string().optional(),
  })
  .passthrough();
export type LinqSendMessageResponse = z.infer<typeof LinqSendMessageResponse>;

/* -------------------------------------------------------------------------- */
/* Chats & messages — best-documented reading, see file header                */
/* -------------------------------------------------------------------------- */

export const LinqMessage = z
  .object({
    id: z.string().min(1),
    chat_id: z.string().nullable().optional(),
    from: z.string().nullable().optional(),
    to: z.array(z.string()).nullable().optional(),
    parts: z.array(LinqMessagePartInput).nullable().optional(),
    service: z.string().nullable().optional(),
    status: z.string().nullable().optional(),
    delivery_status: z.string().nullable().optional(),
    created_at: z.string().nullable().optional(),
  })
  .passthrough();
export type LinqMessage = z.infer<typeof LinqMessage>;

/** Live 2026-08-15: `{ messages, next_cursor }`. Also accept `{ data }` from the research reading. */
export const LinqMessageList = z.union([
  z.array(LinqMessage),
  z.object({ data: z.array(LinqMessage), next_cursor: z.string().nullable().optional() }).passthrough(),
  z.object({ messages: z.array(LinqMessage), next_cursor: z.string().nullable().optional() }).passthrough(),
]);
export type LinqMessageList = z.infer<typeof LinqMessageList>;

export function messagesOf(list: LinqMessageList): readonly LinqMessage[] {
  if (Array.isArray(list)) return list;
  if ('messages' in list && Array.isArray(list.messages)) return list.messages;
  if ('data' in list && Array.isArray(list.data)) return list.data;
  return [];
}

export const LinqChat = z
  .object({
    id: z.string().min(1),
    participants: z.array(z.string()).nullable().optional(),
    handles: z.unknown().optional(),
    /** Live: `{ status, doc_url, updated_at }`. Older reading was a string (`OPTED_OUT`). */
    health_status: z.unknown().optional(),
    service: z.string().nullable().optional(),
    created_at: z.string().nullable().optional(),
  })
  .passthrough();
export type LinqChat = z.infer<typeof LinqChat>;

/** Live 2026-08-15: `{ chats, next_cursor }`. */
export const LinqChatList = z.union([
  z.array(LinqChat),
  z.object({ data: z.array(LinqChat), next_cursor: z.string().nullable().optional() }).passthrough(),
  z.object({ chats: z.array(LinqChat), next_cursor: z.string().nullable().optional() }).passthrough(),
]);
export type LinqChatList = z.infer<typeof LinqChatList>;

export function chatsOf(list: LinqChatList): readonly LinqChat[] {
  if (Array.isArray(list)) return list;
  if ('chats' in list && Array.isArray(list.chats)) return list.chats;
  if ('data' in list && Array.isArray(list.data)) return list.data;
  return [];
}

export function nextCursorOf(list: LinqChatList | LinqMessageList): string | null | undefined {
  if (Array.isArray(list)) return undefined;
  if ('next_cursor' in list) return list.next_cursor ?? null;
  return undefined;
}

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
/* Payment requests & experiences                                             */
/* -------------------------------------------------------------------------- */

export const LinqPaymentRequest = z
  .object({
    id: z.string().min(1),
    checkout_url: z.string().min(1),
    status: z.string(),
    amount: z.number().optional(),
    currency: z.string().optional(),
    expires_at: z.string().nullable().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();
export type LinqPaymentRequest = z.infer<typeof LinqPaymentRequest>;

export const LinqExperienceInvocation = z.object({
  name: z.enum(['agentpay', 'agentcard', 'link']),
  action: z.string().min(1),
  params: z.record(z.string(), z.unknown()).optional(),
});
export type LinqExperienceInvocation = z.infer<typeof LinqExperienceInvocation>;

/** `GET /v3/experiences` — live 2026-08-15 catalog (agentcard, agentpay, link, plus account extras). */
export const LinqExperienceList = z
  .object({
    experiences: z.array(
      z
        .object({
          experience: z.string().min(1),
          display_name: z.string().optional(),
          actions: z
            .array(
              z
                .object({
                  name: z.string(),
                  summary: z.string().optional(),
                  fields: z.record(z.string(), z.unknown()).optional(),
                })
                .passthrough(),
            )
            .optional(),
        })
        .passthrough(),
    ),
  })
  .passthrough();
export type LinqExperienceList = z.infer<typeof LinqExperienceList>;

export const LinqIMessageAppPart = z.object({
  type: z.literal('imessage_app'),
  app: z.object({
    name: z.string(),
    team_id: z.string(),
    bundle_id: z.string(),
  }),
  url: z.string().url(),
  fallback_text: z.string().optional(),
  layout: z
    .object({
      caption: z.string().optional(),
      subcaption: z.string().optional(),
      trailing_caption: z.string().optional(),
      trailing_subcaption: z.string().optional(),
      image_url: z.string().optional(),
    })
    .optional(),
});
export type LinqIMessageAppPart = z.infer<typeof LinqIMessageAppPart>;

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
