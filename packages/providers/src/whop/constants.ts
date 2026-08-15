/**
 * Whop REST pin and checkout hosts.
 *
 * `Api-Version-Date` is mandatory: omitting it selects Whop's original
 * `2025-01-01` shapes. The date below is the pin recorded in PLAN.md /
 * SPONSOR_API_RESEARCH.md on 2026-08-15. The `@whop/sdk` default at install
 * time was `2026-07-20`, which is not this pin — callers constructing the SDK
 * must pass `version` explicitly.
 */
export const WHOP_API_VERSION_DATE = '2026-07-23';

export const WHOP_CHECKOUT_ORIGIN = {
  production: 'https://whop.com',
  sandbox: 'https://sandbox.whop.com',
} as const;

export function whopCheckoutOrigin(environment: 'production' | 'staging' | 'preview'): string {
  return environment === 'production' ? WHOP_CHECKOUT_ORIGIN.production : WHOP_CHECKOUT_ORIGIN.sandbox;
}

export function whopCheckoutUrl(planId: string, environment: 'production' | 'staging' | 'preview'): string {
  return `${whopCheckoutOrigin(environment)}/checkout/${planId}`;
}
