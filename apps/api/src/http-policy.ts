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

const CLIENT_REQUEST_ID = /^[a-zA-Z0-9_-]{8,64}$/;

/**
 * Accept a client `x-request-id` only when it is a short safe token.
 * Anything else (missing, too long, spaces, path characters) is generated.
 */
export function resolveRequestId(
  headers: { readonly [key: string]: unknown },
  generate: () => string,
): string {
  const raw = headers['x-request-id'];
  if (typeof raw === 'string' && CLIENT_REQUEST_ID.test(raw)) return raw;
  return generate();
}

/**
 * Checkout success/cancel URLs are sent by the storefront. A phishing page
 * that created a session with `success_url=https://evil.example/steal` would
 * redirect a paying customer off-site after Stripe collected the card. The
 * URL origin must be on the CORS allowlist (which always includes
 * PUBLIC_BASE_URL).
 */
/**
 * Standard Webhooks (`webhook-id`) is the delivery id. Body fields like
 * Dodo `data.payment_id` are business ids and collide across event types.
 */
export function resolveWebhookEventId(input: {
  readonly preferDeliveryHeader: boolean;
  readonly bodyId: string | null;
  readonly headerId: string | null;
}): string | null {
  if (input.preferDeliveryHeader && input.headerId) return input.headerId;
  return input.bodyId ?? input.headerId;
}

export function checkoutRedirectAllowed(
  url: string,
  allowlist: readonly string[],
): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
  return allowlist.includes(parsed.origin);
}
