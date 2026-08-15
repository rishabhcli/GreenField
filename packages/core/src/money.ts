/**
 * Exact decimal money.
 *
 * Landed-cost and contribution-margin math is the arithmetic the whole business
 * depends on, so it is never done in IEEE-754 floats. Amounts are stored as a
 * `bigint` of minor units at an explicit decimal `scale` (scale 2 = cents,
 * scale 6 = micro-units for per-unit cost modelling where sub-cent precision
 * genuinely matters, e.g. allocating a $4,800 tooling charge across 25,000 units).
 */

import { ValidationError } from './errors.js';

/** ISO-4217 alpha-3, uppercase. Validated on construction. */
export type CurrencyCode = string & { readonly __brand?: 'CurrencyCode' };

export const TRANSACTIONAL_SCALE = 2;
export const MODELLING_SCALE = 6;

export type RoundingMode = 'half_even' | 'half_up' | 'floor' | 'ceil';

export interface MoneyJSON {
  readonly currency: string;
  /** Decimal string, e.g. "12.3456". Round-trips exactly. */
  readonly amount: string;
  readonly scale: number;
}

const CURRENCY_RE = /^[A-Z]{3}$/;

/**
 * Minor-unit exponent for currencies that are not 2-decimal. Used only for
 * presentation and for handing amounts to payment providers, which expect the
 * currency's own minor unit.
 */
const CURRENCY_EXPONENT: Readonly<Record<string, number>> = {
  BIF: 0, CLP: 0, DJF: 0, GNF: 0, JPY: 0, KMF: 0, KRW: 0, MGA: 0, PYG: 0,
  RWF: 0, UGX: 0, VND: 0, VUV: 0, XAF: 0, XOF: 0, XPF: 0,
  BHD: 3, IQD: 3, JOD: 3, KWD: 3, LYD: 3, OMR: 3, TND: 3,
};

export function currencyExponent(currency: CurrencyCode): number {
  return CURRENCY_EXPONENT[currency.toUpperCase()] ?? 2;
}

export class Money {
  readonly currency: CurrencyCode;
  /** Value = amount / 10^scale */
  readonly amount: bigint;
  readonly scale: number;

  private constructor(currency: CurrencyCode, amount: bigint, scale: number) {
    this.currency = currency;
    this.amount = amount;
    this.scale = scale;
    Object.freeze(this);
  }

  /* ---------------------------------------------------------------------- */
  /* Construction                                                            */
  /* ---------------------------------------------------------------------- */

  /** Build from a decimal string ("12.34", "-0.000015", "1e3" is rejected). */
  static of(value: string | number | bigint, currency: string, scale?: number): Money {
    const cur = normaliseCurrency(currency);
    const text = typeof value === 'string' ? value.trim() : String(value);
    if (!/^-?\d+(\.\d+)?$/.test(text)) {
      throw new ValidationError(`Invalid money amount "${text}" (expected plain decimal)`, {
        value: text,
        currency: cur,
      });
    }
    const negative = text.startsWith('-');
    const unsigned = negative ? text.slice(1) : text;
    const [intPart = '0', fracPart = ''] = unsigned.split('.');
    const targetScale = scale ?? Math.max(fracPart.length, currencyExponent(cur));
    if (targetScale < 0 || targetScale > 18) {
      throw new ValidationError(`Money scale must be between 0 and 18, got ${targetScale}`);
    }
    if (fracPart.length > targetScale) {
      throw new ValidationError(
        `Money "${text}" has more precision than the requested scale ${targetScale}; ` +
          `use Money.of(...).rescale(${targetScale}, mode) to round explicitly`,
        { value: text, targetScale },
      );
    }
    const digits = intPart + fracPart.padEnd(targetScale, '0');
    const magnitude = BigInt(digits === '' ? '0' : digits);
    return new Money(cur, negative ? -magnitude : magnitude, targetScale);
  }

  /** Build directly from minor units at a known scale (no string parsing). */
  static fromMinor(amount: bigint | number, currency: string, scale = TRANSACTIONAL_SCALE): Money {
    const cur = normaliseCurrency(currency);
    const big = typeof amount === 'bigint' ? amount : BigInt(Math.trunc(amount));
    if (typeof amount === 'number' && !Number.isInteger(amount)) {
      throw new ValidationError(`fromMinor requires an integer, got ${amount}`);
    }
    return new Money(cur, big, scale);
  }

  static zero(currency: string, scale = TRANSACTIONAL_SCALE): Money {
    return new Money(normaliseCurrency(currency), 0n, scale);
  }

  static fromJSON(json: MoneyJSON): Money {
    return Money.of(json.amount, json.currency, json.scale);
  }

  /* ---------------------------------------------------------------------- */
  /* Inspection                                                              */
  /* ---------------------------------------------------------------------- */

  get isZero(): boolean {
    return this.amount === 0n;
  }
  get isNegative(): boolean {
    return this.amount < 0n;
  }
  get isPositive(): boolean {
    return this.amount > 0n;
  }

  /** Decimal string at the current scale, e.g. "12.3456". */
  toString(): string {
    const negative = this.amount < 0n;
    const digits = (negative ? -this.amount : this.amount).toString().padStart(this.scale + 1, '0');
    const cut = digits.length - this.scale;
    const intPart = digits.slice(0, cut);
    const fracPart = digits.slice(cut);
    const body = this.scale === 0 ? intPart : `${intPart}.${fracPart}`;
    return negative ? `-${body}` : body;
  }

  toJSON(): MoneyJSON {
    return { currency: this.currency, amount: this.toString(), scale: this.scale };
  }

  /**
   * Integer minor units in the currency's own exponent — the representation
   * payment providers expect (Stripe `unit_amount`, Dodo `price`, etc.).
   * Rounds half-even if the value carries extra precision.
   */
  toProviderMinorUnits(mode: RoundingMode = 'half_even'): number {
    const target = this.rescale(currencyExponent(this.currency), mode);
    const n = Number(target.amount);
    if (!Number.isSafeInteger(n)) {
      throw new ValidationError(`Money ${this.toString()} ${this.currency} exceeds safe integer minor units`);
    }
    return n;
  }

  /** Lossy — only for charts, scoring heuristics and log lines. Never for ledgers. */
  toApproximateNumber(): number {
    return Number(this.amount) / 10 ** this.scale;
  }

  /* ---------------------------------------------------------------------- */
  /* Arithmetic                                                              */
  /* ---------------------------------------------------------------------- */

  rescale(newScale: number, mode: RoundingMode = 'half_even'): Money {
    if (newScale === this.scale) return this;
    if (newScale > this.scale) {
      const factor = 10n ** BigInt(newScale - this.scale);
      return new Money(this.currency, this.amount * factor, newScale);
    }
    const divisor = 10n ** BigInt(this.scale - newScale);
    return new Money(this.currency, divideRounded(this.amount, divisor, mode), newScale);
  }

  add(other: Money): Money {
    const [a, b] = align(this, other);
    return new Money(a.currency, a.amount + b.amount, a.scale);
  }

  subtract(other: Money): Money {
    const [a, b] = align(this, other);
    return new Money(a.currency, a.amount - b.amount, a.scale);
  }

  negate(): Money {
    return new Money(this.currency, -this.amount, this.scale);
  }

  abs(): Money {
    return this.amount < 0n ? this.negate() : this;
  }

  /** Multiply by an exact integer count (quantities, units). */
  multiplyBy(count: number | bigint): Money {
    const n = typeof count === 'bigint' ? count : BigInt(assertInteger(count, 'multiplyBy'));
    return new Money(this.currency, this.amount * n, this.scale);
  }

  /**
   * Multiply by an exact decimal given as a string ("0.029", "1.0825").
   * The result keeps full precision; call `.rescale()` to settle it.
   */
  multiplyByDecimal(factor: string | number): Money {
    const { numerator, denominator } = decimalToRatio(factor);
    return this.multiplyByRatio(numerator, denominator);
  }

  multiplyByRatio(numerator: bigint, denominator: bigint, mode: RoundingMode = 'half_even'): Money {
    if (denominator === 0n) throw new ValidationError('Division by zero in multiplyByRatio');
    return new Money(this.currency, divideRounded(this.amount * numerator, denominator, mode), this.scale);
  }

  /** Divide into `parts` equal shares, at the current scale. */
  divideBy(divisor: number | bigint, mode: RoundingMode = 'half_even'): Money {
    const d = typeof divisor === 'bigint' ? divisor : BigInt(assertInteger(divisor, 'divideBy'));
    if (d === 0n) throw new ValidationError('Division by zero');
    return new Money(this.currency, divideRounded(this.amount, d, mode), this.scale);
  }

  /**
   * Split into `parts` shares whose sum is exactly this amount — the largest
   * remainder is distributed one minor unit at a time. Used for allocating
   * tooling, freight and setup charges across a production run.
   */
  allocate(parts: number): Money[] {
    const n = assertInteger(parts, 'allocate');
    if (n <= 0) throw new ValidationError(`allocate requires a positive part count, got ${n}`);
    const big = BigInt(n);
    const base = this.amount / big;
    let remainder = this.amount - base * big;
    const step = remainder < 0n ? -1n : 1n;
    if (remainder < 0n) remainder = -remainder;
    const out: Money[] = [];
    for (let i = 0; i < n; i += 1) {
      const extra = BigInt(i) < remainder ? step : 0n;
      out.push(new Money(this.currency, base + extra, this.scale));
    }
    return out;
  }

  /** Allocate proportionally to integer weights, preserving the exact total. */
  allocateByWeights(weights: readonly number[]): Money[] {
    if (weights.length === 0) throw new ValidationError('allocateByWeights requires at least one weight');
    const w = weights.map((x) => BigInt(assertInteger(x, 'allocateByWeights')));
    if (w.some((x) => x < 0n)) throw new ValidationError('Weights must be non-negative');
    const total = w.reduce((acc, x) => acc + x, 0n);
    if (total === 0n) throw new ValidationError('Weights must not sum to zero');
    const shares = w.map((x) => (this.amount * x) / total);
    let distributed = shares.reduce((acc, x) => acc + x, 0n);
    let remainder = this.amount - distributed;
    const step = remainder < 0n ? -1n : 1n;
    // Hand out leftover minor units to the largest fractional parts first.
    const order = w
      .map((x, i) => ({ i, frac: (this.amount * x) % total }))
      .sort((a, b) => (a.frac === b.frac ? a.i - b.i : a.frac > b.frac ? -1 : 1));
    let k = 0;
    while (remainder !== 0n && order.length > 0) {
      const target = order[k % order.length];
      if (target) {
        shares[target.i] = (shares[target.i] ?? 0n) + step;
        remainder -= step;
        distributed += step;
      }
      k += 1;
    }
    return shares.map((s) => new Money(this.currency, s, this.scale));
  }

  /* ---------------------------------------------------------------------- */
  /* Comparison                                                              */
  /* ---------------------------------------------------------------------- */

  compare(other: Money): -1 | 0 | 1 {
    const [a, b] = align(this, other);
    return a.amount < b.amount ? -1 : a.amount > b.amount ? 1 : 0;
  }
  equals(other: Money): boolean {
    return this.currency === other.currency && this.compare(other) === 0;
  }
  greaterThan(other: Money): boolean {
    return this.compare(other) > 0;
  }
  greaterThanOrEqual(other: Money): boolean {
    return this.compare(other) >= 0;
  }
  lessThan(other: Money): boolean {
    return this.compare(other) < 0;
  }
  lessThanOrEqual(other: Money): boolean {
    return this.compare(other) <= 0;
  }

  /* ---------------------------------------------------------------------- */
  /* Aggregation                                                             */
  /* ---------------------------------------------------------------------- */

  static sum(items: readonly Money[], currencyIfEmpty?: string): Money {
    const first = items[0];
    if (!first) {
      if (!currencyIfEmpty) throw new ValidationError('Money.sum of an empty list needs a currency');
      return Money.zero(currencyIfEmpty, MODELLING_SCALE);
    }
    return items.slice(1).reduce<Money>((acc, m) => acc.add(m), first);
  }

  /** Percentage of `total` this amount represents, as a decimal string with 6 dp. */
  static ratio(part: Money, total: Money): number {
    const [a, b] = align(part, total);
    if (b.amount === 0n) return 0;
    return Number((a.amount * 1_000_000n) / b.amount) / 1_000_000;
  }
}

/* -------------------------------------------------------------------------- */
/* Internals                                                                   */
/* -------------------------------------------------------------------------- */

function normaliseCurrency(currency: string): CurrencyCode {
  const cur = currency.trim().toUpperCase();
  if (!CURRENCY_RE.test(cur)) {
    throw new ValidationError(`Invalid currency code "${currency}" (expected ISO-4217 alpha-3)`);
  }
  return cur;
}

function align(a: Money, b: Money): [Money, Money] {
  if (a.currency !== b.currency) {
    throw new ValidationError(
      `Currency mismatch: ${a.currency} vs ${b.currency}. Convert explicitly with a dated FX rate.`,
      { left: a.currency, right: b.currency },
    );
  }
  if (a.scale === b.scale) return [a, b];
  const scale = Math.max(a.scale, b.scale);
  return [a.rescale(scale), b.rescale(scale)];
}

function assertInteger(value: number, op: string): number {
  if (!Number.isInteger(value)) {
    throw new ValidationError(`${op} requires an integer, got ${value}`);
  }
  return value;
}

function divideRounded(numerator: bigint, denominator: bigint, mode: RoundingMode): bigint {
  if (denominator === 0n) throw new ValidationError('Division by zero');
  const negative = numerator < 0n !== denominator < 0n;
  const n = numerator < 0n ? -numerator : numerator;
  const d = denominator < 0n ? -denominator : denominator;
  const q = n / d;
  const r = n % d;
  if (r === 0n) return negative ? -q : q;

  let rounded: bigint;
  switch (mode) {
    case 'floor':
      rounded = negative ? q + 1n : q;
      return negative ? -rounded : rounded;
    case 'ceil':
      rounded = negative ? q : q + 1n;
      return negative ? -rounded : rounded;
    case 'half_up':
      rounded = r * 2n >= d ? q + 1n : q;
      return negative ? -rounded : rounded;
    case 'half_even': {
      const twice = r * 2n;
      if (twice > d) rounded = q + 1n;
      else if (twice < d) rounded = q;
      else rounded = q % 2n === 0n ? q : q + 1n;
      return negative ? -rounded : rounded;
    }
  }
}

/** "2.9%" is not accepted; pass 0.029. Converts an exact decimal to a ratio. */
export function decimalToRatio(factor: string | number): { numerator: bigint; denominator: bigint } {
  const text = typeof factor === 'string' ? factor.trim() : String(factor);
  if (!/^-?\d+(\.\d+)?$/.test(text)) {
    throw new ValidationError(`Invalid decimal factor "${text}"`);
  }
  const negative = text.startsWith('-');
  const unsigned = negative ? text.slice(1) : text;
  const [intPart = '0', fracPart = ''] = unsigned.split('.');
  const numerator = BigInt(intPart + fracPart);
  const denominator = 10n ** BigInt(fracPart.length);
  return { numerator: negative ? -numerator : numerator, denominator };
}

/** Basis points helper: 250 bps = 2.50%. */
export function bps(value: number): { numerator: bigint; denominator: bigint } {
  return { numerator: BigInt(assertInteger(value, 'bps')), denominator: 10_000n };
}
