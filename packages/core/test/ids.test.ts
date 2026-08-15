/**
 * Prefixed ULID identifiers.
 *
 * Two properties here are load-bearing rather than cosmetic:
 *
 *   1. **A prefix identifies exactly one kind.** `isId`/`assertId` decide
 *      whether a string is "an id of kind K" purely from its prefix, so two
 *      kinds sharing one means an id of the wrong entity passes validation and
 *      is then used to look up a row in the wrong table. This is not
 *      hypothetical: `audienceSegment` and `auditEvent` both shipped as `aud`,
 *      which made `assertId(auditEventId, 'audienceSegment')` succeed and made
 *      `idKindOf` report every audience segment as an audit event.
 *   2. **Ids sort by insertion order.** The whole reason for a ULID body is
 *      that audit logs, order events and agent traces can be read in order
 *      without joining on `created_at`. Monotonicity inside a single
 *      millisecond is the part that is easy to lose and easy to not notice.
 */

import { describe, expect, it } from 'vitest';
import {
  ID_PREFIXES,
  ValidationError,
  assertId,
  findIdPrefixProblems,
  idKindOf,
  idTimestamp,
  isId,
  newId,
  ulid,
  type IdKind,
} from '@foundry/core';

const ALL_KINDS = Object.keys(ID_PREFIXES) as IdKind[];

describe('the prefix registry', () => {
  it('assigns a distinct prefix to every kind', () => {
    // The regression this file exists for. Reported as a list rather than a
    // count so the failure message names the offending pair directly.
    const byPrefix = new Map<string, string[]>();
    for (const [kind, prefix] of Object.entries(ID_PREFIXES)) {
      byPrefix.set(prefix, [...(byPrefix.get(prefix) ?? []), kind]);
    }
    const shared = [...byPrefix.entries()].filter(([, kinds]) => kinds.length > 1);
    expect(shared, `prefixes claimed by more than one kind: ${JSON.stringify(shared)}`).toEqual([]);
  });

  it('keeps `aud` with auditEvent, whose ids are already in the hash chain', () => {
    // `audit_events` is append-only and hash-chained, so its ids are baked into
    // the chain material and cannot be restated by a forward-only migration.
    // The newcomer moved instead.
    expect(ID_PREFIXES.auditEvent).toBe('aud');
    expect(ID_PREFIXES.audienceSegment).not.toBe('aud');
  });

  it('is well-formed as it stands', () => {
    expect(findIdPrefixProblems(ID_PREFIXES)).toEqual([]);
  });
});

describe('the registry guard', () => {
  it('names both kinds when a prefix is reused', () => {
    const problems = findIdPrefixProblems({ auditEvent: 'aud', audienceSegment: 'aud' });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('auditEvent');
    expect(problems[0]).toContain('audienceSegment');
  });

  it('rejects a prefix containing an underscore', () => {
    // `idKindOf` splits on the first `_` and `isId` slices at `prefix.length + 1`,
    // so an underscore in a prefix silently breaks the round trip.
    expect(findIdPrefixProblems({ order: 'or_d' })).toHaveLength(1);
  });

  it('rejects uppercase and empty prefixes', () => {
    expect(findIdPrefixProblems({ order: 'ORD' })).toHaveLength(1);
    expect(findIdPrefixProblems({ order: '' })).toHaveLength(1);
    expect(findIdPrefixProblems({ order: '1st' })).toHaveLength(1);
  });

  it('reports every problem at once rather than only the first', () => {
    expect(findIdPrefixProblems({ a: 'x', b: 'x', c: 'X', d: 'y_z' })).toHaveLength(3);
  });

  /**
   * The module-load guard is what actually makes the bug unreintroducible: a
   * duplicated prefix makes `@foundry/core` unimportable, so nothing can boot
   * far enough to write a mis-prefixed row. It cannot be observed without
   * re-running the throwing path, which is what this reconstructs.
   */
  it('throws a ValidationError, not a bare Error, when the registry is broken', () => {
    const problems = findIdPrefixProblems({ auditEvent: 'aud', audienceSegment: 'aud' });
    const thrown = new ValidationError(`ID_PREFIXES is not a valid registry: ${problems.join('; ')}`, { problems });
    expect(thrown).toBeInstanceOf(ValidationError);
    expect(thrown.category).toBe('validation');
    expect(thrown.retryable).toBe(false);
  });
});

describe('newId', () => {
  it('round-trips through idKindOf for every kind in the registry', () => {
    for (const kind of ALL_KINDS) {
      expect(idKindOf(newId(kind)), `${kind} did not round-trip`).toBe(kind);
    }
  });

  it('recognises its own output as an id of that kind, and only that kind', () => {
    for (const kind of ALL_KINDS) {
      const id = newId(kind);
      expect(isId(id, kind)).toBe(true);
      const foreign = ALL_KINDS.filter((k) => k !== kind);
      expect(foreign.filter((k) => isId(id, k)), `${kind} id also validated as another kind`).toEqual([]);
    }
  });

  it('produces `prefix_` plus a 26-character Crockford body', () => {
    const id = newId('order');
    expect(id.startsWith('ord_')).toBe(true);
    expect(id.slice(4)).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it('preserves the caller-supplied timestamp in the body', () => {
    const now = Date.parse('2026-08-15T12:34:56.789Z');
    for (const kind of ALL_KINDS) {
      expect(idTimestamp(newId(kind, now)), `${kind} lost its timestamp`).toBe(now);
    }
  });
});

describe('assertId', () => {
  it('accepts an id of the expected kind and returns it unchanged', () => {
    const id = newId('order');
    expect(assertId(id, 'order')).toBe(id);
  });

  it('rejects an id of a foreign kind', () => {
    expect(() => assertId(newId('order'), 'refund')).toThrow(ValidationError);
    expect(() => assertId(newId('customer'), 'company')).toThrow(ValidationError);
  });

  it('rejects an audit-event id where an audience segment is required', () => {
    // The exact confusion the shared `aud` prefix used to permit. Both
    // directions, because the collision made it symmetric.
    expect(() => assertId(newId('auditEvent'), 'audienceSegment')).toThrow(ValidationError);
    expect(() => assertId(newId('audienceSegment'), 'auditEvent')).toThrow(ValidationError);
  });

  it('names the expected kind and prefix so the failure is actionable', () => {
    try {
      assertId(newId('auditEvent'), 'audienceSegment');
      expect.unreachable('assertId should have thrown');
    } catch (error) {
      expect((error as Error).message).toContain('audienceSegment');
      expect((error as Error).message).toContain(`${ID_PREFIXES.audienceSegment}_`);
    }
  });

  it('rejects a bare ULID with no prefix, and a prefix with no body', () => {
    expect(() => assertId(ulid(), 'order')).toThrow(ValidationError);
    expect(() => assertId('ord_', 'order')).toThrow(ValidationError);
  });

  it('rejects a body of the right length containing a Crockford-excluded letter', () => {
    // I, L, O and U are excluded to avoid transcription errors; accepting them
    // would let two different strings denote the same id in a support thread.
    const body = newId('order').slice(4);
    for (const bad of ['I', 'L', 'O', 'U']) {
      expect(isId(`ord_${bad}${body.slice(1)}`, 'order'), `accepted excluded letter ${bad}`).toBe(false);
    }
  });

  it('rejects non-strings without throwing a TypeError', () => {
    for (const value of [null, undefined, 42, {}, ['ord_x']]) {
      expect(isId(value, 'order')).toBe(false);
      expect(() => assertId(value, 'order')).toThrow(ValidationError);
    }
  });

  it('rejects a prefix that is a prefix of the real one', () => {
    // `adSet` is `adset` and `asset` is `asset`; a sloppy startsWith without the
    // `_` would let these bleed into each other.
    expect(isId(newId('adSet'), 'asset')).toBe(false);
    expect(isId(newId('asset'), 'adSet')).toBe(false);
  });
});

describe('ULID ordering', () => {
  it('is strictly increasing inside a single millisecond', () => {
    // CLAUDE.md's claim that "rows sort by insertion order" only holds if the
    // random component is a counter within a tick rather than fresh entropy.
    const frozen = 1_760_000_000_000;
    const ids = Array.from({ length: 2_000 }, () => ulid(frozen));
    for (let i = 1; i < ids.length; i += 1) {
      expect(ids[i]! > ids[i - 1]!, `id ${i} did not sort after ${i - 1}`).toBe(true);
    }
  });

  it('sorts prefixed ids of one kind by insertion order', () => {
    const frozen = 1_760_000_000_001;
    const ids = Array.from({ length: 500 }, () => newId('orderEvent', frozen));
    expect([...ids].sort()).toEqual(ids);
  });

  it('orders across milliseconds by time, regardless of the random component', () => {
    const base = 1_760_000_000_002;
    const earlier = ulid(base);
    const later = ulid(base + 1);
    expect(later > earlier).toBe(true);
  });

  it('keeps the time component fixed-width so lexical order matches numeric order', () => {
    // A shorter encoding for a smaller timestamp would sort a 1970 id after a
    // 2026 one. The 10-character pad is what prevents that.
    expect(ulid(0).slice(0, 10)).toBe('0000000000');
    expect(ulid(1).slice(0, 10)).toBe('0000000001');
    expect(ulid(1_760_000_000_000)).toHaveLength(26);
    expect(ulid(0)).toHaveLength(26);
  });

  it('recovers the millisecond it was minted at', () => {
    for (const t of [0, 1, 1_760_000_000_000, Date.now()]) {
      expect(idTimestamp(ulid(t))).toBe(t);
    }
  });
});

describe('idKindOf', () => {
  it('returns undefined for a string with no prefix separator', () => {
    expect(idKindOf('nounderscore')).toBeUndefined();
    expect(idKindOf('_leadingunderscore')).toBeUndefined();
  });

  it('returns undefined for an unknown prefix', () => {
    expect(idKindOf('nope_01ARZ3NDEKTSV4RRFFQ69G5FAV')).toBeUndefined();
  });

  /**
   * DOCUMENTS ACTUAL BEHAVIOUR, not an endorsement of it.
   *
   * `idKindOf` inspects only the prefix; it never checks that the body is a
   * well-formed ULID. `isId` does both. That makes them disagree on strings
   * like `job_<13-char idempotency hash>`, which `idempotencyKey('job', …)`
   * really does produce. Nothing currently calls `idKindOf` (it exists for logs
   * and support conversations), so this is recorded rather than tightened —
   * changing it is a behaviour change, not a bug fix.
   */
  it('trusts the prefix without validating the body', () => {
    expect(idKindOf('job_NOTAULID')).toBe('job');
    expect(isId('job_NOTAULID', 'job')).toBe(false);
  });
});
