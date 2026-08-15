/**
 * Seeds one actor row per org-chart role so the policy gate can resolve a
 * handle on the first tool call. Without this, every agent run fails at
 * `requireByHandle` before any work happens.
 */

import { AUTHORITIES, ORG_CHART, type Authority, type ModelTier } from '@foundry/core';
import type { Repositories } from '@foundry/db';

const KNOWN = new Set<string>(AUTHORITIES);

const FALLBACK_BY_FUNC: Record<string, Authority> = {
  executive: 'research.collect',
  research: 'research.collect',
  sourcing: 'supplier.contact',
  brand: 'brand.publish',
  commerce: 'payments.configure',
  growth: 'ads.create_campaign',
  customer_ops: 'messaging.send_customer',
  finance: 'payments.configure',
  engineering: 'infrastructure.provision',
  qa: 'site.deploy_preview',
  legal: 'legal.publish_policy',
};

function actorKind(tier: ModelTier): 'ceo_agent' | 'manager_agent' | 'specialist_agent' {
  if (tier === 'executive') return 'ceo_agent';
  if (tier === 'manager') return 'manager_agent';
  return 'specialist_agent';
}

function authoritiesOf(role: (typeof ORG_CHART)[number]): readonly string[] {
  const held = role.authorities.filter((a) => KNOWN.has(a));
  if (held.length > 0) return held;
  return [FALLBACK_BY_FUNC[role.func] ?? 'research.collect'];
}

export async function seedOrgActors(
  repos: Repositories,
  companyId: string,
  currency = 'USD',
): Promise<number> {
  let count = 0;
  for (const role of ORG_CHART) {
    await repos.governance.actors.upsert({
      companyId,
      kind: actorKind(role.tier),
      handle: role.key,
      roleKey: role.key,
      authorities: authoritiesOf(role),
      spendCeilingMinor: role.spendCeilingMinorUsd,
      currency,
    });
    count += 1;
  }
  return count;
}
