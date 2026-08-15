/**
 * Escalation policy and opt-out detection.
 */

import { describe, expect, it } from 'vitest';
import { decideEscalation, isOptOutMessage, type EscalationInput } from '@foundry/core';

function input(overrides: Partial<EscalationInput> = {}): EscalationInput {
  return {
    intent: 'order_status',
    intentConfidence: 0.9,
    requestedRefundMinor: null,
    agentRefundLimitMinor: 2500,
    orderFound: true,
    customerMessageCount: 1,
    requiresUnverifiableClaim: false,
    ...overrides,
  };
}

describe('decideEscalation', () => {
  it('escalates always-escalate intents, with safety as urgent', () => {
    const legal = decideEscalation(input({ intent: 'legal_threat' }));
    expect(legal.escalate).toBe(true);
    expect(legal.priority).toBe('high');

    const safety = decideEscalation(input({ intent: 'safety_incident' }));
    expect(safety.escalate).toBe(true);
    expect(safety.priority).toBe('urgent');
  });

  it('escalates when answering would require an unverifiable claim', () => {
    const result = decideEscalation(input({ requiresUnverifiableClaim: true }));
    expect(result.escalate).toBe(true);
    expect(result.reason).toMatch(/not present in verified/);
  });

  it('escalates a refund above the agent limit', () => {
    const result = decideEscalation(input({ requestedRefundMinor: 5000, agentRefundLimitMinor: 2500 }));
    expect(result.escalate).toBe(true);
    expect(result.priority).toBe('high');
  });

  it('does not escalate a confident, in-limit, order-found enquiry', () => {
    expect(decideEscalation(input()).escalate).toBe(false);
  });
});

describe('isOptOutMessage', () => {
  it('matches provider keywords as a whole message, not as a substring', () => {
    expect(isOptOutMessage('STOP')).toBe(true);
    expect(isOptOutMessage('  opt out  ')).toBe(true);
    expect(isOptOutMessage('please stop shipping')).toBe(false);
    expect(isOptOutMessage('UNSUBSCRIBE')).toBe(true);
  });
});
