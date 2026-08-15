/**
 * Streamable-HTTP MCP client for Lovable.
 *
 * Lovable has no REST API. The only programmatic surface is
 * `https://mcp.lovable.dev` over streamable HTTP, OAuth 2.1, restricted to an
 * allowlist of first-party chat clients. A Render worker cannot mint that
 * token unattended; an operator must complete the browser flow and store the
 * access token as LOVABLE_OAUTH_ACCESS_TOKEN.
 *
 * Responses may be JSON or SSE (`text/event-stream`). Both are parsed here.
 * Session id, when the server sends `mcp-session-id`, is replayed on later
 * calls in the same adapter instance.
 */

import { ProviderAuthError, ProviderContractError, ProviderUnavailableError, type Secret } from '@foundry/core';
import { z } from 'zod';

export const LOVABLE_MCP_ENDPOINT = 'https://mcp.lovable.dev';

const JsonRpcResponse = z.object({
  jsonrpc: z.literal('2.0').optional(),
  id: z.union([z.string(), z.number()]).optional(),
  result: z.unknown().optional(),
  error: z
    .object({
      code: z.number(),
      message: z.string(),
      data: z.unknown().optional(),
    })
    .optional(),
});

export interface McpToolCallResult {
  readonly content: unknown;
  readonly isError: boolean;
}

export function buildToolsCall(
  name: string,
  args: Record<string, unknown>,
  id: string | number,
): Record<string, unknown> {
  return {
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: { name, arguments: args },
  };
}

export function parseSseJsonRpc(text: string): unknown[] {
  const frames: unknown[] = [];
  for (const block of text.split(/\n\n+/)) {
    const data = block
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
      .filter((line) => line.length > 0 && line !== '[DONE]')
      .join('');
    if (!data) continue;
    frames.push(JSON.parse(data) as unknown);
  }
  return frames;
}

export class LovableMcpClient {
  #sessionId: string | undefined;
  #nextId = 1;
  #initialized = false;
  readonly #endpoint: string;
  readonly #accessToken: string;
  readonly #fetchImpl: typeof fetch;

  constructor(
    endpointOrOpts: string | { accessToken: Secret; fetchImpl?: typeof fetch; endpoint?: string },
    accessToken?: string,
    fetchImpl?: typeof fetch,
  ) {
    if (typeof endpointOrOpts === 'string') {
      this.#endpoint = endpointOrOpts;
      this.#accessToken = accessToken ?? '';
      this.#fetchImpl = fetchImpl ?? globalThis.fetch;
    } else {
      this.#endpoint = endpointOrOpts.endpoint ?? LOVABLE_MCP_ENDPOINT;
      this.#accessToken = endpointOrOpts.accessToken.reveal();
      this.#fetchImpl = endpointOrOpts.fetchImpl ?? globalThis.fetch;
    }
  }

  get initialized(): boolean {
    return this.#initialized;
  }

  async initialize(): Promise<Record<string, unknown>> {
    const result = await this.#rpc('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'foundry-autonomous-company', version: '0.1.0' },
    });
    await this.#notify('notifications/initialized', {});
    this.#initialized = true;
    return (result as Record<string, unknown> | undefined) ?? {};
  }

  async listTools(): Promise<unknown> {
    if (!this.#initialized) await this.initialize();
    return this.#rpc('tools/list', {});
  }

  async callTool(name: string, args: Record<string, unknown> = {}): Promise<McpToolCallResult> {
    if (!this.#initialized) await this.initialize();
    const result = await this.#rpc('tools/call', { name, arguments: args });
    const record = result && typeof result === 'object' ? (result as Record<string, unknown>) : {};
    return {
      content: record['content'] ?? result,
      isError: record['isError'] === true,
    };
  }

  async post(payload: Record<string, unknown>, _meta?: { operation?: string }): Promise<unknown> {
    return this.#post(payload, true);
  }

  async #notify(method: string, params: Record<string, unknown>): Promise<void> {
    await this.#post({ jsonrpc: '2.0', method, params }, false);
  }

  async #rpc(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = this.#nextId++;
    const body = await this.#post({ jsonrpc: '2.0', id, method, params }, true);
    const parsed = JsonRpcResponse.safeParse(body);
    if (!parsed.success) {
      throw new ProviderContractError('lovable', `MCP ${method} response was not JSON-RPC`, {
        issues: parsed.error.issues.slice(0, 5),
      });
    }
    if (parsed.data.error) {
      throw new ProviderUnavailableError('lovable', `MCP ${method}: ${parsed.data.error.message}`, {
        code: parsed.data.error.code,
        method,
      });
    }
    return parsed.data.result;
  }

  async #post(payload: Record<string, unknown>, expectResult: boolean): Promise<unknown> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.#accessToken}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2025-03-26',
    };
    if (this.#sessionId) headers['mcp-session-id'] = this.#sessionId;

    const response = await this.#fetchImpl(this.#endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });

    const session = response.headers.get('mcp-session-id');
    if (session) this.#sessionId = session;

    const text = await response.text();
    if (response.status === 401 || response.status === 403) {
      throw new ProviderAuthError(
        'lovable',
        'OAuth token rejected. The Lovable MCP server is allowlisted to first-party clients; complete the browser OAuth flow from an allowlisted client and store LOVABLE_OAUTH_ACCESS_TOKEN.',
        { status: response.status, wwwAuthenticate: response.headers.get('www-authenticate') },
      );
    }
    if (!response.ok) {
      throw new ProviderUnavailableError('lovable', `MCP HTTP ${response.status}`, {
        status: response.status,
        body: text.slice(0, 500),
      });
    }
    if (!expectResult) return null;
    return parseMcpBody(text, response.headers.get('content-type'));
  }
}

export function parseMcpBody(text: string, contentType: string | null): unknown {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (contentType?.includes('text/event-stream') || trimmed.startsWith('event:') || trimmed.includes('\ndata:')) {
    const dataLines = trimmed
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
      .filter((line) => line.length > 0 && line !== '[DONE]');
    const last = dataLines.at(-1);
    if (!last) return null;
    return JSON.parse(last) as unknown;
  }
  return JSON.parse(trimmed) as unknown;
}
