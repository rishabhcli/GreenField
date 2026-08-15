/**
 * Secret references and resolution.
 *
 * Rules enforced here, not by convention:
 *  - No integration reads `process.env` directly; it declares a `SecretSpec`.
 *  - A resolved secret is wrapped so it cannot be stringified into a log line.
 *  - A missing secret produces a typed, actionable `CredentialsMissingError`
 *    naming the exact variable and where to get it. It never produces a
 *    fabricated value, an empty string, or a silently skipped call.
 */

import { CredentialsMissingError, ValidationError } from './errors.js';

export type SecretMode = 'test' | 'live' | 'unknown';

export interface SecretSpec {
  /** Environment variable name, e.g. `STRIPE_SECRET_KEY`. */
  readonly env: string;
  readonly description: string;
  /** When false the integration still activates without it (optional feature). */
  readonly required: boolean;
  /** Where a human goes to mint this credential. */
  readonly obtainFrom: string;
  /** Optional shape check so a pasted-wrong key fails at boot, not mid-checkout. */
  readonly pattern?: RegExp;
  /** Classifies test vs live keys so we never mix modes in one environment. */
  readonly detectMode?: (value: string) => SecretMode;
  /** True for values that are safe to expose to a browser (publishable keys). */
  readonly publicSafe?: boolean;
}

/**
 * Holder for secret material. `toString`/`toJSON`/inspect are all neutered so a
 * stray template literal or `logger.info({ key })` cannot leak the value.
 */
export class Secret {
  readonly env: string;
  readonly mode: SecretMode;
  readonly #value: string;

  constructor(env: string, value: string, mode: SecretMode = 'unknown') {
    this.env = env;
    this.#value = value;
    this.mode = mode;
  }

  /** The only way to read the material. Call it as late as possible. */
  reveal(): string {
    return this.#value;
  }

  /** Stable, non-reversible fingerprint for correlating "which key is loaded". */
  get fingerprint(): string {
    const v = this.#value;
    if (v.length <= 8) return `${this.env}:len${v.length}`;
    return `${this.env}:${v.slice(0, 4)}…${v.slice(-4)}`;
  }

  toString(): string {
    return `[Secret ${this.env}]`;
  }
  toJSON(): string {
    return `[Secret ${this.env}]`;
  }
  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return `[Secret ${this.env}]`;
  }
}

export interface EnvSource {
  get(name: string): string | undefined;
}

export const processEnvSource: EnvSource = {
  get: (name) => {
    const raw = process.env[name];
    if (raw === undefined) return undefined;
    const trimmed = raw.trim();
    return trimmed.length === 0 ? undefined : trimmed;
  },
};

export interface SecretResolution {
  readonly present: readonly string[];
  readonly missingRequired: readonly string[];
  readonly missingOptional: readonly string[];
  readonly malformed: readonly { env: string; reason: string }[];
  readonly modes: Readonly<Record<string, SecretMode>>;
}

export class SecretStore {
  readonly #source: EnvSource;
  readonly #cache = new Map<string, Secret>();

  constructor(source: EnvSource = processEnvSource) {
    this.#source = source;
  }

  has(spec: SecretSpec): boolean {
    return this.#source.get(spec.env) !== undefined;
  }

  /** Returns undefined when absent. Throws only when present but malformed. */
  tryGet(spec: SecretSpec): Secret | undefined {
    const cached = this.#cache.get(spec.env);
    if (cached) return cached;
    const raw = this.#source.get(spec.env);
    if (raw === undefined) return undefined;
    if (spec.pattern && !spec.pattern.test(raw)) {
      throw new ValidationError(
        `Environment variable ${spec.env} is set but does not match the expected format for ${spec.description}`,
        { env: spec.env, expected: spec.pattern.source },
      );
    }
    const secret = new Secret(spec.env, raw, spec.detectMode?.(raw) ?? 'unknown');
    this.#cache.set(spec.env, secret);
    return secret;
  }

  /** Throws `CredentialsMissingError` when absent — the correct production behaviour. */
  require(provider: string, spec: SecretSpec): Secret {
    const secret = this.tryGet(spec);
    if (!secret) throw new CredentialsMissingError(provider, [spec.env], spec.obtainFrom);
    return secret;
  }

  /** Batch resolution used by the capability registry and the /readiness endpoint. */
  resolve(specs: readonly SecretSpec[]): SecretResolution {
    const present: string[] = [];
    const missingRequired: string[] = [];
    const missingOptional: string[] = [];
    const malformed: { env: string; reason: string }[] = [];
    const modes: Record<string, SecretMode> = {};

    for (const spec of specs) {
      const raw = this.#source.get(spec.env);
      if (raw === undefined) {
        (spec.required ? missingRequired : missingOptional).push(spec.env);
        continue;
      }
      if (spec.pattern && !spec.pattern.test(raw)) {
        malformed.push({ env: spec.env, reason: `does not match ${spec.pattern.source}` });
        continue;
      }
      present.push(spec.env);
      modes[spec.env] = spec.detectMode?.(raw) ?? 'unknown';
    }
    return { present, missingRequired, missingOptional, malformed, modes };
  }

  /** Clears memoised secrets so a rotated value is picked up on next read. */
  invalidate(env?: string): void {
    if (env) this.#cache.delete(env);
    else this.#cache.clear();
  }
}

/* -------------------------------------------------------------------------- */
/* Common secret-shape helpers                                                 */
/* -------------------------------------------------------------------------- */

export function prefixMode(testPrefixes: readonly string[], livePrefixes: readonly string[]) {
  return (value: string): SecretMode => {
    if (testPrefixes.some((p) => value.startsWith(p))) return 'test';
    if (livePrefixes.some((p) => value.startsWith(p))) return 'live';
    return 'unknown';
  };
}

/**
 * Guards against the single most damaging misconfiguration in this system:
 * a live payment key loaded into a non-production deployment, or a test key
 * loaded into production and quietly accepting no real money.
 */
export function assertModeMatchesEnvironment(
  provider: string,
  secretMode: SecretMode,
  environment: 'production' | 'staging' | 'preview',
): void {
  if (secretMode === 'unknown') return;
  if (environment === 'production' && secretMode === 'test') {
    throw new ValidationError(
      `${provider} is configured with a TEST credential in the production environment. ` +
        `Production must not report live commerce backed by test keys.`,
      { provider, secretMode, environment },
    );
  }
  if (environment !== 'production' && secretMode === 'live') {
    throw new ValidationError(
      `${provider} is configured with a LIVE credential in the ${environment} environment. ` +
        `Refusing to start: this would move real money from a non-production deploy.`,
      { provider, secretMode, environment },
    );
  }
}
