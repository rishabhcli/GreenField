import { allReferencedTools } from '@foundry/core';
import { describe, expect, it } from 'vitest';
import { buildCompanyTools } from '../src/tools/catalog.js';
import { defaultHackathonCompanyConfig } from '../src/org/default-config.js';

describe('org tool catalog', () => {
  it('registers every tool name referenced by the org chart', () => {
    const tools = buildCompanyTools({} as never);
    const names = new Set(tools.map((tool) => tool.name));
    expect(allReferencedTools().filter((name) => !names.has(name))).toEqual([]);
  });

  it('parses the hackathon default company config', () => {
    const config = defaultHackathonCompanyConfig({
      ownerName: 'Founder',
      ownerEmail: 'founder@example.test',
    });
    expect(config.legalEntity.type).toBe('not_yet_formed');
    expect(config.commerce.baseCurrency).toBe('USD');
    expect(config.legalEntity.registeredName).toBeNull();
  });

  it('registers prize-track tools used by Terac, Stripe, Linq, Band, Pioneer, Replay, Superserve', () => {
    const tools = buildCompanyTools({} as never);
    const names = new Set(tools.map((tool) => tool.name));
    expect(
      [
        'expert.request_review',
        'commerce.configure_checkout',
        'commerce.collect_payment',
        'linq.send_link',
        'linq.list_experiences',
        'stripe.get_hackathon_payment_link',
        'band.post_message',
        'band.ensure_room',
        'compliance.scan_pii',
        'compliance.guard_prompt',
        'qa.create_project',
        'sandbox.create',
        'terac.list_projects',
      ].filter((name) => !names.has(name)),
    ).toEqual([]);
  });
});
