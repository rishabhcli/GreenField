/**
 * Org chart structure and the human-only authority boundary.
 */

import { describe, expect, it } from 'vitest';
import {
  HUMAN_ONLY_AUTHORITIES,
  ORG_CHART,
  directReports,
  managers,
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
});
