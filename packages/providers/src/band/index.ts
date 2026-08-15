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
 * (`band_a_...` / legacy `thnv_a_...`, used here) from a human key
 * (`band_u_...` / legacy `thnv_u_...`, for the Human API that registers agents)
 * and note that an agent key gets a 403 on Human API endpoints.
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
  Secret,
  ValidationError,
  type CredentialsMissingError,
  type FoundryError,
} from '@foundry/core';
import { ProviderAdapter, type AdapterContext, type ProbeResult } from '../http/adapter.js';
import { apiKeyHeaderAuth, ProviderHttpClient } from '../http/client.js';
import { limiterFor } from '../http/rate-limit.js';
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
  bandResource,
  normaliseBandList,
  registrationApiKey,
  BandAgentRegistration,
  bandCreateChatBody,
  bandSendMessageBody,
  bandMarkFailedBody,
} from './schemas.js';
import { BandWebSocketClient } from './websocket.js';

/** Live Zero Human Co coordination room. Do not open a decorative second chat. */
export const ZERO_HUMAN_CO_COORDINATION_ROOM_ID = 'a70129cc-0663-4090-86b5-c5a98025532e';

export interface ResolveCoordinationRoomInput {
  readonly configuredChatId?: string | null;
  readonly companyName?: string;
}

export interface ResolvedCoordinationRoom {
  readonly chatId: string;
  readonly created: boolean;
}

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
  /** Mapped to `chat.title` (Band rejects top-level `name`). */
  readonly name?: string;
  /** Included only when it is a UUID; company ids are not Band task ids. */
  readonly taskId?: string;
  readonly participantHandles?: readonly string[];
}

export interface SendMessageInput {
  /** Agent/user handles to @mention, with or without a leading `@`. Must be non-empty. */
  readonly recipients: readonly string[];
  readonly body: string;
  /**
   * Ignored on the wire. Live Band `POST /messages` 422s `message.task_id`
   * as an unexpected field; Foundry run ids are not Band task UUIDs.
   */
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
  #humanHttpClient: ProviderHttpClient | undefined;

  constructor(ctx: AdapterContext) {
    super(ctx);
  }

  #client(): ProviderHttpClient {
    const secret = this.requireSecret(SECRETS.bandAgentApiKey);
    return this.http(apiKeyHeaderAuth('X-API-Key', secret), { classifyError: classifyBandError });
  }

  /**
   * Separate client: `this.http()` memoises one auth header, and a human key
   * must not be reused on Agent API paths (or vice versa).
   */
  #humanClient(): ProviderHttpClient {
    if (!this.#humanHttpClient) {
      const secret = this.requireSecret(SECRETS.bandUserApiKey);
      this.#humanHttpClient = new ProviderHttpClient({
        provider: this.provider,
        baseUrl: this.baseUrl(),
        auth: apiKeyHeaderAuth('X-API-Key', secret),
        rateLimiter: limiterFor(this.provider),
        defaultTimeoutMs: 30_000,
        classifyError: classifyBandError,
      });
    }
    return this.#humanHttpClient;
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
      bandResource(BandAgentIdentity),
    );
    return {
      succeeded: true,
      detail: `GET /agent/me succeeded${response.body.handle ? ` as @${response.body.handle}` : ''}`,
      evidence: { endpoint: 'GET /agent/me', agentId: response.body.id, handle: response.body.handle ?? null },
    };
  }

  async getMe(): Promise<BandAgentIdentity> {
    this.assertActivated();
    const response = await this.#client().request(
      { method: 'GET', path: '/agent/me', operation: 'agent.me' },
      bandResource(BandAgentIdentity),
    );
    return response.body;
  }

  /* --- Human API (register agents) --------------------------------------- */

  async listOwnedAgents(): Promise<unknown> {
    const response = await this.#humanClient().raw({
      method: 'GET',
      path: '/me/agents',
      operation: 'me.agents.list',
    });
    return response.body;
  }

  /**
   * Registers a remote agent. The returned API key is shown once — caller must
   * persist it as BAND_AGENT_API_KEY. Human API is documented as Enterprise;
   * a Pro-only workspace will fail honestly here.
   */
  async registerExternalAgent(input: {
    readonly name: string;
    readonly description: string;
  }): Promise<{ readonly agentId: string; readonly apiKey: Secret }> {
    if (input.name.trim().length === 0) throw new ValidationError('registerExternalAgent requires a name');
    const response = await this.#humanClient().request(
      {
        method: 'POST',
        path: '/me/agents/register',
        operation: 'me.agents.register',
        retryable: false,
        body: { agent: { name: input.name, description: input.description } },
      },
      BandAgentRegistration,
    );
    const extracted = registrationApiKey(response.body);
    if (!extracted) {
      throw new ProviderUnavailableError(
        'band',
        'POST /me/agents/register succeeded but the response did not include credentials.api_key',
        { status: response.status },
      );
    }
    return {
      agentId: extracted.agentId,
      apiKey: new Secret('BAND_AGENT_API_KEY', extracted.apiKey, 'unknown'),
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
      bandResource(BandContact),
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
      bandResource(BandContactRequest),
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

  /**
   * Picks the company coordination room. A configured id or the live Zero
   * Human Co room wins; createChat is last resort, never a substitute for
   * "we already have a room."
   */
  async resolveCoordinationRoom(input: ResolveCoordinationRoomInput = {}): Promise<ResolvedCoordinationRoom> {
    const configured = input.configuredChatId?.trim();
    if (configured) {
      return { chatId: configured, created: false };
    }

    const chats = await this.listChats();
    const known = chats.find((chat) => chat.id === ZERO_HUMAN_CO_COORDINATION_ROOM_ID);
    if (known) return { chatId: known.id, created: false };

    const expectedTitle = `${input.companyName?.trim() || 'Zero Human Co'} coordination`;
    const named = chats.find((chat) => {
      const title = (chat.title ?? chat.name ?? '').trim();
      return title === expectedTitle || chat.id === expectedTitle;
    });
    if (named) return { chatId: named.id, created: false };

    const chat = await this.createChat({ name: expectedTitle });
    return { chatId: chat.id, created: true };
  }

  async createChat(input: CreateChatInput = {}): Promise<BandChat> {
    this.assertActivated();
    const response = await this.#client().request(
      {
        method: 'POST',
        path: '/agent/chats',
        operation: 'agent.chats.create',
        body: bandCreateChatBody(input),
      },
      bandResource(BandChat),
    );
    const chat = response.body;
    if (input.participantHandles) {
      for (const handle of input.participantHandles) {
        await this.addParticipant(chat.id, handle);
      }
    }
    return chat;
  }

  async getChat(chatId: string): Promise<BandChat> {
    this.assertActivated();
    const response = await this.#client().request(
      { method: 'GET', path: `/agent/chats/${encodeURIComponent(chatId)}`, operation: 'agent.chats.get' },
      bandResource(BandChat),
    );
    return response.body;
  }

  async renameChat(chatId: string, name: string): Promise<BandChat> {
    this.assertActivated();
    if (name.trim().length === 0) throw new ValidationError('renameChat requires a non-empty name', { chatId });
    const response = await this.#client().request(
      { method: 'PATCH', path: `/agent/chats/${encodeURIComponent(chatId)}`, operation: 'agent.chats.rename', body: { name } },
      bandResource(BandChat),
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
      bandResource(BandMessage.nullable()),
    );
    return response.body;
  }

  /**
   * Sends a message. BAND's docs state messages without an @mention are not
   * routed to anyone ("Agents only see messages that mention them"), so an
   * empty `recipients` list is refused outright rather than silently sent —
   * that would be an unroutable, un-received message masquerading as a real
   * send. The live Agent API requires `{ message: { content, mentions } }`;
   * each recipient becomes a `mentions[].handle` and an `@handle` in content.
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
    const body = bandSendMessageBody({ recipients: input.recipients, body: input.body });
    if (body.message.mentions.length === 0) {
      throw new ValidationError(
        'BAND routes a message only to the agents it @mentions; messages without one route to nobody per the ' +
          'docs. Sending with an empty recipient list would silently produce an unroutable message — that is a ' +
          'fake send, not a real one, so this adapter refuses it.',
        { chatId },
      );
    }

    const response = await this.#client().request(
      {
        method: 'POST',
        path: `/agent/chats/${encodeURIComponent(chatId)}/messages`,
        operation: 'agent.chats.messages.send',
        body,
      },
      bandResource(BandMessage),
    );
    return response.body;
  }

  /**
   * Executor entry: claim the dispatch @mention before any LLM turn.
   * Missing ids mean the room never received the handoff — start must break.
   */
  async claimHandoff(chatId: string | null | undefined, messageId: string | null | undefined): Promise<BandMessage> {
    if (!chatId?.trim() || !messageId?.trim()) {
      throw new ValidationError(
        'A BAND room message must be claimed before work starts. Missing chat or message id means dispatch never posted an @mention.',
        { chatId: chatId ?? null, messageId: messageId ?? null },
      );
    }
    return this.markMessageProcessing(chatId, messageId);
  }

  async markMessageProcessing(chatId: string, messageId: string): Promise<BandMessage> {
    this.assertActivated();
    const response = await this.#client().request(
      {
        method: 'POST',
        path: `/agent/chats/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(messageId)}/processing`,
        operation: 'agent.chats.messages.mark_processing',
      },
      bandResource(BandMessage),
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
      bandResource(BandMessage),
    );
    return response.body;
  }

  async markMessageFailed(chatId: string, messageId: string, reason?: string): Promise<BandMessage> {
    this.assertActivated();
    const error = reason?.trim() ?? '';
    if (!error) {
      throw new ValidationError(
        'markMessageFailed requires a non-empty error. Live BAND 422s Unexpected field: reason and requires `error`.',
        { chatId, messageId },
      );
    }
    const response = await this.#client().request(
      {
        method: 'POST',
        path: `/agent/chats/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(messageId)}/failed`,
        operation: 'agent.chats.messages.mark_failed',
        body: bandMarkFailedBody(error),
      },
      bandResource(BandMessage),
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
      bandResource(BandEvent),
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
      bandResource(BandParticipant),
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
      bandResource(BandChatContext),
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
      bandResource(BandTask),
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
      bandResource(BandTask),
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
      bandResource(BandTaskBoard),
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
      bandResource(BandMemory),
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
      bandResource(BandMemory),
    );
    return response.body;
  }
}

export type { CredentialsMissingError };
export * from './schemas.js';
export * from './websocket.js';
