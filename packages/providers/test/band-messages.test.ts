/**
 * BAND sendMessage must match POST /agent/chats/{id}/messages:
 * `{ message: { content, mentions: [{ handle }] } }`.
 * Live 422 for the dispatcher payload was Unexpected field: content;
 * message.task_id is also rejected.
 */

import { describe, expect, it } from 'vitest';
import { SecretStore } from '@foundry/core';
import { BandAdapter } from '../src/band/index.js';
import { bandSendMessageBody } from '../src/band/schemas.js';

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

describe('BAND sendMessage request shape', () => {
  it('wraps dispatcher text as message.content and mentions[].handle', () => {
    expect(
      bandSendMessageBody({
        recipients: ['rishabh.rb'],
        body:
          'DISPATCH role=research_manager run=run_01K3BANDSEND422REPRO000000\n' +
          'Collect real market evidence.\n' +
          'A specialist must not start this work except by claiming this message.',
      }),
    ).toEqual({
      message: {
        content:
          '@rishabh.rb DISPATCH role=research_manager run=run_01K3BANDSEND422REPRO000000\n' +
          'Collect real market evidence.\n' +
          'A specialist must not start this work except by claiming this message.',
        mentions: [{ handle: 'rishabh.rb' }],
      },
    });
  });

  it('posts the nested message wrapper and omits taskId', async () => {
    let posted: unknown;
    const original = globalThis.fetch;
    globalThis.fetch = async (_input, init) => {
      posted = JSON.parse(String(init?.body));
      return json({
        data: {
          id: 'a1b2c3d4-e5f6-4a5b-9c8d-e7f8a9b0c1d2',
          recipients: [{ handle: 'rishabh.rb', id: '8f1bfb6b-8084-4d3b-aa5d-a54b77d39a5b' }],
          success: true,
        },
      });
    };
    try {
      const message = await previewAdapter().sendMessage('a70129cc-0663-4090-86b5-c5a98025532e', {
        recipients: ['rishabh.rb'],
        body: 'handoff',
        taskId: 'run_01K3BANDSEND422REPRO000000',
      });
      expect(posted).toEqual({
        message: {
          content: '@rishabh.rb handoff',
          mentions: [{ handle: 'rishabh.rb' }],
        },
      });
      expect(message.id).toBe('a1b2c3d4-e5f6-4a5b-9c8d-e7f8a9b0c1d2');
    } finally {
      globalThis.fetch = original;
    }
  });
});
