/**
 * Live Lovable MCP initialize / tools/list. Skipped unless LIVE_PROBES=1.
 * No token means CredentialsMissingError — that is the correct state.
 * tools/list runs only when LOVABLE_OAUTH_ACCESS_TOKEN is present.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CredentialsMissingError, Secret, SecretStore } from '@foundry/core';
import { LovableAdapter } from '../src/lovable/index.js';
import { LovableMcpClient } from '../src/lovable/mcp-client.js';

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
const token = process.env['LOVABLE_OAUTH_ACCESS_TOKEN'];

describe.skipIf(!live)('Lovable live MCP', () => {
  it('probe names LOVABLE_OAUTH_ACCESS_TOKEN when the token is absent', async () => {
    if (token) return;
    const adapter = new LovableAdapter({
      secrets: new SecretStore({ get: () => undefined }),
      environment: 'production',
      publicBaseUrl: 'https://example.test',
    });
    await expect(adapter.probe()).rejects.toSatisfy((error: unknown) => {
      return error instanceof CredentialsMissingError && error.missing.includes('LOVABLE_OAUTH_ACCESS_TOKEN');
    });
  });

  it('initialize + tools/list when a token exists', async () => {
    if (!token) {
      process.stdout.write('LOVABLE_OAUTH_ACCESS_TOKEN missing; skipped authenticated tools/list\n');
      return;
    }
    const client = new LovableMcpClient({
      accessToken: new Secret('LOVABLE_OAUTH_ACCESS_TOKEN', token, 'unknown'),
    });
    const init = await client.initialize();
    expect(client.initialized).toBe(true);
    const listed = await client.listTools();
    const tools =
      listed && typeof listed === 'object' && Array.isArray((listed as { tools?: unknown }).tools)
        ? (listed as { tools: { name?: string }[] }).tools.map((t) => t.name).filter((n): n is string => Boolean(n))
        : [];
    process.stdout.write(`LOVABLE tools/list: ${tools.join(', ') || JSON.stringify(listed).slice(0, 400)}\n`);
    expect(tools.length).toBeGreaterThan(0);
    expect(init).toBeTypeOf('object');
  });
});
