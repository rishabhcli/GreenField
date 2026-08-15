/**
 * Live sandbox0 exec smoke: claim, exec echo, delete.
 * Skipped unless LIVE_PROBES=1. Failures are recorded with the exact error.
 * Does not treat pause as Superserve-equivalent.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SecretStore, toFoundryError } from '@foundry/core';
import type { AdapterContext } from '../src/http/adapter.js';
import { Sandbox0Adapter } from '../src/sandbox0/index.js';

function loadDotenv(path: string): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined || process.env[key] === '') process.env[key] = value;
  }
}

loadDotenv(resolve(process.cwd(), '.env'));
loadDotenv(resolve(process.cwd(), '../../.env'));

const live = process.env['LIVE_PROBES'] === '1';

function ctx(): AdapterContext {
  return {
    secrets: new SecretStore(),
    environment: 'production',
    publicBaseUrl: 'https://example.test',
  };
}

describe.skipIf(!live)('sandbox0 live exec smoke', () => {
  it(
    'claims a sandbox, execs echo, deletes',
    async () => {
      const adapter = new Sandbox0Adapter(ctx());
      let sandboxId: string | undefined;
      try {
        const claimed = await adapter.claimOrCreateSandbox({
          template: 'default',
          ttlSeconds: 180,
          hardTtlSeconds: 300,
          metadata: { agent_run_id: `foundry-s0-exec-smoke-${Date.now()}` },
        });
        sandboxId = 'sandbox_id' in claimed && typeof claimed.sandbox_id === 'string' ? claimed.sandbox_id : claimed.id;
        process.stdout.write(
          `SANDBOX0 claim id_len=${sandboxId.length} status=${'status' in claimed ? String(claimed.status) : ''} keys=${Object.keys(claimed).join(',')}\n`,
        );
        expect(sandboxId.length).toBeGreaterThan(4);

        const exec = await adapter.exec({ sandboxId, command: 'echo foundry-sandbox0-ok' });
        const text = `${exec.stdout ?? ''}${exec.output_raw ?? ''}${exec.stderr ?? ''}`;
        process.stdout.write(
          `SANDBOX0 exec exit_code=${String(exec.exit_code)} state=${exec.state ?? ''} text=${JSON.stringify(text).slice(0, 400)}\n`,
        );
        expect(exec.exit_code === undefined || exec.exit_code === 0).toBe(true);
        expect(text).toContain('foundry-sandbox0-ok');
      } catch (error) {
        const foundry = toFoundryError(error);
        process.stdout.write(
          `SANDBOX0 live smoke failed code=${foundry.code} category=${foundry.category} message=${foundry.message} context=${JSON.stringify(foundry.context)}\n`,
        );
        throw error;
      } finally {
        if (sandboxId) {
          await adapter.deleteSandbox(sandboxId);
          process.stdout.write('SANDBOX0 delete done\n');
        }
      }
    },
    180_000,
  );
});
