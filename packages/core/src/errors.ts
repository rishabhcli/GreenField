/**
 * Error taxonomy for the platform.
 *
 * Every failure in the system is classified so that queues, circuit breakers and
 * the capability registry can make mechanical decisions (retry / do not retry /
 * mark capability blocked) instead of string-matching provider messages.
 */

export type ErrorCategory =
  /** Caller supplied bad input; never retry. */
  | 'validation'
  /** Governance/policy refused the action; never retry without a policy change. */
  | 'policy_denied'
  /** Required secret is not configured. Capability is blocked, not broken. */
  | 'credentials_missing'
  /** Credentials present but rejected by the provider. */
  | 'auth'
  /** Provider does not offer this capability at all. Structural; never retry. */
  | 'capability_unsupported'
  /** Provider access requires an approval/allowlist we do not have yet. */
  | 'vendor_approval_required'
  /** Resource does not exist. */
  | 'not_found'
  /** Optimistic-concurrency / duplicate / state-machine conflict. */
  | 'conflict'
  /** Provider said slow down. Retryable, honour retry-after. */
  | 'rate_limited'
  /** Provider 5xx, connection reset, DNS failure. Retryable. */
  | 'provider_unavailable'
  /** Deadline exceeded. Retryable. */
  | 'timeout'
  /** Provider responded, but the response violated the documented contract. */
  | 'provider_contract'
  /** Anything we failed to classify. Treated as non-retryable to avoid runaway loops. */
  | 'internal';

const RETRYABLE: ReadonlySet<ErrorCategory> = new Set<ErrorCategory>([
  'rate_limited',
  'provider_unavailable',
  'timeout',
]);

export interface FoundryErrorOptions {
  readonly category: ErrorCategory;
  readonly message: string;
  readonly cause?: unknown;
  /** Stable machine code, e.g. `stripe.signature_invalid`. */
  readonly code?: string;
  /** Structured, log-safe context. Must never contain secret material. */
  readonly context?: Readonly<Record<string, unknown>>;
  /** Seconds to wait before retrying, when the provider told us. */
  readonly retryAfterSeconds?: number;
  /** HTTP status to surface if this error escapes through the API layer. */
  readonly httpStatus?: number;
}

export class FoundryError extends Error {
  readonly category: ErrorCategory;
  readonly code: string;
  readonly context: Readonly<Record<string, unknown>>;
  readonly retryAfterSeconds: number | undefined;
  readonly httpStatus: number;

  constructor(options: FoundryErrorOptions) {
    super(options.message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.category = options.category;
    this.code = options.code ?? options.category;
    this.context = options.context ?? {};
    this.retryAfterSeconds = options.retryAfterSeconds;
    this.httpStatus = options.httpStatus ?? defaultHttpStatus(options.category);
    Error.captureStackTrace?.(this, new.target);
  }

  get retryable(): boolean {
    return RETRYABLE.has(this.category);
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      category: this.category,
      message: this.message,
      retryable: this.retryable,
      retryAfterSeconds: this.retryAfterSeconds,
      context: this.context,
    };
  }
}

function defaultHttpStatus(category: ErrorCategory): number {
  switch (category) {
    case 'validation':
      return 400;
    case 'auth':
      return 401;
    case 'policy_denied':
      return 403;
    case 'not_found':
      return 404;
    case 'conflict':
      return 409;
    case 'rate_limited':
      return 429;
    case 'credentials_missing':
    case 'capability_unsupported':
    case 'vendor_approval_required':
      return 503;
    case 'provider_unavailable':
    case 'provider_contract':
      return 502;
    case 'timeout':
      return 504;
    case 'internal':
      return 500;
  }
}

/* -------------------------------------------------------------------------- */
/* Concrete error constructors                                                 */
/* -------------------------------------------------------------------------- */

export class ValidationError extends FoundryError {
  constructor(message: string, context?: Record<string, unknown>, cause?: unknown) {
    super({ category: 'validation', message, context, cause });
  }
}

export class PolicyDeniedError extends FoundryError {
  constructor(message: string, context?: Record<string, unknown>) {
    super({ category: 'policy_denied', message, context });
  }
}

/**
 * Thrown when an integration is invoked without its secrets configured.
 * This is the *only* correct behaviour for a missing key: the system neither
 * fabricates a credential nor pretends the call succeeded.
 */
export class CredentialsMissingError extends FoundryError {
  readonly provider: string;
  readonly missing: readonly string[];

  constructor(provider: string, missing: readonly string[], setupUrl?: string) {
    super({
      category: 'credentials_missing',
      code: `${provider}.credentials_missing`,
      message:
        `Provider "${provider}" is not activated: missing environment variable(s) ` +
        `${missing.join(', ')}.` +
        (setupUrl ? ` Obtain credentials at ${setupUrl}.` : ''),
      context: { provider, missing, setupUrl },
    });
    this.provider = provider;
    this.missing = missing;
  }
}

export class ProviderAuthError extends FoundryError {
  constructor(provider: string, message: string, context?: Record<string, unknown>) {
    super({
      category: 'auth',
      code: `${provider}.auth_rejected`,
      message: `Provider "${provider}" rejected our credentials: ${message}`,
      context: { provider, ...context },
    });
  }
}

export class CapabilityUnsupportedError extends FoundryError {
  constructor(provider: string, capability: string, reason: string) {
    super({
      category: 'capability_unsupported',
      code: `${provider}.capability_unsupported`,
      message: `Provider "${provider}" does not support capability "${capability}": ${reason}`,
      context: { provider, capability, reason },
    });
  }
}

export class VendorApprovalRequiredError extends FoundryError {
  constructor(provider: string, what: string, howToRequest: string) {
    super({
      category: 'vendor_approval_required',
      code: `${provider}.vendor_approval_required`,
      message: `Provider "${provider}" requires approval for ${what}. ${howToRequest}`,
      context: { provider, what, howToRequest },
    });
  }
}

export class NotFoundError extends FoundryError {
  constructor(resource: string, id: string) {
    super({
      category: 'not_found',
      code: `${resource}.not_found`,
      message: `${resource} "${id}" was not found`,
      context: { resource, id },
    });
  }
}

export class ConflictError extends FoundryError {
  constructor(message: string, context?: Record<string, unknown>) {
    super({ category: 'conflict', message, context });
  }
}

export class RateLimitError extends FoundryError {
  constructor(provider: string, retryAfterSeconds?: number, context?: Record<string, unknown>) {
    super({
      category: 'rate_limited',
      code: `${provider}.rate_limited`,
      message: `Provider "${provider}" rate limited the request`,
      retryAfterSeconds,
      context: { provider, ...context },
    });
  }
}

export class ProviderUnavailableError extends FoundryError {
  constructor(provider: string, message: string, context?: Record<string, unknown>) {
    super({
      category: 'provider_unavailable',
      code: `${provider}.unavailable`,
      message: `Provider "${provider}" is unavailable: ${message}`,
      context: { provider, ...context },
    });
  }
}

export class TimeoutError extends FoundryError {
  constructor(operation: string, ms: number) {
    super({
      category: 'timeout',
      code: 'timeout',
      message: `Operation "${operation}" exceeded ${ms}ms deadline`,
      context: { operation, timeoutMs: ms },
    });
  }
}

export class ProviderContractError extends FoundryError {
  constructor(provider: string, message: string, context?: Record<string, unknown>) {
    super({
      category: 'provider_contract',
      code: `${provider}.contract_violation`,
      message: `Provider "${provider}" returned an unexpected shape: ${message}`,
      context: { provider, ...context },
    });
  }
}

export class InternalError extends FoundryError {
  constructor(message: string, cause?: unknown, context?: Record<string, unknown>) {
    super({ category: 'internal', message, cause, context });
  }
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

export function isFoundryError(value: unknown): value is FoundryError {
  return value instanceof FoundryError;
}

export function isRetryable(value: unknown): boolean {
  return isFoundryError(value) ? value.retryable : false;
}

/** Wrap an unknown thrown value into a FoundryError without losing the cause. */
export function toFoundryError(value: unknown, fallbackMessage = 'Unhandled error'): FoundryError {
  if (isFoundryError(value)) return value;
  if (value instanceof Error) return new InternalError(value.message, value);
  return new InternalError(fallbackMessage, value, { thrown: String(value) });
}

/** Structured, log-safe rendering of any error. */
export function describeError(value: unknown): Record<string, unknown> {
  const err = toFoundryError(value);
  return err.toJSON();
}
