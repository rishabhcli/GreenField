/**
 * BAND handoff primitives: @mention is required to send, and a missing room
 * message cannot be claimed. Live foundry-dispatch identity is opt-in.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SecretStore, ValidationError } from '@foundry/core';
import { BandAdapter, ZERO_HUMAN_CO_COORDINATION_ROOM_ID } from '../src/band/index.js';

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

function previewAdapter(agentKey = 'band_a_testkey'): BandAdapter {
  return new BandAdapter({
    secrets: new SecretStore({
      get: (name) => (name === 'BAND_AGENT_API_KEY' ? agentKey : undefined),
    }),
    environment: 'preview',
    publicBaseUrl: 'https://example.test',
  });
}

describe('BAND handoff primitives', () => {
  it('refuses a send with no @mention recipients before any HTTP call', async () => {
    const band = previewAdapter();
    await expect(band.sendMessage('chat_test', { recipients: [], body: 'hello' })).rejects.toSatisfy(
      (error: unknown) => error instanceof ValidationError && /@mention|route to nobody/i.test(error.message),
    );
  });

  it('claimHandoff throws when the room or message is missing', async () => {
    const band = previewAdapter();
    await expect(band.claimHandoff(undefined, undefined)).rejects.toThrow(/claimed before work/i);
    await expect(band.claimHandoff('', 'msg_1')).rejects.toThrow(/claimed before work/i);
    await expect(band.claimHandoff('chat_1', '')).rejects.toThrow(/claimed before work/i);
  });
});

const live = process.env['LIVE_PROBES'] === '1' && Boolean(process.env['BAND_AGENT_API_KEY']);

function liveBand(): BandAdapter {
  return new BandAdapter({
    secrets: new SecretStore(),
    environment: 'production',
    publicBaseUrl: 'https://example.test',
  });
}

describe.skipIf(!live)('BAND live foundry-dispatch', () => {
  it('GET /agent/me is the live foundry-dispatch agent', async () => {
    const me = await liveBand().getMe();
    expect(me.handle ?? me.id).toMatch(/foundry-dispatch/i);
  });

  it('reuses the live Zero Human Co room instead of creating a second one', async () => {
    const chat = await liveBand().getChat(ZERO_HUMAN_CO_COORDINATION_ROOM_ID);
    expect(chat.id).toBe(ZERO_HUMAN_CO_COORDINATION_ROOM_ID);
    const title = chat.title ?? chat.name ?? '';
    expect(title).toMatch(/Zero Human Co/i);
  });
});
