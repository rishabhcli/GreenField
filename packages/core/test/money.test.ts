import { describe, expect, it } from 'vitest';
import { Money, MODELLING_SCALE, ValidationError, bps, decimalToRatio } from '@foundry/core';

describe('Money construction', () => {
  it('parses decimal strings exactly', () => {
    expect(Money.of('12.34', 'USD').toString()).toBe('12.34');
    expect(Money.of('0.000001', 'USD', 6).toString()).toBe('0.000001');
    expect(Money.of('-5', 'USD').toString()).toBe('-5.00');
  });

  it('defaults scale to the currency exponent', () => {
    expect(Money.of('100', 'JPY').toString()).toBe('100');
    expect(Money.of('100', 'USD').toString()).toBe('100.00');
    expect(Money.of('1.234', 'KWD').toString()).toBe('1.234');
  });

  it('refuses to silently truncate precision', () => {
    expect(() => Money.of('1.234', 'USD', 2)).toThrow(ValidationError);
  });

  it('rejects malformed input rather than coercing it', () => {
    expect(() => Money.of('1e3', 'USD')).toThrow(ValidationError);
    expect(() => Money.of('twelve', 'USD')).toThrow(ValidationError);
    expect(() => Money.of('12.34', 'DOLLARS')).toThrow(ValidationError);
  });

  it('round-trips through JSON without loss', () => {
    const original = Money.of('1234.567891', 'USD', 6);
    expect(Money.fromJSON(original.toJSON()).equals(original)).toBe(true);
  });
});

describe('Money arithmetic', () => {
  it('adds and subtracts exactly where floats would drift', () => {
    // 0.1 + 0.2 !== 0.3 in IEEE-754; it must here.
    const sum = Money.of('0.1', 'USD').add(Money.of('0.2', 'USD'));
    expect(sum.toString()).toBe('0.30');
    expect(sum.equals(Money.of('0.30', 'USD'))).toBe(true);
  });

  it('aligns differing scales without losing precision', () => {
    const a = Money.of('1.00', 'USD', 2);
    const b = Money.of('0.005', 'USD', 6);
    expect(a.add(b).toString()).toBe('1.005000');
  });

  it('refuses to mix currencies', () => {
    expect(() => Money.of('1', 'USD').add(Money.of('1', 'EUR'))).toThrow(/Currency mismatch/);
  });

  it('multiplies by an exact decimal rate', () => {
    // 2.9% payment fee on $47.00 = $1.363
    const fee = Money.of('47.00', 'USD', 6).multiplyByDecimal('0.029');
    expect(fee.toString()).toBe('1.363000');
  });

  it('supports basis points', () => {
    const { numerator, denominator } = bps(290);
    const fee = Money.of('47.00', 'USD', 6).multiplyByRatio(numerator, denominator);
    expect(fee.toString()).toBe('1.363000');
  });

  it('uses banker’s rounding by default', () => {
    expect(Money.of('0.125', 'USD', 3).rescale(2).toString()).toBe('0.12');
    expect(Money.of('0.135', 'USD', 3).rescale(2).toString()).toBe('0.14');
    expect(Money.of('0.125', 'USD', 3).rescale(2, 'half_up').toString()).toBe('0.13');
  });

  it('rounds negative values symmetrically', () => {
    expect(Money.of('-0.125', 'USD', 3).rescale(2, 'half_up').toString()).toBe('-0.13');
    expect(Money.of('-1.5', 'USD', 1).rescale(0, 'floor').toString()).toBe('-2');
    expect(Money.of('-1.5', 'USD', 1).rescale(0, 'ceil').toString()).toBe('-1');
  });
});

describe('Money.allocate', () => {
  it('splits without losing or inventing a minor unit', () => {
    const parts = Money.of('10.00', 'USD').allocate(3);
    expect(parts.map((p) => p.toString())).toEqual(['3.34', '3.33', '3.33']);
    expect(Money.sum(parts).toString()).toBe('10.00');
  });

  it('allocates a real tooling charge across a production run exactly', () => {
    // $4,800 tooling across 25,000 units — the case that motivates scale 6.
    const tooling = Money.of('4800.00', 'USD', MODELLING_SCALE);
    const perUnit = tooling.divideBy(25_000);
    expect(perUnit.toString()).toBe('0.192000');
    expect(perUnit.multiplyBy(25_000).equals(tooling)).toBe(true);
  });

  it('handles a run size that does not divide evenly', () => {
    const tooling = Money.of('1000.00', 'USD', 2);
    const parts = tooling.allocate(7);
    expect(Money.sum(parts).toString()).toBe('1000.00');
    expect(new Set(parts.map((p) => p.toString())).size).toBeLessThanOrEqual(2);
  });

  it('allocates by weights preserving the exact total', () => {
    const freight = Money.of('1234.56', 'USD');
    const parts = freight.allocateByWeights([3, 1, 1]);
    expect(Money.sum(parts).toString()).toBe('1234.56');
    expect(parts).toHaveLength(3);
  });

  it('rejects nonsense allocations', () => {
    expect(() => Money.of('1', 'USD').allocate(0)).toThrow(ValidationError);
    expect(() => Money.of('1', 'USD').allocateByWeights([0, 0])).toThrow(ValidationError);
  });
});

describe('provider minor units', () => {
  it('converts to the currency’s own exponent', () => {
    expect(Money.of('47.00', 'USD').toProviderMinorUnits()).toBe(4700);
    expect(Money.of('4700', 'JPY').toProviderMinorUnits()).toBe(4700);
    expect(Money.of('1.234', 'KWD').toProviderMinorUnits()).toBe(1234);
  });

  it('rounds modelling precision down to chargeable cents', () => {
    expect(Money.of('47.004999', 'USD', 6).toProviderMinorUnits()).toBe(4700);
    expect(Money.of('47.005001', 'USD', 6).toProviderMinorUnits()).toBe(4701);
  });
});

describe('decimalToRatio', () => {
  it('converts exact decimals', () => {
    expect(decimalToRatio('0.029')).toEqual({ numerator: 29n, denominator: 1000n });
    expect(decimalToRatio('-1.5')).toEqual({ numerator: -15n, denominator: 10n });
  });
  it('rejects percentage strings, which are a common unit bug', () => {
    expect(() => decimalToRatio('2.9%')).toThrow(ValidationError);
  });
});
