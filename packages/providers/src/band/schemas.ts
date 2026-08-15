/**
 * Zod schemas for the BAND objects we consume.
 *
 * BAND's docs enumerate endpoint paths thoroughly but show almost no sample
 * response bodies — far less field-level detail than Stripe or even Terac.
 * Every schema below is deliberately permissive (`id` plus `.passthrough()`)
 * rather than a rigid shape asserted from guesswork: the one thing we can be
 * confident of for any of these resources is that it has an id, because every
 * operation that reads one back also references it by id elsewhere in the
 * documented surface (e.g. `/agent/chats/{id}/messages`). Field names beyond
 * that are accepted opportunistically and read defensively at the call site.
 */

import { z } from 'zod';

/** `{"error": "unauthorized", "message": "Invalid or missing API key"}` — documented verbatim. */
export const BandErrorEnvelope = z.object({
  error: z.string(),
  message: z.string().optional(),
});
export type BandErrorEnvelope = z.infer<typeof BandErrorEnvelope>;

/* -------------------------------------------------------------------------- */
/* Identity                                                                    */
/* -------------------------------------------------------------------------- */

/** `GET /agent/me` — our live probe. Exact field set beyond `id` UNVERIFIED. */
export const BandAgentIdentity = z
  .object({
    id: z.string(),
    handle: z.string().nullish(),
    name: z.string().nullish(),
    is_external: z.boolean().nullish(),
    is_global: z.boolean().nullish(),
  })
  .passthrough();
export type BandAgentIdentity = z.infer<typeof BandAgentIdentity>;

/** POST /me/agents/register — API key is shown once. */
export const BandAgentRegistration = z
  .object({
    data: z
      .object({
        agent: z.object({ id: z.string() }).passthrough().optional(),
        credentials: z.object({ api_key: z.string() }).passthrough().optional(),
      })
      .passthrough()
      .optional(),
    agent: z.object({ id: z.string() }).passthrough().optional(),
    credentials: z.object({ api_key: z.string() }).passthrough().optional(),
  })
  .passthrough();
export type BandAgentRegistration = z.infer<typeof BandAgentRegistration>;

export function registrationApiKey(body: BandAgentRegistration): { agentId: string; apiKey: string } | undefined {
  const nested = body.data;
  const agentId =
    (typeof nested?.agent?.id === 'string' ? nested.agent.id : undefined) ??
    (typeof body.agent?.id === 'string' ? body.agent.id : undefined);
  const apiKey =
    (typeof nested?.credentials?.api_key === 'string' ? nested.credentials.api_key : undefined) ??
    (typeof body.credentials?.api_key === 'string' ? body.credentials.api_key : undefined);
  if (!agentId || !apiKey) return undefined;
  return { agentId, apiKey };
}

export const BandPeer = z
  .object({
    id: z.string(),
    handle: z.string().nullish(),
    name: z.string().nullish(),
  })
  .passthrough();
export type BandPeer = z.infer<typeof BandPeer>;

/* -------------------------------------------------------------------------- */
/* Contacts                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Contacts are documented as a mutual permission handshake (per the manifest's
 * `coordination.governance` evidence). Exact status vocabulary UNVERIFIED.
 */
export const BandContact = z
  .object({
    id: z.string(),
    handle: z.string().nullish(),
    name: z.string().nullish(),
    status: z.string().nullish(),
  })
  .passthrough();
export type BandContact = z.infer<typeof BandContact>;

export const BandContactRequest = z
  .object({
    id: z.string(),
    from_handle: z.string().nullish(),
    from_agent_id: z.string().nullish(),
    status: z.string().nullish(),
    created_at: z.string().nullish(),
  })
  .passthrough();
export type BandContactRequest = z.infer<typeof BandContactRequest>;

/* -------------------------------------------------------------------------- */
/* Chats                                                                       */
/* -------------------------------------------------------------------------- */

export const BandChat = z
  .object({
    id: z.string(),
    name: z.string().nullish(),
    title: z.string().nullish(),
    task_id: z.string().nullish(),
    is_external: z.boolean().nullish(),
    is_global: z.boolean().nullish(),
    created_at: z.string().nullish(),
    inserted_at: z.string().nullish(),
    updated_at: z.string().nullish(),
  })
  .passthrough();
export type BandChat = z.infer<typeof BandChat>;

/** Band OpenAPI: task_id is optional uuid. Company ids like `co_…` 422. */
const BAND_TASK_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * POST /agent/chats body. Live 2026-08-15: `chat` is required; title lives
 * under `chat.title` (not top-level `name`); empty `{}` 422s Missing field: chat.
 */
export function bandCreateChatBody(input: {
  readonly name?: string;
  readonly taskId?: string;
}): { readonly chat: { readonly title?: string; readonly task_id?: string } } {
  const chat: { title?: string; task_id?: string } = {};
  const title = input.name?.trim();
  if (title) chat.title = title;
  if (input.taskId && BAND_TASK_UUID.test(input.taskId)) chat.task_id = input.taskId;
  return { chat };
}

export interface BandSendMessageMention {
  readonly handle: string;
}

/**
 * POST /agent/chats/{id}/messages/{id}/failed body. Live 2026-08-15: top-level
 * `reason` 422s Unexpected field: reason (`details["/reason"]`). The documented
 * required field is `error` (not nested).
 */
export function bandMarkFailedBody(reason: string): { readonly error: string } {
  return { error: reason.trim() };
}

/**
 * POST /agent/chats/{id}/messages body. Live 2026-08-15: top-level `content`
 * 422s Unexpected field: content; `message` is required; `message.mentions`
 * is required with minItems 1 (handle-only entries resolve in-room);
 * `message.task_id` 422s Unexpected field: task_id.
 */
export function bandSendMessageBody(input: {
  readonly recipients: readonly string[];
  readonly body: string;
}): {
  readonly message: {
    readonly content: string;
    readonly mentions: readonly BandSendMessageMention[];
  };
} {
  const seen = new Set<string>();
  const mentions: BandSendMessageMention[] = [];
  for (const raw of input.recipients) {
    const handle = raw.replace(/^@/, '').trim();
    if (!handle || seen.has(handle)) continue;
    seen.add(handle);
    mentions.push({ handle });
  }
  const mentionPrefix = mentions.map((m) => `@${m.handle}`).join(' ');
  const content = `${mentionPrefix} ${input.body}`.trim();
  return { message: { content, mentions } };
}

export const BandParticipant = z
  .object({
    id: z.string(),
    handle: z.string().nullish(),
    name: z.string().nullish(),
    role: z.string().nullish(),
  })
  .passthrough();
export type BandParticipant = z.infer<typeof BandParticipant>;

/** `GET /agent/chats/{id}/context` — rehydration payload. Contents entirely UNVERIFIED; treated as opaque. */
export const BandChatContext = z.record(z.string(), z.unknown());
export type BandChatContext = z.infer<typeof BandChatContext>;

/* -------------------------------------------------------------------------- */
/* Messages                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The message body field name is UNVERIFIED — `content`, `body` and `text` are
 * all plausible conventions and are accepted defensively. `messageText()`
 * below reads whichever is present, in that preference order.
 */
export const BandMessage = z
  .object({
    id: z.string(),
    chat_id: z.string().nullish(),
    content: z.string().nullish(),
    body: z.string().nullish(),
    text: z.string().nullish(),
    sender_id: z.string().nullish(),
    sender_handle: z.string().nullish(),
    mentions: z.array(z.string()).nullish(),
    status: z.string().nullish(),
    task_id: z.string().nullish(),
    created_at: z.string().nullish(),
  })
  .passthrough();
export type BandMessage = z.infer<typeof BandMessage>;

/** Reads whichever body-text field the wire payload actually used. */
export function messageText(message: BandMessage): string | null {
  return message.content ?? message.body ?? message.text ?? null;
}

/** Visible to humans; explicitly documented NOT to route to other agents. */
export const BandEventKind = z.enum(['tool_call', 'tool_result', 'thought', 'error', 'task']);
export type BandEventKind = z.infer<typeof BandEventKind>;

export const BandEvent = z
  .object({
    id: z.string().nullish(),
    kind: BandEventKind.nullish(),
    chat_id: z.string().nullish(),
    created_at: z.string().nullish(),
  })
  .passthrough();
export type BandEvent = z.infer<typeof BandEvent>;

/* -------------------------------------------------------------------------- */
/* Tasks                                                                       */
/* -------------------------------------------------------------------------- */

export const BandTask = z
  .object({
    id: z.string(),
    chat_id: z.string().nullish(),
    title: z.string().nullish(),
    status: z.string().nullish(),
    created_at: z.string().nullish(),
    updated_at: z.string().nullish(),
  })
  .passthrough();
export type BandTask = z.infer<typeof BandTask>;

/** `GET /agent/chats/{id}/board` — shape entirely UNVERIFIED; treated as opaque. */
export const BandTaskBoard = z.record(z.string(), z.unknown());
export type BandTaskBoard = z.infer<typeof BandTaskBoard>;

/* -------------------------------------------------------------------------- */
/* Memories                                                                    */
/* -------------------------------------------------------------------------- */

export const BandMemory = z
  .object({
    id: z.string(),
    content: z.string().nullish(),
    superseded_by: z.string().nullish(),
    created_at: z.string().nullish(),
  })
  .passthrough();
export type BandMemory = z.infer<typeof BandMemory>;

/* -------------------------------------------------------------------------- */
/* List envelope                                                              */
/* -------------------------------------------------------------------------- */

/**
 * No pagination scheme is documented anywhere for BAND (contrast Terac's
 * explicit cursor envelope and Replay's `page`/`page_size` params). List
 * endpoints are modelled defensively as either a bare array or an
 * `{items|data:[...]}` wrapper, same reasoning as Replay's list envelope.
 */
export function bandListEnvelope<T extends z.ZodTypeAny>(item: T) {
  return z.union([z.object({ items: z.array(item).optional(), data: z.array(item).optional() }).passthrough(), z.array(item)]);
}

/** Live 2026-08-15: single resources are wrapped `{ data: T }`. */
export function bandResource<T extends z.ZodTypeAny>(item: T) {
  return z.preprocess((raw) => {
    if (raw && typeof raw === 'object' && 'data' in raw && !('id' in raw)) {
      return (raw as { data: unknown }).data;
    }
    return raw;
  }, item);
}

export function normaliseBandList<T>(raw: readonly T[] | { items?: T[]; data?: T[] }): readonly T[] {
  if (Array.isArray(raw)) return raw as readonly T[];
  // `Array.isArray` does not narrow away a `readonly T[]` union member, so the
  // envelope branch is named explicitly rather than relying on inference.
  const envelope = raw as Exclude<typeof raw, readonly T[]>;
  return envelope.items ?? envelope.data ?? [];
}

/* -------------------------------------------------------------------------- */
/* Phoenix Channels wire frame                                                 */
/* -------------------------------------------------------------------------- */

/** `[join_ref, ref, topic, event, payload]` — the Phoenix v2 JSON serializer frame. */
export const BandPhoenixFrame = z.tuple([z.string().nullable(), z.string().nullable(), z.string(), z.string(), z.unknown()]);
export type BandPhoenixFrame = z.infer<typeof BandPhoenixFrame>;
