/**
 * Conservative Zod schemas for Lovable MCP tool payloads.
 *
 * Tool *names* are verified (docs.lovable.dev/integrations/lovable-mcp-server,
 * 2026-08-15). Per-tool JSON response shapes are UNVERIFIED — Lovable publishes
 * no REST schema and the MCP skill lists parameters, not wire objects. Every
 * object below therefore:
 *   - requires nothing we have not seen on the wire;
 *   - accepts both snake_case and camelCase aliases that appear in the skill
 *     (`project_id` vs `projectId`);
 *   - `.passthrough()`s unknown fields so a live payload cannot fail a
 *     contract check solely because Lovable added a key.
 *
 * Do not tighten these schemas from guesswork. A real `tools/call` response
 * is the only thing that may add required fields.
 */

import { z } from 'zod';

/** Open record used when we only know "this is a JSON object". */
export const UnknownRecord = z.object({}).passthrough();
export type UnknownRecord = z.infer<typeof UnknownRecord>;

/* -------------------------------------------------------------------------- */
/* Identity                                                                    */
/* -------------------------------------------------------------------------- */

export const LovableIdentity = z
  .object({
    id: z.string().nullish(),
    user_id: z.string().nullish(),
    userId: z.string().nullish(),
    email: z.string().nullish(),
    name: z.string().nullish(),
    workspaces: z.unknown().optional(),
  })
  .passthrough();
export type LovableIdentity = z.infer<typeof LovableIdentity>;

export const LovableWorkspace = z
  .object({
    id: z.string().nullish(),
    workspace_id: z.string().nullish(),
    workspaceId: z.string().nullish(),
    name: z.string().nullish(),
    plan: z.string().nullish(),
  })
  .passthrough();
export type LovableWorkspace = z.infer<typeof LovableWorkspace>;

/* -------------------------------------------------------------------------- */
/* Projects                                                                    */
/* -------------------------------------------------------------------------- */

export const LovableProject = z
  .object({
    id: z.string().nullish(),
    project_id: z.string().nullish(),
    projectId: z.string().nullish(),
    name: z.string().nullish(),
    workspace_id: z.string().nullish(),
    workspaceId: z.string().nullish(),
    preview_url: z.string().nullish(),
    previewUrl: z.string().nullish(),
    editor_url: z.string().nullish(),
    editorUrl: z.string().nullish(),
    live_url: z.string().nullish(),
    liveUrl: z.string().nullish(),
    url: z.string().nullish(),
    published_url: z.string().nullish(),
    publishedUrl: z.string().nullish(),
    // README: read_file needs a git ref; get_project is described as the source
    // of `latest_commit_sha`. Field name UNVERIFIED beyond that mention.
    latest_commit_sha: z.string().nullish(),
    latestCommitSha: z.string().nullish(),
  })
  .passthrough();
export type LovableProject = z.infer<typeof LovableProject>;

/**
 * `create_project` may return a project id, or a documented `WAITING` payload
 * listing `available_workspaces` when more than one workspace is eligible.
 * Skill.md also mentions `deduplicated: true` on a short retry window —
 * UNVERIFIED, and we do not treat it as an idempotency mechanism.
 */
export const LovableCreateProjectResult = z
  .object({
    id: z.string().nullish(),
    project_id: z.string().nullish(),
    projectId: z.string().nullish(),
    message_id: z.string().nullish(),
    messageId: z.string().nullish(),
    thread_id: z.string().nullish(),
    threadId: z.string().nullish(),
    status: z.string().nullish(),
    available_workspaces: z.unknown().optional(),
    availableWorkspaces: z.unknown().optional(),
    deduplicated: z.boolean().nullish(),
  })
  .passthrough();
export type LovableCreateProjectResult = z.infer<typeof LovableCreateProjectResult>;

export const LovableDeployResult = z
  .object({
    url: z.string().nullish(),
    live_url: z.string().nullish(),
    liveUrl: z.string().nullish(),
    published_url: z.string().nullish(),
    publishedUrl: z.string().nullish(),
    production_url: z.string().nullish(),
    productionUrl: z.string().nullish(),
    project_id: z.string().nullish(),
    projectId: z.string().nullish(),
  })
  .passthrough();
export type LovableDeployResult = z.infer<typeof LovableDeployResult>;

/* -------------------------------------------------------------------------- */
/* Agent messages                                                              */
/* -------------------------------------------------------------------------- */

export const LovableMessage = z
  .object({
    id: z.string().nullish(),
    message_id: z.string().nullish(),
    messageId: z.string().nullish(),
    thread_id: z.string().nullish(),
    threadId: z.string().nullish(),
    project_id: z.string().nullish(),
    projectId: z.string().nullish(),
    status: z.string().nullish(),
    content: z.unknown().optional(),
    text: z.string().nullish(),
  })
  .passthrough();
export type LovableMessage = z.infer<typeof LovableMessage>;

/* -------------------------------------------------------------------------- */
/* Code export                                                                 */
/* -------------------------------------------------------------------------- */

export const LovableFileEntry = z
  .object({
    path: z.string().nullish(),
    name: z.string().nullish(),
    type: z.string().nullish(),
    sha: z.string().nullish(),
    ref: z.string().nullish(),
  })
  .passthrough();
export type LovableFileEntry = z.infer<typeof LovableFileEntry>;

export const LovableFileList = z.union([
  z.array(LovableFileEntry),
  z
    .object({
      files: z.array(LovableFileEntry).optional(),
      items: z.array(LovableFileEntry).optional(),
      data: z.array(LovableFileEntry).optional(),
      pagination: z.unknown().optional(),
    })
    .passthrough(),
]);
export type LovableFileList = z.infer<typeof LovableFileList>;

export const LovableFileContents = z.union([
  z.string(),
  z
    .object({
      path: z.string().nullish(),
      content: z.string().nullish(),
      contents: z.string().nullish(),
      text: z.string().nullish(),
    })
    .passthrough(),
]);
export type LovableFileContents = z.infer<typeof LovableFileContents>;

export const LovableDiff = z.union([
  z.string(),
  z
    .object({
      diff: z.string().nullish(),
      unified_diff: z.string().nullish(),
      unifiedDiff: z.string().nullish(),
      patch: z.string().nullish(),
    })
    .passthrough(),
]);
export type LovableDiff = z.infer<typeof LovableDiff>;

/* -------------------------------------------------------------------------- */
/* Knowledge / uploads / catch-all                                             */
/* -------------------------------------------------------------------------- */

export const LovableKnowledge = z
  .object({
    content: z.string().nullish(),
    knowledge: z.string().nullish(),
    text: z.string().nullish(),
  })
  .passthrough();
export type LovableKnowledge = z.infer<typeof LovableKnowledge>;

export const LovableUploadUrl = z
  .object({
    upload_url: z.string().nullish(),
    uploadUrl: z.string().nullish(),
    url: z.string().nullish(),
    file_id: z.string().nullish(),
    fileId: z.string().nullish(),
  })
  .passthrough();
export type LovableUploadUrl = z.infer<typeof LovableUploadUrl>;

/**
 * Inbound webhook bodies. Event names are UNVERIFIED (docs never listed a
 * catalogue) so this is an open object — callers must not switch on invented
 * event type strings.
 */
export const LovableWebhookPayload = z.unknown();
export type LovableWebhookPayload = z.infer<typeof LovableWebhookPayload>;

/* -------------------------------------------------------------------------- */
/* MCP envelopes                                                               */
/* -------------------------------------------------------------------------- */

export const McpInitializeResult = z
  .object({
    protocolVersion: z.string().nullish(),
    capabilities: z.unknown().optional(),
    serverInfo: z
      .object({
        name: z.string().nullish(),
        version: z.string().nullish(),
      })
      .passthrough()
      .nullish(),
  })
  .passthrough();
export type McpInitializeResult = z.infer<typeof McpInitializeResult>;

export const McpTextContent = z
  .object({
    type: z.string(),
    text: z.string().optional(),
  })
  .passthrough();

export const McpCallToolResult = z
  .object({
    content: z.array(McpTextContent).optional(),
    structuredContent: z.unknown().optional(),
    isError: z.boolean().optional(),
  })
  .passthrough();
export type McpCallToolResult = z.infer<typeof McpCallToolResult>;

/* -------------------------------------------------------------------------- */
/* Field pickers — never invent an id that the payload did not supply          */
/* -------------------------------------------------------------------------- */

const ID_KEYS = ['id', 'project_id', 'projectId', 'workspace_id', 'workspaceId', 'message_id', 'messageId'] as const;

export function firstString(record: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

export function asRecord(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return { value };
}

export function projectIdOf(project: Record<string, unknown>): string | undefined {
  return firstString(project, ['id', 'project_id', 'projectId']);
}

export function messageIdOf(message: Record<string, unknown>): string | undefined {
  return firstString(message, ['id', 'message_id', 'messageId']);
}

export function liveUrlOf(payload: Record<string, unknown>): string | undefined {
  return firstString(payload, [
    'live_url',
    'liveUrl',
    'published_url',
    'publishedUrl',
    'production_url',
    'productionUrl',
    'url',
  ]);
}

export function gitRefOf(project: Record<string, unknown>): string | undefined {
  return firstString(project, ['latest_commit_sha', 'latestCommitSha', 'sha', 'ref']);
}

export function fileTextOf(contents: LovableFileContents): string {
  if (typeof contents === 'string') return contents;
  return firstString(contents, ['content', 'contents', 'text']) ?? '';
}

export function diffTextOf(diff: LovableDiff): string {
  if (typeof diff === 'string') return diff;
  return firstString(diff, ['diff', 'unified_diff', 'unifiedDiff', 'patch']) ?? '';
}

/**
 * Pulls an array out of the envelopes Lovable is documented to use
 * (`pagination.next_cursor` in the skill) plus the usual `items`/`data`
 * aliases. Returns an empty array only when the payload is an object with no
 * recognised list key — never fabricates entries.
 */
export function extractList(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (raw !== null && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    for (const key of [
      'items',
      'data',
      'projects',
      'files',
      'messages',
      'workspaces',
      'edits',
      'results',
      'templates',
      'design_systems',
      'designSystems',
    ]) {
      const value = obj[key];
      if (Array.isArray(value)) return value;
    }
  }
  return [];
}

export function parseWith<T>(schema: z.ZodType<T>, raw: unknown): T {
  const parsed = schema.safeParse(raw);
  if (parsed.success) return parsed.data;
  // Last resort: if the schema is an object and the payload is not, wrap it
  // so extra/unknown tool output still round-trips rather than crashing the job.
  const wrapped = schema.safeParse({ value: raw });
  if (wrapped.success) return wrapped.data;
  return raw as T;
}

/** @deprecated internal alias so call sites can document that ids were not invented. */
export const LOVABLE_ID_KEYS = ID_KEYS;
