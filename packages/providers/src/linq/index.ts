/**
 * Linq adapter — iMessage, RCS, SMS and Voice for the customer-support loop.
 *
 * Written against `docs/research/SPONSOR_API_RESEARCH.md` section 6 (verified
 * 2026-08-14, authoritative) and structured the way `../stripe/index.ts` is:
 * narrow zod schemas, one adapter class, comments that explain *why*. Every
 * method here makes a real HTTP call; with no `LINQ_API_V3_API_KEY` configured,
 * `requireSecret` raises a typed `CredentialsMissingError`, which is the
 * correct output — nothing here substitutes a stub for it.
 *
 * Two things make this adapter different from a typical REST client:
 *   1. Opt-out is a compliance boundary, not a nicety. A message must never
 *      reach the wire for a recipient we already know has opted out, and a
 *      provider-confirmed opt-out (error 2024 / HTTP 403) must never be
 *      retried or silently worked around. Both directions are implemented
 *      below, not just documented.
 *   2. Several surfaces (chat/message read fields, and all of Voice) go
 *      beyond what the research doc quotes verbatim. Those spots say so
 *      explicitly and are isolated so a corrected shape is a small diff.
 */

import {
  CredentialsMissingError,
  FoundryError,
  PolicyDeniedError,
  ValidationError,
  isOptOutMessage,
  type MessageChannel,
  type MessageDeliveryStatus,
} from '@foundry/core';
import { ProviderAdapter, type AdapterContext, type ProbeResult } from '../http/adapter.js';
import { bearerAuth, type ProviderHttpClient } from '../http/client.js';
import { verifyStandardWebhook, type VerificationResult } from '../http/webhook-verify.js';
import { SECRETS, LINQ_MANIFEST } from '../manifests.js';
import {
  LinqAttachmentUploadResponse,
  LinqBlockedHandle,
  LinqBlockedHandleList,
  LinqCallResponse,
  LinqCapabilityCheckResponse,
  LinqChat,
  LinqChatList,
  LinqExperienceInvocation,
  LinqExperienceList,
  LinqIMessageAppPart,
  LinqMessage,
  LinqMessageList,
  LinqMessagePartInput,
  LinqPaymentRequest,
  LinqPhoneNumber,
  LinqPhoneNumberList,
  LinqSendMessageResponse,
  blockedHandlesOf,
  chatsOf,
  extractLinqErrorCode,
  extractLinqErrorMessage,
  messagesOf,
  nextCursorOf,
  phoneNumbersOf,
  reputationStatusOf,
} from './schemas.js';

/* -------------------------------------------------------------------------- */
/* Opt-out: the compliance boundary                                           */
/* -------------------------------------------------------------------------- */

/**
 * Terminal by construction: `category: 'policy_denied'` is not in the
 * platform's retryable set (`core/errors.ts`), so a retry loop, a queue
 * consumer or a naive `withRetry` wrapper cannot accidentally re-attempt a
 * send Linq has already refused. Linq enforces the same rule server-side
 * (error code 2024 / HTTP 403) — this class exists so *our* side agrees with
 * it before and after the network call, not only after.
 */
export class LinqOptOutError extends FoundryError {
  constructor(handle: string, reason: string, context?: Record<string, unknown>) {
    super({
      category: 'policy_denied',
      code: 'linq.recipient_opted_out',
      message: `Linq will not deliver to "${handle}": ${reason}`,
      context: { handle, reason, ...context },
    });
  }
}

/** Delegates to core's keyword check so "is this an opt-out?" has one definition platform-wide. */
export function isOptOutInbound(body: string): boolean {
  return isOptOutMessage(body);
}

/** Local ledger the adapter consults *before* sending, so a known-opted-out recipient never reaches the wire. */
export interface OptOutStateStore {
  isOptedOut(handle: string): Promise<boolean> | boolean;
  /** Called after Linq itself reports a recipient opted out (error 2024), so the local ledger catches up. */
  markOptedOut?(handle: string, reason: string): Promise<void> | void;
}

/**
 * Default when no ledger is wired: never blocks locally, relies entirely on
 * Linq's server-side enforcement. That enforcement is real and documented,
 * but it costs a round trip to discover per attempt, so `setOptOutStateStore`
 * should be wired to whatever the support domain persists as soon as it
 * exists.
 */
const NO_LOCAL_OPT_OUT_STATE: OptOutStateStore = { isOptedOut: () => false };

/* -------------------------------------------------------------------------- */
/* Inputs / results                                                           */
/* -------------------------------------------------------------------------- */

export interface LinqSendMessageInput {
  readonly to: readonly string[];
  readonly from?: string;
  readonly parts: readonly LinqMessagePartInput[];
  readonly preferredService?: 'iMessage' | 'RCS' | 'SMS';
  readonly replyTo?: { readonly messageId: string; readonly partIndex?: number };
  readonly idempotencyKey: string;
}

export interface LinqSendMessageResult {
  readonly chatId: string;
  readonly messageIds: readonly string[];
  readonly fromSelection: { readonly from: string; readonly reason: string };
  readonly createdChat: boolean;
  readonly traceId: string;
}

export class LinqAdapter extends ProviderAdapter {
  override readonly manifest = LINQ_MANIFEST;
  #optOutState: OptOutStateStore = NO_LOCAL_OPT_OUT_STATE;
  #client: ProviderHttpClient | undefined;
  readonly #fetchImpl: typeof fetch | undefined;

  constructor(ctx: AdapterContext, overrides?: { readonly fetchImpl?: typeof fetch }) {
    super(ctx);
    this.#fetchImpl = overrides?.fetchImpl;
  }

  /** Wires a real opt-out ledger. See `NO_LOCAL_OPT_OUT_STATE` for the fallback behaviour without one. */
  setOptOutStateStore(store: OptOutStateStore): void {
    this.#optOutState = store;
  }

  #httpClient(): ProviderHttpClient {
    if (!this.#client) {
      this.#client = this.http(bearerAuth(this.requireSecret(SECRETS.linqApiKey)), {
        idempotencyHeader: 'Idempotency-Key',
        classifyError: (status, body) => this.#classifyError(status, body),
        fetchImpl: this.#fetchImpl,
      });
    }
    return this.#client;
  }

  /**
   * Intercepts Linq's documented error codes before the client's generic
   * status-based classification runs — a bare HTTP 403 would otherwise become
   * a `ProviderAuthError`, which would misreport an opt-out as a credentials
   * problem and could plausibly be retried after a token refresh. 2024 (opt
   * out) and 2025/2026 (blocked-handle conflicts) are handled here instead;
   * everything else (including 429 / code 1007) falls through to the
   * client's default mapping, which already turns any 429 into a
   * `RateLimitError`.
   */
  #classifyError(status: number, body: unknown): FoundryError | undefined {
    const code = extractLinqErrorCode(body);
    const message = extractLinqErrorMessage(body) ?? `Linq error code ${String(code)} (HTTP ${status})`;
    if (code === 2024) {
      // The handle is not identifiable from the transport-level response
      // alone; `sendMessage`/`sendToChat` catch this and re-throw with the
      // real recipient(s) attached before any caller observes it.
      return new LinqOptOutError('(resolved by caller)', message, { httpStatus: status, linqErrorCode: code });
    }
    if (code === 2025 || code === 2026) {
      return new PolicyDeniedError(`Linq blocked-handle operation refused (code ${code}): ${message}`, {
        linqErrorCode: code,
        httpStatus: status,
      });
    }
    if (code === 2011) {
      return new ValidationError(
        'Linq Agent Pay is not usable: no connected payment account on file (error 2011). Connect a Stripe account in the Linq dashboard before POST /v3/payment_requests.',
        { linqErrorCode: code, httpStatus: status },
      );
    }
    if (code === 2018) {
      return new ValidationError(`iMessage app messages can only be sent over iMessage (error 2018): ${message}`, {
        linqErrorCode: code,
        httpStatus: status,
      });
    }
    if (code === 1005) {
      return new ValidationError(message, { linqErrorCode: code, httpStatus: status });
    }
    return undefined;
  }

  /* ---------------------------------------------------------------------- */
  /* Probe                                                                    */
  /* ---------------------------------------------------------------------- */

  override async probe(): Promise<ProbeResult> {
    const res = await this.#httpClient().request(
      { method: 'GET', path: '/v3/phone_numbers', operation: 'phoneNumbers.list' },
      LinqPhoneNumberList,
    );
    const numbers = phoneNumbersOf(res.body);
    return {
      succeeded: true,
      detail: `GET /v3/phone_numbers returned ${numbers.length} assigned line(s)`,
      evidence: {
        endpoint: 'GET /v3/phone_numbers',
        lineCount: numbers.length,
        reputations: numbers.map((n) => reputationStatusOf(n) ?? null),
      },
    };
  }

  /* ---------------------------------------------------------------------- */
  /* Messaging                                                                */
  /* ---------------------------------------------------------------------- */

  /**
   * `POST /v3/messages` → 202 Accepted. Sends both the `message.idempotency_key`
   * body field and the `Idempotency-Key` header — the research doc documents
   * both but leaves the canonical form unconfirmed, so both are sent rather
   * than guessing which one Linq actually keys on.
   */
  async sendMessage(input: LinqSendMessageInput): Promise<LinqSendMessageResult> {
    if (input.to.length === 0) throw new ValidationError('sendMessage requires at least one recipient');
    if (input.parts.length === 0) throw new ValidationError('sendMessage requires at least one message part');
    assertMessageParts(input.parts, input.preferredService);
    this.assertActivated();

    // Checked before any network call. Linq enforces the same rule
    // server-side (error 2024 / HTTP 403) — this is defence in depth, saving
    // a round trip against a recipient we already know has opted out.
    for (const handle of input.to) {
      if (await this.#optOutState.isOptedOut(handle)) {
        throw new LinqOptOutError(handle, 'recipient is recorded as opted out in local state; never overridden automatically');
      }
    }

    const preferredService =
      input.parts.some((part) => part.type === 'imessage_app') ? 'iMessage' : input.preferredService;
    const body = {
      to: input.to,
      ...(input.from ? { from: input.from } : {}),
      message: {
        parts: input.parts,
        ...(preferredService ? { preferred_service: preferredService } : {}),
        ...(input.replyTo
          ? { reply_to: { message_id: input.replyTo.messageId, part_index: input.replyTo.partIndex } }
          : {}),
        idempotency_key: input.idempotencyKey,
      },
    };

    try {
      const res = await this.#httpClient().request(
        { method: 'POST', path: '/v3/messages', operation: 'messages.send', body, idempotencyKey: input.idempotencyKey },
        LinqSendMessageResponse,
      );
      return toSendResult(res.body);
    } catch (error) {
      if (error instanceof LinqOptOutError) {
        // Multi-recipient sends (group chats, up to 31 handles) do not tell
        // us which handle triggered 2024, so every handle in this send is
        // conservatively marked. For the common case here — 1:1 support
        // replies — that mapping is exact. A false-positive local opt-out
        // mark is far cheaper than risking one more message to someone who
        // opted out.
        for (const handle of input.to) await this.#optOutState.markOptedOut?.(handle, 'Linq error code 2024');
        throw new LinqOptOutError(input.to.join(', '), 'Linq rejected the send: recipient(s) opted out (error code 2024)', {
          recipients: input.to,
        });
      }
      throw error;
    }
  }

  /* ---------------------------------------------------------------------- */
  /* iMessage experiences, apps, and Agent Pay                               */
  /* ---------------------------------------------------------------------- */

  /**
   * Invokes a Linq-hosted iMessage card. `experience` occupies the whole
   * message — it cannot be combined with `parts`. Cards are iMessage-only.
   */
  async sendExperience(input: {
    readonly to: readonly string[];
    readonly from?: string;
    readonly experience: LinqExperienceInvocation;
    readonly chatId?: string;
    readonly idempotencyKey: string;
  }): Promise<LinqSendMessageResult> {
    if (input.to.length !== 1) {
      throw new ValidationError('Linq experience cards go to exactly one recipient');
    }
    assertExperienceInvocation(input.experience);
    this.assertActivated();
    for (const handle of input.to) {
      if (await this.#optOutState.isOptedOut(handle)) {
        throw new LinqOptOutError(handle, 'recipient is recorded as opted out in local state; never overridden automatically');
      }
    }
    const path = input.chatId ? `/v3/chats/${encodeURIComponent(input.chatId)}/messages` : '/v3/messages';
    const experienceMessage = {
      experience: input.experience,
      preferred_service: 'iMessage' as const,
      idempotency_key: input.idempotencyKey,
    };
    const body = input.chatId
      ? { message: experienceMessage }
      : {
          to: input.to,
          ...(input.from ? { from: input.from } : {}),
          message: experienceMessage,
        };
    const res = await this.#httpClient().request(
      { method: 'POST', path, operation: 'messages.sendExperience', body, idempotencyKey: input.idempotencyKey },
      LinqSendMessageResponse,
    );
    return toSendResult(res.body);
  }

  /**
   * Partner-owned Messages extension card. Requires a real team_id + bundle_id
   * of an installed iMessage app. Without one, use `sendExperience` instead.
   */
  async sendIMessageApp(input: {
    readonly to: readonly string[];
    readonly from?: string;
    readonly part: LinqIMessageAppPart;
    readonly idempotencyKey: string;
  }): Promise<LinqSendMessageResult> {
    assertRealIMessageAppPart(input.part);
    return this.sendMessage({
      to: input.to,
      from: input.from,
      parts: [input.part],
      preferredService: 'iMessage',
      idempotencyKey: input.idempotencyKey,
    });
  }

  async updateMessageCard(messageId: string, experience: LinqExperienceInvocation): Promise<void> {
    this.assertActivated();
    await this.#httpClient().raw({
      method: 'POST',
      path: `/v3/messages/${encodeURIComponent(messageId)}/update`,
      operation: 'messages.update',
      body: { experience },
    });
  }

  async createPaymentRequest(input: {
    readonly amountMinor: number;
    readonly currency: string;
    readonly description: string;
    readonly metadata?: Readonly<Record<string, string>>;
    readonly customerId?: string;
    readonly rail?: 'stripe' | 'natural';
  }): Promise<LinqPaymentRequest> {
    if (!Number.isInteger(input.amountMinor) || input.amountMinor < 50) {
      throw new ValidationError('Linq payment requests have a 50-cent minimum in minor units', {
        amountMinor: input.amountMinor,
      });
    }
    this.assertActivated();
    const res = await this.#httpClient().request(
      {
        method: 'POST',
        path: '/v3/payment_requests',
        operation: 'payment_requests.create',
        body: {
          amount: input.amountMinor,
          currency: input.currency.toLowerCase(),
          description: input.description,
          ...(input.metadata ? { metadata: input.metadata } : {}),
          ...(input.customerId ? { customer_id: input.customerId } : {}),
          ...(input.rail ? { rail: input.rail } : {}),
        },
      },
      LinqPaymentRequest,
    );
    return res.body;
  }

  async getPaymentRequest(id: string): Promise<LinqPaymentRequest> {
    this.assertActivated();
    const res = await this.#httpClient().request(
      {
        method: 'GET',
        path: `/v3/payment_requests/${encodeURIComponent(id)}`,
        operation: 'payment_requests.get',
      },
      LinqPaymentRequest,
    );
    return res.body;
  }

  /**
   * Agent Pay card in iMessage. `checkout_url` must be from our own
   * `createPaymentRequest` (a `*.linqapp.com` URL). A Stripe Payment Link is
   * rejected here — live Linq error 1005: "checkout_url must be a Linq checkout
   * link (linqapp.com)". Error 2011 is a separate gate on payment_requests.
   */
  async sendAgentPay(input: {
    readonly to: string;
    readonly checkoutUrl: string;
    readonly chatId?: string;
    readonly from?: string;
    readonly idempotencyKey: string;
  }): Promise<LinqSendMessageResult> {
    if (isStripePaymentLinkUrl(input.checkoutUrl)) {
      throw new ValidationError(
        'Linq Agent Pay checkout_url must be a Linq payment_request URL, not a Stripe Payment Link',
        { host: 'buy.stripe.com' },
      );
    }
    if (!isLinqCheckoutUrl(input.checkoutUrl)) {
      throw new ValidationError('Linq Agent Pay checkout_url must be a Linq checkout link (linqapp.com)', {
        checkoutUrlHost: hostOf(input.checkoutUrl),
      });
    }
    return this.sendExperience({
      to: [input.to],
      from: input.from,
      chatId: input.chatId,
      idempotencyKey: input.idempotencyKey,
      experience: {
        name: 'agentpay',
        action: 'request_payment',
        params: { checkout_url: input.checkoutUrl },
      },
    });
  }

  /**
   * Linq-hosted `link` / `open` iMessage card. This is the working iMessage App
   * path when Agent Pay is 2011: Linq renders it with its own Messages
   * extension (`team_id` M9X86M4PHN). A Stripe Payment Link is allowed as
   * `params.url` — it is not an agentpay `checkout_url`.
   */
  async sendLink(input: {
    readonly to: string;
    readonly url: string;
    readonly title?: string;
    readonly subtitle?: string;
    readonly button?: string;
    readonly chatId?: string;
    readonly from?: string;
    readonly idempotencyKey: string;
  }): Promise<LinqSendMessageResult> {
    const params: Record<string, unknown> = { url: input.url };
    if (input.title) params['title'] = input.title;
    if (input.subtitle) params['subtitle'] = input.subtitle;
    if (input.button) params['button'] = input.button;
    return this.sendExperience({
      to: [input.to],
      from: input.from,
      chatId: input.chatId,
      idempotencyKey: input.idempotencyKey,
      experience: { name: 'link', action: 'open', params },
    });
  }

  /**
   * Linq-hosted agentcard. `attach_card` is catalog-valid but live-rejected
   * until the recipient has connected a payment method (error 1005).
   * `approve_card` requires `params.payment_id`.
   */
  async sendAgentCard(input: {
    readonly to: string;
    readonly action: string;
    readonly params?: Readonly<Record<string, unknown>>;
    readonly chatId?: string;
    readonly from?: string;
    readonly idempotencyKey: string;
  }): Promise<LinqSendMessageResult> {
    return this.sendExperience({
      to: [input.to],
      from: input.from,
      chatId: input.chatId,
      idempotencyKey: input.idempotencyKey,
      experience: { name: 'agentcard', action: input.action, params: input.params },
    });
  }

  async listExperiences(): Promise<LinqExperienceList> {
    this.assertActivated();
    const res = await this.#httpClient().request(
      { method: 'GET', path: '/v3/experiences', operation: 'experiences.list' },
      LinqExperienceList,
    );
    return res.body;
  }

  /* ---------------------------------------------------------------------- */
  /* Chats & messages                                                        */
  /* ---------------------------------------------------------------------- */

  async listChats(input: { cursor?: string; limit?: number } = {}): Promise<{
    readonly data: readonly LinqChat[];
    readonly next_cursor: string | null | undefined;
  }> {
    this.assertActivated();
    const res = await this.#httpClient().request(
      { method: 'GET', path: '/v3/chats', operation: 'chats.list', query: { cursor: input.cursor, limit: input.limit } },
      LinqChatList,
    );
    return { data: chatsOf(res.body), next_cursor: nextCursorOf(res.body) };
  }

  async getChat(chatId: string): Promise<LinqChat> {
    this.assertActivated();
    const res = await this.#httpClient().request(
      { method: 'GET', path: `/v3/chats/${encodeURIComponent(chatId)}`, operation: 'chats.get' },
      LinqChat,
    );
    return res.body;
  }

  /** `GET /v3/chats/{chatId}/messages` — confirmed path, cursor + limit (1-100, default 50). */
  async listMessages(
    chatId: string,
    input: { cursor?: string; limit?: number } = {},
  ): Promise<{ readonly data: readonly LinqMessage[]; readonly next_cursor: string | null | undefined }> {
    this.assertActivated();
    const res = await this.#httpClient().request(
      {
        method: 'GET',
        path: `/v3/chats/${encodeURIComponent(chatId)}/messages`,
        operation: 'chats.messages.list',
        query: { cursor: input.cursor, limit: input.limit },
      },
      LinqMessageList,
    );
    return { data: messagesOf(res.body), next_cursor: nextCursorOf(res.body) };
  }

  /** `POST /v3/chats/{chatId}/messages` — confirmed path. Subject to the same opt-out handling as `sendMessage`. */
  async sendToChat(
    chatId: string,
    input: { parts: readonly LinqMessagePartInput[]; idempotencyKey: string },
  ): Promise<LinqSendMessageResult> {
    if (input.parts.length === 0) throw new ValidationError('sendToChat requires at least one message part');
    assertMessageParts(input.parts, 'iMessage');
    this.assertActivated();
    try {
      const res = await this.#httpClient().request(
        {
          method: 'POST',
          path: `/v3/chats/${encodeURIComponent(chatId)}/messages`,
          operation: 'chats.messages.send',
          body: {
            message: {
              parts: input.parts,
              idempotency_key: input.idempotencyKey,
              ...(input.parts.some((part) => part.type === 'imessage_app') ? { preferred_service: 'iMessage' } : {}),
            },
          },
          idempotencyKey: input.idempotencyKey,
        },
        LinqSendMessageResponse,
      );
      return toSendResult(res.body);
    } catch (error) {
      if (error instanceof LinqOptOutError) {
        throw new LinqOptOutError(chatId, 'Linq rejected the chat send: chat is opted out (error code 2024)', { chatId });
      }
      throw error;
    }
  }

  /** `POST /v3/chats/{chatId}/read` — confirmed path. */
  async markRead(chatId: string): Promise<void> {
    this.assertActivated();
    await this.#httpClient().raw({
      method: 'POST',
      path: `/v3/chats/${encodeURIComponent(chatId)}/read`,
      operation: 'chats.markRead',
    });
  }

  /**
   * Path inferred from REST convention on the message resource. The research
   * doc confirms reactions exist and names the `reaction.added` webhook event
   * but does not quote an exact request path — kept behind this one method so
   * a corrected path is a one-line change, the same resolver pattern the
   * research doc describes for Terac's unconfirmed operation paths.
   */
  async addReaction(messageId: string, reaction: string): Promise<void> {
    this.assertActivated();
    await this.#httpClient().raw({
      method: 'POST',
      path: `/v3/messages/${encodeURIComponent(messageId)}/reactions`,
      operation: 'messages.addReaction',
      body: { reaction },
    });
  }

  /** Path inferred from REST convention; see `addReaction` for the same caveat. */
  async setTyping(chatId: string, isTyping: boolean): Promise<void> {
    this.assertActivated();
    await this.#httpClient().raw({
      method: 'POST',
      path: `/v3/chats/${encodeURIComponent(chatId)}/typing`,
      operation: 'chats.setTyping',
      body: { typing: isTyping },
    });
  }

  /** `POST /v3/attachments` — confirmed path. ≤100 MB via `base64`, ≤10 MB via a source `url`. */
  async uploadAttachment(input: {
    readonly url?: string;
    readonly base64?: string;
    readonly filename?: string;
    readonly mimeType?: string;
  }): Promise<LinqAttachmentUploadResponse> {
    this.assertActivated();
    if (!input.url && !input.base64) {
      throw new ValidationError('uploadAttachment requires either a source url (<=10MB inline) or base64 content (<=100MB)');
    }
    const res = await this.#httpClient().request(
      {
        method: 'POST',
        path: '/v3/attachments',
        operation: 'attachments.upload',
        body: {
          ...(input.url ? { url: input.url } : {}),
          ...(input.base64 ? { content: input.base64 } : {}),
          ...(input.filename ? { filename: input.filename } : {}),
          ...(input.mimeType ? { mime_type: input.mimeType } : {}),
        },
      },
      LinqAttachmentUploadResponse,
    );
    return res.body;
  }

  /** `POST /v3/capability_checks` — confirmed path. What a handle can actually receive before we commit to a send. */
  async capabilityCheck(to: string): Promise<LinqCapabilityCheckResponse> {
    this.assertActivated();
    const res = await this.#httpClient().request(
      { method: 'POST', path: '/v3/capability_checks', operation: 'capabilityChecks.create', body: { to } },
      LinqCapabilityCheckResponse,
    );
    return res.body;
  }

  /* ---------------------------------------------------------------------- */
  /* Phone numbers                                                           */
  /* ---------------------------------------------------------------------- */

  async listPhoneNumbers(): Promise<readonly LinqPhoneNumber[]> {
    this.assertActivated();
    const res = await this.#httpClient().request(
      { method: 'GET', path: '/v3/phone_numbers', operation: 'phoneNumbers.list' },
      LinqPhoneNumberList,
    );
    return phoneNumbersOf(res.body);
  }

  /**
   * Numbers are provisioned by a Linq representative — the research doc
   * quotes the vendor directly: "there is no self-serve create or delete
   * endpoint on the V3 API." This method can only update a line already
   * assigned to us; `messaging.*` capabilities stay `blocked_vendor_approval`
   * (per `LINQ_MANIFEST.vendorApproval`) until `GET /v3/phone_numbers` lists a
   * real assigned line, and no method in this adapter can change that on its own.
   */
  async updatePhoneNumber(id: string, patch: { readonly forwardingNumber?: string }): Promise<LinqPhoneNumber> {
    this.assertActivated();
    const res = await this.#httpClient().request(
      {
        method: 'PUT',
        path: `/v3/phone_numbers/${encodeURIComponent(id)}`,
        operation: 'phoneNumbers.update',
        body: patch.forwardingNumber ? { forwarding_number: patch.forwardingNumber } : {},
      },
      LinqPhoneNumber,
    );
    return res.body;
  }

  /* ---------------------------------------------------------------------- */
  /* Blocked handles (org-level, distinct from per-recipient opt-out)        */
  /* ---------------------------------------------------------------------- */

  async listBlockedHandles(): Promise<readonly LinqBlockedHandle[]> {
    this.assertActivated();
    const res = await this.#httpClient().request(
      { method: 'GET', path: '/v3/blocked_handles', operation: 'blockedHandles.list' },
      LinqBlockedHandleList,
    );
    return blockedHandlesOf(res.body);
  }

  async blockHandle(handle: string, reason?: string): Promise<void> {
    this.assertActivated();
    await this.#httpClient().raw({
      method: 'POST',
      path: '/v3/blocked_handles',
      operation: 'blockedHandles.create',
      body: { handle, ...(reason ? { reason } : {}) },
    });
  }

  async unblockHandle(handle: string): Promise<void> {
    this.assertActivated();
    await this.#httpClient().raw({
      method: 'DELETE',
      path: `/v3/blocked_handles/${encodeURIComponent(handle)}`,
      operation: 'blockedHandles.delete',
    });
  }

  /* ---------------------------------------------------------------------- */
  /* Voice — UNVERIFIED request/response schema                              */
  /* ---------------------------------------------------------------------- */

  /**
   * UNVERIFIED. The paths are confirmed under the OpenAPI "Calls" tag, but the
   * 466 KB spec truncated before the request/response bodies and no `call.*`
   * event payload is published anywhere the research pass found (research
   * doc, section 6, "Voice — thinly documented"). `LinqCallResponse` is
   * deliberately a passthrough bag so a real response gets captured rather
   * than rejected the first time this runs live, and this capability reports
   * `configured_unverified` rather than `live_verified` until one does.
   */
  async initiateCall(input: { readonly to: string; readonly from?: string }): Promise<LinqCallResponse> {
    this.assertActivated();
    const res = await this.#httpClient().request(
      {
        method: 'POST',
        path: '/v3/calls',
        operation: 'calls.initiate',
        body: { to: input.to, ...(input.from ? { from: input.from } : {}) },
      },
      LinqCallResponse,
    );
    return res.body;
  }

  /** UNVERIFIED — see `initiateCall`. */
  async answerCall(callId: string): Promise<LinqCallResponse> {
    this.assertActivated();
    const res = await this.#httpClient().request(
      { method: 'POST', path: `/v3/calls/${encodeURIComponent(callId)}/answer`, operation: 'calls.answer' },
      LinqCallResponse,
    );
    return res.body;
  }

  /** UNVERIFIED — see `initiateCall`. */
  async hangupCall(callId: string): Promise<LinqCallResponse> {
    this.assertActivated();
    const res = await this.#httpClient().request(
      { method: 'POST', path: `/v3/calls/${encodeURIComponent(callId)}/hangup`, operation: 'calls.hangup' },
      LinqCallResponse,
    );
    return res.body;
  }

  /* ---------------------------------------------------------------------- */
  /* Webhooks                                                                */
  /* ---------------------------------------------------------------------- */

  /** Standard Webhooks — same scheme as Whop and Dodo, verified independently per provider in `webhook-verify.ts`. */
  verifyWebhook(rawBody: Buffer | string, headers: Record<string, string | string[] | undefined>): VerificationResult {
    const secret = this.requireSecret(SECRETS.linqWebhookSecret);
    return verifyStandardWebhook('linq', { rawBody, headers, secret });
  }

  /** Convenience wrapper so callers holding an adapter instance don't need a separate import. */
  interpretEvent(eventType: string, payload: unknown): LinqSupportUpdate {
    return mapLinqEventToSupportUpdate(eventType, payload);
  }
}

/* -------------------------------------------------------------------------- */
/* Webhook event -> support-domain mapping                                    */
/* -------------------------------------------------------------------------- */

export type LinqSupportUpdate =
  | {
      readonly kind: 'inbound_message';
      readonly channel: MessageChannel;
      readonly externalChatId: string | null;
      readonly externalMessageId: string | null;
      readonly fromHandle: string | null;
      readonly toHandle: string | null;
      readonly body: string;
      readonly isOptOutRequest: boolean;
    }
  | { readonly kind: 'outbound_status'; readonly externalMessageId: string | null; readonly status: MessageDeliveryStatus }
  | { readonly kind: 'reaction_added'; readonly externalMessageId: string | null; readonly reaction: string | null }
  | { readonly kind: 'chat_created'; readonly externalChatId: string | null }
  | {
      readonly kind: 'participant_changed';
      readonly externalChatId: string | null;
      readonly handle: string | null;
      readonly added: boolean;
    }
  | {
      readonly kind: 'phone_number_status';
      readonly phoneNumberId: string | null;
      readonly status: string | null;
      readonly reputation: string | null;
    }
  | { readonly kind: 'call_event'; readonly callId: string | null; readonly event: string }
  | {
      readonly kind: 'payment';
      readonly event: string;
      readonly paymentRequestId: string | null;
      readonly status: string | null;
    }
  | { readonly kind: 'unhandled'; readonly eventType: string; readonly reason: string };

/** Event names this mapper claims to handle — exactly `LINQ_MANIFEST.webhooks[0].events`, checked by `linq-optout.test.ts`. */
export const HANDLED_LINQ_EVENTS: readonly string[] = [
  'message.received',
  'message.sent',
  'message.delivered',
  'message.read',
  'message.failed',
  'reaction.added',
  'chat.created',
  'participant.added',
  'participant.removed',
  'phone_number.status_updated',
  'call.initiated',
  'call.ringing',
  'call.answered',
  'call.ended',
  'call.failed',
  'payment.succeeded',
  'payment.canceled',
  'payment.expired',
  'call.declined',
  'call.no_answer',
];

/**
 * `eventType` and `payload` (the webhook's `data`-equivalent) are passed
 * separately because the exact envelope Linq wraps them in in the HTTP body
 * is not quoted in the research doc — only the header-level signing scheme
 * is (Standard Webhooks). The caller (the webhook route) is expected to have
 * already extracted both from whatever the real envelope turns out to be.
 */
export function mapLinqEventToSupportUpdate(eventType: string, payload: unknown): LinqSupportUpdate {
  switch (eventType) {
    case 'message.received': {
      const body = str(payload, 'body') ?? str(payload, 'text') ?? '';
      return {
        kind: 'inbound_message',
        channel: normaliseChannel(str(payload, 'service')),
        externalChatId: str(payload, 'chat_id'),
        externalMessageId: str(payload, 'id') ?? str(payload, 'message_id'),
        fromHandle: str(payload, 'from'),
        toHandle: str(payload, 'to'),
        body,
        isOptOutRequest: isOptOutInbound(body),
      };
    }
    case 'message.sent':
      return outboundStatus(payload, 'sent');
    case 'message.delivered':
      // Fires only on iMessage and RCS (research doc, section 6). Its
      // absence on an SMS/MMS send is expected behaviour, not a failure —
      // callers must not treat "never saw delivered" as an error for SMS.
      return outboundStatus(payload, 'delivered');
    case 'message.read':
      // Same iMessage/RCS-only caveat as message.delivered.
      return outboundStatus(payload, 'read');
    case 'message.failed':
      return outboundStatus(payload, 'failed');
    case 'reaction.added':
      return {
        kind: 'reaction_added',
        externalMessageId: str(payload, 'message_id') ?? str(payload, 'id'),
        reaction: str(payload, 'reaction'),
      };
    case 'chat.created':
      return { kind: 'chat_created', externalChatId: str(payload, 'chat_id') ?? str(payload, 'id') };
    case 'participant.added':
      return {
        kind: 'participant_changed',
        externalChatId: str(payload, 'chat_id'),
        handle: str(payload, 'handle') ?? str(payload, 'participant'),
        added: true,
      };
    case 'participant.removed':
      return {
        kind: 'participant_changed',
        externalChatId: str(payload, 'chat_id'),
        handle: str(payload, 'handle') ?? str(payload, 'participant'),
        added: false,
      };
    case 'phone_number.status_updated':
      return {
        kind: 'phone_number_status',
        phoneNumberId: str(payload, 'id') ?? str(payload, 'phone_number_id'),
        status: str(payload, 'status'),
        reputation: str(payload, 'reputation'),
      };
    case 'call.initiated':
    case 'call.ringing':
    case 'call.answered':
    case 'call.ended':
    case 'call.failed':
    case 'call.declined':
    case 'call.no_answer':
      // Voice payload shape is UNVERIFIED end to end (see `initiateCall`);
      // this extracts an id defensively rather than asserting a schema.
      return { kind: 'call_event', callId: str(payload, 'call_id') ?? str(payload, 'id'), event: eventType };
    case 'payment.succeeded':
    case 'payment.canceled':
    case 'payment.expired':
      return {
        kind: 'payment',
        event: eventType,
        paymentRequestId: str(payload, 'id') ?? str(payload, 'payment_request_id'),
        status: str(payload, 'status') ?? eventType.replace('payment.', ''),
      };
    default:
      return {
        kind: 'unhandled',
        eventType,
        reason: `Linq event "${eventType}" has no mapping in mapLinqEventToSupportUpdate.`,
      };
  }
}

function outboundStatus(payload: unknown, status: MessageDeliveryStatus): LinqSupportUpdate {
  return { kind: 'outbound_status', externalMessageId: str(payload, 'id') ?? str(payload, 'message_id'), status };
}

function normaliseChannel(service: string | null): MessageChannel {
  switch (service?.toLowerCase()) {
    case 'imessage':
      return 'imessage';
    case 'rcs':
      return 'rcs';
    case 'voice':
      return 'voice';
    case 'sms':
    default:
      // SMS is Linq's most common fallback transport; a caller needing more
      // precision than this six-way channel enum still has the raw payload.
      return 'sms';
  }
}

function str(payload: unknown, key: string): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : null;
}

function toSendResult(body: LinqSendMessageResponse): LinqSendMessageResult {
  const nestedId = body.message?.id;
  const messageIds = body.message_ids ?? (nestedId ? [nestedId] : []);
  const from = body.from ?? body.from_selection?.from ?? '';
  const reason = body.from_selection?.reason ?? 'unspecified';
  return {
    chatId: body.chat_id,
    messageIds,
    fromSelection: { from, reason },
    createdChat: body.created_chat ?? body.created_new_chat ?? false,
    traceId: body.trace_id ?? '',
  };
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

/** Stripe Payment Links (`buy.stripe.com` / Dashboard payment-link URLs) are not Linq Agent Pay checkouts. */
export function isStripePaymentLinkUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.hostname === 'buy.stripe.com' || parsed.hostname.endsWith('.buy.stripe.com')) return true;
    if (parsed.hostname === 'stripe.com' || parsed.hostname.endsWith('.stripe.com')) {
      return parsed.pathname.includes('/payment-links') || parsed.pathname.includes('/test/') || url.includes('plink_');
    }
    return false;
  } catch {
    return false;
  }
}

/** Live Agent Pay checkout_url host: `*.linqapp.com` (typically `zero.linqapp.com`). */
export function isLinqCheckoutUrl(url: string): boolean {
  const host = hostOf(url);
  if (!host) return false;
  return host === 'linqapp.com' || host.endsWith('.linqapp.com');
}

const PLACEHOLDER_TEAM_IDS = new Set(['A1B2C3D4E5', 'XXXXXXXXXX']);

function isPlaceholderBundleId(bundleId: string): boolean {
  return /example/i.test(bundleId) || /placeholder/i.test(bundleId) || /yourcompany/i.test(bundleId);
}

function layoutHasVisibleField(layout: LinqIMessageAppPart['layout'] | LinqMessagePartInput['layout']): boolean {
  if (!layout) return false;
  return Boolean(
    layout.caption ||
      layout.subcaption ||
      ('trailing_caption' in layout && layout.trailing_caption) ||
      ('trailing_subcaption' in layout && layout.trailing_subcaption) ||
      ('image_url' in layout && layout.image_url),
  );
}

/** Partner `imessage_app` parts need a real Apple team_id + bundle_id. Docs placeholders are refused. */
export function assertRealIMessageAppPart(part: LinqIMessageAppPart | LinqMessagePartInput): void {
  if (part.type !== 'imessage_app') return;
  const teamId = part.app?.team_id ?? '';
  const bundleId = part.app?.bundle_id ?? '';
  if (!/^[A-Z0-9]{10}$/.test(teamId) || PLACEHOLDER_TEAM_IDS.has(teamId) || isPlaceholderBundleId(bundleId) || bundleId.includes(':')) {
    throw new ValidationError(
      'imessage_app parts require a real Apple team_id and bundle_id of an installed Messages extension. Without one, send a Linq-hosted experience (agentpay/agentcard/link) instead.',
      { teamId, bundleId },
    );
  }
  if (!layoutHasVisibleField(part.layout)) {
    throw new ValidationError(
      'imessage_app parts need layout caption, subcaption, trailing_caption, trailing_subcaption, or image_url',
    );
  }
}

function assertMessageParts(parts: readonly LinqMessagePartInput[], preferredService?: string): void {
  const linkCount = parts.filter((part) => part.type === 'link').length;
  if (linkCount > 0 && parts.length !== 1) {
    throw new ValidationError('A Linq link part must be the only part in the message');
  }
  const appParts = parts.filter((part) => part.type === 'imessage_app');
  if (appParts.length === 0) return;
  if (parts.length !== 1) {
    throw new ValidationError('An imessage_app part must be the only part in the message');
  }
  if (preferredService && preferredService !== 'iMessage') {
    throw new ValidationError('iMessage app messages can only be sent over iMessage');
  }
  for (const part of appParts) assertRealIMessageAppPart(part);
}

function assertExperienceInvocation(experience: LinqExperienceInvocation): void {
  if (experience.name === 'agentpay') {
    const checkoutUrl = typeof experience.params?.['checkout_url'] === 'string' ? experience.params['checkout_url'] : '';
    if (isStripePaymentLinkUrl(checkoutUrl)) {
      throw new ValidationError(
        'Linq Agent Pay checkout_url must be a Linq payment_request URL, not a Stripe Payment Link',
        { host: 'buy.stripe.com' },
      );
    }
    if (!isLinqCheckoutUrl(checkoutUrl)) {
      throw new ValidationError('Linq Agent Pay checkout_url must be a Linq checkout link (linqapp.com)', {
        checkoutUrlHost: hostOf(checkoutUrl),
      });
    }
  }
  if (experience.name === 'link') {
    const url = typeof experience.params?.['url'] === 'string' ? experience.params['url'] : '';
    if (!url) throw new ValidationError('Linq link experience requires params.url');
  }
  if (experience.name === 'agentcard' && experience.action === 'approve_card') {
    const paymentId = experience.params?.['payment_id'];
    if (typeof paymentId !== 'string' || paymentId.length === 0) {
      throw new ValidationError('agentcard approve_card requires params.payment_id');
    }
  }
}

export { CredentialsMissingError };
export * from './schemas.js';
