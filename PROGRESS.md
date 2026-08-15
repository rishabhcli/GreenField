# PROGRESS

Status legend: **DONE** = built and verified by an executed test. **PARTIAL** = built,
not yet fully verified. **NOT COMPLETE** = not built, or built but a stated requirement
is unmet. Nothing is marked DONE on the strength of code existing.

Last updated: 2026-08-15 (verifier rows + Render Workflows). Production **NOT COMPLETE**. Loop **not DONE**.

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

Full suite this session: **354 passed, 1 skipped** (`live-prize-probes` unless `LIVE_PROBES=1`). `pnpm typecheck` passed.

## Built vs live-verified

| Area | Status | What is missing |
|---|---|---|
| Provider HTTP client | **PARTIAL** | Unit coverage exists; not every client path has a live call. |
| Webhook signature verifiers | **PARTIAL** | Stripe ingest blocked: `STRIPE_WEBHOOK_SECRET` unset. |
| Provider manifests / registry | **PARTIAL** | Verifier wrote 24 rows. **11 providers `live_verified`** (probe only). See `VERIFICATION_EVIDENCE.md`. |
| Queue system | **PARTIAL** | Render Key Value provisioned (`noeviction`). BullMQ 5 rejects `:`; local fix `environment.name`. Deployed `main` still fails workflow ticks. 24 queues. |
| Dodo / Whop / Lovable | **PARTIAL** | Whop `live_verified`. Dodo 401. Lovable missing OAuth. Physical refuse local. |
| Prize-track adapters | **PARTIAL** | Probe-verified: Terac, Stripe, Linq (phone), Replay (list), Superserve, Pioneer (catalog), Band, Render. Still blocked: Agent Pay 2011, Pioneer inference, Terac study (0 projects), Replay QA, workflow task success. |

## Not complete (production)

- Company loop on `foundry-api` + workers — **NOT COMPLETE** (`foundry-api` not created)
- Linq Agent Pay, Pioneer GLiNER2/GLiGuard inference, Dodo, Lovable MCP — **NOT COMPLETE**
- Workflow `tickCompanyLoop` **accepted** (HTTP 202) then **failed** on deployed queue names — **NOT COMPLETE** until local BullMQ fix is deployed
- Remaining required markdown (ARCHITECTURE, SPONSORS, INTEGRATIONS, DATA_MODEL, AGENTS, SECURITY, LEGAL_COMPLIANCE, TESTING, RUNBOOK, PRODUCTION_CHECKLIST, DECISIONS) — **NOT COMPLETE**

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

Verifier **ran** against hosted Render Postgres and wrote 24 `integration_verifications` rows.
**11 `live_verified`:** terac, stripe, whop, render, linq, superserve, replay, band, sandbox0, solari, pioneer
(those are `probe()` rows — not Agent Pay settlement, not Pioneer inference, not a Terac study, not a finished workflow tick).

Render Workflows: `POST /v1/workflows` created `foundry-workflows`; `POST /v1/task-runs` returned **202** then failed on deployed `Queue name cannot contain :`. Local queue key fix is unpushed.

Human blockers unchanged: Linq **2011**, Pioneer **403 card_required**, Dodo **401**, Lovable OAuth, Egoist by design.

See `VERIFICATION_EVIDENCE.md` and `BLOCKERS.md`.
