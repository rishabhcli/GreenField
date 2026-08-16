/**
 * Postgres connection pooling and transaction helpers.
 *
 * Target is Render managed Postgres 17. There is no local/dev variant of this
 * code path: `DATABASE_URL` names a hosted database, and `assertProductionTopology`
 * in `@foundry/core` refuses to start a production process pointed at localhost.
 */

import pg from 'pg';
import {
  ConflictError,
  FoundryError,
  InternalError,
  NotFoundError,
  ProviderUnavailableError,
  TimeoutError,
  ValidationError,
  toFoundryError,
} from '@foundry/core';
import { getLogger } from '@foundry/obs';
import type { z } from 'zod';

const { Pool, types } = pg;

export type DbPool = pg.Pool;
export type DbClient = pg.PoolClient;
/** Anything you can run a query on — lets repositories compose inside a transaction. */
export type Queryable = pg.Pool | pg.PoolClient;

// BIGINT (OID 20) arrives as a string by default so JS cannot silently lose
// precision. Money columns are BIGINT minor units, and every value we store
// fits comfortably in a JS safe integer, so we parse to number at the edge and
// throw loudly if that assumption is ever violated.
types.setTypeParser(20, (value: string) => {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new ValidationError(
      `BIGINT value ${value} exceeds JavaScript's safe integer range; it must be handled as a string`,
    );
  }
  return parsed;
});
// NUMERIC (OID 1700) stays a string. Never parse it to float — that is exactly
// the precision loss the Money type exists to prevent.
types.setTypeParser(1700, (value: string) => value);

export interface PoolConfig {
  readonly connectionString: string;
  readonly maxConnections?: number;
  readonly applicationName: string;
  readonly statementTimeoutMs?: number;
  readonly idleTimeoutMs?: number;
  readonly connectionTimeoutMs?: number;
}

/**
 * Render exposes two connection strings for a managed Postgres instance:
 * an internal hostname (no TLS required, same-VPC) and an external
 * `*.<region>-postgres.render.com` hostname that requires TLS. We key off the
 * hostname rather than a config flag so the same image works in both
 * topologies without a redeploy.
 */
export function requiresTls(connectionString: string): boolean {
  try {
    const url = new URL(connectionString);
    if (url.searchParams.get('sslmode') === 'disable') return false;
    if (url.searchParams.get('sslmode')) return true;
    return url.hostname.includes('.render.com') || url.hostname.includes('.rds.amazonaws.com');
  } catch {
    return false;
  }
}

export function createPool(config: PoolConfig): DbPool {
  const useTls = requiresTls(config.connectionString);

  const pool = new Pool({
    connectionString: config.connectionString,
    max: config.maxConnections ?? 10,
    // Deliberately shorter than any plausible network idle-kill window. The
    // external Render endpoint is reached over the public internet, where the
    // load balancer and any NAT in between will silently drop an idle TCP
    // session after a few minutes. Reaping our own idle clients first means the
    // pool decides when a connection dies, instead of discovering it inside a
    // query. A long agent run holds no transaction and queries intermittently
    // over many minutes, so it mostly pays a fresh TLS handshake — a few tens of
    // milliseconds against a run measured in minutes, which is the right trade.
    idleTimeoutMillis: config.idleTimeoutMs ?? 30_000,
    connectionTimeoutMillis: config.connectionTimeoutMs ?? 10_000,
    application_name: config.applicationName,
    statement_timeout: config.statementTimeoutMs ?? 30_000,
    // A query that has been cancelled server-side should not leave the client
    // waiting for a response that will never come.
    query_timeout: (config.statementTimeoutMs ?? 30_000) + 5_000,
    // TCP keepalive is off by default in `pg`, and that default is wrong for a
    // database on the far side of the public internet. Without it, a socket the
    // network has already discarded still looks alive to the pool, which hands
    // it to the next caller; that caller is the one that dies, with
    // `Connection terminated unexpectedly`. Probing from 10s of quiet both keeps
    // the intermediary's mapping alive and turns a dead peer into a connection
    // error the pool can replace between queries rather than during one.
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
    // Render's managed certificate chain is not in Node's default trust store
    // for the external endpoint. TLS is still negotiated and the traffic is
    // encrypted; only chain verification is relaxed, which is what Render's own
    // connection examples do.
    ...(useTls ? { ssl: { rejectUnauthorized: false } } : {}),
  });

  // An idle client erroring must not take down the process. `pg-pool` re-emits
  // it here precisely because there is no query promise left to reject, so an
  // unhandled `error` event would be an unhandled EventEmitter error and take
  // the worker with it. The pool has already discarded the client by the time
  // this runs; the next checkout reconnects.
  pool.on('error', (error: Error) => {
    getLogger().error({ err: error }, 'idle postgres client error');
  });

  return pool;
}

/**
 * `pool.connect()` with the same classification every query gets.
 *
 * Checkout is where a dropped connection most often surfaces — the pool notices
 * the socket is gone while handing one out, or the connect itself times out —
 * and every transaction helper below used to call `pool.connect()` outside its
 * `try`, so those failures escaped `mapPostgresError` entirely and reached the
 * worker as an unclassified `Error`. An unclassified error is non-retryable by
 * design, which is the opposite of what a lost connection warrants.
 */
async function connect(pool: DbPool): Promise<DbClient> {
  try {
    return await pool.connect();
  } catch (error) {
    throw mapPostgresError(error, { phase: 'connect' });
  }
}

/* -------------------------------------------------------------------------- */
/* Error mapping                                                               */
/* -------------------------------------------------------------------------- */

interface PgError extends Error {
  code?: string;
  constraint?: string;
  detail?: string;
  table?: string;
}

/**
 * SQLSTATEs where the correct response is to try again.
 *
 * Class 08 is "connection exception" and class 57 is "operator intervention";
 * both mean the connection, not the statement, is what went wrong. Serialization
 * and deadlock failures are retryable because the whole unit is re-executed.
 *
 * Deliberately absent: `08007` (transaction_resolution_unknown). The connection
 * dropped between COMMIT and the acknowledgement, so the transaction may or may
 * not have applied. Calling that retryable would let the platform re-run a
 * mutation that already committed; it stays `internal` so a human decides.
 */
const RETRYABLE_SQLSTATES = new Set([
  '40001', // serialization_failure
  '40P01', // deadlock_detected
  '53300', // too_many_connections
  '57P01', // admin_shutdown — server told us to go away
  '57P02', // crash_shutdown
  '57P03', // cannot_connect_now — starting up / recovering
  '08000', // connection_exception
  '08001', // sqlclient_unable_to_establish_sqlconnection
  '08003', // connection_does_not_exist
  '08004', // sqlserver_rejected_establishment_of_sqlconnection
  '08006', // connection_failure
]);

/**
 * Node socket and DNS `error.code`s that reach us through `pg` when the network
 * between this process and Render's Postgres endpoint fails.
 *
 * These are structured signals, not prose: `code` is set by libuv and `pg`
 * passes the error through untouched, so keying on it is the same mechanical
 * classification the SQLSTATE table above does.
 */
const RETRYABLE_SYSCALL_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'EPIPE',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENETDOWN',
  'ENOTFOUND', // DNS
  'EAI_AGAIN', // DNS, temporary
]);

/**
 * Connection failures `pg` raises with no code of any kind.
 *
 * Everything else in this file keys off a structured signal, because
 * string-matching a driver's prose is how a taxonomy rots. This set is the
 * documented exception and the reason is structural, not stylistic: at these
 * call sites `pg` constructs a bare `Error` carrying nothing but a message — no
 * SQLSTATE, no `errno`, no `severity`, nothing to key on.
 *
 *   pg/lib/client.js:204   'Connection terminated unexpectedly'   (socket closed under us)
 *   pg/lib/client.js:204   'Connection terminated'                (closed by our own end())
 *   pg/lib/client.js:170   'timeout expired'                      (client connectionTimeout)
 *   pg/lib/client.js:707   'Query read timeout'                   (client query_timeout)
 *   pg/lib/client.js:749   'Client has encountered a connection error and is not queryable'
 *   pg/lib/client.js:756   'Client was closed and is not queryable'
 *   pg-pool/index.js:224   'timeout exceeded when trying to connect'
 *   pg-pool/index.js:276   'Connection terminated due to connection timeout'
 *
 * `Connection terminated unexpectedly` is the one that was observed in
 * production: an idle socket dropped by the network between this process and
 * `dpg-*.oregon-postgres.render.com`, handed to the next query, surfacing as an
 * unclassified error that the queue then treated as permanent and refused to
 * retry.
 *
 * Messages are compared exactly rather than by substring or regex. A `pg`
 * upgrade that rewords one of them fails closed — back to `internal`, which is
 * the behaviour that shipped before this fix — instead of silently widening
 * what the platform is willing to retry.
 */
const CODELESS_CONNECTION_LOSS = new Set([
  'Connection terminated unexpectedly',
  'Connection terminated',
  'Client has encountered a connection error and is not queryable',
  'Client was closed and is not queryable',
]);

const CODELESS_CONNECTION_TIMEOUT = new Set([
  'Connection terminated due to connection timeout',
  'timeout exceeded when trying to connect',
  'Query read timeout',
  'timeout expired',
]);

/**
 * `pg-pool` wraps the underlying failure as `{ cause }` (see index.js:276), so
 * the code that classifies the error is often one level down. Bounded so a
 * self-referential chain cannot spin.
 */
function errorChain(error: unknown, maxDepth = 5): Error[] {
  const chain: Error[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < maxDepth && current instanceof Error; depth += 1) {
    chain.push(current);
    const next: unknown = (current as { cause?: unknown }).cause;
    if (next === current) break;
    current = next;
  }
  return chain;
}

export function mapPostgresError(error: unknown, context: Record<string, unknown> = {}): Error {
  // A domain error raised inside a transaction (an illegal state transition, a
  // refund over the capture) is already correctly classified. Re-wrapping it as
  // an InternalError would lose its category, which drives retry behaviour and
  // the HTTP status the API returns.
  if (error instanceof FoundryError) return error;

  const chain = errorChain(error);
  // The link carrying the code is the one carrying `constraint` and `detail`
  // too, so classification and context stay taken from the same object.
  const pgError = (chain.find((link) => (link as PgError).code !== undefined) ?? error) as PgError;
  const code = pgError?.code;

  if (!code) {
    for (const link of chain) {
      if (CODELESS_CONNECTION_LOSS.has(link.message)) {
        return new ProviderUnavailableError('postgres', link.message, { ...context, driverError: link.message });
      }
      if (CODELESS_CONNECTION_TIMEOUT.has(link.message)) {
        // `0` matches the existing 57014 convention: the driver reports that a
        // deadline was exceeded without telling us which one, and inventing a
        // number would be worse than reporting none.
        return new TimeoutError(`postgres: ${link.message}`, 0);
      }
    }
    return toFoundryError(error);
  }

  if (RETRYABLE_SYSCALL_CODES.has(code)) {
    return new ProviderUnavailableError('postgres', `${code}: ${pgError.message}`, { ...context, syscallCode: code });
  }

  if (code === '23505') {
    return new ConflictError(`Unique constraint violated: ${pgError.constraint ?? 'unknown'}`, {
      ...context,
      constraint: pgError.constraint,
      detail: pgError.detail,
    });
  }
  if (code === '23503') {
    return new ValidationError(`Foreign key constraint violated: ${pgError.constraint ?? 'unknown'}`, {
      ...context,
      constraint: pgError.constraint,
      detail: pgError.detail,
    });
  }
  if (code === '23514') {
    return new ValidationError(`Check constraint violated: ${pgError.constraint ?? 'unknown'}`, {
      ...context,
      constraint: pgError.constraint,
    });
  }
  if (code === '23502') {
    return new ValidationError(`Null value in a non-nullable column`, { ...context, detail: pgError.detail });
  }
  if (code === '57014') {
    return new TimeoutError('postgres statement', 0);
  }
  if (RETRYABLE_SQLSTATES.has(code)) {
    return new ProviderUnavailableError('postgres', `${code}: ${pgError.message}`, context);
  }
  return new InternalError(`Postgres error ${code}: ${pgError.message}`, error, context);
}

export function isSerializationFailure(error: unknown): boolean {
  const code = (error as PgError)?.code;
  return code === '40001' || code === '40P01';
}

/* -------------------------------------------------------------------------- */
/* Query helpers                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Runs a query and validates every row against a schema.
 *
 * Validating on read is not ceremony: a migration that renames a column, or a
 * NULL where the code assumes a value, otherwise surfaces as `undefined`
 * propagating silently into a margin calculation. Here it fails at the source.
 */
export async function q<T>(
  db: Queryable,
  sql: string,
  params: readonly unknown[],
  rowSchema: z.ZodType<T>,
): Promise<T[]> {
  let result: pg.QueryResult;
  try {
    result = await db.query(sql, params as unknown[]);
  } catch (error) {
    throw mapPostgresError(error, { sql: sql.slice(0, 200) });
  }
  return result.rows.map((row, index) => {
    const parsed = rowSchema.safeParse(row);
    if (!parsed.success) {
      throw new ValidationError(
        `Row ${index} did not match the expected shape: ${parsed.error.message}`,
        { sql: sql.slice(0, 200), issues: parsed.error.issues.slice(0, 5) },
      );
    }
    return parsed.data;
  });
}

/** Exactly-one variant; throws `NotFoundError` when the row is absent. */
export async function qOne<T>(
  db: Queryable,
  sql: string,
  params: readonly unknown[],
  rowSchema: z.ZodType<T>,
  resource = 'row',
  id = 'unknown',
): Promise<T> {
  const rows = await q(db, sql, params, rowSchema);
  const first = rows[0];
  if (first === undefined) throw new NotFoundError(resource, id);
  if (rows.length > 1) {
    throw new InternalError(`Expected at most one ${resource} but got ${rows.length}`, undefined, { sql: sql.slice(0, 200) });
  }
  return first;
}

/** Zero-or-one variant. */
export async function qMaybe<T>(
  db: Queryable,
  sql: string,
  params: readonly unknown[],
  rowSchema: z.ZodType<T>,
): Promise<T | undefined> {
  const rows = await q(db, sql, params, rowSchema);
  return rows[0];
}

/** For statements with no meaningful result set. Returns the row count. */
export async function exec(db: Queryable, sql: string, params: readonly unknown[] = []): Promise<number> {
  try {
    const result = await db.query(sql, params as unknown[]);
    return result.rowCount ?? 0;
  } catch (error) {
    throw mapPostgresError(error, { sql: sql.slice(0, 200) });
  }
}

/* -------------------------------------------------------------------------- */
/* Transactions                                                                */
/* -------------------------------------------------------------------------- */

export async function withTransaction<T>(pool: DbPool, fn: (client: DbClient) => Promise<T>): Promise<T> {
  const client = await connect(pool);
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      // Report the rollback failure but never let it mask the original error.
      getLogger().error({ err: rollbackError }, 'rollback failed');
    }
    throw mapPostgresError(error);
  } finally {
    client.release();
  }
}

/**
 * SERIALIZABLE with bounded retry.
 *
 * Used for the operations where a lost update would be a real business error:
 * applying an order state transition, reserving budget, appending to the audit
 * hash chain. Postgres will abort one of two conflicting transactions with
 * 40001; retrying is correct and safe precisely because the whole unit is
 * re-executed.
 */
export async function withSerializableTransaction<T>(
  pool: DbPool,
  fn: (client: DbClient) => Promise<T>,
  maxAttempts = 3,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const client = await connect(pool);
    try {
      await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        /* connection is already broken; the pool will discard it */
      }
      lastError = error;
      if (!isSerializationFailure(error) || attempt === maxAttempts) {
        throw mapPostgresError(error, { attempt });
      }
      getLogger().warn({ attempt }, 'serialization failure, retrying transaction');
      // Small randomised backoff so two conflicting workers do not re-collide.
      await new Promise((resolve) => setTimeout(resolve, 10 * attempt + Math.random() * 20));
    } finally {
      client.release();
    }
  }
  throw mapPostgresError(lastError);
}

/**
 * READ COMMITTED transaction intended to be paired with `SELECT ... FOR UPDATE`.
 *
 * Use this — not `withSerializableTransaction` — when the contended resource is
 * a single identified row. Under SERIALIZABLE, five writers taking `FOR UPDATE`
 * on the same order row all block, and then every waiter is aborted with 40001
 * the moment the winner commits, producing a retry storm for what is really
 * ordinary lock contention. Under READ COMMITTED the waiters block, acquire the
 * lock in turn, and re-read the freshly committed row, which is exactly the
 * semantics an order state transition needs.
 *
 * SERIALIZABLE remains correct for the cases where the conflict is over a
 * *predicate* rather than a row — the audit chain reading MAX(chain_position),
 * for instance, where there is no row to lock.
 */
export async function withRowLockTransaction<T>(
  pool: DbPool,
  fn: (client: DbClient) => Promise<T>,
): Promise<T> {
  const client = await connect(pool);
  try {
    await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* connection already broken; the pool discards it */
    }
    throw mapPostgresError(error);
  } finally {
    client.release();
  }
}

/**
 * Session-level advisory lock.
 *
 * Two Render instances booting simultaneously must not both run migrations, and
 * two workers must not both trigger the same deploy. The lock is held on one
 * dedicated connection and always released, including on failure.
 */
export async function withAdvisoryLock<T>(pool: DbPool, key: string, fn: () => Promise<T>): Promise<T> {
  const lockId = advisoryLockId(key);
  const client = await connect(pool);
  try {
    await client.query('SELECT pg_advisory_lock($1)', [lockId]);
    return await fn();
  } finally {
    try {
      await client.query('SELECT pg_advisory_unlock($1)', [lockId]);
    } catch (error) {
      getLogger().error({ err: error, key }, 'failed to release advisory lock');
    }
    client.release();
  }
}

/** Non-blocking variant: returns undefined when the lock is already held. */
export async function tryAdvisoryLock<T>(
  pool: DbPool,
  key: string,
  fn: () => Promise<T>,
): Promise<T | undefined> {
  const lockId = advisoryLockId(key);
  const client = await connect(pool);
  try {
    const result = await client.query<{ pg_try_advisory_lock: boolean }>(
      'SELECT pg_try_advisory_lock($1)',
      [lockId],
    );
    if (!result.rows[0]?.pg_try_advisory_lock) return undefined;
    try {
      return await fn();
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [lockId]);
    }
  } finally {
    client.release();
  }
}

/** Stable 64-bit signed key from a string, for pg_advisory_lock. */
export function advisoryLockId(key: string): string {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (const byte of Buffer.from(key, 'utf8')) {
    hash = ((hash ^ BigInt(byte)) * prime) & mask;
  }
  // Fold into the signed 64-bit range Postgres expects.
  const signed = hash >= 0x8000000000000000n ? hash - 0x10000000000000000n : hash;
  return signed.toString();
}
