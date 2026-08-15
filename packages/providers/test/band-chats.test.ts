/**
 * BAND createChat must match POST /agent/chats: `{ chat: { title?, task_id? } }`.
 * Live 422 for the dispatcher payload was Unexpected field: name; company ids
 * are not UUIDs and also 422 as task_id.
 */

import { describe, expect, it } from 'vitest';
import { SecretStore } from '@foundry/core';
import { BandAdapter } from '../src/band/index.js';

function previewAdapter(): BandAdapter {
  return new BandAdapter({
    secrets: new SecretStore({
      get: (name) => (name === 'BAND_AGENT_API_KEY' ? 'band_a_testkey' : undefined),
    }),
    environment: 'preview',
    publicBaseUrl: 'https://example.test',
  });
}

function json(body: unknown, status = 201): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('BAND createChat request shape', () => {
  it('wraps the dispatcher name as chat.title and omits a non-uuid company taskId', async () => {
    let posted: unknown;
    const original = globalThis.fetch;
    globalThis.fetch = async (_input, init) => {
      posted = JSON.parse(String(init?.body));
      return json({
        data: {
          id: '7642c9c4-bd52-4b53-a442-ca3015212afd',
          title: 'Zero Human Co coordination',
          inserted_at: '2026-08-15T19:45:41.475422Z',
          updated_at: '2026-08-15T19:45:41.475422Z',
          task_id: null,
        },
      });
    };
    try {
      const chat = await previewAdapter().createChat({
        name: 'Zero Human Co coordination',
        taskId: 'co_01M03F7RQW2M6540BY2GZHCFBW',
      });
      expect(posted).toEqual({ chat: { title: 'Zero Human Co coordination' } });
      expect(chat.id).toBe('7642c9c4-bd52-4b53-a442-ca3015212afd');
    } finally {
      globalThis.fetch = original;
    }
  });

  it('always sends the required chat wrapper, even with no title or task', async () => {
    let posted: unknown;
    const original = globalThis.fetch;
    globalThis.fetch = async (_input, init) => {
      posted = JSON.parse(String(init?.body));
      return json({
        data: {
          id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
          title: null,
          inserted_at: '2026-08-15T19:45:41.475422Z',
          updated_at: '2026-08-15T19:45:41.475422Z',
          task_id: null,
        },
      });
    };
    try {
      await previewAdapter().createChat();
      expect(posted).toEqual({ chat: {} });
    } finally {
      globalThis.fetch = original;
    }
  });

  it('puts a uuid task_id inside chat and still sends chat when title is absent', async () => {
    let posted: unknown;
    const original = globalThis.fetch;
    globalThis.fetch = async (_input, init) => {
      posted = JSON.parse(String(init?.body));
      return json({
        data: {
          id: 'daca00d0-eb6b-4db1-8201-c46015c93d04',
          title: null,
          inserted_at: '2026-08-15T19:45:41.475422Z',
          updated_at: '2026-08-15T19:45:41.475422Z',
          task_id: 'daca00d0-eb6b-4db1-8201-c46015c93d04',
        },
      });
    };
    try {
      await previewAdapter().createChat({ taskId: 'daca00d0-eb6b-4db1-8201-c46015c93d04' });
      expect(posted).toEqual({ chat: { task_id: 'daca00d0-eb6b-4db1-8201-c46015c93d04' } });
    } finally {
      globalThis.fetch = original;
    }
  });
});
