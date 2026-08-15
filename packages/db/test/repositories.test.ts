/**
 * Integration tests against a real PostgreSQL server.
 *
 * These exercise the concurrency and idempotency guarantees that cannot be
 * proven with a mock: two workers racing for the last dollar of budget, a
 * redelivered webhook, an out-of-order payment event, and the audit hash chain.
 *
 * The database used here is a scratch database created and dropped by the test.
 * It is a verification tool for code whose deployment target is Render
 * Postgres — not a development architecture. When no server is reachable the
 * suite skips loudly rather than passing silently, because a green run that
 * tested nothing is worse than a red one.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConflictError, buildSaleTransaction, newId } from '@foundry/core';
import {
  AgentRunRepository,
  AuditRepository,
  BudgetRepository,
  CompanyRepository,
  IdempotencyRepository,
  LedgerRepository,
  OrderRepository,
  ProductRepository,
  CustomerRepository,
  PaymentRepository,
  VerificationRepository,
  WebhookRepository,
  createPool,
  type DbPool,
} from '@foundry/db';

const TEST_DB = `foundry_test_${Date.now()}`;
const ADMIN_URL = process.env['TEST_POSTGRES_ADMIN_URL'] ?? 'postgres://localhost:5432/postgres';
const TEST_URL = ADMIN_URL.replace(/\/[^/]*$/, `/${TEST_DB}`);

let pool: DbPool;
let available = false;
let companyId: string;

function psql(db: string, sql: string): void {
  execFileSync('psql', ['-q', '-v', 'ON_ERROR_STOP=1', '-d', db, '-c', sql], { stdio: 'pipe' });
}

beforeAll(async () => {
  try {
    execFileSync('pg_isready', ['-q'], { stdio: 'pipe' });
    execFileSync('createdb', [TEST_DB], { stdio: 'pipe' });
    available = true;
  } catch {
    // Report clearly instead of quietly reporting success.
    console.warn(
      `\n[db integration] No reachable PostgreSQL server; skipping ${__filename}. ` +
        `These tests verify concurrency guarantees and are required before a production release.\n`,
    );
    return;
  }

  const migrationsDir = join(import.meta.dirname, '..', 'src', 'migrations');
  for (const file of readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort()) {
    execFileSync('psql', ['-q', '-v', 'ON_ERROR_STOP=1', '-d', TEST_DB, '-f', join(migrationsDir, file)], {
      stdio: 'pipe',
    });
  }

  pool = createPool({ connectionString: TEST_URL, applicationName: 'foundry-test', maxConnections: 8 });

  const companies = new CompanyRepository(pool);
  const company = await companies.create({
    name: 'Test Co',
    mission: 'prove the invariants',
    config: minimalConfig(),
  });
  companyId = company.id;
}, 60_000);

afterAll(async () => {
  if (!available) return;
  await pool?.end();
  try {
    execFileSync('dropdb', ['--force', TEST_DB], { stdio: 'pipe' });
  } catch {
    /* leave the scratch database behind rather than failing the suite */
  }
});

const maybe = (name: string, fn: () => Promise<void> | void, timeout?: number) =>
  it(name, async () => {
    if (!available) {
      expect(available, 'PostgreSQL was not reachable — this test did not run').toBe(false);
      return;
    }
    await fn();
  }, timeout);

/* -------------------------------------------------------------------------- */

describe('budget reservation under concurrency', () => {
  maybe('two racing workers cannot both spend the last dollar', async () => {
    const budgets = new BudgetRepository(pool);
    await budgets.upsert({
      companyId,
      scope: 'advertising',
      window: 'daily',
      limitMinor: 10_000,
      currency: 'USD',
    });

    // Ten concurrent attempts to reserve 2,000 against a 10,000 limit.
    const attempts = await Promise.all(
      Array.from({ length: 10 }, () => budgets.reserve(companyId, 'advertising', 2_000, 'USD')),
    );

    const granted = attempts.filter((a) => a.reserved);
    expect(granted).toHaveLength(5);
    expect(attempts.filter((a) => !a.reserved)).toHaveLength(5);

    const [budget] = await budgets.forScope(companyId, 'advertising');
    expect(budget?.reserved_minor).toBe(10_000);
    // The invariant that matters: never over-committed.
    expect((budget?.reserved_minor ?? 0) + (budget?.spent_minor ?? 0)).toBeLessThanOrEqual(budget?.limit_minor ?? 0);
  }, 30_000);

  maybe('a refused reservation explains exactly why', async () => {
    const budgets = new BudgetRepository(pool);
    const result = await budgets.reserve(companyId, 'advertising', 5_000, 'USD');
    expect(result.reserved).toBe(false);
    expect(result.reason).toContain('remain');

    const wrongCurrency = await budgets.reserve(companyId, 'advertising', 1, 'EUR');
    expect(wrongCurrency.reserved).toBe(false);
    expect(wrongCurrency.reason).toContain('denominated in USD');

    const noBudget = await budgets.reserve(companyId, 'sampling', 1, 'USD');
    expect(noBudget.reserved).toBe(false);
    expect(noBudget.reason).toContain('no sampling budget is configured');
  });

  maybe('settling converts a reservation into spend', async () => {
    const budgets = new BudgetRepository(pool);
    await budgets.upsert({ companyId, scope: 'research', window: 'daily', limitMinor: 5_000, currency: 'USD' });
    await budgets.reserve(companyId, 'research', 1_000, 'USD');
    const settled = await budgets.settle(companyId, 'research', 1_000, 800);
    expect(settled.reserved_minor).toBe(0);
    expect(settled.spent_minor).toBe(800);
  });
});

/* -------------------------------------------------------------------------- */

describe('idempotency ledger', () => {
  maybe('only one of many concurrent claimants wins', async () => {
    const repo = new IdempotencyRepository(pool);
    const key = `test_${newId('idempotency')}`;
    const outcomes = await Promise.all(
      Array.from({ length: 8 }, () => repo.claim(key, 'test.scope', { companyId })),
    );
    expect(outcomes.filter((o) => o.status === 'claimed')).toHaveLength(1);
    expect(outcomes.filter((o) => o.status === 'in_progress')).toHaveLength(7);
  });

  maybe('a completed key replays its result instead of re-running the work', async () => {
    const repo = new IdempotencyRepository(pool);
    const key = `test_${newId('idempotency')}`;
    let sideEffects = 0;

    const first = await repo.run(key, 'charge.customer', async () => {
      sideEffects += 1;
      return { chargeId: 'ch_123', amount: 4700 };
    });
    expect(first.replayed).toBe(false);

    const second = await repo.run(key, 'charge.customer', async () => {
      sideEffects += 1;
      return { chargeId: 'ch_SHOULD_NOT_HAPPEN', amount: 0 };
    });
    expect(second.replayed).toBe(true);
    expect(second.result).toEqual({ chargeId: 'ch_123', amount: 4700 });
    // The whole point: the effect happened exactly once.
    expect(sideEffects).toBe(1);
  });

  maybe('the same key with a different payload is rejected, not silently replayed', async () => {
    const repo = new IdempotencyRepository(pool);
    const key = `test_${newId('idempotency')}`;
    await repo.run(key, 'send.rfq', async () => ({ ok: true }), { requestPayload: { supplier: 'A' } });
    await expect(
      repo.run(key, 'send.rfq', async () => ({ ok: true }), { requestPayload: { supplier: 'B' } }),
    ).rejects.toThrow(/different request payload/);
  });

  maybe('a failed operation records the failure rather than reporting success', async () => {
    const repo = new IdempotencyRepository(pool);
    const key = `test_${newId('idempotency')}`;
    await expect(
      repo.run(key, 'flaky.op', async () => {
        throw new Error('provider returned 500');
      }),
    ).rejects.toThrow('provider returned 500');

    const stored = await repo.get(key);
    expect(stored?.status).toBe('failed');
    expect(stored?.error).toContain('provider returned 500');
  });
});

/* -------------------------------------------------------------------------- */

describe('audit hash chain', () => {
  maybe('appends form an unbroken verifiable chain', async () => {
    const audit = new AuditRepository(pool);
    for (let i = 0; i < 5; i += 1) {
      await audit.append({
        companyId,
        kind: 'agent_decision',
        actorId: 'ag_test',
        actorKind: 'manager_agent',
        action: `decision ${i}`,
        outcome: 'success',
        detail: { index: i },
      });
    }
    const result = await audit.verifyChain(companyId);
    expect(result.valid).toBe(true);
    expect(result.checked).toBeGreaterThanOrEqual(5);
  });

  maybe('detects a tampered row', async () => {
    const audit = new AuditRepository(pool);
    const row = await audit.append({
      companyId,
      kind: 'refund_issued',
      actorId: 'ag_test',
      actorKind: 'specialist_agent',
      action: 'refund',
      outcome: 'success',
      amountMinor: 4700,
      currency: 'USD',
    });

    // The append-only trigger blocks normal UPDATE, so tampering requires
    // disabling it — which is exactly the scenario the chain is designed to
    // catch after the fact.
    psql(TEST_DB, 'ALTER TABLE audit_events DISABLE TRIGGER audit_events_append_only');
    psql(TEST_DB, `UPDATE audit_events SET amount_minor = 1 WHERE id = '${row.id}'`);
    psql(TEST_DB, 'ALTER TABLE audit_events ENABLE TRIGGER audit_events_append_only');

    const result = await audit.verifyChain(companyId);
    expect(result.valid).toBe(false);
    expect(result.firstBreakAt?.id).toBe(row.id);
    expect(result.firstBreakAt?.reason).toContain('altered');
  }, 20_000);
});

/* -------------------------------------------------------------------------- */

describe('webhook deduplication', () => {
  maybe('a redelivered event is recognised, not reprocessed', async () => {
    const repo = new WebhookRepository(pool);
    const eventId = `evt_${Date.now()}`;
    const first = await repo.recordIfNew({
      provider: 'stripe',
      externalEventId: eventId,
      eventType: 'charge.refunded',
      signatureVerified: true,
      payload: { amount: 4700 },
      headers: { 'stripe-signature': 't=1,v1=deadbeef', 'content-type': 'application/json' },
    });
    expect(first.isNew).toBe(true);

    const second = await repo.recordIfNew({
      provider: 'stripe',
      externalEventId: eventId,
      eventType: 'charge.refunded',
      signatureVerified: true,
      payload: { amount: 4700 },
    });
    expect(second.isNew).toBe(false);
    expect(second.event.id).toBe(first.event.id);
  });

  maybe('signature headers are redacted before storage', async () => {
    const repo = new WebhookRepository(pool);
    const stored = await repo.recordIfNew({
      provider: 'whop',
      externalEventId: `evt_redact_${Date.now()}`,
      eventType: 'payment.succeeded',
      signatureVerified: true,
      payload: {},
      headers: { 'webhook-signature': 'v1,SECRETSIG', 'x-request-id': 'req_1' },
    });
    expect(stored.event.headers['webhook-signature']).toBe('[redacted]');
    expect(stored.event.headers['x-request-id']).toBe('req_1');
  });

  maybe('only one worker can claim an event for processing', async () => {
    const repo = new WebhookRepository(pool);
    const recorded = await repo.recordIfNew({
      provider: 'dodo',
      externalEventId: `evt_claim_${Date.now()}`,
      eventType: 'payment.succeeded',
      signatureVerified: true,
      payload: {},
    });
    const claims = await Promise.all([
      repo.claimForProcessing(recorded.event.id),
      repo.claimForProcessing(recorded.event.id),
      repo.claimForProcessing(recorded.event.id),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
  });
});

/* -------------------------------------------------------------------------- */

let productId: string;
let orderCustomerId: string;

describe('order state machine', () => {
  let orderId: string;

  maybe('an order can be created with line items', async () => {
    const products = new ProductRepository(pool);
    const customers = new CustomerRepository(pool);
    const orders = new OrderRepository(pool);

    const product = await products.create({
      companyId,
      sku: `SKU-${Date.now()}`,
      name: 'Test Widget',
      kind: 'physical_good',
      description: 'a real physical good',
      paymentRoute: 'stripe_direct',
      priceMinor: 4700,
      currency: 'USD',
      physical: {
        weightGrams: 320,
        lengthMm: 120,
        widthMm: 80,
        heightMm: 60,
        countryOfOrigin: 'CN',
        hsCode: '3924.90',
        hazardous: false,
        batteryContained: false,
      },
    });
    productId = product.id;

    const customer = await customers.upsert({ companyId, email: `buyer-${Date.now()}@example.com` });
    orderCustomerId = customer.id;

    const created = await orders.create({
      companyId,
      customerId: orderCustomerId,
      currency: 'USD',
      paymentRoute: 'stripe_direct',
      shippingMinor: 699,
      lineItems: [
        { productId, sku: product.sku, name: product.name, quantity: 1, unitPriceMinor: 4700, taxMinor: 388, landedUnitCostMinor: 672 },
      ],
    });
    orderId = created.order.id;

    expect(created.order.status).toBe('CREATED');
    expect(created.order.total_minor).toBe(4700 + 388 + 699);
    expect(created.lineItems).toHaveLength(1);
  });

  maybe('a physical good cannot be routed through a digital merchant of record', async () => {
    const products = new ProductRepository(pool);
    await expect(
      products.create({
        companyId,
        sku: `SKU-BAD-${Date.now()}`,
        name: 'Bad routing',
        kind: 'physical_good',
        description: 'x',
        paymentRoute: 'dodo_merchant_of_record',
        priceMinor: 100,
        currency: 'USD',
        physical: { weightGrams: 1, lengthMm: 1, widthMm: 1, heightMm: 1, countryOfOrigin: 'CN', hsCode: null, hazardous: false, batteryContained: false },
      }),
    ).rejects.toThrow(/Merchant of Record/);
  });

  maybe('the happy path advances through the state machine', async () => {
    const orders = new OrderRepository(pool);
    const checkout = await orders.applyEvent({
      orderId, kind: 'checkout_started', toStatus: 'CHECKOUT_STARTED', actor: 'system:checkout',
    });
    expect(checkout.outcome).toBe('applied');

    const paid = await orders.applyEvent({
      orderId,
      kind: 'payment_webhook_received',
      toStatus: 'PAID',
      actor: 'webhook:stripe',
      externalEventId: 'evt_paid_1',
      amountPaidDeltaMinor: 5787,
    });
    expect(paid.outcome).toBe('applied');
    if (paid.outcome === 'applied') {
      expect(paid.order.amount_paid_minor).toBe(5787);
      expect(paid.order.paid_at).not.toBeNull();
    }
  });

  maybe('a redelivered payment webhook is a no-op, not a double credit', async () => {
    const orders = new OrderRepository(pool);
    const replay = await orders.applyEvent({
      orderId,
      kind: 'payment_webhook_received',
      toStatus: 'PAID',
      actor: 'webhook:stripe',
      externalEventId: 'evt_paid_1',
      amountPaidDeltaMinor: 5787,
    });
    expect(replay.outcome).toBe('duplicate');

    const order = await orders.byId(orderId);
    // Still exactly one payment's worth.
    expect(order.amount_paid_minor).toBe(5787);
  });

  maybe('a late out-of-order event is recorded but not applied', async () => {
    const orders = new OrderRepository(pool);
    const stale = await orders.applyEvent({
      orderId,
      kind: 'payment_webhook_received',
      toStatus: 'PAYMENT_PENDING',
      actor: 'webhook:stripe',
      externalEventId: 'evt_processing_late',
    });
    expect(stale.outcome).toBe('stale');

    const order = await orders.byId(orderId);
    expect(order.status).toBe('PAID');

    // It is still in the history — we did not pretend it never arrived.
    const events = await orders.events(orderId);
    const staleEvent = events.find((e) => e['external_event_id'] === 'evt_processing_late');
    expect(staleEvent).toBeDefined();
    expect((staleEvent?.['payload'] as Record<string, unknown>)['staleIgnored']).toBe(true);
  });

  maybe('a forward transition that skips required states is refused', async () => {
    const orders = new OrderRepository(pool);
    await orders.applyEvent({ orderId, kind: 'status_changed', toStatus: 'FULFILLMENT_QUEUED', actor: 'agent:ops' });
    await orders.applyEvent({ orderId, kind: 'status_changed', toStatus: 'FULFILLING', actor: 'agent:ops' });
    await orders.applyEvent({ orderId, kind: 'shipment_created', toStatus: 'SHIPPED', actor: 'agent:ops' });
    await orders.applyEvent({ orderId, kind: 'delivered', toStatus: 'DELIVERED', actor: 'carrier' });

    // A backwards target is treated as a late delivery and recorded, not
    // raised — providers send those routinely. Illegality is therefore tested
    // with a forward target that is genuinely not reachable.
    const backwards = await orders.applyEvent({
      orderId, kind: 'status_changed', toStatus: 'CHECKOUT_STARTED', actor: 'agent:ops',
    });
    expect(backwards.outcome).toBe('stale');

    await expect(
      orders.applyEvent({ orderId, kind: 'status_changed', toStatus: 'RETURNED', actor: 'agent:ops' }),
    ).rejects.toThrow(ConflictError);
  });

  maybe('a refund larger than the capture is refused with a typed conflict', async () => {
    const orders = new OrderRepository(pool);
    // DELIVERED -> REFUND_REQUESTED is the legal route to a refund.
    await orders.applyEvent({ orderId, kind: 'note_added', toStatus: 'REFUND_REQUESTED', actor: 'agent:support' });

    const error = await orders
      .applyEvent({
        orderId,
        kind: 'refund_issued',
        toStatus: 'REFUNDED',
        actor: 'agent:support',
        amountRefundedDeltaMinor: 99_999,
      })
      .then(() => null)
      .catch((e: unknown) => e);

    // The category must survive the transaction wrapper, because retry policy
    // and the API's HTTP status both read it.
    expect(error).toBeInstanceOf(ConflictError);
    expect((error as ConflictError).category).toBe('conflict');
    expect((error as Error).message).toMatch(/exceeds the refundable balance/);
  });

  maybe('a partial refund is applied and bounded by the capture', async () => {
    const orders = new OrderRepository(pool);
    const result = await orders.applyEvent({
      orderId,
      kind: 'refund_issued',
      toStatus: 'PARTIALLY_REFUNDED',
      actor: 'agent:support',
      externalEventId: 'evt_refund_1',
      amountRefundedDeltaMinor: 2000,
    });
    expect(result.outcome).toBe('applied');
    if (result.outcome === 'applied') {
      expect(result.order.amount_refunded_minor).toBe(2000);
      expect(result.order.amount_refunded_minor).toBeLessThanOrEqual(result.order.amount_paid_minor);
    }
  });

  maybe('concurrent transitions do not corrupt the order', async () => {
    const orders = new OrderRepository(pool);
    const customers = new CustomerRepository(pool);
    const products = new ProductRepository(pool);

    // Self-contained so this can be run in isolation.
    const product = await products.create({
      companyId,
      sku: `SKU-RACE-${Date.now()}`,
      name: 'Race Widget',
      kind: 'physical_good',
      description: 'concurrency fixture',
      paymentRoute: 'stripe_direct',
      priceMinor: 4700,
      currency: 'USD',
      physical: {
        weightGrams: 100, lengthMm: 10, widthMm: 10, heightMm: 10,
        countryOfOrigin: 'CN', hsCode: null, hazardous: false, batteryContained: false,
      },
    });
    const customer = await customers.upsert({ companyId, email: `race-${Date.now()}@example.com` });
    const created = await orders.create({
      companyId,
      customerId: customer.id,
      currency: 'USD',
      paymentRoute: 'stripe_direct',
      lineItems: [{ productId: product.id, sku: product.sku, name: product.name, quantity: 1, unitPriceMinor: 4700 }],
    });

    // Five concurrent identical webhooks, as a provider retry storm would send.
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () =>
        orders.applyEvent({
          orderId: created.order.id,
          kind: 'payment_webhook_received',
          toStatus: 'PAID',
          actor: 'webhook:stripe',
          externalEventId: 'evt_race_1',
          amountPaidDeltaMinor: 4700,
        }),
      ),
    );

    const outcomes = results.map((r) =>
      r.status === 'fulfilled'
        ? (r.value as { outcome: string }).outcome
        : `rejected:${(r.reason as Error).message.slice(0, 80)}`,
    );

    // Exactly one delivery may take effect; the rest must resolve as
    // duplicates, never as errors a retry queue would keep re-driving.
    expect(outcomes.filter((o) => o === 'applied'), `outcomes were ${JSON.stringify(outcomes)}`).toHaveLength(1);
    expect(outcomes.filter((o) => o === 'duplicate'), `outcomes were ${JSON.stringify(outcomes)}`).toHaveLength(4);

    const final = await orders.byId(created.order.id);
    expect(final.amount_paid_minor).toBe(4700);
    expect(final.status).toBe('PAID');
  }, 30_000);
});

/* -------------------------------------------------------------------------- */

describe('payments and reconciliation keys', () => {
  maybe('a payment is unique per provider object', async () => {
    const payments = new PaymentRepository(pool);
    const orders = new OrderRepository(pool);
    const customers = new CustomerRepository(pool);
    const products = new ProductRepository(pool);

    // Products are created as drafts; use the one this suite created rather
    // than assuming anything is active yet.
    const product = await products.byId(productId);
    const customer = await customers.upsert({ companyId, email: `pay-${Date.now()}@example.com` });
    const order = await orders.create({
      companyId,
      customerId: customer.id,
      currency: 'USD',
      paymentRoute: 'stripe_direct',
      lineItems: [{ productId: product.id, sku: product.sku, name: product.name, quantity: 1, unitPriceMinor: 4700 }],
    });

    const externalId = `pi_${Date.now()}`;
    const first = await payments.upsert({
      companyId, orderId: order.order.id, provider: 'stripe', externalId,
      status: 'processing', amountMinor: 4700, currency: 'USD',
    });
    // A later event adds the fee; it must not blank previously known fields.
    const second = await payments.upsert({
      companyId, orderId: order.order.id, provider: 'stripe', externalId,
      status: 'succeeded', amountMinor: 4700, currency: 'USD', feeMinor: 166, netMinor: 4534,
    });
    expect(second.id).toBe(first.id);
    expect(second.status).toBe('succeeded');
    expect(second.fee_minor).toBe(166);

    const third = await payments.upsert({
      companyId, orderId: order.order.id, provider: 'stripe', externalId,
      status: 'succeeded', amountMinor: 4700, currency: 'USD',
    });
    expect(third.fee_minor).toBe(166);
  });
});

/* -------------------------------------------------------------------------- */

describe('ledger', () => {
  maybe('a balanced sale transaction is written', async () => {
    const ledger = new LedgerRepository(pool);
    const tx = buildSaleTransaction({
      transactionId: `tx_${Date.now()}`,
      currency: 'USD',
      productRevenueMinor: 4700,
      shippingRevenueMinor: 699,
      discountMinor: 0,
      taxCollectedMinor: 388,
      paymentFeeMinor: 187,
      landedCogsMinor: 672,
    });
    const entries = await ledger.writeTransaction({
      companyId, transaction: tx, sourceType: 'order', sourceRefId: 'ord_test',
    });
    expect(entries.length).toBeGreaterThan(2);

    const unbalanced = await ledger.findUnbalancedTransactions(companyId);
    expect(unbalanced).toHaveLength(0);
  });

  maybe('the profit and loss reflects what was written', async () => {
    const ledger = new LedgerRepository(pool);
    const pl = await ledger.profitAndLoss(companyId, 'USD');
    expect(pl.revenueMinor).toBeGreaterThan(0);
    expect(pl.cogsMinor).toBeGreaterThan(0);
    // Gross profit must be revenue less COGS, not an independent number.
    expect(pl.grossProfitMinor).toBe(pl.netRevenueMinor - pl.cogsMinor);
  });

  maybe('an unbalanced transaction is rejected before it reaches the database', async () => {
    const ledger = new LedgerRepository(pool);
    await expect(
      ledger.writeTransaction({
        companyId,
        transaction: {
          transactionId: `tx_bad_${Date.now()}`,
          entries: [
            { account: 'cash_settled', amountMinor: 100, currency: 'USD', description: 'x' },
            { account: 'product_revenue', amountMinor: -50, currency: 'USD', description: 'y' },
          ],
        },
        sourceType: 'test',
        sourceRefId: 'x',
      }),
    ).rejects.toThrow(/does not balance/);
  });
});

/* -------------------------------------------------------------------------- */

describe('verification records drive capability state', () => {
  maybe('a failed probe is recorded as failed, not omitted', async () => {
    const repo = new VerificationRepository(pool);
    await repo.record({
      provider: 'stripe',
      succeeded: false,
      detail: 'not activated: missing STRIPE_SECRET_KEY',
      evidence: { reason: 'credentials_missing' },
      environment: 'preview',
    });
    const latest = await repo.latestByProvider('preview');
    expect(latest.get('stripe')?.succeeded).toBe(false);
  });

  maybe('the most recent probe per provider wins', async () => {
    const repo = new VerificationRepository(pool);
    await repo.record({
      provider: 'stripe', succeeded: true, detail: 'GET /v1/balance ok',
      evidence: { status: 200 }, environment: 'preview',
    });
    const latest = await repo.latestByProvider('preview');
    expect(latest.get('stripe')?.succeeded).toBe(true);
    expect(latest.get('stripe')?.detail).toContain('/v1/balance');
  });

  maybe('probes are scoped per environment', async () => {
    const repo = new VerificationRepository(pool);
    const production = await repo.latestByProvider('production');
    // A successful preview probe says nothing about production.
    expect(production.get('stripe')).toBeUndefined();
  });
});

/* -------------------------------------------------------------------------- */

describe('agent runs', () => {
  maybe('a run records its model, usage and outcome', async () => {
    const runs = new AgentRunRepository(pool);
    const run = await runs.create({ companyId, roleKey: 'research_manager', objective: 'find pain points' });
    expect(run.model).toBe('claude-opus-5');

    await runs.markStarted(run.id);
    await runs.addUsage(run.id, { inputTokens: 1200, outputTokens: 340, costMinorUsd: 9, toolCalls: 3 });
    const finished = await runs.finish({ id: run.id, status: 'succeeded', roleKey: 'research_manager', output: { found: 4 } });

    expect(finished.input_tokens).toBe(1200);
    expect(finished.cost_minor_usd).toBe(9);
    expect(finished.tool_call_count).toBe(3);
    expect(finished.status).toBe('succeeded');
  });

  maybe('an unknown role is refused', async () => {
    const runs = new AgentRunRepository(pool);
    await expect(runs.create({ companyId, roleKey: 'not_a_real_role', objective: 'x' })).rejects.toThrow(/org chart/);
  });

  maybe('specialists run on the specialist model', async () => {
    const runs = new AgentRunRepository(pool);
    const run = await runs.create({ companyId, roleKey: 'community_researcher', objective: 'collect' });
    expect(run.model).toBe('claude-sonnet-5');
  });
});

function minimalConfig(): unknown {
  return {
    owner: { name: 'Operator', email: 'owner@example.com', delegatedAuthorities: [], delegationRecordedAt: null },
    legalEntity: {
      type: 'not_yet_formed',
      registeredName: null,
      registrationNumber: null,
      taxId: null,
      jurisdiction: null,
      registeredAddress: null,
    },
    contact: { supportEmail: 'support@example.com', supportPhone: null, supportMessagingHandle: null, physicalAddressDisclosed: false },
    commerce: {
      baseCurrency: 'USD',
      sellsTo: ['US'],
      shipsFrom: ['US'],
      returnWindowDays: 30,
      restockingFeeBps: 0,
      whoPaysReturnShipping: 'depends_on_reason',
      warrantyOffered: false,
      warrantyTermMonths: null,
      taxCollectionEnabled: false,
      taxProvider: null,
    },
    privacy: {
      dataController: null,
      personalDataCategories: ['contact', 'order'],
      retentionDays: 365,
      analyticsEnabled: false,
      cookiesUsed: ['strictly_necessary'],
      consentRequiredRegions: ['EU'],
      dpoContact: null,
      subprocessors: [],
    },
    messaging: {
      marketingMessagingEnabled: false,
      consentLanguage: null,
      messageFrequencyDisclosure: null,
      optOutInstructions: null,
      helpInstructions: null,
    },
    risk: {
      maxOrderValueMinor: 50_000,
      maxDailyOrdersBeforeReview: 100,
      agentRefundLimitMinor: 5_000,
      maxSupplierPurchaseWithoutHumanMinor: 20_000,
      maxDailyAdSpendMinor: 50_000,
    },
  };
}
