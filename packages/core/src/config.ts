/**
 * Runtime environment configuration.
 *
 * Parsed once at boot and validated. A service that cannot determine which
 * environment it is running in refuses to start, because that ambiguity is what
 * lets a test key serve production traffic or a live key run from a preview.
 */

import { z } from 'zod';
import { ValidationError } from './errors.js';
import type { EnvSource } from './secrets.js';
import { processEnvSource } from './secrets.js';

export const DeploymentEnvironment = z.enum(['production', 'staging', 'preview']);
export type DeploymentEnvironment = z.infer<typeof DeploymentEnvironment>;

export const LogLevel = z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']);
export type LogLevel = z.infer<typeof LogLevel>;

/**
 * The two complementary queue sets the worker binary can consume. A typo in
 * the Render dashboard must refuse to boot — falling through an unvalidated
 * cast to a second `general` worker is how agent jobs silently accumulate.
 */
export const WorkerRole = z.enum(['general', 'agents']);
export type WorkerRole = z.infer<typeof WorkerRole>;

export const RuntimeConfig = z.object({
  /** Which deployed environment this process is. Never defaults silently. */
  environment: DeploymentEnvironment,
  /** Render service name, used in logs and audit actor strings. */
  serviceName: z.string().min(1),
  /** Render-assigned instance id, for correlating logs across replicas. */
  instanceId: z.string().min(1),
  /** Git SHA of the running build. */
  releaseSha: z.string().min(1),
  port: z.number().int().positive(),
  logLevel: LogLevel,
  /** Public base URL of the control plane, used to build webhook URLs. */
  publicBaseUrl: z.string().url(),
  databaseUrl: z.string().min(1),
  redisUrl: z.string().min(1),
  /** Max concurrent jobs a worker process will run. */
  workerConcurrency: z.number().int().positive(),
  /** Global switch that stops all agent execution without a redeploy. */
  agentsEnabled: z.boolean(),
  /**
   * Origins the API will reflect in CORS. Always includes the origin of
   * `PUBLIC_BASE_URL`. Extra origins come from `CORS_ALLOWED_ORIGINS`
   * (comma-separated). Production refuses unknown browser origins; preview
   * and staging do not, because a local storefront and the API rarely share
   * a host.
   */
  corsAllowedOrigins: z.array(z.string().min(1)),
  /** True when unknown browser origins are rejected. */
  corsFailClosed: z.boolean(),
  /**
   * Bearer token for operator routes and `/metrics`. Absent means those
   * routes refuse (fail closed). Never logged.
   */
  operatorApiToken: z.string().min(1).optional(),
  /**
   * Set only on worker processes. Absent on the API/verifier is correct.
   * Present-but-invalid refuses to boot on any process.
   */
  workerRole: WorkerRole.optional(),
  /**
   * Render service id for the generated storefront. Copied onto `sites.hosting_service_id`
   * at spec creation / first deploy. Absent is a blocked hosting state, not a fabricated site.
   */
  renderStorefrontServiceId: z.string().min(1).optional(),
});
export type RuntimeConfig = z.infer<typeof RuntimeConfig>;

function required(env: EnvSource, name: string, hint: string): string {
  const value = env.get(name);
  if (value === undefined) {
    throw new ValidationError(
      `Required environment variable ${name} is not set. ${hint}`,
      { env: name },
    );
  }
  return value;
}

function optional(env: EnvSource, name: string, fallback: string): string {
  return env.get(name) ?? fallback;
}

/**
 * Loads and validates runtime configuration.
 *
 * `APP_ENVIRONMENT` is mandatory and has no default. Defaulting it to
 * `production` would let a misconfigured preview take live traffic; defaulting
 * it to `preview` would let production silently disable its own guards.
 */
export function loadRuntimeConfig(env: EnvSource = processEnvSource): RuntimeConfig {
  const environmentRaw = required(
    env,
    'APP_ENVIRONMENT',
    'Set it to production, staging or preview in the Render service environment.',
  );
  const parsedEnvironment = DeploymentEnvironment.safeParse(environmentRaw);
  if (!parsedEnvironment.success) {
    throw new ValidationError(
      `APP_ENVIRONMENT must be one of production | staging | preview, got "${environmentRaw}"`,
    );
  }

  const logLevel = parseLogLevel(optional(env, 'LOG_LEVEL', 'info'));
  const publicBaseUrl = required(
    env,
    'PUBLIC_BASE_URL',
    'This is the externally reachable https URL of the API service; webhook URLs are built from it.',
  );

  const config: RuntimeConfig = {
    environment: parsedEnvironment.data,
    // Render sets RENDER_SERVICE_NAME and RENDER_INSTANCE_ID automatically.
    serviceName: optional(env, 'RENDER_SERVICE_NAME', optional(env, 'SERVICE_NAME', 'unknown-service')),
    instanceId: optional(env, 'RENDER_INSTANCE_ID', 'local-instance'),
    releaseSha: optional(env, 'RENDER_GIT_COMMIT', optional(env, 'RELEASE_SHA', 'unknown')),
    port: Number.parseInt(optional(env, 'PORT', '10000'), 10),
    logLevel,
    publicBaseUrl,
    databaseUrl: required(
      env,
      'DATABASE_URL',
      'Bind it from the Render Postgres instance with fromDatabase.property=connectionString.',
    ),
    redisUrl: required(
      env,
      'REDIS_URL',
      'Bind it from the Render Key Value instance with fromService.property=connectionString.',
    ),
    workerConcurrency: Number.parseInt(optional(env, 'WORKER_CONCURRENCY', '8'), 10),
    agentsEnabled: optional(env, 'AGENTS_ENABLED', 'true') !== 'false',
    corsAllowedOrigins: parseCorsOrigins(env, publicBaseUrl),
    corsFailClosed: parsedEnvironment.data === 'production',
    operatorApiToken: env.get('OPERATOR_API_TOKEN'),
    workerRole: parseWorkerRole(env.get('WORKER_ROLE'), { required: false }),
    renderStorefrontServiceId: env.get('RENDER_STOREFRONT_SERVICE_ID'),
  };

  const parsed = RuntimeConfig.safeParse(config);
  if (!parsed.success) {
    throw new ValidationError(`Invalid runtime configuration: ${parsed.error.message}`, {
      issues: parsed.error.issues,
    });
  }

  if (parsed.data.environment === 'production' && !parsed.data.publicBaseUrl.startsWith('https://')) {
    throw new ValidationError('PUBLIC_BASE_URL must be https in production; webhook signatures require TLS.');
  }

  return parsed.data;
}

export function parseLogLevel(raw: string): LogLevel {
  const parsed = LogLevel.safeParse(raw);
  if (!parsed.success) {
    throw new ValidationError(
      `LOG_LEVEL must be one of ${LogLevel.options.join(' | ')}, got "${raw}"`,
    );
  }
  return parsed.data;
}

/**
 * Parse `WORKER_ROLE`. A typo must not silently become `general`.
 *
 * `required: false` (API, verifier, migrate): unset is fine, a present-but
 * invalid value still throws so a dashboard typo cannot hide.
 * `required: true` (the worker binary): unset defaults to `general` only when
 * the variable is actually absent, never when it is a typo.
 */
export function parseWorkerRole(
  raw: string | undefined,
  options: { required: boolean } = { required: false },
): WorkerRole | undefined {
  if (raw === undefined || raw === '') {
    return options.required ? 'general' : undefined;
  }
  const parsed = WorkerRole.safeParse(raw);
  if (!parsed.success) {
    throw new ValidationError(
      `WORKER_ROLE must be one of ${WorkerRole.options.join(' | ')}, got "${raw}". ` +
        `A typo here silently creates a second general worker and agent jobs are never consumed.`,
    );
  }
  return parsed.data;
}

/** Worker entrypoint: validate `WORKER_ROLE` before `buildContext`. */
export function loadWorkerRole(env: EnvSource = processEnvSource): WorkerRole {
  return parseWorkerRole(env.get('WORKER_ROLE'), { required: true }) ?? 'general';
}

export function serviceNameFromEnv(fallback: string, env: EnvSource = processEnvSource): string {
  return env.get('RENDER_SERVICE_NAME') ?? env.get('SERVICE_NAME') ?? fallback;
}

/** Migrate CLI: DATABASE_URL without requiring the rest of RuntimeConfig. */
export function readDatabaseUrl(env: EnvSource = processEnvSource): string | undefined {
  return env.get('DATABASE_URL');
}

/**
 * Logger settings that do not require DATABASE_URL. The migrate CLI and the
 * logger's own first line run before a full `RuntimeConfig` exists; this is
 * the documented bootstrap exception, not a second env-reading system.
 */
export function loadBootstrapLogConfig(env: EnvSource = processEnvSource): {
  readonly level: LogLevel;
  readonly serviceName: string;
  readonly environment: string;
  readonly instanceId: string;
  readonly releaseSha: string;
} {
  return {
    level: parseLogLevel(env.get('LOG_LEVEL') ?? 'info'),
    serviceName: serviceNameFromEnv('unknown-service', env),
    environment: env.get('APP_ENVIRONMENT') ?? 'unknown',
    instanceId: env.get('RENDER_INSTANCE_ID') ?? 'local-instance',
    releaseSha: env.get('RENDER_GIT_COMMIT') ?? env.get('RELEASE_SHA') ?? 'unknown',
  };
}

function parseCorsOrigins(env: EnvSource, publicBaseUrl: string): string[] {
  const fromPublic = new URL(publicBaseUrl).origin;
  const extra = (env.get('CORS_ALLOWED_ORIGINS') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return [...new Set([fromPublic, ...extra])];
}

/**
 * Rejects a local-only architecture in production. Hosts like `localhost` or a
 * bare in-process datastore are development conveniences, never the deployed
 * system, and a production process that finds one refuses to start rather than
 * pretending to be production.
 */
export function assertProductionTopology(config: RuntimeConfig): void {
  if (config.environment !== 'production') return;
  const localPatterns = [/localhost/i, /127\.0\.0\.1/, /::1/, /\.local(:|$)/i];
  const offenders: string[] = [];
  if (localPatterns.some((p) => p.test(config.databaseUrl))) offenders.push('DATABASE_URL');
  if (localPatterns.some((p) => p.test(config.redisUrl))) offenders.push('REDIS_URL');
  if (localPatterns.some((p) => p.test(config.publicBaseUrl))) offenders.push('PUBLIC_BASE_URL');
  if (offenders.length > 0) {
    throw new ValidationError(
      `Refusing to start in production with local endpoints configured: ${offenders.join(', ')}. ` +
        `Production must use the hosted Render Postgres, Render Key Value and the public service URL.`,
      { offenders },
    );
  }
}
