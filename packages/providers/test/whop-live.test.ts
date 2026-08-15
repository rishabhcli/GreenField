/**
 * Live Whop GET /accounts/me. Skipped unless LIVE_PROBES=1.
 * Requires WHOP_API_KEY + WHOP_COMPANY_ID as the adapter actually reads them.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SecretStore } from '@foundry/core';
import { WhopAdapter } from '../src/whop/index.js';

function loadDotenv(path: string): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined || process.env[key] === '') process.env[key] = value;
  }
}

loadDotenv(resolve(process.cwd(), '.env'));
loadDotenv(resolve(process.cwd(), '../../.env'));

const live = process.env['LIVE_PROBES'] === '1';

describe.skipIf(!live)('Whop live GET /accounts/me', () => {
  it('returns the configured company id', async () => {
    const adapter = new WhopAdapter({
      secrets: new SecretStore(),
      environment: 'production',
      publicBaseUrl: 'https://example.test',
    });
    const result = await adapter.probe();
    process.stdout.write(`WHOP succeeded=${String(result.succeeded)} detail=${result.detail}\n`);
    expect(result.succeeded).toBe(true);
    expect(result.evidence['accountId']).toBe(process.env['WHOP_COMPANY_ID']);
  });
});
