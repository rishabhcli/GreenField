/**
 * BAND adapter — agent coordination (and the honest limits of its "governance").
 *
 * Written against the raw HTTP surface at `https://app.band.ai/api/v1`. There
 * is no npm package for this — BAND ships a Python-only SDK (`band-sdk` on
 * PyPI); the docs literally say "npm: Not available (Python-only SDK)" — so
 * every request here is hand-written against the documented REST paths, and
 * `websocket.ts` hand-implements the Phoenix Channels client for the
 * read-only event stream. Every method makes a real call; with no credentials
 * configured, `requireSecret`/`assertActivated` raise a typed
 * `CredentialsMissingError` naming `BAND_AGENT_API_KEY`.
 *
 * Auth is `X-API-Key` (NOT bearer) — BAND's own docs distinguish an agent key
 * (`thnv_a_...`, used here) from a human key (`thnv_u_...`, for the separate
 * Human API this adapter does not implement) and note that an agent key gets
 * a 403 on Human API endpoints.
 *
 * --- Honest finding: BAND's marketed "governance" is broader than its API ---
 * BAND's landing page describes an interaction *control plane* for
 * "delegation, authority, approval and audit". The research pass read the
 * full documented API surface (Agent API + Human API) looking for the
 * primitives that framing implies, and found none of them: no role objects,
 * no policy objects, no permission-scope objects, no audit-log endpoint, and
 * no approval-workflow API. `BAND_MANIFEST` records this directly —
 * `coordination.governance` is bound with evidence kind
 * `marketing_claim_only`, which the capability registry structurally refuses
 * to ever report as `live_verified`, no matter what credentials are
 * configured.
 *
 * What BAND concretely, verifiably provides is coordination, not authority:
 * contacts as a mutual permission handshake, @mention as the routing/attention
 * primitive (a message without one is not delivered to anyone), one isolated
 * execution per agent per room, and `is_external`/`is_global` visibility
 * flags. None of that is a spend-approval or audit mechanism. Consequently,
 * this system's actual approval, spend-authority and audit-log functions live
 * in our own policy service, not in BAND — which is where they have to live
 * anyway, since they gate real money, and a third-party coordination layer
 * with no audit endpoint cannot be the system of record for that.
 */

import {
  NotFoundError,
  ProviderAuthError,
  ProviderUnavailableError,
  RateLimitError,
  ValidationError,
  type CredentialsMissingError,
  type FoundryError,
} from '@foundry/core';
import { ProviderAdapter, type AdapterContext, type ProbeResult } from '../http/adapter.js';
import { apiKeyHeaderAuth, type ProviderHttpClient } from '../http/client.js';
import { SECRETS, BAND_MANIFEST } from '../manifests.js';
import {
  BandAgentIdentity,
  BandChat,
  BandChatContext,
  BandContact,
  BandContactRequest,
  BandErrorEnvelope,
  BandEvent,
  BandEventKind,
  BandMemory,
  BandMessage,
  BandParticipant,
  BandPeer,
  BandTask,
  BandTaskBoard,
  bandListEnvelope,
  normaliseBandList,
} from './schemas.js';
import { BandWebSocketClient } from './websocket.js';

/** Converts BAND's documented `{"error": "...", "message": "..."}` envelope into our taxonomy. */
function classifyBandError(status: number, body: unknown): FoundryError | undefined {
  const parsed = BandErrorEnvelope.safeParse(body);
  if (!parsed.success) return undefined; // fall through to the client's generic status-code classifier
  const detail = parsed.data.message ?? parsed.data.error;
  const context = { bandError: parsed.data.error, status };
  if (status === 401 || status === 403) return new ProviderAuthError('band', detail, context);
  if (status === 429) return new RateLimitError('band', undefined, context);
  if (status === 404) return new NotFoundError('band', detail);
  if (status >= 500) return new ProviderUnavailableError('band', detail, context);
  if (status === 400 || status === 422) return new ValidationError(`BAND rejected the request: ${detail}`, context);
  return undefined;
}

/* -------------------------------------------------------------------------- */
/* Inputs                                                                      */
/* -------------------------------------------------------------------------- */

export interface CreateChatInput {
  readonly name?: string;
  readonly taskId?: string;
  readonly participantHandles?: readonly string[];
}

export interface SendMessageInput {
  /** Agent handles to @mention, with or without a leading `@`. Must be non-empty. */
  readonly recipients: readonly string[];
  readonly body: string;
  readonly taskId?: string;
}

export interface PostEventInput {
  readonly kind: BandEventKind;
  readonly payload?: Record<string, unknown>;
}

export interface ListMessagesOptions {
  readonly limit?: number;
  readonly before?: string;
  readonly after?: string;
}

export interface CreateTaskInput {
  readonly title: string;
  readonly metadata?: Record<string, unknown>;
}

export interface UpdateTaskInput {
  readonly title?: string;
  readonly status?: string;
  readonly metadata?: Record<string, unknown>;
}

export interface CreateMemoryInput {
  readonly content: string;
}

/* -------------------------------------------------------------------------- */
/* Adapter                                                                     */
/* -------------------------------------------------------------------------- */

export class BandAdapter extends ProviderAdapter {
  override readonly manifest = BAND_MANIFEST;

  constructor(ctx: AdapterContext) {
    super(ctx);
  }

  #client(): ProviderHttpClient {
    const secret = this.requireSecret(SECRETS.bandAgentApiKey);
    return this.http(apiKeyHeaderAuth('X-API-Key', secret), { classifyError: classifyBandError });
  }

  /** A Phoenix Channels client for the read-only event stream, wired with the agent API key. */
  createWebSocketClient(): BandWebSocketClient {
    const secret = this.requireSecret(SECRETS.bandAgentApiKey);
    return new BandWebSocketClient({ apiKey: secret });
  }

  /* --- Probe -------------------------------------------------------------- */

  override async probe(): Promise<ProbeResult> {
    const response = await this.#client().request(
      { method: 'GET', path: '/agent/me', operation: 'agent.me' },
      BandAgentIdentity,
    );
    return {
      succeeded: true,
      detail: `GET /agent/me succeeded${response.body.handle ? ` as @${response.body.handle}` : ''}`,
      evidence: { endpoint: 'GET /agent/me', agentId: response.body.id, handle: response.body.handle ?? null },
    };
  }

  /* --- Peers ---------------------------------------------------------------- */

  async listPeers(): Promise<readonly BandPeer[]> {
    this.assertActivated();
    const response = await this.#client().request(
      { method: 'GET', path: '/agent/peers', operation: 'agent.peers.list' },
      bandListEnvelope(BandPeer),
    );
    return normaliseBandList<BandPeer>(response.body);
  }

  /* --- Contacts --------------------------------------------------------------- */

  async listContacts(): Promise<readonly BandContact[]> {
    this.assertActivated();
    const response = await this.#client().request(
      { method: 'GET', path: '/agent/contacts', operation: 'agent.contacts.list' },
      bandListEnvelope(BandContact),
    );
    return normaliseBandList<BandContact>(response.body);
  }

  async addContact(handle: string): Promise<BandContact> {
    this.assertActivated();
    if (handle.trim().length === 0) throw new ValidationError('addContact requires a non-empty handle');
    const response = await this.#client().request(
      { method: 'POST', path: '/agent/contacts/add', operation: 'agent.contacts.add', body: { handle } },
      BandContact,
    );
    return response.body;
  }

  async removeContact(handle: string): Promise<void> {
    this.assertActivated();
    await this.#client().raw({
      method: 'POST',
      path: '/agent/contacts/remove',
      operation: 'agent.contacts.remove',
      body: { handle },
    });
  }

  async listContactRequests(): Promise<readonly BandContactRequest[]> {
    this.assertActivated();
    const response = await this.#client().request(
      { method: 'GET', path: '/agent/contacts/requests', operation: 'agent.contacts.requests.list' },
      bandListEnvelope(BandContactRequest),
    );
    return normaliseBandList<BandContactRequest>(response.body);
  }

  async respondToContactRequest(requestId: string, accept: boolean): Promise<BandContactRequest> {
    this.assertActivated();
    const response = await this.#client().request(
      {
        method: 'POST',
        path: '/agent/contacts/requests/respond',
        operation: 'agent.contacts.requests.respond',
        body: { request_id: requestId, accept },
      },
      BandContactRequest,
    );
    return response.body;
  }

  /* --- Chats ------------------------------------------------------------------ */

  async listChats(): Promise<readonly BandChat[]> {
    this.assertActivated();
    const response = await this.#client().request(
      { method: 'GET', path: '/agent/chats', operation: 'agent.chats.list' },
      bandListEnvelope(BandChat),
    );
    return normaliseBandList<BandChat>(response.body);
  }

  async createChat(input: CreateChatInput = {}): Promise<BandChat> {
    this.assertActivated();
    const response = await this.#client().request(
      {
        method: 'POST',
        path: '/agent/chats',
        operation: 'agent.chats.create',
        body: {
          ...(input.name ? { name: input.name } : {}),
          ...(input.taskId ? { task_id: input.taskId } : {}),
          ...(input.participantHandles ? { participants: input.participantHandles } : {}),
        },
      },
      BandChat,
    );
    return response.body;
  }

  async getChat(chatId: string): Promise<BandChat> {
    this.assertActivated();
    const response = await this.#client().request(
      { method: 'GET', path: `/agent/chats/${encodeURIComponent(chatId)}`, operation: 'agent.chats.get' },
      BandChat,
    );
    return response.body;
  }

  async renameChat(chatId: string, name: string): Promise<BandChat> {
    this.assertActivated();
    if (name.trim().length === 0) throw new ValidationError('renameChat requires a non-empty name', { chatId });
    const response = await this.#client().request(
      { method: 'PATCH', path: `/agent/chats/${encodeURIComponent(chatId)}`, operation: 'agent.chats.rename', body: { name } },
      BandChat,
    );
    return response.body;
  }

  /* --- Messages ----------------------------------------------------------------- */

  /** Pagination scheme is UNVERIFIED; `limit`/`before`/`after` are passed through opportunistically. */
  async listMessages(chatId: string, options: ListMessagesOptions = {}): Promise<readonly BandMessage[]> {
    this.assertActivated();
    const response = await this.#client().request(
      {
        method: 'GET',
        path: `/agent/chats/${encodeURIComponent(chatId)}/messages`,
        operation: 'agent.chats.messages.list',
        query: { limit: options.limit, before: options.before, after: options.after },
      },
      bandListEnvelope(BandMessage),
    );
    return normaliseBandList<BandMessage>(response.body);
  }

  /** `null` means no message is currently waiting — a real, honest outcome, not a failure. */
  async getNextMessage(chatId: string): Promise<BandMessage | null> {
    this.assertActivated();
    const response = await this.#client().request(
      {
        method: 'GET',
        path: `/agent/chats/${encodeURIComponent(chatId)}/messages/next`,
        operation: 'agent.chats.messages.next',
      },
      BandMessage.nullable(),
    );
    return response.body;
  }

  /**
   * Sends a message. BAND's docs state messages without an @mention are not
   * routed to anyone ("Agents only see messages that mention them"), so an
   * empty `recipients` list is refused outright rather than silently sent —
   * that would be an unroutable, un-received message masquerading as a real
   * send. The @handle prefixes are built into the message content itself,
   * since BAND's mention mechanism is textual (like Slack/Discord @mentions),
   * not a separate structured "to" field.
   */
  async sendMessage(chatId: string, input: SendMessageInput): Promise<BandMessage> {
    this.assertActivated();
    if (input.recipients.length === 0) {
      throw new ValidationError(
        'BAND routes a message only to the agents it @mentions; messages without one route to nobody per the ' +
          'docs. Sending with an empty recipient list would silently produce an unroutable message — that is a ' +
          'fake send, not a real one, so this adapter refuses it.',
        { chatId },
      );
    }
    if (input.body.trim().length === 0) {
      throw new ValidationError('sendMessage requires a non-empty body', { chatId });
    }
    const mentionPrefix = input.recipients.map((handle) => `@${handle.replace(/^@/, '')}`).join(' ');
    const content = `${mentionPrefix} ${input.body}`.trim();

    const response = await this.#client().request(
      {
        method: 'POST',
        path: `/agent/chats/${encodeURIComponent(chatId)}/messages`,
        operation: 'agent.chats.messages.send',
        body: { content, ...(input.taskId ? { task_id: input.taskId } : {}) },
      },
      BandMessage,
    );
    return response.body;
  }

  async markMessageProcessing(chatId: string, messageId: string): Promise<BandMessage> {
    this.assertActivated();
    const response = await this.#client().request(
      {
        method: 'POST',
        path: `/agent/chats/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(messageId)}/processing`,
        operation: 'agent.chats.messages.mark_processing',
      },
      BandMessage,
    );
    return response.body;
  }

  async markMessageProcessed(chatId: string, messageId: string): Promise<BandMessage> {
    this.assertActivated();
    const response = await this.#client().request(
      {
        method: 'POST',
        path: `/agent/chats/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(messageId)}/processed`,
        operation: 'agent.chats.messages.mark_processed',
      },
      BandMessage,
    );
    return response.body;
  }

  async markMessageFailed(chatId: string, messageId: string, reason?: string): Promise<BandMessage> {
    this.assertActivated();
    const response = await this.#client().request(
      {
        method: 'POST',
        path: `/agent/chats/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(messageId)}/failed`,
        operation: 'agent.chats.messages.mark_failed',
        body: reason ? { reason } : {},
      },
      BandMessage,
    );
    return response.body;
  }

  /**
   * Posts an observability event (`tool_call`/`tool_result`/`thought`/`error`/`task`).
   * Documented as visible to humans and explicitly NOT routed to other agents
   * — this is not a substitute for `sendMessage`'s @mention routing, and
   * calling it does not notify or wake any other agent in the room.
   */
  async postEvent(chatId: string, input: PostEventInput): Promise<BandEvent> {
    this.assertActivated();
    const response = await this.#client().request(
      {
        method: 'POST',
        path: `/agent/chats/${encodeURIComponent(chatId)}/events`,
        operation: 'agent.chats.events.post',
        body: { kind: input.kind, ...(input.payload ? { payload: input.payload } : {}) },
      },
      BandEvent,
    );
    return response.body;
  }

  /* --- Participants -------------------------------------------------------------- */

  async listParticipants(chatId: string): Promise<readonly BandParticipant[]> {
    this.assertActivated();
    const response = await this.#client().request(
      {
        method: 'GET',
        path: `/agent/chats/${encodeURIComponent(chatId)}/participants`,
        operation: 'agent.chats.participants.list',
      },
      bandListEnvelope(BandParticipant),
    );
    return normaliseBandList<BandParticipant>(response.body);
  }

  async addParticipant(chatId: string, handle: string): Promise<BandParticipant> {
    this.assertActivated();
    if (handle.trim().length === 0) throw new ValidationError('addParticipant requires a non-empty handle', { chatId });
    const response = await this.#client().request(
      {
        method: 'POST',
        path: `/agent/chats/${encodeURIComponent(chatId)}/participants`,
        operation: 'agent.chats.participants.add',
        body: { handle },
      },
      BandParticipant,
    );
    return response.body;
  }

  /**
   * UNVERIFIED path segment: research confirms `GET/POST/DELETE` on the
   * participants collection but does not spell out the DELETE sub-path. This
   * assumes the conventional `.../participants/{handle}` shape.
   */
  async removeParticipant(chatId: string, handle: string): Promise<void> {
    this.assertActivated();
    await this.#client().raw({
      method: 'DELETE',
      path: `/agent/chats/${encodeURIComponent(chatId)}/participants/${encodeURIComponent(handle)}`,
      operation: 'agent.chats.participants.remove',
    });
  }

  /* --- Context, activity -------------------------------------------------------- */

  /** Rehydration payload. Contents are entirely UNVERIFIED and kept opaque — see `schemas.ts`. */
  async getChatContext(chatId: string): Promise<BandChatContext> {
    this.assertActivated();
    const response = await this.#client().request(
      { method: 'GET', path: `/agent/chats/${encodeURIComponent(chatId)}/context`, operation: 'agent.chats.context' },
      BandChatContext,
    );
    return response.body;
  }

  /** Keep-alive ping. Response shape is undocumented and not meaningful, so this uses `raw()` rather than inventing a schema. */
  async reportActivity(chatId: string): Promise<void> {
    this.assertActivated();
    await this.#client().raw({
      method: 'POST',
      path: `/agent/chats/${encodeURIComponent(chatId)}/activity`,
      operation: 'agent.chats.activity',
    });
  }

  /* --- Task board ------------------------------------------------------------------ */

  async listTasks(chatId: string): Promise<readonly BandTask[]> {
    this.assertActivated();
    const response = await this.#client().request(
      { method: 'GET', path: `/agent/chats/${encodeURIComponent(chatId)}/tasks`, operation: 'agent.chats.tasks.list' },
      bandListEnvelope(BandTask),
    );
    return normaliseBandList<BandTask>(response.body);
  }

  async createTask(chatId: string, input: CreateTaskInput): Promise<BandTask> {
    this.assertActivated();
    if (input.title.trim().length === 0) throw new ValidationError('createTask requires a non-empty title', { chatId });
    const response = await this.#client().request(
      {
        method: 'POST',
        path: `/agent/chats/${encodeURIComponent(chatId)}/tasks`,
        operation: 'agent.chats.tasks.create',
        body: { title: input.title, ...(input.metadata ? { metadata: input.metadata } : {}) },
      },
      BandTask,
    );
    return response.body;
  }

  async updateTask(chatId: string, taskId: string, input: UpdateTaskInput): Promise<BandTask> {
    this.assertActivated();
    const response = await this.#client().request(
      {
        method: 'PUT',
        path: `/agent/chats/${encodeURIComponent(chatId)}/tasks/${encodeURIComponent(taskId)}`,
        operation: 'agent.chats.tasks.update',
        body: {
          ...(input.title ? { title: input.title } : {}),
          ...(input.status ? { status: input.status } : {}),
          ...(input.metadata ? { metadata: input.metadata } : {}),
        },
      },
      BandTask,
    );
    return response.body;
  }

  async listTaskHistory(chatId: string): Promise<readonly BandTask[]> {
    this.assertActivated();
    const response = await this.#client().request(
      {
        method: 'GET',
        path: `/agent/chats/${encodeURIComponent(chatId)}/tasks/history`,
        operation: 'agent.chats.tasks.history',
      },
      bandListEnvelope(BandTask),
    );
    return normaliseBandList<BandTask>(response.body);
  }

  async getTaskBoard(chatId: string): Promise<BandTaskBoard> {
    this.assertActivated();
    const response = await this.#client().request(
      { method: 'GET', path: `/agent/chats/${encodeURIComponent(chatId)}/board`, operation: 'agent.chats.board' },
      BandTaskBoard,
    );
    return response.body;
  }

  /* --- Memories ------------------------------------------------------------------- */

  async listMemories(): Promise<readonly BandMemory[]> {
    this.assertActivated();
    const response = await this.#client().request(
      { method: 'GET', path: '/agent/memories', operation: 'agent.memories.list' },
      bandListEnvelope(BandMemory),
    );
    return normaliseBandList<BandMemory>(response.body);
  }

  async createMemory(input: CreateMemoryInput): Promise<BandMemory> {
    this.assertActivated();
    if (input.content.trim().length === 0) throw new ValidationError('createMemory requires non-empty content');
    const response = await this.#client().request(
      { method: 'POST', path: '/agent/memories', operation: 'agent.memories.create', body: { content: input.content } },
      BandMemory,
    );
    return response.body;
  }

  async supersedeMemory(memoryId: string, input: CreateMemoryInput): Promise<BandMemory> {
    this.assertActivated();
    if (input.content.trim().length === 0) throw new ValidationError('supersedeMemory requires non-empty content', { memoryId });
    const response = await this.#client().request(
      {
        method: 'POST',
        path: `/agent/memories/${encodeURIComponent(memoryId)}/supersede`,
        operation: 'agent.memories.supersede',
        body: { content: input.content },
      },
      BandMemory,
    );
    return response.body;
  }
}

export type { CredentialsMissingError };
export * from './schemas.js';
export * from './websocket.js';
