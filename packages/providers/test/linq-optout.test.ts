/**
 * Linq opt-out is a compliance boundary: inbound keywords map, local ledger
 * blocks sends, and every manifest webhook event has a mapper.
 */

import { describe, expect, it } from 'vitest';
import { SecretStore } from '@foundry/core';
import { LINQ_MANIFEST } from '../src/manifests.js';
import {
  HANDLED_LINQ_EVENTS,
  LinqAdapter,
  LinqOptOutError,
  isOptOutInbound,
  mapLinqEventToSupportUpdate,
} from '../src/linq/index.js';

function keyedAdapter(fetchImpl: typeof fetch): LinqAdapter {
  return new LinqAdapter(
    {
      secrets: new SecretStore({
        get: (name) => (name === 'LINQ_API_V3_API_KEY' ? 'linq_test_not_live' : undefined),
      }),
      environment: 'preview',
      publicBaseUrl: 'https://example.test',
    },
    { fetchImpl },
  );
}

describe('Linq opt-out', () => {
  it('treats STOP as an inbound opt-out keyword', () => {
    expect(isOptOutInbound('STOP')).toBe(true);
    expect(isOptOutInbound('please stop shipping')).toBe(false);
  });

  it('maps message.received STOP to inbound_message with isOptOutRequest', () => {
    const update = mapLinqEventToSupportUpdate('message.received', {
      id: 'm1',
      chat_id: 'c1',
      from: '+15551234567',
      body: 'STOP',
      service: 'SMS',
    });
    expect(update.kind).toBe('inbound_message');
    if (update.kind === 'inbound_message') {
      expect(update.isOptOutRequest).toBe(true);
      expect(update.fromHandle).toBe('+15551234567');
    }
  });

  it('setOptOutStateStore blocks sendMessage before any HTTP call', async () => {
    let httpCalls = 0;
    const adapter = keyedAdapter(async () => {
      httpCalls += 1;
      return new Response('{}', { status: 500 });
    });
    adapter.setOptOutStateStore({
      isOptedOut: (handle) => handle === '+15551234567',
    });
    await expect(
      adapter.sendMessage({
        to: ['+15551234567'],
        parts: [{ type: 'text', value: 'hello' }],
        idempotencyKey: 'k-optout',
      }),
    ).rejects.toBeInstanceOf(LinqOptOutError);
    expect(httpCalls).toBe(0);
  });

  it('handles exactly the events listed on LINQ_MANIFEST.webhooks[0]', () => {
    const documented = [...(LINQ_MANIFEST.webhooks?.[0]?.events ?? [])].sort();
    const handled = [...HANDLED_LINQ_EVENTS].sort();
    expect(handled).toEqual(documented);
  });
});
