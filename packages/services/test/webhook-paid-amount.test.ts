/**
 * Paid-amount honesty: a webhook that disagrees with the order total must not
 * mark the order PAID, and a zero/missing capture must not be booked as paid.
 */

import { describe, expect, it } from 'vitest';
import { evaluatePaidCapture } from '../src/commerce/webhook-processor.js';

describe('evaluatePaidCapture', () => {
  const order = {
    orderTotalMinor: 5787,
    orderCurrency: 'USD',
    orderAmountPaidMinor: 0,
  };

  it('credits when the captured amount equals the order total', () => {
    expect(
      evaluatePaidCapture({
        ...order,
        intendedStatus: 'PAID',
        amountPaidDeltaMinor: 5787,
        eventCurrency: 'usd',
      }),
    ).toEqual({ action: 'credit', amountPaidDeltaMinor: 5787 });
  });

  it('rejects a mismatch rather than marking PAID (processor maps reject → MANUAL_REVIEW)', () => {
    const decision = evaluatePaidCapture({
      ...order,
      intendedStatus: 'PAID',
      amountPaidDeltaMinor: 9900,
      eventCurrency: 'usd',
    });
    expect(decision.action).toBe('reject');
    if (decision.action === 'reject') {
      expect(decision.reason).toContain('does not equal order total');
    }
  });

  it('rejects a paid intent with a zero capture', () => {
    expect(
      evaluatePaidCapture({
        ...order,
        intendedStatus: 'PAID',
        amountPaidDeltaMinor: 0,
        eventCurrency: 'usd',
      }).action,
    ).toBe('reject');
  });

  it('passes a PAID event that carries no amount (other providers, or a later status-only webhook)', () => {
    expect(
      evaluatePaidCapture({
        ...order,
        intendedStatus: 'PAID',
        amountPaidDeltaMinor: undefined,
        eventCurrency: 'usd',
      }),
    ).toEqual({ action: 'pass' });
  });

  it('does not double-credit the same captured amount', () => {
    expect(
      evaluatePaidCapture({
        ...order,
        orderAmountPaidMinor: 5787,
        intendedStatus: 'PAID',
        amountPaidDeltaMinor: 5787,
        eventCurrency: 'usd',
      }),
    ).toEqual({ action: 'already_credited' });
  });

  it('rejects a second capture that disagrees with the booked amount', () => {
    const decision = evaluatePaidCapture({
      ...order,
      orderAmountPaidMinor: 5787,
      intendedStatus: 'PAID',
      amountPaidDeltaMinor: 4700,
      eventCurrency: 'usd',
    });
    expect(decision.action).toBe('reject');
  });
});
