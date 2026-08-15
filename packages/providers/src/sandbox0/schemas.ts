/**
 * Sandbox0 envelopes.
 *
 * List/claim/exec responses are wrapped in `{ data: ... }` on the public
 * `/api/v1` surface this adapter calls. Extra fields are accepted so a catalog
 * expansion does not fail a probe.
 */

import { z } from 'zod';

export const SANDBOX0_PREVIEW_TTL_MIN = 30;
export const SANDBOX0_PREVIEW_TTL_MAX = 86_400;
export const SANDBOX0_QUOTA_EXCEEDED = 'quota_exceeded';

const UnknownRecord = z.record(z.string(), z.unknown());

export const Sandbox0Sandbox = z
  .object({
    id: z.string(),
    status: z.string().optional(),
    paused: z.boolean().optional(),
    ttl: z.number().optional(),
    metadata: UnknownRecord.optional(),
    sandbox_id: z.string().optional(),
  })
  .passthrough();
export type Sandbox0Sandbox = z.infer<typeof Sandbox0Sandbox>;
export type Sandbox0SandboxSummary = Sandbox0Sandbox;

export const Sandbox0SandboxList = z.union([
  z.object({ sandboxes: z.array(Sandbox0Sandbox).optional(), items: z.array(Sandbox0Sandbox).optional() }).passthrough(),
  z.array(Sandbox0Sandbox),
]);

export const Sandbox0SandboxListEnvelope = z
  .object({
    data: z
      .object({
        sandboxes: z.array(Sandbox0Sandbox).default([]),
        has_more: z.boolean().optional(),
      })
      .passthrough(),
  })
  .passthrough();
export type Sandbox0SandboxListEnvelope = z.infer<typeof Sandbox0SandboxListEnvelope>;

export const Sandbox0SandboxEnvelope = z.object({ data: Sandbox0Sandbox }).passthrough();
export type Sandbox0SandboxEnvelope = z.infer<typeof Sandbox0SandboxEnvelope>;

export const Sandbox0Claim = z
  .object({
    sandbox_id: z.string(),
    status: z.string().optional(),
    id: z.string().optional(),
  })
  .passthrough();
export type Sandbox0Claim = z.infer<typeof Sandbox0Claim>;
export const Sandbox0ClaimEnvelope = z.object({ data: Sandbox0Claim }).passthrough();

export const Sandbox0Context = z
  .object({
    id: z.string(),
    sandbox_id: z.string().optional(),
    output_raw: z.string().optional(),
    stdout: z.string().optional(),
    stderr: z.string().optional(),
    exit_code: z.number().optional(),
    state: z.string().optional(),
  })
  .passthrough();
export type Sandbox0Context = z.infer<typeof Sandbox0Context>;
export const Sandbox0ContextEnvelope = z.object({ data: Sandbox0Context }).passthrough();

export const Sandbox0ExecResult = z.object({
  stdout: z.string().optional(),
  stderr: z.string().optional(),
  output_raw: z.string().optional(),
  exit_code: z.number().optional(),
  state: z.string().optional(),
});
export type Sandbox0ExecResult = z.infer<typeof Sandbox0ExecResult>;
export const Sandbox0ExecResultEnvelope = z.object({ data: Sandbox0ExecResult }).passthrough();

export const Sandbox0FileInfo = z
  .object({
    path: z.string().optional(),
    name: z.string().optional(),
  })
  .passthrough();
export type Sandbox0FileInfo = z.infer<typeof Sandbox0FileInfo>;

export const Sandbox0FileListEnvelope = z
  .object({
    data: z
      .object({
        entries: z.array(Sandbox0FileInfo).optional(),
      })
      .passthrough(),
  })
  .passthrough();

export const Sandbox0FileContent = z
  .object({
    path: z.string().optional(),
    content: z.string().optional(),
    encoding: z.string().optional(),
  })
  .passthrough();
export type Sandbox0FileContent = z.infer<typeof Sandbox0FileContent>;
export const Sandbox0FileContentEnvelope = z.object({ data: Sandbox0FileContent }).passthrough();

export const Sandbox0NetworkPolicy = UnknownRecord;
export type Sandbox0NetworkPolicy = z.infer<typeof Sandbox0NetworkPolicy>;
export const Sandbox0NetworkPolicyEnvelope = z.object({ data: UnknownRecord }).passthrough();

export const Sandbox0Preview = z
  .object({
    url: z.string().optional(),
    hostname: z.string().optional(),
  })
  .passthrough();
export type Sandbox0Preview = z.infer<typeof Sandbox0Preview>;
export const Sandbox0PreviewEnvelope = z.object({ data: Sandbox0Preview }).passthrough();

export const Sandbox0Refresh = z
  .object({
    sandbox_id: z.string().optional(),
    status: z.string().optional(),
  })
  .passthrough();
export type Sandbox0Refresh = z.infer<typeof Sandbox0Refresh>;
export const Sandbox0RefreshEnvelope = z.object({ data: Sandbox0Refresh }).passthrough();

/**
 * `POST /api/v1/sandboxes/{id}/pause` live 200 (2026-08-15): `paused: false`
 * and `status: running`. HTTP 200 is not `paused: true`.
 */
export const Sandbox0Pause = z
  .object({
    sandbox_id: z.string().optional(),
    paused: z.boolean().optional(),
    status: z.string().optional(),
  })
  .passthrough();
export type Sandbox0Pause = z.infer<typeof Sandbox0Pause>;
export const Sandbox0PauseEnvelope = z.object({ data: Sandbox0Pause }).passthrough();

/** `POST /api/v1/sandboxes/{id}/resume` live 200 (2026-08-15). */
export const Sandbox0Resume = z
  .object({
    sandbox_id: z.string().optional(),
    resumed: z.boolean().optional(),
    status: z.string().optional(),
  })
  .passthrough();
export type Sandbox0Resume = z.infer<typeof Sandbox0Resume>;
export const Sandbox0ResumeEnvelope = z.object({ data: Sandbox0Resume }).passthrough();

export const Sandbox0WebhookEvent = z.unknown();
export type Sandbox0WebhookEvent = z.infer<typeof Sandbox0WebhookEvent>;

export function sandboxesOf(body: z.infer<typeof Sandbox0SandboxList>): readonly Sandbox0Sandbox[] {
  if (Array.isArray(body)) return body;
  return body.sandboxes ?? body.items ?? [];
}

export function agentRunIdOf(metadata: unknown): string | undefined {
  if (!metadata || typeof metadata !== 'object') return undefined;
  const value = (metadata as Record<string, unknown>)['agent_run_id'];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function extractSandbox0ErrorCode(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const rec = body as Record<string, unknown>;
  const error = rec['error'];
  if (typeof rec['code'] === 'string') return rec['code'];
  if (error && typeof error === 'object' && typeof (error as Record<string, unknown>)['code'] === 'string') {
    return (error as Record<string, unknown>)['code'] as string;
  }
  return undefined;
}

export function extractSandbox0ErrorMessage(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const rec = body as Record<string, unknown>;
  if (typeof rec['message'] === 'string') return rec['message'];
  const error = rec['error'];
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object' && typeof (error as Record<string, unknown>)['message'] === 'string') {
    return (error as Record<string, unknown>)['message'] as string;
  }
  return undefined;
}
