/**
 * Application composition root.
 *
 * Everything the API and the worker need is constructed here, once, in
 * dependency order — so both processes share exactly the same wiring and there
 * is a single place to see what the system is made of.
 */

import {
  CapabilityRegistry,
  SecretStore,
  assertProductionTopology,
  loadRuntimeConfig,
  type RuntimeConfig,
} from '@foundry/core';
import { Repositories, createPool, databaseHealthCheck, schemaHealthCheck, DbVerificationLookup, type DbPool } from '@foundry/db';
import { HealthRegistry, initLogger, getLogger } from '@foundry/obs';
import {
  ALL_MANIFESTS,
  AlibabaSourcingAdapter,
  AnthropicAdapter,
  BandAdapter,
  CloudflareAdapter,
  GoogleAdsAdapter,
  ImageGenerationAdapter,
  LinqAdapter,
  MetaAdsAdapter,
  ProviderRegistry,
  RenderAdapter,
  ReplayAdapter,
  ResendAdapter,
  ShippoAdapter,
  StripeAdapter,
  TeracAdapter,
  allSecretSpecs,
  type AdapterContext,
  type AdapterFactory,
} from '@foundry/providers';
import {
  QueueSet,
  assertEvictionPolicy,
  createRedisConnection,
  queueHealthCheck,
  redisHealthCheck,
} from '@foundry/queue';
import { AgentExecutor, OrgDispatcher, PolicyGate, ToolRegistry, DEFAULT_APPROVAL_THRESHOLDS } from '@foundry/agents';
import type { Redis } from 'ioredis';

export interface AppContext {
  readonly config: RuntimeConfig;
  readonly pool: DbPool;
  readonly repos: Repositories;
  readonly redis: Redis;
  readonly queues: QueueSet;
  readonly providers: ProviderRegistry;
  readonly capabilities: CapabilityRegistry;
  readonly secrets: SecretStore;
  readonly gate: PolicyGate;
  readonly tools: ToolRegistry;
  readonly executor: AgentExecutor;
  readonly dispatcher: OrgDispatcher;
  readonly health: HealthRegistry;
  shutdown(): Promise<void>;
}

/**
 * Adapters that are implemented.
 *
 * A provider absent from this map is reported by the registry as
 * unimplemented, and every capability that depends on it is unavailable. That
 * gap is visible at `/readiness/providers` rather than discovered when a job
 * fails — the map is the single honest answer to "what is actually wired in".
 */
function adapterFactories(): Partial<Record<string, AdapterFactory>> {
  return {
    // Model inference
    anthropic: (ctx: AdapterContext) => new AnthropicAdapter(ctx),
    openai_images: (ctx: AdapterContext) => new ImageGenerationAdapter(ctx),

    // Payments
    stripe: (ctx: AdapterContext) => new StripeAdapter(ctx),

    // Research and expert review
    terac: (ctx: AdapterContext) => new TeracAdapter(ctx),
    band: (ctx: AdapterContext) => new BandAdapter(ctx),

    // Build, host, QA
    render: (ctx: AdapterContext) => new RenderAdapter(ctx),
    replay: (ctx: AdapterContext) => new ReplayAdapter(ctx),
    cloudflare_dns: (ctx: AdapterContext) => new CloudflareAdapter(ctx),

    // Marketing and support
    meta_ads: (ctx: AdapterContext) => new MetaAdsAdapter(ctx),
    google_ads: (ctx: AdapterContext) => new GoogleAdsAdapter(ctx),
    resend: (ctx: AdapterContext) => new ResendAdapter(ctx),
    linq: (ctx: AdapterContext) => new LinqAdapter(ctx),

    // Sourcing and fulfilment
    alibaba: (ctx: AdapterContext) => new AlibabaSourcingAdapter(ctx),
    shippo: (ctx: AdapterContext) => new ShippoAdapter(ctx),
  };
}

export interface BuildOptions {
  readonly serviceName: string;
  /** Migration count this build expects, used by the schema health check. */
  readonly expectedMigrations: number;
  readonly installSchedules?: boolean;
}

export async function buildContext(options: BuildOptions): Promise<AppContext> {
  const config = loadRuntimeConfig();

  initLogger({
    level: config.logLevel,
    serviceName: options.serviceName,
    environment: config.environment,
    instanceId: config.instanceId,
    releaseSha: config.releaseSha,
  });
  const log = getLogger();

  // Refuses to boot a production process pointed at localhost. A developer
  // laptop is never the production architecture.
  assertProductionTopology(config);

  const pool = createPool({
    connectionString: config.databaseUrl,
    applicationName: options.serviceName,
    maxConnections: options.serviceName.includes('worker') ? 12 : 10,
  });
  const repos = new Repositories(pool);

  const redis = createRedisConnection({ url: config.redisUrl, role: 'client', connectionName: options.serviceName });
  const evictionPolicy = await assertEvictionPolicy(redis, config.environment);
  log.info({ maxmemoryPolicy: evictionPolicy.policy }, 'redis eviction policy checked');

  const queues = new QueueSet({ connection: redis, environment: config.environment });
  if (options.installSchedules) {
    await queues.installSchedules();
    const pruned = await queues.pruneSchedules();
    if (pruned.length > 0) log.info({ pruned }, 'removed stale schedules');
  }

  const secrets = new SecretStore();
  const adapterContext: AdapterContext = {
    secrets,
    environment: config.environment,
    publicBaseUrl: config.publicBaseUrl,
  };

  // Load recorded verification probes so the registry can report
  // `live_verified` only where a real probe actually succeeded.
  const verifications = await DbVerificationLookup.load(repos.verifications, config.environment);

  const providers = new ProviderRegistry({
    context: adapterContext,
    factories: adapterFactories(),
    manifests: ALL_MANIFESTS,
    verifications,
  });
  providers.publishCapabilityMetrics();

  const unimplemented = providers.unimplementedProviders();
  if (unimplemented.length > 0) {
    log.warn({ unimplemented }, 'providers with a manifest but no adapter; their capabilities are unavailable');
  }

  const gate = new PolicyGate(repos, providers, { approvalThresholdsMinor: DEFAULT_APPROVAL_THRESHOLDS });
  const tools = new ToolRegistry();
  const llm = providers.adapter('anthropic') as AnthropicAdapter;
  const executor = new AgentExecutor({ repos, llm, tools, gate });
  const dispatcher = new OrgDispatcher(repos, queues);

  const health = new HealthRegistry(config.releaseSha);
  health.register(databaseHealthCheck(pool));
  health.register(schemaHealthCheck(pool, options.expectedMigrations));
  health.register(redisHealthCheck(redis));
  health.register(queueHealthCheck(queues));

  const missingSecrets = secrets.resolve(allSecretSpecs()).missingRequired;
  log.info(
    {
      environment: config.environment,
      release: config.releaseSha,
      capabilities: providers.capabilities.summary(),
      missingSecretCount: missingSecrets.length,
    },
    'application context built',
  );

  return {
    config,
    pool,
    repos,
    redis,
    queues,
    providers,
    capabilities: providers.capabilities,
    secrets,
    gate,
    tools,
    executor,
    dispatcher,
    health,
    async shutdown() {
      health.beginShutdown();
      // Order matters: stop taking work, then close the queue clients, then
      // drop the datastore connections.
      await queues.close().catch((e) => log.error({ err: e }, 'queue close failed'));
      await redis.quit().catch((e) => log.error({ err: e }, 'redis quit failed'));
      await pool.end().catch((e) => log.error({ err: e }, 'pool end failed'));
    },
  };
}
