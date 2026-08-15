/**
 * Lovable MCP adapter — credentials honesty and request-shape tests.
 *
 * These tests never contact https://mcp.lovable.dev. An empty SecretStore
 * must fail closed with setup instructions. JSON-RPC bodies are asserted
 * against a fake fetchImpl that returns 401, so we do not fabricate a
 * successful live MCP session.
 */

import { describe, expect, it } from 'vitest';
import { CredentialsMissingError, ProviderAuthError, Secret, SecretStore } from '@foundry/core';
import { LovableAdapter } from '../src/lovable/index.js';
import {
  LOVABLE_MCP_ENDPOINT,
  LovableMcpClient,
  buildToolsCall,
  parseSseJsonRpc,
} from '../src/lovable/mcp-client.js';

function emptyStore(): SecretStore {
  return new SecretStore({ get: () => undefined });
}

function adapter(secrets: SecretStore, fetchImpl?: typeof fetch): LovableAdapter {
  return new LovableAdapter(
    { secrets, environment: 'preview', publicBaseUrl: 'https://example.test' },
    fetchImpl ? { fetchImpl } : {},
  );
}

describe('LovableAdapter credentials', () => {
  it('probe throws CredentialsMissingError naming LOVABLE_OAUTH_ACCESS_TOKEN and allowlisted OAuth', async () => {
    const client = adapter(emptyStore());
    await expect(client.probe()).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(CredentialsMissingError);
      const missing = error as CredentialsMissingError;
      expect(missing.missing).toContain('LOVABLE_OAUTH_ACCESS_TOKEN');
      expect(missing.message).toMatch(/LOVABLE_OAUTH_ACCESS_TOKEN/);
      expect(missing.message).toMatch(/allowlisted/i);
      expect(missing.message).toMatch(/OAuth/i);
      return true;
    });
  });

  it('createProject throws the same missing-token error before any MCP POST', async () => {
    const client = adapter(emptyStore());
    await expect(
      client.createProject({
        initialMessage: 'Build a storefront',
        idempotencyKey: 'site-build-1',
      }),
    ).rejects.toBeInstanceOf(CredentialsMissingError);
  });
});

describe('MCP JSON-RPC request builder', () => {
  it('produces a valid tools/call body for get_me', () => {
    const body = buildToolsCall('get_me', {}, 1);
    expect(body).toEqual({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'get_me', arguments: {} },
    });
  });

  it('produces a valid tools/call body for create_project', () => {
    const body = buildToolsCall(
      'create_project',
      { initial_message: 'Build a candle storefront', workspace_id: 'ws_1' },
      'rpc-2',
    );
    expect(body).toEqual({
      jsonrpc: '2.0',
      id: 'rpc-2',
      method: 'tools/call',
      params: {
        name: 'create_project',
        arguments: {
          initial_message: 'Build a candle storefront',
          workspace_id: 'ws_1',
        },
      },
    });
    expect(JSON.stringify(body)).not.toMatch(/idempotency/i);
  });
});

describe('LovableMcpClient with fake fetch', () => {
  it('POSTs a tools/call get_me JSON-RPC body with bearer auth and MCP accept headers, then throws on 401', async () => {
    let captured: { url: string; init: RequestInit } | undefined;
    const fetchImpl: typeof fetch = async (url, init) => {
      captured = { url: String(url), init: init ?? {} };
      return new Response('invalid_token', { status: 401, headers: { 'www-authenticate': 'Bearer error="invalid_token"' } });
    };
    const client = new LovableMcpClient({
      accessToken: new Secret('LOVABLE_OAUTH_ACCESS_TOKEN', 'not-a-live-token', 'unknown'),
      fetchImpl,
    });

    await expect(client.post(buildToolsCall('get_me', {}, 7), { operation: 'mcp.tools/call.get_me' })).rejects.toSatisfy(
      (error: unknown) => {
        expect(error).toBeInstanceOf(ProviderAuthError);
        const auth = error as ProviderAuthError;
        expect(auth.message).toMatch(/allowlisted/i);
        expect(auth.message).toMatch(/OAuth/i);
        expect(auth.message).not.toContain('not-a-live-token');
        return true;
      },
    );

    expect(captured).toBeDefined();
    expect(captured!.url).toBe(LOVABLE_MCP_ENDPOINT);
    const headers = new Headers(captured!.init.headers);
    expect(headers.get('authorization')).toBe('Bearer not-a-live-token');
    expect(headers.get('accept')).toContain('application/json');
    expect(headers.get('accept')).toContain('text/event-stream');
    expect(headers.get('content-type')).toContain('application/json');
    expect(JSON.parse(String(captured!.init.body))).toEqual({
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: { name: 'get_me', arguments: {} },
    });
  });

  it('POSTs a tools/call create_project JSON-RPC body', async () => {
    let body: unknown;
    const fetchImpl: typeof fetch = async (_url, init) => {
      body = JSON.parse(String(init?.body));
      return new Response('unauthorized', { status: 401 });
    };
    const client = new LovableMcpClient({
      accessToken: new Secret('LOVABLE_OAUTH_ACCESS_TOKEN', 'not-a-live-token', 'unknown'),
      fetchImpl,
    });

    await expect(
      client.post(
        buildToolsCall('create_project', { initial_message: 'Build a store', workspace_id: 'ws_1' }, 3),
        { operation: 'mcp.tools/call.create_project' },
      ),
    ).rejects.toBeInstanceOf(ProviderAuthError);

    expect(body).toEqual({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'create_project',
        arguments: { initial_message: 'Build a store', workspace_id: 'ws_1' },
      },
    });
  });

  it('does not treat initialize as successful when the server returns 401', async () => {
    const client = new LovableMcpClient({
      accessToken: new Secret('LOVABLE_OAUTH_ACCESS_TOKEN', 'not-a-live-token', 'unknown'),
      fetchImpl: async () => new Response('', { status: 401 }),
    });
    await expect(client.initialize()).rejects.toBeInstanceOf(ProviderAuthError);
    expect(client.initialized).toBe(false);
  });
});

describe('SSE JSON-RPC parser', () => {
  it('reads event: message / data: {...} frames', () => {
    const frames = parseSseJsonRpc(
      [
        'event: message',
        'data: {"jsonrpc":"2.0","id":1,"result":{"ok":true}}',
        '',
        'event: message',
        'data: {"jsonrpc":"2.0","method":"notifications/progress"}',
        '',
      ].join('\n'),
    );
    expect(frames).toHaveLength(2);
    expect(frames[0]).toEqual({ jsonrpc: '2.0', id: 1, result: { ok: true } });
  });
});
