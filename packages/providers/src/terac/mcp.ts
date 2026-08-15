/**
 * Terac MCP client — streamable HTTP at https://terac.com/api/mcp.
 *
 * Hackathon submission requires using the Terac MCP, not only REST. Chat
 * clients authenticate with OAuth; this worker uses the same `TERAC_API_KEY`
 * as Bearer because that is the credential Terac issued for programmatic
 * access. If the MCP server rejects API-key auth, the call fails honestly
 * rather than falling through to a fake "MCP succeeded" flag.
 *
 * Tool names are taken from terac.com/mcp: terac_list_opportunities,
 * terac_request_feasibility, terac_get_feasibility_request,
 * terac_launch_draft_opportunity, terac_get_submissions, terac_get_context,
 * terac_pause_opportunity.
 */

import { ProviderContractError, ProviderUnavailableError } from '@foundry/core';
import { z } from 'zod';

export const TERAC_MCP_URL = 'https://terac.com/api/mcp';

export const TERAC_MCP_TOOLS = [
  'terac_list_opportunities',
  'terac_request_feasibility',
  'terac_get_feasibility_request',
  'terac_launch_draft_opportunity',
  'terac_get_submissions',
  'terac_get_context',
  'terac_pause_opportunity',
] as const;

export type TeracMcpTool = (typeof TERAC_MCP_TOOLS)[number];

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

export interface TeracMcpToolResult {
  readonly content: unknown;
  readonly isError: boolean;
}

export class TeracMcpClient {
  #sessionId: string | undefined;
  #nextId = 1;
  #initialized = false;

  constructor(
    private readonly endpoint: string,
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
  ) {}

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

  async callTool(name: TeracMcpTool | string, args: Record<string, unknown> = {}): Promise<TeracMcpToolResult> {
    if (!this.#initialized) await this.initialize();
    const result = await this.#rpc('tools/call', { name, arguments: args });
    const record = result && typeof result === 'object' ? (result as Record<string, unknown>) : {};
    return {
      content: record['content'] ?? result,
      isError: record['isError'] === true,
    };
  }

  async #notify(method: string, params: Record<string, unknown>): Promise<void> {
    await this.#post({ jsonrpc: '2.0', method, params }, false);
  }

  async #rpc(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = this.#nextId++;
    const body = await this.#post({ jsonrpc: '2.0', id, method, params }, true);
    const parsed = JsonRpcResponse.safeParse(body);
    if (!parsed.success) {
      throw new ProviderContractError('terac', `MCP ${method} response was not JSON-RPC`, {
        issues: parsed.error.issues.slice(0, 5),
      });
    }
    if (parsed.data.error) {
      throw new ProviderUnavailableError('terac', `MCP ${method}: ${parsed.data.error.message}`, {
        code: parsed.data.error.code,
        method,
      });
    }
    return parsed.data.result;
  }

  async #post(payload: Record<string, unknown>, expectResult: boolean): Promise<unknown> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.apiKey}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2025-03-26',
    };
    if (this.#sessionId) headers['mcp-session-id'] = this.#sessionId;

    const response = await this.fetchImpl(this.endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });

    const session = response.headers.get('mcp-session-id');
    if (session) this.#sessionId = session;

    const text = await response.text();
    if (!response.ok) {
      throw new ProviderUnavailableError('terac', `MCP HTTP ${response.status}`, {
        status: response.status,
        body: text.slice(0, 500),
      });
    }
    if (!expectResult) return null;
    return parseMcpBody(text, response.headers.get('content-type'));
  }
}

function parseMcpBody(text: string, contentType: string | null): unknown {
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
