import { describe, expect, it } from 'vitest';
import {
  AUTHORITY_KILL_SCOPES,
  AUTHORITIES,
  HUMAN_ONLY_AUTHORITIES,
  budgetRemainingMinor,
  budgetUtilisation,
  canonicalAuditPayload,
  evaluatePolicy,
  type Actor,
  type Budget,
  type PolicyEvaluationInput,
} from '@foundry/core';

const NOW = new Date('2026-08-15T12:00:00Z');

function actor(overrides: Partial<Actor> = {}): Actor {
  return {
    id: 'ag_1',
    kind: 'manager_agent',
    handle: 'growth_manager',
    authorities: ['ads.create_campaign'],
    spendCeilingMinor: 50_00,
    currency: 'USD',
    ...overrides,
  };
}

function budget(overrides: Partial<Budget> = {}): Budget {
  return {
    id: 'bdg_1',
    companyId: 'co_1',
    scope: 'advertising',
    window: 'daily',
    limitMinor: 500_00,
    currency: 'USD',
    reservedMinor: 0,
    spentMinor: 0,
    windowStartedAt: NOW.toISOString(),
    warnAtRatio: 0.8,
    hardStop: true,
    updatedAt: NOW.toISOString(),
    ...overrides,
  };
}

function input(overrides: Partial<PolicyEvaluationInput> = {}): PolicyEvaluationInput {
  return {
    actor: actor(),
    authority: 'ads.create_campaign',
    action: 'launch experiment arm',
    amountMinor: 20_00,
    currency: 'USD',
    budgets: [budget()],
    budgetScope: 'advertising',
    engagedKillSwitches: [],
    approvalThresholdsMinor: { 'ads.create_campaign': 100_00 },
    now: NOW,
    capabilityAvailable: true,
    ...overrides,
  };
}

describe('kill switches', () => {
  it('block the action before anything else is considered', () => {
    const result = evaluatePolicy(input({ engagedKillSwitches: ['ad_spend'] }));
    expect(result.outcome).toBe('deny');
    expect(result.reasons[0]?.code).toBe('kill_switch_engaged');
  });

  it('the global switch blocks every authority that has any scope', () => {
    for (const authority of AUTHORITIES) {
      const scopes = AUTHORITY_KILL_SCOPES[authority];
      if (scopes.length === 0) continue;
      expect(scopes).toContain('all');
    }
  });

  it('an unrelated switch does not block', () => {
    const result = evaluatePolicy(input({ engagedKillSwitches: ['customer_messaging'] }));
    expect(result.outcome).not.toBe('deny');
  });
});

describe('human-only authorities', () => {
  it('cannot be exercised by any agent, even one granted them', () => {
    for (const authority of HUMAN_ONLY_AUTHORITIES) {
      const result = evaluatePolicy(
        input({
          authority,
          actor: actor({ kind: 'ceo_agent', handle: 'ceo', authorities: [authority], spendCeilingMinor: 10_000_00 }),
          approvalThresholdsMinor: {},
          amountMinor: 1_00,
        }),
      );
      expect(result.outcome).toBe('deny');
      expect(result.reasons[0]?.code).toBe('human_only_authority');
    }
  });

  it('can be exercised by a human operator', () => {
    const result = evaluatePolicy(
      input({
        authority: 'finance.move_funds',
        actor: actor({ kind: 'human_operator', handle: 'owner', authorities: ['finance.move_funds'], spendCeilingMinor: 10_000_00 }),
        budgetScope: undefined,
        approvalThresholdsMinor: {},
      }),
    );
    expect(result.outcome).toBe('allow');
  });
});

describe('authority checks', () => {
  it('denies an authority the actor does not hold and says what it does hold', () => {
    const result = evaluatePolicy(input({ authority: 'supplier.purchase_production' }));
    expect(result.outcome).toBe('deny');
    expect(result.reasons[0]?.code).toBe('authority_not_held');
    expect(result.reasons[0]?.detail).toContain('ads.create_campaign');
  });
});

describe('capability availability', () => {
  it('denies when the underlying provider is not activated', () => {
    const result = evaluatePolicy(input({ capabilityAvailable: false }));
    expect(result.outcome).toBe('deny');
    expect(result.reasons[0]?.code).toBe('capability_unavailable');
  });
});

describe('budgets', () => {
  it('computes remaining and utilisation from reserved plus spent', () => {
    const b = budget({ limitMinor: 100_00, reservedMinor: 20_00, spentMinor: 30_00 });
    expect(budgetRemainingMinor(b)).toBe(50_00);
    expect(budgetUtilisation(b)).toBeCloseTo(0.5);
  });

  it('hard-stops when the request exceeds what is left', () => {
    const result = evaluatePolicy(input({ amountMinor: 60_00, budgets: [budget({ limitMinor: 100_00, spentMinor: 60_00 })] }));
    expect(result.outcome).toBe('deny');
    expect(result.reasons[0]?.code).toBe('budget_exhausted');
  });

  it('escalates instead of denying when the budget is soft', () => {
    const result = evaluatePolicy(
      input({ amountMinor: 60_00, budgets: [budget({ limitMinor: 100_00, spentMinor: 60_00, hardStop: false })] }),
    );
    expect(result.outcome).toBe('require_approval');
  });

  it('warns near the threshold without blocking', () => {
    const result = evaluatePolicy(input({ amountMinor: 5_00, budgets: [budget({ limitMinor: 100_00, spentMinor: 85_00 })] }));
    expect(result.outcome).toBe('allow');
    expect(result.reasons.some((r) => r.code === 'budget_warning_threshold')).toBe(true);
  });

  it('respects the company_total budget even when the scoped budget has room', () => {
    const result = evaluatePolicy(
      input({
        amountMinor: 400_00,
        budgets: [budget({ limitMinor: 500_00 }), budget({ id: 'bdg_2', scope: 'company_total', limitMinor: 200_00 })],
      }),
    );
    expect(result.outcome).toBe('deny');
    expect(result.reasons[0]?.detail).toContain('company_total');
  });
});

describe('spend ceilings and approvals', () => {
  it('requires approval above the actor ceiling', () => {
    const result = evaluatePolicy(input({ amountMinor: 75_00 }));
    expect(result.outcome).toBe('require_approval');
    expect(result.reasons.some((r) => r.code === 'actor_ceiling_exceeded')).toBe(true);
  });

  it('requires approval above the authority threshold', () => {
    const result = evaluatePolicy(
      input({ amountMinor: 150_00, actor: actor({ spendCeilingMinor: 1_000_00 }) }),
    );
    expect(result.outcome).toBe('require_approval');
    expect(result.reasons.some((r) => r.code === 'approval_threshold_exceeded')).toBe(true);
  });

  it('an actor with no independent spend authority always needs approval', () => {
    const result = evaluatePolicy(input({ amountMinor: 1, actor: actor({ spendCeilingMinor: null }) }));
    expect(result.outcome).toBe('require_approval');
  });

  it('an existing valid approval unblocks the action', () => {
    const result = evaluatePolicy(
      input({
        amountMinor: 150_00,
        existingApproval: {
          id: 'appr_1',
          status: 'approved',
          expiresAt: new Date(NOW.getTime() + 3_600_000).toISOString(),
          amountMinor: 200_00,
        },
      }),
    );
    expect(result.outcome).toBe('allow');
    expect(result.reasons.some((r) => r.code === 'existing_approval_valid')).toBe(true);
  });

  it('an expired approval does not unblock', () => {
    const result = evaluatePolicy(
      input({
        amountMinor: 150_00,
        existingApproval: {
          id: 'appr_1',
          status: 'approved',
          expiresAt: new Date(NOW.getTime() - 1).toISOString(),
          amountMinor: 200_00,
        },
      }),
    );
    expect(result.outcome).toBe('require_approval');
  });

  it('an approval for a smaller amount does not cover a larger spend', () => {
    const result = evaluatePolicy(
      input({
        amountMinor: 300_00,
        existingApproval: {
          id: 'appr_1',
          status: 'approved',
          expiresAt: new Date(NOW.getTime() + 3_600_000).toISOString(),
          amountMinor: 200_00,
        },
      }),
    );
    expect(result.outcome).toBe('require_approval');
  });

  it('allows a normal in-budget, in-ceiling action', () => {
    const result = evaluatePolicy(input());
    expect(result.outcome).toBe('allow');
    expect(result.reasons.some((r) => r.code === 'authority_granted')).toBe(true);
    expect(result.reasons.some((r) => r.code === 'within_actor_ceiling')).toBe(true);
  });
});

describe('audit hash chain', () => {
  const base = {
    id: 'aud_1',
    companyId: 'co_1',
    kind: 'policy_decision' as const,
    actorId: 'ag_1',
    actorKind: 'manager_agent' as const,
    action: 'launch arm',
    subjectType: 'experiment_arm',
    subjectRefId: 'arm_1',
    outcome: 'success' as const,
    detail: { b: 2, a: 1 },
    amountMinor: 2000,
    currency: 'USD',
    previousHash: null,
    occurredAt: NOW.toISOString(),
  };

  it('is deterministic regardless of detail key order', () => {
    const first = canonicalAuditPayload(base);
    const second = canonicalAuditPayload({ ...base, detail: { a: 1, b: 2 } });
    expect(first).toBe(second);
  });

  it('changes when any field changes', () => {
    const original = canonicalAuditPayload(base);
    expect(canonicalAuditPayload({ ...base, amountMinor: 2001 })).not.toBe(original);
    expect(canonicalAuditPayload({ ...base, previousHash: 'abc' })).not.toBe(original);
    expect(canonicalAuditPayload({ ...base, detail: { a: 1, b: 3 } })).not.toBe(original);
  });

  it('handles nested objects and arrays stably', () => {
    const nested = { ...base, detail: { z: [3, { y: 1, x: 2 }], a: null } };
    expect(canonicalAuditPayload(nested)).toBe(canonicalAuditPayload({ ...nested, detail: { a: null, z: [3, { x: 2, y: 1 }] } }));
  });
});
