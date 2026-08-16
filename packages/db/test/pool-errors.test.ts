/**
 * Postgres error classification.
 *
 * These are pure-function tests and need no database: the point is that a
 * dropped connection lands in a *retryable* category. It matters because the
 * worker turns a non-retryable error into a BullMQ `UnrecoverableError`
 * (`packages/queue/src/queues.ts`), so a misclassified network blip permanently
 * kills a job that would have succeeded five seconds later. That is what
 * happened to `run_01M03XWGXJZBFS49SWRRK9VVGE`, which died on a raw
 * `Connection terminated unexpectedly`.
 *
 * The errors constructed here are the exact objects `pg` and `pg-pool` build —
 * see the file:line references in `mapPostgresError` — including the fact that
 * the connection-loss ones carry no `code` at all.
 */

import { describe, expect, it } from 'vitest';
import { isFoundryError, FoundryError } from '@foundry/core';
import { mapPostgresError } from '@foundry/db';

/** A `pg` DatabaseError: SQLSTATE in `code`, plus the usual detail fields. */
function databaseError(code: string, message = 'db error', extra: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(message), { code, ...extra });
}

/** A libuv socket error as it arrives through `pg`. */
function syscallError(code: string, message = 'socket error'): Error {
  return Object.assign(new Error(message), { code, errno: -1, syscall: 'read' });
}

function classify(error: unknown): FoundryError {
  const mapped = mapPostgresError(error);
  if (!isFoundryError(mapped)) throw new Error('mapPostgresError must always return a FoundryError');
  return mapped;
}

describe('mapPostgresError — dropped connections are retryable', () => {
  it('classifies the bare "Connection terminated unexpectedly" that pg raises with no code', () => {
    // pg/lib/client.js:204 — a plain Error, no SQLSTATE, no errno.
    const raw = new Error('Connection terminated unexpectedly');
    expect((raw as { code?: string }).code).toBeUndefined();

    const mapped = classify(raw);
    expect(mapped.category).toBe('provider_unavailable');
    expect(mapped.retryable).toBe(true);
    expect(mapped.code).toBe('postgres.unavailable');
    expect(mapped.message).toContain('Connection terminated unexpectedly');
  });

  it.each([
    'Connection terminated',
    'Client has encountered a connection error and is not queryable',
    'Client was closed and is not queryable',
  ])('classifies the codeless connection-loss message %j as provider_unavailable', (message) => {
    const mapped = classify(new Error(message));
    expect(mapped.category).toBe('provider_unavailable');
    expect(mapped.retryable).toBe(true);
  });

  it.each([
    'Connection terminated due to connection timeout',
    'timeout exceeded when trying to connect',
    'Query read timeout',
    'timeout expired',
  ])('classifies the codeless timeout message %j as timeout', (message) => {
    const mapped = classify(new Error(message));
    expect(mapped.category).toBe('timeout');
    expect(mapped.retryable).toBe(true);
  });

  it('unwraps the cause pg-pool attaches when it rewrites a connect failure', () => {
    // pg-pool/index.js:276 wraps the real failure rather than replacing it.
    const wrapped = new Error('Connection terminated due to connection timeout', {
      cause: syscallError('ECONNRESET', 'read ECONNRESET'),
    });
    const mapped = classify(wrapped);
    expect(mapped.retryable).toBe(true);
  });

  it.each(['ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH'])(
    'classifies the socket/DNS code %s as provider_unavailable',
    (code) => {
      const mapped = classify(syscallError(code));
      expect(mapped.category).toBe('provider_unavailable');
      expect(mapped.retryable).toBe(true);
      expect(mapped.context['syscallCode']).toBe(code);
    },
  );

  it.each(['08000', '08001', '08003', '08004', '08006', '57P01', '57P02', '57P03', '53300'])(
    'classifies the connection-class SQLSTATE %s as provider_unavailable',
    (code) => {
      const mapped = classify(databaseError(code));
      expect(mapped.category).toBe('provider_unavailable');
      expect(mapped.retryable).toBe(true);
    },
  );

  it('leaves 08007 non-retryable: the transaction may already have committed', () => {
    const mapped = classify(databaseError('08007', 'transaction resolution unknown'));
    expect(mapped.category).toBe('internal');
    expect(mapped.retryable).toBe(false);
  });
});

describe('mapPostgresError — everything else keeps its existing classification', () => {
  it('maps a unique violation to a conflict, with the constraint preserved', () => {
    const mapped = classify(databaseError('23505', 'dup', { constraint: 'orders_pkey', detail: 'Key (id)=(1)' }));
    expect(mapped.category).toBe('conflict');
    expect(mapped.retryable).toBe(false);
    expect(mapped.context['constraint']).toBe('orders_pkey');
  });

  it.each([
    ['23503', 'validation'],
    ['23514', 'validation'],
    ['23502', 'validation'],
    ['57014', 'timeout'],
    ['40001', 'provider_unavailable'],
    ['40P01', 'provider_unavailable'],
  ] as const)('maps SQLSTATE %s to %s', (code, category) => {
    expect(classify(databaseError(code)).category).toBe(category);
  });

  it('does not re-wrap a FoundryError raised inside a transaction', () => {
    const domain = new (class extends FoundryError {
      constructor() {
        super({ category: 'policy_denied', message: 'refund exceeds capture' });
      }
    })();
    expect(mapPostgresError(domain)).toBe(domain);
  });

  it('fails closed on an unrecognised codeless error rather than guessing retryable', () => {
    // A reworded pg message, or any unrelated throw, must land in `internal` —
    // non-retryable — instead of widening what the platform will hammer.
    const mapped = classify(new Error('Connection was terminated in an unexpected manner'));
    expect(mapped.category).toBe('internal');
    expect(mapped.retryable).toBe(false);
  });

  it('reports an unknown SQLSTATE as internal, keeping the code in the message', () => {
    const mapped = classify(databaseError('42601', 'syntax error at or near "SELCT"'));
    expect(mapped.category).toBe('internal');
    expect(mapped.message).toContain('42601');
  });
});
