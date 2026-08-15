/**
 * In-process metrics with a Prometheus text exposition endpoint.
 *
 * Deliberately dependency-free and small: the operational questions this system
 * needs answered are "is a provider failing", "are queues draining", "is spend
 * accelerating" and "are webhooks arriving", all of which are counters,
 * gauges and histograms scraped from `/metrics`.
 */

export type Labels = Readonly<Record<string, string>>;

function labelKey(labels: Labels): string {
  const entries = Object.entries(labels).sort(([a], [b]) => (a < b ? -1 : 1));
  return entries.map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(',');
}

function renderLabels(labels: Labels): string {
  const entries = Object.entries(labels).sort(([a], [b]) => (a < b ? -1 : 1));
  if (entries.length === 0) return '';
  return `{${entries.map(([k, v]) => `${k}="${escapeLabelValue(v)}"`).join(',')}}`;
}

function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}

abstract class Metric {
  constructor(
    readonly name: string,
    readonly help: string,
    readonly type: 'counter' | 'gauge' | 'histogram',
  ) {}
  abstract render(): string;
}

export class Counter extends Metric {
  readonly #values = new Map<string, { labels: Labels; value: number }>();
  constructor(name: string, help: string) {
    super(name, help, 'counter');
  }
  inc(labels: Labels = {}, by = 1): void {
    const key = labelKey(labels);
    const existing = this.#values.get(key);
    if (existing) existing.value += by;
    else this.#values.set(key, { labels, value: by });
  }
  get(labels: Labels = {}): number {
    return this.#values.get(labelKey(labels))?.value ?? 0;
  }
  override render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`];
    if (this.#values.size === 0) lines.push(`${this.name} 0`);
    for (const { labels, value } of this.#values.values()) {
      lines.push(`${this.name}${renderLabels(labels)} ${value}`);
    }
    return lines.join('\n');
  }
}

export class Gauge extends Metric {
  readonly #values = new Map<string, { labels: Labels; value: number }>();
  constructor(name: string, help: string) {
    super(name, help, 'gauge');
  }
  set(value: number, labels: Labels = {}): void {
    this.#values.set(labelKey(labels), { labels, value });
  }
  inc(labels: Labels = {}, by = 1): void {
    const key = labelKey(labels);
    const existing = this.#values.get(key);
    if (existing) existing.value += by;
    else this.#values.set(key, { labels, value: by });
  }
  dec(labels: Labels = {}, by = 1): void {
    this.inc(labels, -by);
  }
  override render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} gauge`];
    for (const { labels, value } of this.#values.values()) {
      lines.push(`${this.name}${renderLabels(labels)} ${value}`);
    }
    return lines.join('\n');
  }
}

const DEFAULT_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60];

export class Histogram extends Metric {
  readonly #series = new Map<string, { labels: Labels; counts: number[]; sum: number; count: number }>();
  constructor(
    name: string,
    help: string,
    readonly buckets: readonly number[] = DEFAULT_BUCKETS,
  ) {
    super(name, help, 'histogram');
  }
  observe(seconds: number, labels: Labels = {}): void {
    const key = labelKey(labels);
    let series = this.#series.get(key);
    if (!series) {
      series = { labels, counts: new Array<number>(this.buckets.length).fill(0), sum: 0, count: 0 };
      this.#series.set(key, series);
    }
    series.sum += seconds;
    series.count += 1;
    for (let i = 0; i < this.buckets.length; i += 1) {
      if (seconds <= (this.buckets[i] ?? Infinity)) series.counts[i] = (series.counts[i] ?? 0) + 1;
    }
  }
  /** Times an async operation and records the duration, success or failure. */
  async time<T>(fn: () => Promise<T>, labels: Labels = {}): Promise<T> {
    const start = process.hrtime.bigint();
    try {
      const result = await fn();
      this.observe(Number(process.hrtime.bigint() - start) / 1e9, { ...labels, outcome: 'success' });
      return result;
    } catch (error) {
      this.observe(Number(process.hrtime.bigint() - start) / 1e9, { ...labels, outcome: 'failure' });
      throw error;
    }
  }
  override render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    for (const series of this.#series.values()) {
      for (let i = 0; i < this.buckets.length; i += 1) {
        lines.push(
          `${this.name}_bucket${renderLabels({ ...series.labels, le: String(this.buckets[i]) })} ${series.counts[i] ?? 0}`,
        );
      }
      lines.push(`${this.name}_bucket${renderLabels({ ...series.labels, le: '+Inf' })} ${series.count}`);
      lines.push(`${this.name}_sum${renderLabels(series.labels)} ${series.sum}`);
      lines.push(`${this.name}_count${renderLabels(series.labels)} ${series.count}`);
    }
    return lines.join('\n');
  }
}

class Registry {
  readonly #metrics = new Map<string, Metric>();

  counter(name: string, help: string): Counter {
    return this.#getOrCreate(name, () => new Counter(name, help)) as Counter;
  }
  gauge(name: string, help: string): Gauge {
    return this.#getOrCreate(name, () => new Gauge(name, help)) as Gauge;
  }
  histogram(name: string, help: string, buckets?: readonly number[]): Histogram {
    return this.#getOrCreate(name, () => new Histogram(name, help, buckets)) as Histogram;
  }
  #getOrCreate(name: string, factory: () => Metric): Metric {
    const existing = this.#metrics.get(name);
    if (existing) return existing;
    const created = factory();
    this.#metrics.set(name, created);
    return created;
  }
  render(): string {
    return [...this.#metrics.values()].map((m) => m.render()).join('\n\n') + '\n';
  }
}

export const registry = new Registry();

/* -------------------------------------------------------------------------- */
/* Standard metrics                                                            */
/* -------------------------------------------------------------------------- */

export const metrics = {
  httpRequests: registry.counter('foundry_http_requests_total', 'HTTP requests handled'),
  httpDuration: registry.histogram('foundry_http_request_duration_seconds', 'HTTP request duration'),
  providerCalls: registry.counter('foundry_provider_calls_total', 'Outbound provider API calls'),
  providerDuration: registry.histogram('foundry_provider_call_duration_seconds', 'Outbound provider call duration'),
  providerErrors: registry.counter('foundry_provider_errors_total', 'Outbound provider call errors by category'),
  breakerState: registry.gauge('foundry_circuit_breaker_open', 'Circuit breaker open (1) or closed (0)'),
  webhooksReceived: registry.counter('foundry_webhooks_received_total', 'Inbound webhooks by provider and result'),
  jobsProcessed: registry.counter('foundry_jobs_processed_total', 'Queue jobs processed by queue and result'),
  jobDuration: registry.histogram('foundry_job_duration_seconds', 'Queue job duration'),
  queueDepth: registry.gauge('foundry_queue_depth', 'Jobs waiting in a queue'),
  agentRuns: registry.counter('foundry_agent_runs_total', 'Agent runs by role and outcome'),
  agentTokens: registry.counter('foundry_agent_tokens_total', 'Model tokens consumed by role and direction'),
  policyDecisions: registry.counter('foundry_policy_decisions_total', 'Policy decisions by authority and outcome'),
  spendMinor: registry.counter('foundry_spend_minor_total', 'Committed spend in minor units by scope'),
  ordersByStatus: registry.gauge('foundry_orders_by_status', 'Orders currently in each status'),
  capabilityState: registry.gauge('foundry_capability_state', 'Capability usable (1) or not (0)'),
} as const;
