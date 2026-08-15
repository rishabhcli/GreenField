/**
 * Live Solari sandbox smoke: create, exec echo, delete.
 * Skipped unless LIVE_PROBES=1. Failures are recorded with the exact error.
 * Does not call POST /desktops.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SecretStore, toFoundryError } from '@foundry/core';
import type { AdapterContext } from '../src/http/adapter.js';
import { SolariAdapter, solariSandboxId } from '../src/solari/index.js';

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

describe.skipIf(!live)('Solari live sandbox exec smoke', () => {
  it(
    'creates a sandbox, execs echo via {cmd,args}, deletes',
    async () => {
      const adapter = new SolariAdapter(ctx());
      let sandboxId: string | undefined;
      try {
        const created = await adapter.createSandbox({
          kind: 'sandbox',
          template: 'base',
          timeoutMs: 180_000,
          metadata: { purpose: 'foundry-solari-exec-smoke' },
        });
        sandboxId = solariSandboxId(created);
        process.stdout.write(`SOLARI create sandboxId_len=${sandboxId.length} kind=${created.kind ?? ''} state=${created.state ?? ''}\n`);
        expect(sandboxId.length).toBeGreaterThan(4);

        const exec = await adapter.execInSandbox(sandboxId, { cmd: '/bin/echo', args: ['foundry-solari-ok'] });
        process.stdout.write(
          `SOLARI exec exitCode=${String(exec.exitCode)} stdout=${JSON.stringify(exec.stdout)} stderr=${JSON.stringify(exec.stderr)}\n`,
        );
        expect(exec.exitCode).toBe(0);
        expect(`${exec.stdout ?? ''}${exec.stderr ?? ''}`).toContain('foundry-solari-ok');
      } catch (error) {
        const foundry = toFoundryError(error);
        process.stdout.write(
          `SOLARI live smoke failed code=${foundry.code} category=${foundry.category} message=${foundry.message} context=${JSON.stringify(foundry.context)}\n`,
        );
        throw error;
      } finally {
        if (sandboxId) {
          await adapter.deleteSandbox(sandboxId);
          process.stdout.write(`SOLARI delete ${sandboxId.slice(0, 12)}… done\n`);
        }
      }
    },
    180_000,
  );
});
