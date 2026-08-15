/**
 * Zod schemas for Superserve sandbox objects.
 *
 * Verified against `docs.superserve.ai` (sandboxes/create-a-new-sandbox,
 * sandbox/lifecycle) and the OpenAPI spec at
 * `github.com/superserve-ai/sandbox` on 2026-08-14 — see
 * `docs/research/SPONSOR_API_RESEARCH.md` section 7. The create-response
 * field list is given verbatim in the docs (`id`, `status`, `vcpu_count`,
 * `memory_mib`, `access_token`); the PATCH-able field allowlist for an
 * existing sandbox is never enumerated, so `updateSandbox` in `index.ts`
 * accepts the same shape as create minus identity/one-shot fields, flagged
 * there rather than here.
 */

import { z } from 'zod';

/* -------------------------------------------------------------------------- */
/* Sandboxes                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Documented values. Exported separately rather than baked into a strict zod
 * enum on the schema itself: this API publishes no numeric rate limits and
 * reads as actively evolving, so a transitional status value showing up
 * before the docs mention it must not turn a whole response into a
 * `ProviderContractError`. Callers that want to switch on status still have
 * this list to compare against.
 */
export const SUPERSERVE_SANDBOX_STATUSES = ['active', 'paused', 'resuming'] as const;
export type SuperserveSandboxStatus = (typeof SUPERSERVE_SANDBOX_STATUSES)[number];

export const SuperservePreviewAccess = z.enum(['public', 'private']);

export const SuperserveSandbox = z
  .object({
    id: z.string(),
    name: z.string().nullish(),
    status: z.string(), // see SUPERSERVE_SANDBOX_STATUSES for the documented values
    from_template: z.string().nullish(),
    vcpu_count: z.number().nullish(),
    memory_mib: z.number().nullish(),
    /**
     * Documented on the create and resume responses only. GET is never shown
     * returning it, so the adapter never assumes it does — `#cacheTokenIfPresent`
     * treats absence as normal, not a contract violation.
     */
    access_token: z.string().nullish(),
    timeout_seconds: z.number().nullish(),
    auto_delete_seconds: z.number().nullish(),
    preview_access: SuperservePreviewAccess.nullish(),
    metadata: z.record(z.string(), z.unknown()).nullish(),
    created_at: z.string().nullish(),
    updated_at: z.string().nullish(),
  })
  .passthrough();
export type SuperserveSandbox = z.infer<typeof SuperserveSandbox>;

/**
 * The list envelope shape is UNVERIFIED — no example payload is shown for
 * `GET /sandboxes`. Accepts a bare array or an `{items:[]}`/`{data:[]}`
 * envelope (the two shapes seen elsewhere in this codebase for undocumented
 * list responses) rather than committing to one.
 */
export const SuperserveSandboxList = z.union([
  z.array(SuperserveSandbox),
  z.object({ items: z.array(SuperserveSandbox).optional(), data: z.array(SuperserveSandbox).optional() }).passthrough(),
]);
export function sandboxesOf(list: z.infer<typeof SuperserveSandboxList>): readonly SuperserveSandbox[] {
  if (Array.isArray(list)) return list;
  return list.items ?? list.data ?? [];
}

/* -------------------------------------------------------------------------- */
/* Exec (data plane)                                                           */
/* -------------------------------------------------------------------------- */

export const SuperserveExecResult = z
  .object({
    stdout: z.string().nullish(),
    stderr: z.string().nullish(),
    exit_code: z.number().nullish(),
    truncated: z.boolean().nullish(),
  })
  .passthrough();
export type SuperserveExecResult = z.infer<typeof SuperserveExecResult>;

/* -------------------------------------------------------------------------- */
/* Secondary resources                                                        */
/* -------------------------------------------------------------------------- */

/** "egress log" is the only description given; shape entirely undocumented. */
export const SuperserveNetworkLog = z.record(z.string(), z.unknown());

export const SuperservePreviewPort = z
  .object({
    port: z.number().nullish(),
    protocol: z.string().nullish(),
    url: z.string().nullish(),
  })
  .passthrough();
export type SuperservePreviewPort = z.infer<typeof SuperservePreviewPort>;

export const SuperservePreviewPortList = z.union([
  z.array(SuperservePreviewPort),
  z.object({ items: z.array(SuperservePreviewPort).optional() }).passthrough(),
]);
export function previewPortsOf(list: z.infer<typeof SuperservePreviewPortList>): readonly SuperservePreviewPort[] {
  return Array.isArray(list) ? list : (list.items ?? []);
}

export const SuperserveFileEntry = z
  .object({ path: z.string(), size: z.number().nullish(), is_dir: z.boolean().nullish() })
  .passthrough();
export type SuperserveFileEntry = z.infer<typeof SuperserveFileEntry>;

export const SuperserveFileList = z.union([
  z.array(SuperserveFileEntry),
  z.object({ items: z.array(SuperserveFileEntry).optional() }).passthrough(),
]);
export function filesOf(list: z.infer<typeof SuperserveFileList>): readonly SuperserveFileEntry[] {
  return Array.isArray(list) ? list : (list.items ?? []);
}

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

/** The four documented error codes. The envelope shape carrying them is UNVERIFIED. */
export const SUPERSERVE_ERROR_CODES = [
  'rate_limited',
  'too_many_sandboxes',
  'too_many_builds',
  'too_many_templates',
] as const;

/** Tries `{code}` and `{error:{code}}` — the two shapes this codebase sees elsewhere for undocumented error envelopes. */
export function extractSuperserveErrorCode(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const root = body as Record<string, unknown>;
  if (typeof root.code === 'string') return root.code;
  const nested = root.error;
  if (nested && typeof nested === 'object' && typeof (nested as Record<string, unknown>).code === 'string') {
    return (nested as Record<string, unknown>).code as string;
  }
  return undefined;
}

export function extractSuperserveErrorMessage(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const root = body as Record<string, unknown>;
  if (typeof root.message === 'string') return root.message;
  const nested = root.error;
  if (nested && typeof nested === 'object' && typeof (nested as Record<string, unknown>).message === 'string') {
    return (nested as Record<string, unknown>).message as string;
  }
  return undefined;
}
