/**
 * CORS and rate-limit policy for the public API.
 *
 * Commerce routes are unauthenticated by design and compensate by never
 * trusting client-supplied prices. CORS therefore cannot be "reflect any
 * origin": any page on the internet could drive checkout creation from a
 * visitor's browser. Webhooks send no Origin and must never be CORS-blocked.
 *
 * Production refuses unknown origins (`corsFailClosed`). Preview and staging
 * allow all origins because a local storefront and the API almost never share
 * a host, and there are no paying customers on those environments. Failing
 * closed in production without the storefront origin in `CORS_ALLOWED_ORIGINS`
 * is the worse failure — it is visible. Failing open in production is not.
 */

export function isWebhookPath(url: string): boolean {
  return url.startsWith('/webhooks/');
}

export function corsAllowsOrigin(
  origin: string | undefined,
  options: { readonly allowlist: readonly string[]; readonly failClosed: boolean },
): boolean {
  // Non-browser callers (webhooks, curl, Render health) send no Origin.
  if (!origin) return true;
  if (!options.failClosed) return true;
  return options.allowlist.includes(origin);
}
