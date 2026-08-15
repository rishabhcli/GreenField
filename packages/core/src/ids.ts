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

const PREFIX_TO_KIND = new Map<string, IdKind>(
  Object.entries(ID_PREFIXES).map(([kind, prefix]) => [prefix, kind as IdKind]),
);

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
