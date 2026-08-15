/**
 * Lovable adapter — programmatic storefront generation via MCP.
 *
 * There is no REST API. The documented surface is the streamable-HTTP MCP
 * server at https://mcp.lovable.dev, OAuth 2.1 only, allowlisted clients.
 * This adapter requires an operator-exported access token. Until that token
 * exists, every method raises CredentialsMissingError naming
 * LOVABLE_OAUTH_ACCESS_TOKEN — which is the correct production state, not a
 * gap to paper over with a screenshot generator.
 *
 * Generated code is exported (list_files / read_file) and deployed on Render.
 * Lovable preview URLs are not production hosting.
 */

import { ProviderContractError } from '@foundry/core';
import { ProviderAdapter, type AdapterContext, type ProbeResult } from '../http/adapter.js';
import { verifyLovableSignature, type VerificationInput, type VerificationResult } from '../http/webhook-verify.js';
import { LOVABLE_MANIFEST, SECRETS } from '../manifests.js';
import { LovableMcpClient } from './mcp-client.js';

export { LovableMcpClient, parseMcpBody, buildToolsCall, parseSseJsonRpc, LOVABLE_MCP_ENDPOINT } from './mcp-client.js';

export interface LovableProject {
  readonly projectId: string;
  readonly raw: unknown;
}

export class LovableAdapter extends ProviderAdapter {
  override readonly manifest = LOVABLE_MANIFEST;
  #mcp: LovableMcpClient | undefined;

  constructor(ctx: AdapterContext) {
    super(ctx);
  }

  #client(): LovableMcpClient {
    if (!this.#mcp) {
      const token = this.requireSecret(SECRETS.lovableOauthToken);
      this.#mcp = new LovableMcpClient(this.baseUrl(), token.reveal());
    }
    return this.#mcp;
  }

  override async probe(): Promise<ProbeResult> {
    const result = await this.#client().callTool('get_me');
    if (result.isError) {
      return {
        succeeded: false,
        detail: 'MCP get_me returned isError=true',
        evidence: { tool: 'get_me', content: result.content },
      };
    }
    return {
      succeeded: true,
      detail: 'MCP tools/call get_me succeeded',
      evidence: { tool: 'get_me', content: summarise(result.content) },
    };
  }

  async createProject(input: {
    name?: string;
    prompt?: string;
    initialMessage?: string;
    workspaceId?: string;
    idempotencyKey?: string;
  }): Promise<LovableProject> {
    this.assertActivated();
    const prompt = input.prompt ?? input.initialMessage;
    if (!prompt) {
      throw new ProviderContractError('lovable', 'create_project requires prompt or initialMessage');
    }
    const result = await this.#client().callTool('create_project', {
      initial_message: prompt,
      ...(input.name ? { name: input.name } : {}),
      ...(input.workspaceId ? { workspace_id: input.workspaceId } : {}),
    });
    this.#throwIfToolError('create_project', result.isError, result.content);
    const projectId = extractId(result.content);
    if (!projectId) {
      throw new ProviderContractError('lovable', 'create_project did not return a project id', {
        content: summarise(result.content),
      });
    }
    return { projectId, raw: result.content };
  }

  async sendMessage(projectId: string, text: string): Promise<unknown> {
    this.assertActivated();
    const result = await this.#client().callTool('send_message', { project_id: projectId, message: text, text });
    this.#throwIfToolError('send_message', result.isError, result.content);
    return result.content;
  }

  async listFiles(projectId: string): Promise<readonly string[]> {
    this.assertActivated();
    const result = await this.#client().callTool('list_files', { project_id: projectId });
    this.#throwIfToolError('list_files', result.isError, result.content);
    return extractFilePaths(result.content);
  }

  async readFile(projectId: string, path: string): Promise<string> {
    this.assertActivated();
    const result = await this.#client().callTool('read_file', { project_id: projectId, path });
    this.#throwIfToolError('read_file', result.isError, result.content);
    const text = extractText(result.content);
    if (text === null) {
      throw new ProviderContractError('lovable', `read_file returned no text for ${path}`);
    }
    return text;
  }

  async deployProject(projectId: string): Promise<{ url: string | null; raw: unknown }> {
    this.assertActivated();
    const result = await this.#client().callTool('deploy_project', { project_id: projectId });
    this.#throwIfToolError('deploy_project', result.isError, result.content);
    return { url: extractUrl(result.content), raw: result.content };
  }

  verifyWebhook(input: VerificationInput): VerificationResult {
    const secret = this.requireSecret(SECRETS.lovableWebhookSecret);
    return verifyLovableSignature({ ...input, secret });
  }

  #throwIfToolError(tool: string, isError: boolean, content: unknown): void {
    if (!isError) return;
    throw new ProviderContractError('lovable', `MCP tool ${tool} returned isError`, {
      tool,
      content: summarise(content),
    });
  }
}

function summarise(value: unknown): unknown {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (!text) return value;
  return text.length > 800 ? `${text.slice(0, 800)}…` : value;
}

function extractId(content: unknown): string | null {
  if (!content || typeof content !== 'object') return null;
  const record = content as Record<string, unknown>;
  for (const key of ['project_id', 'projectId', 'id']) {
    if (typeof record[key] === 'string') return record[key] as string;
  }
  if (Array.isArray(record['content'])) {
    for (const block of record['content']) {
      if (block && typeof block === 'object' && 'text' in block) {
        const found = extractId(tryParse((block as { text: unknown }).text));
        if (found) return found;
      }
    }
  }
  return null;
}

function extractFilePaths(content: unknown): readonly string[] {
  if (Array.isArray(content) && content.every((x) => typeof x === 'string')) return content;
  if (content && typeof content === 'object' && Array.isArray((content as { files?: unknown }).files)) {
    return ((content as { files: unknown[] }).files).filter((x): x is string => typeof x === 'string');
  }
  const text = extractText(content);
  if (!text) return [];
  try {
    const parsed = JSON.parse(text) as unknown;
    return extractFilePaths(parsed);
  } catch {
    return text.split('\n').map((l) => l.trim()).filter(Boolean);
  }
}

function extractText(content: unknown): string | null {
  if (typeof content === 'string') return content;
  if (content && typeof content === 'object' && Array.isArray((content as { content?: unknown }).content)) {
    const parts = (content as { content: Array<{ text?: string }> }).content
      .map((b) => b.text)
      .filter((t): t is string => typeof t === 'string');
    if (parts.length > 0) return parts.join('\n');
  }
  return null;
}

function extractUrl(content: unknown): string | null {
  const text = extractText(content) ?? JSON.stringify(content);
  const match = text.match(/https?:\/\/[^\s"'<>]+/);
  return match?.[0] ?? null;
}

function tryParse(text: unknown): unknown {
  if (typeof text !== 'string') return text;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { text };
  }
}
