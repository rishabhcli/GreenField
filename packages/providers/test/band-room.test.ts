/**
 * The live Zero Human Co room is the coordination surface. Creating a second
 * chat and calling that "channels done" is a decorative pass — these tests
 * refuse that path. GET /agent/me is identity, not mesh-complete.
 */

import { describe, expect, it } from 'vitest';
import { SecretStore } from '@foundry/core';
import { BAND_MANIFEST } from '../src/manifests.js';
import {
  BandAdapter,
  ZERO_HUMAN_CO_COORDINATION_ROOM_ID,
} from '../src/band/index.js';

function previewAdapter(): BandAdapter {
  return new BandAdapter({
    secrets: new SecretStore({
      get: (name) => (name === 'BAND_AGENT_API_KEY' ? 'band_a_testkey' : undefined),
    }),
    environment: 'preview',
    publicBaseUrl: 'https://example.test',
  });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('BAND coordination room reuse', () => {
  it('uses a configured chat id and never lists or creates', async () => {
    const paths: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = async (input) => {
      paths.push(String(input));
      throw new Error(`unexpected fetch ${String(input)}`);
    };
    try {
      const resolved = await previewAdapter().resolveCoordinationRoom({
        configuredChatId: ZERO_HUMAN_CO_COORDINATION_ROOM_ID,
        companyName: 'Zero Human Co',
      });
      expect(resolved).toEqual({
        chatId: ZERO_HUMAN_CO_COORDINATION_ROOM_ID,
        created: false,
      });
      expect(paths).toEqual([]);
    } finally {
      globalThis.fetch = original;
    }
  });

  it('reuses the live Zero Human Co room from listChats instead of createChat', async () => {
    const paths: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      const method = String(init?.method ?? 'GET').toUpperCase();
      paths.push(`${method} ${url}`);
      if (method === 'GET' && url.includes('/agent/chats') && !url.includes('/messages')) {
        return json({
          data: [
            {
              id: ZERO_HUMAN_CO_COORDINATION_ROOM_ID,
              title: 'Zero Human Co coordination',
            },
          ],
        });
      }
      throw new Error(`must not create a second room: ${method} ${url}`);
    };
    try {
      const resolved = await previewAdapter().resolveCoordinationRoom({
        configuredChatId: null,
        companyName: 'Zero Human Co',
      });
      expect(resolved.created).toBe(false);
      expect(resolved.chatId).toBe(ZERO_HUMAN_CO_COORDINATION_ROOM_ID);
      expect(paths.some((p) => p.includes('/agent/chats'))).toBe(true);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe('BAND probe is not mesh-complete', () => {
  it('GET /agent/me is an identity probe, not a governance or mesh-complete claim', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = async () =>
      json({
        data: { id: 'agt_test', handle: 'foundry-dispatch' },
      });
    try {
      const result = await previewAdapter().probe();
      expect(result.succeeded).toBe(true);
      expect(JSON.stringify(result)).not.toMatch(/mesh complete/i);
      expect(result.detail).toMatch(/GET \/agent\/me/);
    } finally {
      globalThis.fetch = original;
    }
  });

  it('coordination.governance stays marketing_claim_only so a probe cannot verify it', () => {
    const gov = BAND_MANIFEST.capabilities.find((c) => c.capability === 'coordination.governance');
    expect(gov?.evidence.kind).toBe('marketing_claim_only');
    expect(BAND_MANIFEST.liveProbe.description).toMatch(/GET \/agent\/me/);
  });
});
