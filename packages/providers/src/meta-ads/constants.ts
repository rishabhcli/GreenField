/**
 * Meta Marketing/Graph API version — confirmed 2026-08-15 via WebSearch and a
 * direct WebFetch of `developers.facebook.com/docs/graph-api/changelog/versions/`.
 *
 * Findings, and why this constant exists instead of `META_ADS_MANIFEST.baseUrls`:
 *   - `manifests.ts` currently hard-codes `graph.facebook.com/v21.0`. The live
 *     changelog page lists Marketing API v21.0 as EXPIRED on 2025-09-09 — a
 *     date already in the past relative to this build. That is not a "slightly
 *     behind" discrepancy; a call against v21.0 today fails outright.
 *   - Graph API's current latest is v26.0 (released 2026-07-29). The
 *     Marketing-API-specific line was separately listed at v25.0 (released
 *     2026-02-18) with a documented "Marketing API version auto-upgrade" to
 *     the newer line scheduled for 2026-07-29 — the same date, already past.
 *   - Both API families are called through the identical
 *     `graph.facebook.com/v{N}.0/...` path prefix (campaigns, adsets, ads,
 *     adimages, adcreatives and insights all live under it), so one version
 *     constant covers every endpoint this adapter calls.
 *
 * We pin v26.0 as the best-supported current value given the above, per the
 * task instruction to use a corrected constant in this directory rather than
 * edit `manifests.ts` (which is out of scope for this agent). Meta ships a new
 * major roughly quarterly with an ~2 year deprecation window, so this should
 * be reconfirmed at each redeploy rather than assumed evergreen.
 */
export const META_MARKETING_API_VERSION = 'v26.0';

export const META_ADS_BASE_URL = `https://graph.facebook.com/${META_MARKETING_API_VERSION}`;

/** Error codes documented (and independently well-known) as throttling, never a reason to stop trying. */
export const META_RETRYABLE_ERROR_CODES: ReadonlySet<number> = new Set([17, 613]);

/** Access token expired/invalid — terminal until a human re-authorises, never retried blindly. */
export const META_AUTH_ERROR_CODE = 190;
