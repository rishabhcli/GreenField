# PROGRESS

Status legend: **DONE** = built and verified by an executed test. **PARTIAL** = built,
not yet fully verified. **NOT COMPLETE** = not built, or built but a stated requirement
is unmet. Nothing is marked DONE on the strength of code existing.

Last updated: 2026-08-15.

---

## Verified by executed tests

| Area | Status | Evidence |
|---|---|---|
| Exact decimal money (`Money`) | **DONE** | 21 unit tests. Covers 0.1+0.2, banker's rounding, allocation without losing a minor unit, $4,800 tooling across 25,000 units, provider minor-unit conversion. |
| Order state machine | **DONE** | 19 unit + 9 integration tests. Legal transitions, idempotent redelivery, stale out-of-order events, refund ceilings, payment-route compliance. |
| Policy engine (authority, budgets, kill switches, approvals) | **DONE** | 22 unit tests over `evaluatePolicy`, including human-only authorities and approval reuse. |
| Opportunity scoring + selection gates | **DONE** | 20 unit tests. Risk inversion, confidence shrink toward neutral, grounded-vs-assumed split, hard gates that a high score cannot bypass. |
| Landed cost + contribution margin | **DONE** | 18 unit tests. Grounded ratio, break-even CAC, negative-contribution detection, price-for-target-margin round trip. |
| Database schema | **DONE** | 52 tables, 169 indexes, 104 FKs, applied to a real PostgreSQL 16 server. 23 invariant-violation attempts all rejected; see `docs/verification/DB_INVARIANTS.md`. |
| Budget reservation under concurrency | **DONE** | Integration test: 10 concurrent reservations against a 5-slot budget grant exactly 5. |
| Idempotency ledger | **DONE** | Integration tests: 8 concurrent claimants → 1 winner; completed key replays without re-running the effect; mismatched payload rejected. |
| Audit hash chain | **DONE** | Integration tests: chain verifies; a row altered with the append-only trigger disabled is detected and located. |
| Webhook deduplication | **DONE** | Integration tests: redelivery recognised, signature headers redacted, single-claim processing. |
| Double-entry ledger | **DONE** | Integration tests: balanced sale written, unbalanced transaction rejected before reaching the database, P&L derived not asserted. |
| Agent run records | **DONE** | Integration tests: model resolved from the org chart tier, usage accumulated, unknown role refused. |

Full suite: **132 tests, 132 passing**, stable across three consecutive runs.

## Built, not yet verified against a live service

| Area | Status | What is missing |
|---|---|---|
| Provider HTTP client (retry, breaker, rate limit, idempotency, error classification) | **PARTIAL** | Unit tests not yet written; no live call made. |
| Webhook signature verifiers (Standard Webhooks, Stripe, Terac, Lovable, Sandbox0) | **PARTIAL** | Written against documented schemes; unit tests with known-good vectors not yet written. Sandbox0's exact signed-content layout is UNVERIFIED by the vendor's docs. |
| Provider manifests (20 providers) | **PARTIAL** | Encodes the 2026-08-14 documentation research. No live probe has run, so every capability is correctly reporting `blocked_missing_credentials` or `configured_unverified`. |
| Queue system (BullMQ over Render Key Value) | **PARTIAL** | 24 queues, policies and schedules defined; no Redis integration test yet. |

## Not built yet

- Provider adapters (Stripe, Dodo, Whop, Terac, Replay, BAND, Superserve, Sandbox0,
  Solari, Render, Lovable, Anthropic, Meta Ads, Google Ads, Resend, Cloudflare, Shippo,
  sourcing, images) — **NOT COMPLETE**
- Agent runtime and tool registry — **NOT COMPLETE**
- Business services (research, sourcing, brand, commerce, marketing, support, finance,
  legal, QA orchestration) — **NOT COMPLETE**
- API service (`apps/api`), worker (`apps/worker`), verifier (`apps/verifier`) — **NOT COMPLETE**
- `render.yaml` deployment blueprint — **NOT COMPLETE**
- Remaining required markdown (ARCHITECTURE, SPONSORS, INTEGRATIONS, DATA_MODEL, AGENTS,
  SECURITY, LEGAL_COMPLIANCE, TESTING, RUNBOOK, PRODUCTION_CHECKLIST, DECISIONS, BLOCKERS,
  VERIFICATION_EVIDENCE) — **NOT COMPLETE**

## Design decisions forced by testing

These were found by tests failing, not by review:

1. **`CREATED → PAID` is now legal.** The original table required
   `CREATED → CHECKOUT_STARTED → PAID`. A concurrency test showed that a provider webhook
   winning the race against our own checkout-start write would be rejected — meaning a real
   captured payment with no order record. Money arriving is authoritative.
2. **Order transitions use a row lock under READ COMMITTED, not SERIALIZABLE.** Five
   concurrent redeliveries taking `SELECT … FOR UPDATE` under SERIALIZABLE all abort with
   40001 the instant the winner commits. Under READ COMMITTED the waiters queue and re-read.
   SERIALIZABLE is retained where the conflict is over a predicate (the audit chain's
   `MAX(chain_position)`), where there is no row to lock.
3. **`mapPostgresError` passes domain errors through.** It was wrapping `ConflictError`
   into `InternalError`, destroying the category that drives retry policy and HTTP status.
4. **A pre-transaction dedupe check was added to `applyEvent`.** A provider retry storm is
   the common case; letting redeliveries contend on a transaction wasted a retry budget for
   what is not really a conflict.

## Honest position on live integrations

No live API call has been made against any provider, because no credentials exist. Every
capability therefore reports `blocked_missing_credentials` or `configured_unverified`, and
the capability registry structurally cannot report `live_verified` without a dated,
successful probe row written by the verification harness. That is the intended behaviour,
not a gap to paper over.
