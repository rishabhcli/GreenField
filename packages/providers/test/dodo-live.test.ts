/**
 * Live Dodo GET /products. Skipped unless LIVE_PROBES=1.
 * Failures are recorded with the exact HTTP body. Never stubbed into success.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CredentialsMissingError, SecretStore, toFoundryError } from '@foundry/core';
import type { AdapterContext } from '../src/http/adapter.js';
import { DodoAdapter } from '../src/dodo/index.js';

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

function ctx(environment: AdapterContext['environment']): AdapterContext {
  return {
    secrets: new SecretStore(),
    environment,
    publicBaseUrl: 'https://example.test',
  };
}

describe.skipIf(!live)('Dodo live GET /products', () => {
  it('probes the test host and records the real status/body', async () => {
    const adapter = new DodoAdapter(ctx('preview'));
    expect(adapter.missingSecrets).not.toContain('DODO_API_KEY');
    const result = await adapter.probe();
    process.stdout.write(
      `DODO test host succeeded=${String(result.succeeded)} detail=${result.detail}\n`,
    );
    if (result.succeeded) {
      expect(result.evidence['status']).toBe(200);
      return;
    }
    expect(result.evidence['status']).toBe(401);
    expect(JSON.stringify(result.evidence['body'])).toMatch(/Unauthorized/i);
  });

  it('probes the live host without claiming success on 401', async () => {
    const adapter = new DodoAdapter(ctx('production'));
    const result = await adapter.probe();
    process.stdout.write(
      `DODO live host succeeded=${String(result.succeeded)} detail=${result.detail}\n`,
    );
    if (result.succeeded) {
      expect(result.evidence['status']).toBe(200);
      return;
    }
    expect(result.succeeded).toBe(false);
    expect(result.evidence['status']).toBe(401);
  });
});

describe('Dodo live harness honesty', () => {
  it('empty store still names DODO_API_KEY rather than inventing a 2xx', async () => {
    const adapter = new DodoAdapter({
      secrets: new SecretStore({ get: () => undefined }),
      environment: 'preview',
      publicBaseUrl: 'https://example.test',
    });
    try {
      await adapter.probe();
      throw new Error('expected CredentialsMissingError');
    } catch (error) {
      const foundry = toFoundryError(error);
      expect(foundry).toBeInstanceOf(CredentialsMissingError);
    }
  });
});
