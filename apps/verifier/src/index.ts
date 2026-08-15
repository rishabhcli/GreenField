/**
 * Verification harness.
 *
 * This process is the reason nothing in this system can claim a working
 * integration it does not have. The capability registry will only report
 * `live_verified` when two things are simultaneously true: the required
 * secrets are present, and a dated row in `integration_verifications` records
 * a successful non-destructive probe against the live provider. This job is
 * the only writer of that row.
 *
 * Consequences that are load-bearing, not incidental:
 *
 *  - With no credentials, every probe records a failure with the missing
 *    variable named. The system then honestly reports zero verified
 *    capabilities. That is the correct state today, not a bug to work around.
 *  - A probe that cannot be performed at all (no public read endpoint, vendor
 *    approval pending) records `succeeded: false` with the reason. It never
 *    records a pass on the grounds that nothing went wrong.
 *  - Probes are non-destructive by contract. Verification must never create an
 *    order, send a message, charge a card, or publish a site.
 */

import { describeError } from '@foundry/core';
import type { ProviderId } from '@foundry/core';
import { getLogger } from '@foundry/obs';
import { buildContext } from '@foundry/runtime';

const EXPECTED_MIGRATIONS = 5;

/** Per-probe ceiling. A hung provider must not stall the whole sweep. */
const PROBE_TIMEOUT_MS = 20_000;

export interface ProbeOutcome {
  readonly provider: ProviderId;
  readonly succeeded: boolean;
  readonly detail: string;
  readonly latencyMs: number;
  readonly evidence: Readonly<Record<string, unknown>>;
}

async function main(): Promise<void> {
  const ctx = await buildContext({
    serviceName: process.env['RENDER_SERVICE_NAME'] ?? 'foundry-verifier',
    expectedMigrations: EXPECTED_MIGRATIONS,
    installSchedules: false,
  });
  const log = getLogger();

  const results = await runSweep(ctx);

  const verified = results.filter((r) => r.succeeded);
  const failed = results.filter((r) => !r.succeeded);

  log.info(
    {
      probed: results.length,
      verified: verified.map((r) => r.provider),
      failed: failed.map((r) => ({ provider: r.provider, detail: r.detail })),
    },
    'verification sweep complete',
  );

  // Printed, not just logged: this is the artefact a human reads to answer
  // "what actually works right now".
  process.stdout.write(`\n${renderReport(results)}\n`);

  await ctx.shutdown();

  // Exit 0 even when probes fail. A failing probe is a true statement about the
  // world, not a failure of this job — and a non-zero exit would make Render
  // page an operator every six hours for a key that is simply not issued yet.
  process.exit(0);
}

export async function runSweep(ctx: Awaited<ReturnType<typeof buildContext>>): Promise<readonly ProbeOutcome[]> {
  const log = getLogger();
  const outcomes: ProbeOutcome[] = [];

  for (const provider of ctx.providers.registeredProviders()) {
    const startedAt = Date.now();
    let outcome: ProbeOutcome;

    try {
      const adapter = ctx.providers.adapter(provider);
      if (!adapter) {
        outcome = {
          provider,
          succeeded: false,
          detail: 'no adapter is constructed for this provider in this deployment',
          latencyMs: 0,
          evidence: {},
        };
      } else {
        const result = await withTimeout(adapter.probe(), PROBE_TIMEOUT_MS, provider);
        outcome = {
          provider,
          succeeded: result.succeeded,
          detail: result.detail,
          latencyMs: Date.now() - startedAt,
          evidence: result.evidence,
        };
      }
    } catch (error) {
      // A thrown probe is a failed probe. The error is recorded verbatim so the
      // reason survives — "credential missing" and "provider returned 500" lead
      // to completely different actions.
      outcome = {
        provider,
        succeeded: false,
        detail: error instanceof Error ? error.message : String(error),
        latencyMs: Date.now() - startedAt,
        evidence: { error: describeError(error) },
      };
    }

    await ctx.repos.verifications.record({
      provider,
      succeeded: outcome.succeeded,
      detail: outcome.detail,
      evidence: { ...outcome.evidence, latencyMs: outcome.latencyMs },
      environment: ctx.config.environment,
    });

    await ctx.repos.audit
      .append({
        companyId: (await ctx.repos.companies.first())?.id ?? 'system',
        kind: 'verification_probe',
        actorId: 'service:verifier',
        actorKind: 'system_job',
        action: `probe ${provider}`,
        subjectType: 'provider',
        subjectRefId: provider,
        outcome: outcome.succeeded ? 'success' : 'failure',
        detail: { detail: outcome.detail, latencyMs: outcome.latencyMs },
      })
      .catch((error) => {
        // No company row yet is normal on a fresh deployment; the verification
        // row itself is the record that matters.
        log.debug({ err: describeError(error) }, 'verification audit append skipped');
      });

    log.info(
      { provider, succeeded: outcome.succeeded, latencyMs: outcome.latencyMs, detail: outcome.detail },
      'provider probed',
    );
    outcomes.push(outcome);
  }

  return outcomes;
}

/**
 * Human-readable sweep report.
 *
 * Deliberately blunt: a provider is either verified against the live API right
 * now, or it is not, with the reason. There is no "partially configured".
 */
export function renderReport(results: readonly ProbeOutcome[]): string {
  const lines: string[] = [];
  lines.push('VERIFICATION SWEEP');
  lines.push('='.repeat(78));
  lines.push(`Run at: ${new Date().toISOString()}`);
  lines.push(`Probed: ${results.length}   Verified: ${results.filter((r) => r.succeeded).length}`);
  lines.push('');

  const width = Math.max(...results.map((r) => r.provider.length), 10);
  for (const r of results.slice().sort((a, b) => Number(b.succeeded) - Number(a.succeeded))) {
    const mark = r.succeeded ? 'VERIFIED' : 'NOT VERIFIED';
    lines.push(`${r.provider.padEnd(width)}  ${mark.padEnd(13)} ${r.latencyMs}ms  ${r.detail}`);
  }

  lines.push('');
  lines.push(
    'A provider marked NOT VERIFIED has no successful live probe on record. ' +
      'Its capabilities are unavailable and the system will refuse to use them.',
  );
  return lines.join('\n');
}

async function withTimeout<T>(promise: Promise<T>, ms: number, provider: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`probe for ${provider} exceeded ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

main().catch((error) => {
  console.error('Verifier failed to start:', error);
  process.exit(1);
});
