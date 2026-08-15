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
});
