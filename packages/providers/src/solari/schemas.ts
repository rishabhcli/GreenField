/**
 * Zod schemas for the Solari objects we consume.
 *
 * Creation fields come from docs.getsolari.com. Live probes on 2026-08-15
 * additionally pinned: `GET /sessions/:id` 200 (docs had called this route
 * dead), `POST /sandboxes/:id/exec` request `{cmd,args}` response
 * `{exitCode,stdout,stderr}`, `GET /profiles` as a bare array, and
 * `storageStateUrl` omitted on a fast session with no profile. Open records
 * stay open where the wire is still unpinned.
 */

import { z } from 'zod';

/* -------------------------------------------------------------------------- */
/* Browser sessions                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Docs say `storageStateUrl` is `{url, expiresInSeconds}` (or a null `url`
 * when the profile was never saved). Fast sessions with no profile omit the
 * field entirely (live 201 on 2026-08-15). Accept object, string, or null.
 */
export const SolariStorageStateUrl = z.union([
  z.string(),
  z
    .object({
      url: z.string().nullish(),
      expiresInSeconds: z.number().nullish(),
    })
    .passthrough(),
]);

/**
 * `POST /sessions` response. Live 201 (2026-08-15): `sessionId`, `wsEndpoint`,
 * `cdpEndpoint`, `expiresAt`. `storageStateUrl` was absent on a fast session.
 */
export const SolariBrowserSession = z
  .object({
    sessionId: z.string(),
    wsEndpoint: z.string().nullish(),
    cdpEndpoint: z.string().nullish(),
    expiresAt: z.string().nullish(),
    storageStateUrl: SolariStorageStateUrl.nullish(),
  })
  .passthrough();
export type SolariBrowserSession = z.infer<typeof SolariBrowserSession>;

/**
 * `GET /sessions/:id` — older docs said this always 404s. Live 200 on
 * 2026-08-15 returned `id`, `status`, `kind`, `org`, `createdAt`, `expiresAt`,
 * `wsEndpoint`, `cdpEndpoint`.
 */
export const SolariSessionStatus = z
  .object({
    id: z.string().nullish(),
    sessionId: z.string().nullish(),
    status: z.string().nullish(),
    kind: z.string().nullish(),
    org: z.string().nullish(),
    createdAt: z.string().nullish(),
    expiresAt: z.string().nullish(),
    wsEndpoint: z.string().nullish(),
    cdpEndpoint: z.string().nullish(),
  })
  .passthrough();
export type SolariSessionStatus = z.infer<typeof SolariSessionStatus>;

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
 * `POST /sandboxes` 201 (live 2026-08-15): `sandboxId`, `kind`, `controlUrl`,
 * `expiresAt`. List/GET rows also carry `state` and `template`.
 */
export const SolariSandbox = z
  .object({
    sandboxId: z.string().nullish(),
    id: z.string().nullish(),
    kind: z.string().nullish(),
    state: z.string().nullish(),
    template: z.string().nullish(),
    controlUrl: z.string().nullish(),
    expiresAt: z.string().nullish(),
    streamUrl: z.string().nullish(),
    recordingUrl: z.string().nullish(),
  })
  .passthrough();
export type SolariSandbox = z.infer<typeof SolariSandbox>;

export const SolariSandboxList = z
  .object({
    sandboxes: z.array(SolariSandbox).default([]),
    nextCursor: z.string().nullish(),
  })
  .passthrough();
export type SolariSandboxList = z.infer<typeof SolariSandboxList>;

/**
 * `POST /sandboxes/:id/exec` live 200 (2026-08-15): `{exitCode, stdout, stderr}`.
 * Request body is `{cmd, args?, cwd?, timeoutMs?}` — `cmd` is a binary, not a
 * shell line.
 */
export const SolariExecResult = z
  .object({
    exitCode: z.number().nullish(),
    stdout: z.string().nullish(),
    stderr: z.string().nullish(),
  })
  .passthrough();
export type SolariExecResult = z.infer<typeof SolariExecResult>;

/** `GET /sandboxes/:id/metrics` — documented live shape includes cpu/mem/disk. */
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
    expiresAt: z.string().nullish(),
  })
  .passthrough();
export type SolariDesktop = z.infer<typeof SolariDesktop>;

/* -------------------------------------------------------------------------- */
/* Profiles                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * `POST /profiles` / `GET /profiles`. Live GET on 2026-08-15 returned a bare
 * JSON array. `id`/`profileId` are both accepted.
 */
export const SolariProfile = z
  .object({
    id: z.string().nullish(),
    profileId: z.string().nullish(),
    name: z.string().nullish(),
  })
  .passthrough();
export type SolariProfile = z.infer<typeof SolariProfile>;
