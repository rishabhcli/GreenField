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
  logLevel: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']),
  /** Public base URL of the control plane, used to build webhook URLs. */
  publicBaseUrl: z.string().url(),
  databaseUrl: z.string().min(1),
  redisUrl: z.string().min(1),
  /** Max concurrent jobs a worker process will run. */
  workerConcurrency: z.number().int().positive(),
  /** Global switch that stops all agent execution without a redeploy. */
  agentsEnabled: z.boolean(),
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

  const config: RuntimeConfig = {
    environment: parsedEnvironment.data,
    // Render sets RENDER_SERVICE_NAME and RENDER_INSTANCE_ID automatically.
    serviceName: optional(env, 'RENDER_SERVICE_NAME', optional(env, 'SERVICE_NAME', 'unknown-service')),
    instanceId: optional(env, 'RENDER_INSTANCE_ID', 'local-instance'),
    releaseSha: optional(env, 'RENDER_GIT_COMMIT', optional(env, 'RELEASE_SHA', 'unknown')),
    port: Number.parseInt(optional(env, 'PORT', '10000'), 10),
    logLevel: (optional(env, 'LOG_LEVEL', 'info') as RuntimeConfig['logLevel']),
    publicBaseUrl: required(
      env,
      'PUBLIC_BASE_URL',
      'This is the externally reachable https URL of the API service; webhook URLs are built from it.',
    ),
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
