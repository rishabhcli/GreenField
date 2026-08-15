/**
 * Zod schemas for the Solari objects we consume.
 *
 * Solari's docs (docs.getsolari.com, verified 2026-08-14 per
 * `docs/research/SPONSOR_API_RESEARCH.md` §12) name the response fields for
 * session/sandbox/desktop *creation* explicitly, so those are typed exactly as
 * documented. Everywhere the docs describe an endpoint by name only, with no
 * example payload at all — `POST /sandboxes/:id/exec`, `GET
 * /sessions/:id/replay-url`, the profiles resource, `/metrics`, snapshots —
 * the schema is left deliberately open (`.passthrough()` / open records)
 * rather than inventing field names, following the same discipline as
 * `../terac/schemas.ts`.
 */

import { z } from 'zod';

/* -------------------------------------------------------------------------- */
/* Browser sessions                                                            */
/* -------------------------------------------------------------------------- */

/**
 * `POST /sessions` response. Fields directly named in the docs: `sessionId`,
 * `wsEndpoint`, `cdpEndpoint`, `expiresAt`, `storageStateUrl`.
 */
export const SolariBrowserSession = z
  .object({
    sessionId: z.string(),
    wsEndpoint: z.string().nullish(),
    cdpEndpoint: z.string().nullish(),
    expiresAt: z.string().nullish(),
    storageStateUrl: z.string().nullish(),
  })
  .passthrough();
export type SolariBrowserSession = z.infer<typeof SolariBrowserSession>;

/**
 * `GET /sessions/:id/replay-url` response shape is UNVERIFIED — the docs name
 * the endpoint and its precondition (recording must have been on) but never
 * show a sample payload. Every plausible key is accepted; `getReplayUrl` in
 * `index.ts` picks whichever is present and fails loudly if none is, rather
 * than fabricating a URL.
 */
export const SolariReplayUrlResponse = z
  .object({
    replayUrl: z.string().nullish(),
    replay_url: z.string().nullish(),
    url: z.string().nullish(),
  })
  .passthrough();
export type SolariReplayUrlResponse = z.infer<typeof SolariReplayUrlResponse>;

/* -------------------------------------------------------------------------- */
/* Sandboxes                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * `POST /sandboxes` response. Fields directly named in the docs: `sandboxId`,
 * `controlUrl`, `expiresAt`, `streamUrl`, `recordingUrl`.
 */
export const SolariSandbox = z
  .object({
    sandboxId: z.string(),
    controlUrl: z.string().nullish(),
    expiresAt: z.string().nullish(),
    streamUrl: z.string().nullish(),
    recordingUrl: z.string().nullish(),
  })
  .passthrough();
export type SolariSandbox = z.infer<typeof SolariSandbox>;

/**
 * `POST /sandboxes/:id/exec` has no documented request or response shape at
 * all — contrast Sandbox0 (`output_raw, stdout, stderr, exit_code, state`) and
 * Superserve (`stdout, stderr, exit_code, truncated`), whose docs list exact
 * fields. Both directions are therefore left as open records; see
 * `execInSandbox` in `index.ts` for what minimal shape this adapter imposes
 * (and why) on top of that.
 */
export const SolariExecResult = z.record(z.string(), z.unknown());
export type SolariExecResult = z.infer<typeof SolariExecResult>;

/** `GET /sandboxes/:id/metrics` — no documented shape. */
export const SolariSandboxMetrics = z.record(z.string(), z.unknown());
export type SolariSandboxMetrics = z.infer<typeof SolariSandboxMetrics>;

/** `POST /sandboxes/:id/snapshots` and `/snapshots/:id/promote` — id field name UNVERIFIED. */
export const SolariSnapshot = z
  .object({
    snapshotId: z.string().nullish(),
    id: z.string().nullish(),
  })
  .passthrough();
export type SolariSnapshot = z.infer<typeof SolariSnapshot>;

/* -------------------------------------------------------------------------- */
/* Desktops                                                                    */
/* -------------------------------------------------------------------------- */

/** `POST /desktops` response. Fields directly named: `sessionId`, `streamUrl`, `controlUrl`. */
export const SolariDesktop = z
  .object({
    sessionId: z.string(),
    streamUrl: z.string().nullish(),
    controlUrl: z.string().nullish(),
  })
  .passthrough();
export type SolariDesktop = z.infer<typeof SolariDesktop>;

/* -------------------------------------------------------------------------- */
/* Profiles                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The docs show only the SDK call site `client.profiles.create({name})`, not
 * a REST path or a response shape. `id`/`profileId` are both accepted since
 * the wire field name is UNVERIFIED — see `profileCreatePath` in `index.ts`.
 */
export const SolariProfile = z
  .object({
    id: z.string().nullish(),
    profileId: z.string().nullish(),
    name: z.string().nullish(),
  })
  .passthrough();
export type SolariProfile = z.infer<typeof SolariProfile>;
