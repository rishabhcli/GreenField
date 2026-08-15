/**
 * Google Ads API version — confirmed 2026-08-15 via WebSearch and a direct
 * WebFetch of `developers.google.com/google-ads/api/docs/release-notes`.
 *
 * The live release notes page lists **v25** as the current latest version,
 * released 2026-07-22, described as "a major release," with no sunset date
 * yet published for it. `manifests.ts` currently guesses `v18` — Google Ads
 * API versions have historically sunset roughly a year after release, so a
 * version seven majors behind current (v18 -> v25) is certain to already be
 * past its `sunsetMillisAfterEpoch` and rejected outright, not just stale.
 *
 * Per the task instruction to keep a corrected value in this directory rather
 * than edit `manifests.ts` (out of scope for this agent), this constant is
 * what the adapter actually calls with; the base URL is overridden at the
 * `this.http(auth, { baseUrl })` call site rather than trusting
 * `GOOGLE_ADS_MANIFEST.baseUrls`.
 */
export const GOOGLE_ADS_API_VERSION = 'v25';

export const GOOGLE_ADS_BASE_URL = `https://googleads.googleapis.com/${GOOGLE_ADS_API_VERSION}`;

export const GOOGLE_OAUTH_BASE_URL = 'https://oauth2.googleapis.com';
export const GOOGLE_OAUTH_TOKEN_PATH = '/token';
export const GOOGLE_OAUTH_TOKEN_URL = `${GOOGLE_OAUTH_BASE_URL}${GOOGLE_OAUTH_TOKEN_PATH}`;

/**
 * `login-customer-id` is documented as required for manager-account (MCC)
 * structures and optional otherwise. It has no entry in `manifests.ts`'s
 * `SECRETS`, and this adapter must not edit that file, so it is declared here
 * as a local, optional `SecretSpec` — still resolved through `SecretStore`
 * (never a direct `process.env` read) and simply not part of the shared
 * manifest's required-secrets gate. `GOOGLE_ADS_MANIFEST.secrets` should grow
 * this entry too; see the implementation report for why it was not added here.
 */
export const GOOGLE_ADS_LOGIN_CUSTOMER_ID_SECRET = {
  env: 'GOOGLE_ADS_LOGIN_CUSTOMER_ID',
  description: 'Manager account (MCC) customer id sent as login-customer-id when the account is accessed under a manager',
  required: false,
  obtainFrom: 'Google Ads UI, top-right account selector — the manager account digits, not the client account',
} as const;
