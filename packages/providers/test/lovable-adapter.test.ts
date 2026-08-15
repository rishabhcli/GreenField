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

  it('POSTs tools/list after a successful initialize', async () => {
    const methods: string[] = [];
    const fetchImpl: typeof fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { method?: string; id?: number };
      if (body.method) methods.push(body.method);
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id ?? 0, result: { tools: [] } }), {
        status: 200,
      });
    };
    const client = new LovableMcpClient({
      accessToken: new Secret('LOVABLE_OAUTH_ACCESS_TOKEN', 'not-a-live-token', 'unknown'),
      fetchImpl,
    });
    const listed = await client.listTools();
    expect(methods).toContain('initialize');
    expect(methods).toContain('tools/list');
    expect(listed).toEqual({ tools: [] });
  });

  it('never sends a Lovable-API-Key header — OAuth bearer only', async () => {
    let headers: Headers | undefined;
    const fetchImpl: typeof fetch = async (_url, init) => {
      headers = new Headers(init?.headers);
      return new Response('unauthorized', { status: 401 });
    };
    const client = new LovableMcpClient({
      accessToken: new Secret('LOVABLE_OAUTH_ACCESS_TOKEN', 'not-a-live-token', 'unknown'),
      fetchImpl,
    });
    await expect(client.initialize()).rejects.toBeInstanceOf(ProviderAuthError);
    expect(headers?.get('authorization')).toBe('Bearer not-a-live-token');
    expect(headers?.get('lovable-api-key')).toBeNull();
    expect(headers?.get('x-api-key')).toBeNull();
  });
});

function tokenStore(): SecretStore {
  return new SecretStore({
    get: (name) => (name === 'LOVABLE_OAUTH_ACCESS_TOKEN' ? 'not-a-live-token' : undefined),
  });
}

function jsonRpc(id: unknown, result: unknown): Response {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: id ?? 0, result }), { status: 200 });
}

function fakeMcpFetch(tools: Record<string, (args: Record<string, unknown>) => unknown>): {
  fetchImpl: typeof fetch;
  calls: Array<{ name: string; args: Record<string, unknown> }>;
  headers: Headers[];
} {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const headers: Headers[] = [];
  const fetchImpl: typeof fetch = async (_url, init) => {
    headers.push(new Headers(init?.headers));
    const body = JSON.parse(String(init?.body)) as {
      method?: string;
      id?: number;
      params?: { name?: string; arguments?: Record<string, unknown> };
    };
    if (body.method === 'initialize') {
      return jsonRpc(body.id, { protocolVersion: '2025-03-26', serverInfo: { name: 'lovable' } });
    }
    if (body.method === 'notifications/initialized' || body.method === 'tools/list') {
      return jsonRpc(body.id, body.method === 'tools/list' ? { tools: [] } : {});
    }
    if (body.method === 'tools/call') {
      const name = body.params?.name ?? '';
      const args = body.params?.arguments ?? {};
      calls.push({ name, args });
      const result = tools[name]?.(args) ?? { content: [] };
      return jsonRpc(body.id, result);
    }
    return jsonRpc(body.id, {});
  };
  return { fetchImpl, calls, headers };
}

describe('LovableAdapter MCP tools via injected fetch', () => {
  it('createProject / listFiles / readFile / deployProject call the documented tools', async () => {
    const { fetchImpl, calls, headers } = fakeMcpFetch({
      create_project: () => ({
        content: [{ type: 'text', text: JSON.stringify({ project_id: 'proj_1' }) }],
      }),
      list_files: () => ({
        content: [{ type: 'text', text: JSON.stringify({ files: [{ path: 'src/App.tsx' }, { path: 'index.html' }] }) }],
      }),
      read_file: (args) => ({
        content: [{ type: 'text', text: `// ${String(args['path'])}` }],
      }),
      deploy_project: () => ({
        content: [{ type: 'text', text: JSON.stringify({ url: 'https://proj-1.lovable.app' }) }],
      }),
    });
    const client = adapter(tokenStore(), fetchImpl);

    const created = await client.createProject({ prompt: 'Build a storefront' });
    expect(created.projectId).toBe('proj_1');

    const files = await client.listFiles('proj_1');
    expect(files).toEqual(['src/App.tsx', 'index.html']);

    const text = await client.readFile('proj_1', 'src/App.tsx');
    expect(text).toContain('src/App.tsx');

    const deployed = await client.deployProject('proj_1');
    expect(deployed.url).toBe('https://proj-1.lovable.app');

    expect(calls.map((c) => c.name)).toEqual([
      'create_project',
      'list_files',
      'read_file',
      'deploy_project',
    ]);
    expect(calls[0]?.args).toMatchObject({ initial_message: 'Build a storefront' });
    expect(calls[2]?.args).toMatchObject({ project_id: 'proj_1', path: 'src/App.tsx' });
    for (const hdr of headers) {
      expect(hdr.get('authorization')).toBe('Bearer not-a-live-token');
      expect(hdr.get('lovable-api-key')).toBeNull();
    }
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
