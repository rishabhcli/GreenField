/**
 * BAND WebSocket client — Phoenix Channels over `wss://app.band.ai/api/v1/socket/websocket`.
 *
 * Documented contract:
 *  - URL: `wss://app.band.ai/api/v1/socket/websocket?api_key={key}&vsn=2.0.0`.
 *  - Wire format: the Phoenix v2 JSON serializer — every frame is a 5-element
 *    JSON array `[join_ref, ref, topic, event, payload]` (see `BandPhoenixFrame`
 *    in `schemas.ts`).
 *  - **Read-only server→client**: after joining, we only ever receive
 *    broadcasts; there is no documented application-level "send" beyond the
 *    Phoenix protocol frames themselves (`join`, `leave`, `heartbeat`).
 *  - Heartbeat every 30s; the server closes an idle connection after 45s, so
 *    heartbeating at 30s keeps us comfortably inside that window.
 *  - "One connection per Agent ID, last-connect-wins": if another process (or
 *    another instance of this one) connects with the same agent key, our
 *    socket gets displaced. That is documented behaviour, not a fault, so a
 *    close from that cause is treated identically to any other close —
 *    reconnect with backoff, never thrown as an error.
 *
 * Uses the `ws` package (added to `packages/providers/package.json` for this
 * file) because Node's built-in `WebSocket` (via undici) does not expose the
 * fine-grained close-code/reason and ping/pong control this reconnect logic
 * needs, and `ws` is the de facto standard for a Node-side Phoenix client.
 */

import WebSocket from 'ws';
import { DEFAULT_RETRY, nextDelayMs, type RetryPolicy, type Secret } from '@foundry/core';
import { getLogger } from '@foundry/obs';
import { BandPhoenixFrame } from './schemas.js';

const BAND_WS_URL = 'wss://app.band.ai/api/v1/socket/websocket';

/** Server confirmed idle-close window. We heartbeat well inside it. */
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;
/** Documented server-side idle close. Kept only for logging/diagnostics — the heartbeat is what actually prevents it. */
const DOCUMENTED_IDLE_TIMEOUT_MS = 45_000;

export type BandConnectionState = 'connecting' | 'open' | 'closed' | 'reconnecting';

export interface BandServerEvent {
  readonly joinRef: string | null;
  readonly ref: string | null;
  readonly topic: string;
  readonly event: string;
  readonly payload: unknown;
}

export interface BandWebSocketOptions {
  readonly apiKey: Secret;
  /** Override for tests; defaults to the documented production URL. */
  readonly url?: string;
  readonly heartbeatIntervalMs?: number;
  readonly reconnectPolicy?: RetryPolicy;
  /** Injectable for tests. Defaults to the real `ws` constructor. */
  readonly webSocketImpl?: typeof WebSocket;
}

type Unsubscribe = () => void;

/**
 * Five documented topic names. The exact `topic:id` parameterisation
 * convention (the separator between the topic name and a resource id) is
 * UNVERIFIED — only the topic *names* are confirmed. `:` is Phoenix's own
 * idiomatic convention (as in `"room:lobby"`), so the `join*` helpers below
 * use it; `join(topic, payload)` remains available directly for a caller that
 * confirms a different convention against a live socket.
 */
export const BAND_TOPICS = {
  chatRoom: 'chat-room',
  roomParticipants: 'room-participants',
  agentRooms: 'agent-rooms',
  agentContacts: 'agent-contacts',
  roomTasks: 'room-tasks',
} as const;

export class BandWebSocketClient {
  readonly #options: Required<Omit<BandWebSocketOptions, 'apiKey' | 'url' | 'webSocketImpl'>> & {
    apiKey: Secret;
    url: string;
    webSocketImpl: typeof WebSocket;
  };
  #socket: WebSocket | undefined;
  #state: BandConnectionState = 'closed';
  #heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  #reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  #reconnectAttempt = 0;
  #intentionalClose = false;
  #refCounter = 0;
  #joinedTopics = new Set<string>();
  #eventHandlers = new Set<(evt: BandServerEvent) => void>();
  #stateHandlers = new Set<(state: BandConnectionState) => void>();

  constructor(options: BandWebSocketOptions) {
    this.#options = {
      apiKey: options.apiKey,
      url: options.url ?? BAND_WS_URL,
      heartbeatIntervalMs: options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS,
      reconnectPolicy: options.reconnectPolicy ?? DEFAULT_RETRY,
      webSocketImpl: options.webSocketImpl ?? WebSocket,
    };
  }

  get state(): BandConnectionState {
    return this.#state;
  }

  onEvent(handler: (evt: BandServerEvent) => void): Unsubscribe {
    this.#eventHandlers.add(handler);
    return () => this.#eventHandlers.delete(handler);
  }

  onStateChange(handler: (state: BandConnectionState) => void): Unsubscribe {
    this.#stateHandlers.add(handler);
    return () => this.#stateHandlers.delete(handler);
  }

  connect(): void {
    this.#intentionalClose = false;
    this.#open();
  }

  /** Closes the socket and stops all reconnect attempts. */
  close(): void {
    this.#intentionalClose = true;
    this.#clearTimers();
    this.#socket?.close(1000, 'client closing');
  }

  /**
   * Joins a topic. Frame: `[ref, ref, topic, "phx_join", payload]` — Phoenix
   * uses the same value for `join_ref` and `ref` on the join frame itself.
   */
  join(topic: string, payload: Record<string, unknown> = {}): void {
    this.#joinedTopics.add(topic);
    const ref = this.#nextRef();
    this.#send([ref, ref, topic, 'phx_join', payload]);
  }

  leave(topic: string): void {
    this.#joinedTopics.delete(topic);
    const ref = this.#nextRef();
    this.#send([ref, ref, topic, 'phx_leave', {}]);
  }

  joinChatRoom(chatId: string): void {
    this.join(`${BAND_TOPICS.chatRoom}:${chatId}`);
  }
  joinRoomParticipants(chatId: string): void {
    this.join(`${BAND_TOPICS.roomParticipants}:${chatId}`);
  }
  joinAgentRooms(): void {
    this.join(BAND_TOPICS.agentRooms);
  }
  joinAgentContacts(): void {
    this.join(BAND_TOPICS.agentContacts);
  }
  joinRoomTasks(chatId: string): void {
    this.join(`${BAND_TOPICS.roomTasks}:${chatId}`);
  }

  #nextRef(): string {
    this.#refCounter += 1;
    return String(this.#refCounter);
  }

  #send(frame: readonly [string | null, string | null, string, string, unknown]): void {
    if (!this.#socket || this.#socket.readyState !== this.#options.webSocketImpl.OPEN) {
      getLogger().warn({ provider: 'band', frame }, 'band websocket: dropped a frame while not connected');
      return;
    }
    this.#socket.send(JSON.stringify(frame));
  }

  #setState(state: BandConnectionState): void {
    if (this.#state === state) return;
    this.#state = state;
    for (const handler of this.#stateHandlers) handler(state);
  }

  #open(): void {
    this.#setState(this.#reconnectAttempt > 0 ? 'reconnecting' : 'connecting');
    const url = `${this.#options.url}?api_key=${encodeURIComponent(this.#options.apiKey.reveal())}&vsn=2.0.0`;
    const socket = new this.#options.webSocketImpl(url);
    this.#socket = socket;

    socket.on('open', () => {
      this.#reconnectAttempt = 0;
      this.#setState('open');
      this.#startHeartbeat();
      // Re-join every topic that was joined before a reconnect, including a
      // displacement by another connection with the same Agent ID — from the
      // caller's point of view a reconnect should transparently restore the
      // same subscriptions, not silently drop them.
      for (const topic of this.#joinedTopics) {
        const ref = this.#nextRef();
        this.#send([ref, ref, topic, 'phx_join', {}]);
      }
    });

    socket.on('message', (data: WebSocket.RawData) => {
      this.#handleMessage(data);
    });

    socket.on('close', (code: number, reason: Buffer) => {
      this.#stopHeartbeat();
      this.#setState('closed');
      getLogger().info(
        { provider: 'band', code, reason: reason.toString('utf8') },
        'band websocket closed',
      );
      if (this.#intentionalClose) return;
      // Covers both transient network drops and the documented "last-connect-
      // wins" displacement — neither is treated as an error, both reconnect.
      this.#scheduleReconnect();
    });

    socket.on('error', (error: Error) => {
      getLogger().warn({ provider: 'band', error: error.message }, 'band websocket error');
      // `close` always follows `error` for the `ws` package; the reconnect is
      // scheduled from the `close` handler so it happens exactly once.
    });
  }

  #handleMessage(data: WebSocket.RawData): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(data.toString());
    } catch {
      getLogger().warn({ provider: 'band' }, 'band websocket: received a non-JSON frame; ignored');
      return;
    }
    const frame = BandPhoenixFrame.safeParse(parsed);
    if (!frame.success) {
      // Read-only server→client channel: an unparsable frame is logged and
      // dropped rather than crashing a long-lived connection over one bad
      // message.
      getLogger().warn({ provider: 'band', issue: frame.error.message }, 'band websocket: frame did not match the documented 5-tuple shape; ignored');
      return;
    }
    const [joinRef, ref, topic, event, payload] = frame.data;
    if (event === 'phx_reply') return; // ack for our own join/leave/heartbeat, nothing to surface
    const evt: BandServerEvent = { joinRef, ref, topic, event, payload };
    for (const handler of this.#eventHandlers) handler(evt);
  }

  #startHeartbeat(): void {
    this.#stopHeartbeat();
    this.#heartbeatTimer = setInterval(() => {
      const ref = this.#nextRef();
      this.#send([null, ref, 'phoenix', 'heartbeat', {}]);
    }, this.#options.heartbeatIntervalMs);
    this.#heartbeatTimer.unref?.();
  }

  #stopHeartbeat(): void {
    if (this.#heartbeatTimer) clearInterval(this.#heartbeatTimer);
    this.#heartbeatTimer = undefined;
  }

  #scheduleReconnect(): void {
    this.#reconnectAttempt += 1;
    const delayMs = nextDelayMs(this.#options.reconnectPolicy, this.#reconnectAttempt);
    getLogger().info(
      { provider: 'band', attempt: this.#reconnectAttempt, delayMs },
      'band websocket: scheduling reconnect',
    );
    this.#reconnectTimer = setTimeout(() => this.#open(), delayMs);
    this.#reconnectTimer.unref?.();
  }

  #clearTimers(): void {
    this.#stopHeartbeat();
    if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = undefined;
  }
}

/** Documented, informational only — see the file header for why the heartbeat interval is what actually matters. */
export const BAND_DOCUMENTED_IDLE_TIMEOUT_MS = DOCUMENTED_IDLE_TIMEOUT_MS;
