/**
 * The single outbound HTTP client every provider adapter uses.
 *
 * Centralising this is what makes the retry, breaker, rate-limit, idempotency,
 * timeout, redaction and error-classification behaviour uniform and testable.
 * An adapter that called `fetch` directly would silently opt out of all of it,
 * so adapters are written against `ProviderHttpClient` and nothing else.
 */

import { randomUUID } from 'node:crypto';
import {
  CircuitBreaker,
  DEFAULT_RETRY,
  FoundryError,
  ProviderAuthError,
  ProviderContractError,
  ProviderUnavailableError,
  RateLimitError,
  TimeoutError,
  ValidationError,
  withRetry,
  type ProviderId,
  type RetryPolicy,
  type Secret,
} from '@foundry/core';
import { getLogger, metrics } from '@foundry/obs';
import type { z } from 'zod';
import { TokenBucketLimiter } from './rate-limit.js';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD';

export interface HttpRequest<TBody = unknown> {
  readonly method: HttpMethod;
  /** Path appended to the client's base URL, or an absolute URL. */
  readonly path: string;
  readonly query?: Readonly<Record<string, string | number | boolean | undefined | null | readonly string[]>>;
  readonly body?: TBody;
  readonly headers?: Readonly<Record<string, string>>;
  /** Provider-side idempotency key, when the provider supports one. */
  readonly idempotencyKey?: string;
  readonly timeoutMs?: number;
  readonly retryPolicy?: RetryPolicy;
  /** Set false for calls that must never be retried (non-idempotent, unkeyed). */
  readonly retryable?: boolean;
  readonly signal?: AbortSignal;
  /** Send the body as form-encoded rather than JSON (Stripe-style APIs). */
  readonly form?: boolean;
  /** Human-readable operation name for logs, metrics and errors. */
  readonly operation: string;
}

export interface HttpResponse<T = unknown> {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: T;
  readonly requestId: string | undefined;
  readonly durationMs: number;
}

export type AuthApplier = (headers: Record<string, string>) => void;

export interface ProviderHttpClientOptions {
  readonly provider: ProviderId;
  readonly baseUrl: string;
  /** Applies credentials to outgoing headers. Called per request, late. */
  readonly auth: AuthApplier;
  readonly defaultHeaders?: Readonly<Record<string, string>>;
  readonly defaultTimeoutMs?: number;
  readonly retryPolicy?: RetryPolicy;
  readonly rateLimiter?: TokenBucketLimiter;
  readonly breaker?: CircuitBreaker;
  /** Header name carrying the provider's own request id, for support tickets. */
  readonly requestIdHeader?: string;
  /** Header name for the provider's idempotency key, when supported. */
  readonly idempotencyHeader?: string;
  /**
   * Maps a non-2xx response to a typed error. Providers differ enough
   * (error envelopes, rate-limit signalling) that this must be per-provider.
   */
  readonly classifyError?: (
    status: number,
    body: unknown,
    headers: Readonly<Record<string, string>>,
  ) => FoundryError | undefined;
  readonly fetchImpl?: typeof fetch;
}

export class ProviderHttpClient {
  readonly provider: ProviderId;
  readonly #baseUrl: string;
  readonly #options: ProviderHttpClientOptions;
  readonly #breaker: CircuitBreaker;
  readonly #fetch: typeof fetch;

  constructor(options: ProviderHttpClientOptions) {
    this.provider = options.provider;
    this.#baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.#options = options;
    this.#breaker = options.breaker ?? new CircuitBreaker(options.provider);
    this.#fetch = options.fetchImpl ?? globalThis.fetch;
  }

  get breakerState(): string {
    return this.#breaker.state;
  }

  /** Issues a request and validates the response against a schema. */
  async request<TOut>(
    req: HttpRequest,
    schema: z.ZodType<TOut>,
  ): Promise<HttpResponse<TOut>> {
    const response = await this.raw(req);
    const parsed = schema.safeParse(response.body);
    if (!parsed.success) {
      throw new ProviderContractError(
        this.provider,
        `response for ${req.operation} did not match the documented contract: ${parsed.error.message}`,
        {
          operation: req.operation,
          status: response.status,
          requestId: response.requestId,
          issues: parsed.error.issues.slice(0, 10),
        },
      );
    }
    return { ...response, body: parsed.data };
  }

  /** Issues a request without schema validation (binary, text, or probes). */
  async raw(req: HttpRequest): Promise<HttpResponse> {
    if (!this.#breaker.allowsRequest) {
      throw new ProviderUnavailableError(
        this.provider,
        `circuit breaker is open after repeated failures; retry in ~${this.#breaker.retryAfterSeconds}s`,
        { operation: req.operation, retryAfterSeconds: this.#breaker.retryAfterSeconds },
      );
    }

    const policy = req.retryPolicy ?? this.#options.retryPolicy ?? DEFAULT_RETRY;
    const retryable = req.retryable ?? (isIdempotentMethod(req.method) || req.idempotencyKey !== undefined);

    return withRetry(
      `${this.provider}.${req.operation}`,
      async () => this.#execute(req),
      {
        policy,
        signal: req.signal,
        isRetryableError: (error) => retryable && error.retryable,
        hooks: {
          onRetry: ({ attempt, delayMs, error }) => {
            getLogger().warn(
              {
                provider: this.provider,
                operation: req.operation,
                attempt,
                delayMs,
                errorCode: error.code,
                category: error.category,
              },
              'retrying provider call',
            );
          },
        },
      },
    );
  }

  async #execute(req: HttpRequest): Promise<HttpResponse> {
    if (this.#options.rateLimiter) {
      await this.#options.rateLimiter.acquire(1, req.signal);
    }

    const url = this.#buildUrl(req);
    const headers: Record<string, string> = {
      accept: 'application/json',
      'user-agent': 'foundry-autonomous-company/0.1 (+https://github.com/foundry)',
      ...this.#options.defaultHeaders,
      ...req.headers,
    };
    this.#options.auth(headers);

    if (req.idempotencyKey && this.#options.idempotencyHeader) {
      headers[this.#options.idempotencyHeader] = req.idempotencyKey;
    }

    let payload: string | undefined;
    if (req.body !== undefined && req.method !== 'GET' && req.method !== 'HEAD') {
      if (req.form) {
        headers['content-type'] = 'application/x-www-form-urlencoded';
        payload = encodeForm(req.body as Record<string, unknown>);
      } else {
        headers['content-type'] = 'application/json';
        payload = JSON.stringify(req.body);
      }
    }

    const timeoutMs = req.timeoutMs ?? this.#options.defaultTimeoutMs ?? 30_000;
    const controller = new AbortController();
    const onOuterAbort = () => controller.abort(req.signal?.reason);
    req.signal?.addEventListener('abort', onOuterAbort, { once: true });
    const timer = setTimeout(() => controller.abort(new TimeoutError(req.operation, timeoutMs)), timeoutMs);

    const startedAt = Date.now();
    const labels = { provider: this.provider, operation: req.operation };

    try {
      const response = await this.#fetch(url, {
        method: req.method,
        headers,
        body: payload,
        signal: controller.signal,
      });
      const durationMs = Date.now() - startedAt;
      const responseHeaders = headersToObject(response.headers);
      const requestId = this.#options.requestIdHeader
        ? responseHeaders[this.#options.requestIdHeader.toLowerCase()]
        : undefined;
      const body = await parseBody(response);

      metrics.providerCalls.inc({ ...labels, status: String(response.status) });
      metrics.providerDuration.observe(durationMs / 1000, labels);

      if (response.ok) {
        this.#breaker.recordSuccess();
        metrics.breakerState.set(0, { provider: this.provider });
        getLogger().debug({ ...labels, status: response.status, durationMs, requestId }, 'provider call ok');
        return { status: response.status, headers: responseHeaders, body, requestId, durationMs };
      }

      const error = this.#toError(response.status, body, responseHeaders, req);
      if (error.retryable) {
        this.#breaker.recordFailure();
        metrics.breakerState.set(this.#breaker.state === 'open' ? 1 : 0, { provider: this.provider });
      }
      metrics.providerErrors.inc({ ...labels, category: error.category });
      throw error;
    } catch (error) {
      if (error instanceof FoundryError) throw error;
      // Network-level failure: DNS, connection reset, abort.
      const durationMs = Date.now() - startedAt;
      this.#breaker.recordFailure();
      metrics.breakerState.set(this.#breaker.state === 'open' ? 1 : 0, { provider: this.provider });

      if (controller.signal.aborted && controller.signal.reason instanceof TimeoutError) {
        metrics.providerErrors.inc({ ...labels, category: 'timeout' });
        throw controller.signal.reason;
      }
      metrics.providerErrors.inc({ ...labels, category: 'provider_unavailable' });
      throw new ProviderUnavailableError(this.provider, describeNetworkError(error), {
        operation: req.operation,
        durationMs,
      });
    } finally {
      clearTimeout(timer);
      req.signal?.removeEventListener('abort', onOuterAbort);
    }
  }

  #toError(
    status: number,
    body: unknown,
    headers: Readonly<Record<string, string>>,
    req: HttpRequest,
  ): FoundryError {
    const custom = this.#options.classifyError?.(status, body, headers);
    if (custom) return custom;

    const context = { operation: req.operation, status, body: truncateBody(body) };
    if (status === 401 || status === 403) {
      return new ProviderAuthError(this.provider, `HTTP ${status} on ${req.operation}`, context);
    }
    if (status === 429) {
      return new RateLimitError(this.provider, parseRetryAfter(headers), context);
    }
    if (status === 400 || status === 422) {
      return new ValidationError(
        `${this.provider} rejected ${req.operation}: HTTP ${status}`,
        context,
      );
    }
    if (status >= 500) {
      return new ProviderUnavailableError(this.provider, `HTTP ${status} on ${req.operation}`, context);
    }
    return new ProviderContractError(this.provider, `unexpected HTTP ${status} on ${req.operation}`, context);
  }

  #buildUrl(req: HttpRequest): string {
    const base = req.path.startsWith('http') ? req.path : `${this.#baseUrl}/${req.path.replace(/^\/+/, '')}`;
    if (!req.query) return base;
    const url = new URL(base);
    for (const [key, value] of Object.entries(req.query)) {
      if (value === undefined || value === null) continue;
      if (Array.isArray(value)) {
        for (const item of value) url.searchParams.append(key, String(item));
      } else {
        url.searchParams.set(key, String(value));
      }
    }
    return url.toString();
  }
}

/* -------------------------------------------------------------------------- */
/* Auth appliers                                                               */
/* -------------------------------------------------------------------------- */

export function bearerAuth(secret: Secret): AuthApplier {
  return (headers) => {
    headers['authorization'] = `Bearer ${secret.reveal()}`;
  };
}

export function apiKeyHeaderAuth(headerName: string, secret: Secret): AuthApplier {
  return (headers) => {
    headers[headerName.toLowerCase()] = secret.reveal();
  };
}

export function basicAuth(user: Secret, password?: Secret): AuthApplier {
  return (headers) => {
    const raw = `${user.reveal()}:${password?.reveal() ?? ''}`;
    headers['authorization'] = `Basic ${Buffer.from(raw, 'utf8').toString('base64')}`;
  };
}

export function noAuth(): AuthApplier {
  return () => {
    /* public endpoint */
  };
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

function isIdempotentMethod(method: HttpMethod): boolean {
  return method === 'GET' || method === 'HEAD' || method === 'PUT' || method === 'DELETE';
}

function headersToObject(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
}

async function parseBody(response: Response): Promise<unknown> {
  const contentType = response.headers.get('content-type') ?? '';
  if (response.status === 204 || response.status === 205) return null;
  const text = await response.text();
  if (text.length === 0) return null;
  if (contentType.includes('application/json') || contentType.includes('+json')) {
    try {
      return JSON.parse(text);
    } catch {
      return { __unparsable: text.slice(0, 2000) };
    }
  }
  return text;
}

function parseRetryAfter(headers: Readonly<Record<string, string>>): number | undefined {
  const raw = headers['retry-after'] ?? headers['x-ratelimit-reset'];
  if (!raw) return undefined;
  const seconds = Number.parseInt(raw, 10);
  if (Number.isFinite(seconds) && seconds >= 0 && seconds < 3600) return seconds;
  const date = Date.parse(raw);
  if (Number.isFinite(date)) return Math.max(0, Math.ceil((date - Date.now()) / 1000));
  return undefined;
}

function truncateBody(body: unknown): unknown {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  if (!text) return body;
  return text.length > 1500 ? `${text.slice(0, 1500)}…[truncated]` : body;
}

function describeNetworkError(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as { cause?: { code?: string } }).cause;
    return cause?.code ? `${error.message} (${cause.code})` : error.message;
  }
  return String(error);
}

function encodeForm(body: Record<string, unknown>, prefix = ''): string {
  const parts: string[] = [];
  const walk = (value: unknown, key: string): void => {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, `${key}[${index}]`));
      return;
    }
    if (typeof value === 'object') {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        walk(v, key ? `${key}[${k}]` : k);
      }
      return;
    }
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  };
  for (const [k, v] of Object.entries(body)) walk(v, prefix ? `${prefix}[${k}]` : k);
  return parts.join('&');
}

/** V4 UUID suitable for provider idempotency headers. */
export function newIdempotencyToken(): string {
  return randomUUID();
}
