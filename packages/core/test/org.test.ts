/**
 * Org chart structure and the human-only authority boundary.
 */

import { describe, expect, it } from 'vitest';
import {
  BAND_CHANNELS,
  HUMAN_ONLY_AUTHORITIES,
  ORG_CHART,
  bandChannelForRole,
  directReports,
  managers,
  roleByKey,
  roleMayPostToBandChannel,
  validateOrgChart,
} from '@foundry/core';

describe('ORG_CHART', () => {
  it('is 1 CEO + 10 managers + the rest specialists', () => {
    const executives = ORG_CHART.filter((r) => r.tier === 'executive');
    const managerRoles = managers();
    const specialists = ORG_CHART.filter((r) => r.tier === 'specialist');
    expect(executives).toHaveLength(1);
    expect(executives[0]?.key).toBe('ceo');
    expect(managerRoles).toHaveLength(10);
    expect(specialists.length).toBe(ORG_CHART.length - 11);
    expect(ORG_CHART).toHaveLength(78);
  });

  it('has no structural problems', () => {
    expect(validateOrgChart()).toEqual([]);
  });

  it('makes every manager a direct report of the CEO', () => {
    const reportKeys = new Set(directReports('ceo').map((r) => r.key));
    for (const manager of managers()) {
      expect(reportKeys.has(manager.key)).toBe(true);
      expect(manager.reportsTo).toBe('ceo');
    }
  });

  it('never grants a software role a human-only authority', () => {
    for (const role of ORG_CHART) {
      for (const authority of role.authorities) {
        expect(
          HUMAN_ONLY_AUTHORITIES.has(authority),
          `${role.key} holds human-only authority ${authority}`,
        ).toBe(false);
      }
    }
  });

  it('treats a human-only grant as an org-chart structural problem', () => {
    expect(validateOrgChart().some((p) => /human-only/i.test(p))).toBe(false);
  });
});

describe('BAND permissioned channels', () => {
  it('names the eight PLAN §2 coordination channels and no others', () => {
    expect([...BAND_CHANNELS]).toEqual([
      'discovery',
      'sourcing',
      'marketing',
      'support',
      'engineering',
      'finance',
      'qa',
      'incidents',
    ]);
  });

  it('maps every org function onto one of those channels', () => {
    const used = new Set<string>();
    for (const role of ORG_CHART) {
      const channel = bandChannelForRole(role);
      expect(BAND_CHANNELS.includes(channel), `${role.key} → ${channel}`).toBe(true);
      used.add(channel);
    }
    expect(used).toEqual(new Set(BAND_CHANNELS));
  });

  it('routes research to discovery, growth to marketing, legal to incidents', () => {
    expect(bandChannelForRole(roleByKey('research_manager')!)).toBe('discovery');
    expect(bandChannelForRole(roleByKey('community_researcher')!)).toBe('discovery');
    expect(bandChannelForRole(roleByKey('growth_manager')!)).toBe('marketing');
    expect(bandChannelForRole(roleByKey('customer_ops_manager')!)).toBe('support');
    expect(bandChannelForRole(roleByKey('legal_manager')!)).toBe('incidents');
    expect(bandChannelForRole(roleByKey('finance_manager')!)).toBe('finance');
    expect(bandChannelForRole(roleByKey('qa_manager')!)).toBe('qa');
    expect(bandChannelForRole(roleByKey('engineering_manager')!)).toBe('engineering');
    expect(bandChannelForRole(roleByKey('sourcing_manager')!)).toBe('sourcing');
  });

  it('lets a manager post only to its function channel and incidents', () => {
    const research = roleByKey('research_manager')!;
    expect(roleMayPostToBandChannel(research, 'discovery')).toBe(true);
    expect(roleMayPostToBandChannel(research, 'incidents')).toBe(true);
    expect(roleMayPostToBandChannel(research, 'finance')).toBe(false);
    expect(roleMayPostToBandChannel(research, 'marketing')).toBe(false);
  });

  it('lets the CEO and system post to every channel; specialists still cannot assume finance', () => {
    const ceo = roleByKey('ceo')!;
    const specialist = roleByKey('community_researcher')!;
    for (const channel of BAND_CHANNELS) {
      expect(roleMayPostToBandChannel(ceo, channel)).toBe(true);
      expect(roleMayPostToBandChannel('system', channel)).toBe(true);
    }
    expect(roleMayPostToBandChannel(specialist, 'finance')).toBe(false);
    expect(roleMayPostToBandChannel(specialist, 'discovery')).toBe(true);
  });
});
