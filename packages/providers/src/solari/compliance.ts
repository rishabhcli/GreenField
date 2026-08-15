/**
 * Robots/ToS gate for Solari navigation. This is a thrown PolicyDeniedError,
 * not a comment. stealth / captcha / "anti-bot" never override a denial.
 */

import { PolicyDeniedError } from '@foundry/core';

export interface ComplianceCheckResult {
  readonly robotsAllowed: boolean;
  readonly reason?: string;
}

const REVIEWED_RESEARCH_SEARCH_HOSTS = new Set([
  'duckduckgo.com',
  'www.duckduckgo.com',
  'html.duckduckgo.com',
  'bing.com',
  'www.bing.com',
  'en.wikipedia.org',
  'wikipedia.org',
]);

const UNREVIEWED_MARKETPLACE_HOSTS = new Set([
  'alibaba.com',
  'www.alibaba.com',
  'aliexpress.com',
  'www.aliexpress.com',
  '1688.com',
  'www.1688.com',
  'amazon.com',
  'www.amazon.com',
  'made-in-china.com',
  'www.made-in-china.com',
  'globalsources.com',
  'www.globalsources.com',
  'thomasnet.com',
  'www.thomasnet.com',
  'indiamart.com',
  'www.indiamart.com',
]);

function hostnameOf(url: string): string | undefined {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

export function isReviewedResearchSearchHost(urlOrHost: string): boolean {
  const host = urlOrHost.includes('://') ? hostnameOf(urlOrHost) : urlOrHost.toLowerCase();
  if (!host) return false;
  if (REVIEWED_RESEARCH_SEARCH_HOSTS.has(host)) return true;
  return host.endsWith('.duckduckgo.com') || host.endsWith('.bing.com') || host.endsWith('.wikipedia.org');
}

export function isUnreviewedMarketplaceHost(urlOrHost: string): boolean {
  const host = urlOrHost.includes('://') ? hostnameOf(urlOrHost) : urlOrHost.toLowerCase();
  if (!host) return false;
  if (UNREVIEWED_MARKETPLACE_HOSTS.has(host)) return true;
  return [...UNREVIEWED_MARKETPLACE_HOSTS].some((listed) => host === listed || host.endsWith(`.${listed.replace(/^www\./, '')}`));
}

/**
 * Default-deny for sourcing: only reviewed research search hosts may be
 * opened without an explicit robots/ToS review on file.
 */
export function refuseUnreviewedHost(url: string): ComplianceCheckResult {
  if (isReviewedResearchSearchHost(url)) {
    return { robotsAllowed: true, reason: 'reviewed research search host' };
  }
  return {
    robotsAllowed: false,
    reason:
      'No robots.txt/ToS review is registered for this host; Solari will not navigate. stealth/captcha/anti-bot do not override robots.txt or Terms of Service.',
  };
}

export function assertRobotsNotOverridden(input: {
  readonly url: string;
  readonly robotsAllowed: boolean;
  readonly stealth?: boolean;
  readonly captcha?: boolean;
  readonly antiBot?: boolean;
}): void {
  if (input.robotsAllowed) return;
  throw new PolicyDeniedError(
    `Refusing to browse ${input.url}: robots/ToS not allowed. stealth=${Boolean(input.stealth)} captcha=${Boolean(input.captcha)} anti-bot=${Boolean(input.antiBot)} do not override robots.txt or Terms of Service.`,
    {
      url: input.url,
      stealth: Boolean(input.stealth),
      captcha: Boolean(input.captcha),
      antiBot: Boolean(input.antiBot),
    },
  );
}

export function assertNavigationPermitted(
  url: string,
  flags?: { readonly stealth?: boolean; readonly captcha?: boolean; readonly antiBot?: boolean },
): void {
  const check = refuseUnreviewedHost(url);
  assertRobotsNotOverridden({ url, robotsAllowed: check.robotsAllowed, ...flags });
}

/** Research result pages may load unless they are an unreviewed marketplace. */
export function assertResearchResultPermitted(url: string): void {
  if (isUnreviewedMarketplaceHost(url)) {
    assertNavigationPermitted(url);
  }
}
