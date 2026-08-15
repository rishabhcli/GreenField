/**
 * Prefixed, lexicographically sortable identifiers (ULID body + type prefix).
 *
 * Sortable IDs matter operationally: audit logs, order events and agent traces
 * are read in insertion order across shards without a join on `created_at`.
 * The prefix makes every ID self-describing in logs and support conversations.
 */

import { randomFillSync } from 'node:crypto';
import { ValidationError } from './errors.js';

const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32, no I L O U
const ENCODING_LEN = 32n;
const TIME_CHARS = 10;
const RANDOM_CHARS = 16;

export const ID_PREFIXES = {
  company: 'co',
  agent: 'ag',
  agentRun: 'run',
  agentMessage: 'amsg',
  task: 'task',
  evidence: 'evd',
  evidenceSource: 'esrc',
  painPoint: 'pain',
  opportunity: 'opp',
  scorecard: 'score',
  expertReview: 'xrev',
  supplier: 'sup',
  supplierContact: 'scon',
  rfq: 'rfq',
  quote: 'quote',
  costModel: 'cost',
  product: 'prod',
  variant: 'var',
  brand: 'brand',
  asset: 'asset',
  site: 'site',
  siteBuild: 'build',
  deployment: 'dep',
  qaRun: 'qa',
  defect: 'bug',
  order: 'ord',
  orderEvent: 'oev',
  lineItem: 'li',
  customer: 'cust',
  payment: 'pay',
  refund: 'ref',
  dispute: 'dsp',
  shipment: 'shp',
  fulfilment: 'ful',
  campaign: 'camp',
  adSet: 'adset',
  creative: 'crea',
  experiment: 'exp',
  // NOT `aud` — that belongs to `auditEvent` below, and has since the schema was
  // laid down. Two kinds sharing a prefix silently breaks `idKindOf` (the later
  // registry entry wins) and, worse, makes `isId`/`assertId` accept an id of the
  // wrong kind. `auditEvent` cannot move: `audit_events` is append-only and
  // hash-chained, so its ids are already baked into the chain material.
  audienceSegment: 'aseg',
  experimentArm: 'arm',
  metricSnapshot: 'msnap',
  ticket: 'tkt',
  message: 'msg',
  ledgerEntry: 'led',
  policyDecision: 'pol',
  approval: 'appr',
  auditEvent: 'aud',
  webhookEvent: 'whk',
  job: 'job',
  sandbox: 'sbx',
  browserSession: 'bses',
  document: 'doc',
  idempotency: 'idem',
  budget: 'bdg',
  killSwitch: 'kill',
  verification: 'vrf',
} as const;

export type IdKind = keyof typeof ID_PREFIXES;
export type Id<K extends IdKind> = string & { readonly __idKind?: K };

/**
 * Reverse index, built with the uniqueness check that the registry itself
 * cannot express.
 *
 * `new Map(entries)` silently keeps the *last* writer for a repeated key, so a
 * duplicate prefix used to degrade quietly in two directions at once:
 * `idKindOf` reported the wrong kind for every id of the shadowed type, and
 * `isId(value, shadowedKind)` returned true for an id belonging to the other
 * kind — meaning `assertId` would wave through, say, an audit-event id where an
 * audience-segment id was required. Neither failure surfaces at the point of
 * the mistake; both surface later as a cross-entity lookup that returns the
 * wrong row.
 *
 * So the registry is validated when the module loads. This is cheap (one pass
 * over ~55 literals, no I/O, well inside `packages/core`'s purity rule) and it
 * fails at import time, which is the only moment where "someone reused a
 * prefix" is still a one-line fix rather than a data-forensics exercise.
 */
function buildPrefixIndex(): ReadonlyMap<string, IdKind> {
  const index = new Map<string, IdKind>();
  const collisions: string[] = [];
  const malformed: string[] = [];
  for (const [kind, prefix] of Object.entries(ID_PREFIXES) as [IdKind, string][]) {
    // An `_` in a prefix would break `idKindOf`, which splits on the first one.
    // Same class of bug, so it is caught in the same place.
    if (!/^[a-z][a-z0-9]*$/.test(prefix)) {
      malformed.push(`"${kind}" -> "${prefix}"`);
      continue;
    }
    const existing = index.get(prefix);
    if (existing !== undefined) {
      collisions.push(`"${prefix}" is claimed by both "${existing}" and "${kind}"`);
      continue;
    }
    index.set(prefix, kind);
  }
  if (collisions.length > 0 || malformed.length > 0) {
    throw new ValidationError(
      'ID_PREFIXES is not a valid registry: ' +
        [
          collisions.length > 0 ? `duplicate prefixes (${collisions.join('; ')})` : '',
          malformed.length > 0
            ? `malformed prefixes, expected /^[a-z][a-z0-9]*$/ (${malformed.join('; ')})`
            : '',
        ]
          .filter(Boolean)
          .join('; '),
      { collisions, malformed },
    );
  }
  return index;
}

const PREFIX_TO_KIND = buildPrefixIndex();

/**
 * Re-runs the registry validation and returns the problems instead of throwing.
 *
 * The module-load guard above already makes a duplicate prefix unimportable, so
 * this exists for the test that pins the guard itself: a check that can only be
 * observed by crashing the process is a check nobody can assert on.
 */
export function validateIdPrefixes(): readonly string[] {
  try {
    buildPrefixIndex();
    return [];
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
}

let lastTime = -1;
let lastRandom: bigint = 0n;

function encodeBase32(value: bigint, length: number): string {
  let out = '';
  let v = value;
  for (let i = 0; i < length; i += 1) {
    const rem = Number(v % ENCODING_LEN);
    out = ENCODING[rem] + out;
    v /= ENCODING_LEN;
  }
  return out;
}

function randomBigInt(bytes: number): bigint {
  const buf = new Uint8Array(bytes);
  randomFillSync(buf);
  let v = 0n;
  for (const b of buf) v = (v << 8n) | BigInt(b);
  return v;
}

/** Raw 26-character ULID. Monotonic within the same millisecond. */
export function ulid(now = Date.now()): string {
  if (now === lastTime) {
    lastRandom += 1n;
  } else {
    lastTime = now;
    lastRandom = randomBigInt(10); // 80 bits
  }
  return encodeBase32(BigInt(now), TIME_CHARS) + encodeBase32(lastRandom, RANDOM_CHARS);
}

/** `newId('order')` -> `ord_01J9ZK...`. */
export function newId<K extends IdKind>(kind: K, now?: number): Id<K> {
  return `${ID_PREFIXES[kind]}_${ulid(now)}` as Id<K>;
}

export function isId<K extends IdKind>(value: unknown, kind: K): value is Id<K> {
  if (typeof value !== 'string') return false;
  const prefix = ID_PREFIXES[kind];
  if (!value.startsWith(`${prefix}_`)) return false;
  const body = value.slice(prefix.length + 1);
  return body.length === TIME_CHARS + RANDOM_CHARS && [...body].every((c) => ENCODING.includes(c));
}

export function assertId<K extends IdKind>(value: unknown, kind: K): Id<K> {
  if (!isId(value, kind)) {
    throw new ValidationError(`Expected a "${kind}" id (prefix "${ID_PREFIXES[kind]}_"), got ${String(value)}`);
  }
  return value;
}

export function idKindOf(value: string): IdKind | undefined {
  const idx = value.indexOf('_');
  if (idx <= 0) return undefined;
  return PREFIX_TO_KIND.get(value.slice(0, idx));
}

/** Milliseconds encoded in the ULID body — useful for retention sweeps. */
export function idTimestamp(value: string): number | undefined {
  const idx = value.indexOf('_');
  const body = idx > 0 ? value.slice(idx + 1) : value;
  if (body.length !== TIME_CHARS + RANDOM_CHARS) return undefined;
  let time = 0n;
  for (const c of body.slice(0, TIME_CHARS)) {
    const digit = ENCODING.indexOf(c);
    if (digit < 0) return undefined;
    time = time * ENCODING_LEN + BigInt(digit);
  }
  return Number(time);
}

/**
 * Deterministic idempotency key for an operation. Same inputs always produce
 * the same key so a retried job never double-charges or double-orders.
 */
export function idempotencyKey(namespace: string, ...parts: readonly (string | number)[]): string {
  const material = [namespace, ...parts.map(String)].join('|');
  // FNV-1a 64-bit, rendered base32 — short, stable, and safe to log.
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (const byte of Buffer.from(material, 'utf8')) {
    hash = ((hash ^ BigInt(byte)) * prime) & mask;
  }
  return `${namespace}_${encodeBase32(hash, 13)}`;
}
