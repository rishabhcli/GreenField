# PROGRESS

Status legend: **DONE** = built and verified by an executed test. **PARTIAL** = built,
not yet fully verified. **NOT COMPLETE** = not built, or built but a stated requirement
is unmet. `live_verified` is used only for prize methods that actually succeeded —
never for catalog/list probes, unexecuted work, or an accepted-but-failed run.

Last updated: 2026-08-15. Production **NOT COMPLETE**. Company loop **not DONE**.

---

## Live company loop (not DONE)

Company `co_01M03F7RQW2M6540BY2GZHCFBW` exists. Render Workflows `tickCompanyLoop` **COMPLETED** (`trn-0994gda0c8fvlk1mc73fl86u0`). The tick's action output was **blocked** on `research.web_search`; as of 2026-08-15 `BRAVE_SEARCH_API_KEY` is present, answers a direct live probe with **HTTP 200** and real results, and is set on `foundry-worker` / `foundry-api`. That is a credential fact, not a verified method — no `integration_verifications` row exists and the loop has still not completed a phase. **`ANTHROPIC_API_KEY` is absent and is now the only key gating the loop.**

---

## Prize methods — `live_verified` only if the method succeeded

| Prize method | Status | Live fact |
|---|---|---|
| Stripe Payment Link | **`live_verified`** | Link live: `plink_1U4lK242nB81EBguRPuIHrxS` / `https://buy.stripe.com/bJe7sE7Ti3nmbLYdjb2go00` |
| Stripe webhook ingest | **`live_verified`** | `POST /webhooks/stripe` ingest **200** |
| Band room | **`live_verified`** | Room `a70129cc-0663-4090-86b5-c5a98025532e` |
| Render `tickCompanyLoop` | **`live_verified`** | **COMPLETED** `trn-0994gda0c8fvlk1mc73fl86u0` for `co_01M03F7RQW2M6540BY2GZHCFBW`. Brave block is loop output, not a workflow failure. |
| Linq link/open iMessage App | **`live_verified`** | **HTTP 202** chat `de316f38-5ead-4ded-8ca9-27a5c4851987` message `b63a89a7-7204-47e3-bbe4-32acf278f3a9`; Stripe Payment Link as `params.url`. |
| Superserve pause | **`live_verified`** | Pause proven (VM state preserved) |
| Solari exec | **`live_verified`** | Exec live |
| sandbox0 exec | **`live_verified`** | Exec live (pause does **not** equal Superserve) |
| Linq Agent Pay | **NOT COMPLETE** | `POST /v3/payment_requests` **2011** (no connected payment account) |
| Pioneer inference | **NOT COMPLETE** | **403** `card_required` |
| Terac launch | **NOT COMPLETE** | Org credit **$0** |
| Replay QA | **NOT COMPLETE** | Journeys **recording-lost** — not a pass |
| Lovable site.generate | **NOT COMPLETE** | No OAuth (`LOVABLE_OAUTH_ACCESS_TOKEN` missing) |
| Dodo | **NOT COMPLETE** | **HTTP 401** |
| Discover / Brave | **NOT COMPLETE** | Key present; direct live probe **HTTP 200** with real results (2026-08-15) and pushed to Render. Still NOT COMPLETE: no `integration_verifications` row, no completed discover phase. A raw 200 is not a prize method. |
| Anthropic | **NOT COMPLETE** | `ANTHROPIC_API_KEY` missing |

Adapter `probe()` rows (GET /projects, catalog, GET /v1/services, …) are **not** `live_verified`. See `VERIFICATION_EVIDENCE.md`.

---

## Local tests (not live prize evidence)

These are unit/integration tests against code and a real Postgres — they do not make production or the company loop DONE.

| Area | Status | Evidence |
|---|---|---|
| Exact decimal money (`Money`) | **DONE** | Unit tests: 0.1+0.2, banker's rounding, allocation, provider minor-unit conversion. |
| Order state machine | **DONE** | Unit + integration: legal transitions, idempotent redelivery, refund ceilings. |
| Policy engine | **DONE** | Unit tests over `evaluatePolicy`. |
| Opportunity scoring + selection gates | **DONE** | Unit tests: grounded-vs-assumed split, hard gates. |
| Landed cost + contribution margin | **DONE** | Unit tests: break-even CAC, negative-contribution detection. |
| Database schema | **DONE** | Applied to hosted Postgres. Invariant-violation attempts rejected; conventions are stated at the top of `packages/db/migrations/0001_foundation.sql`. |
| Budget reservation under concurrency | **DONE** | Integration: 10 concurrent reservations against a 5-slot budget grant exactly 5. |
| Idempotency ledger | **DONE** | Integration: concurrent claimants, replay, mismatched payload rejected. |
| Audit hash chain | **DONE** | Integration: chain verifies; tamper detected. |
| Webhook deduplication | **DONE** | Integration: redelivery recognised, signature headers redacted. |
| Double-entry ledger | **DONE** | Integration: balanced sale written, unbalanced rejected. |
| Agent run records | **DONE** | Integration: model from org-chart tier, unknown role refused. |
| ID prefix registry + collision guard | **DONE** | 28 unit tests (`packages/core/test/ids.test.ts`): distinct prefix per kind (pins the `aud` collision regression — `auditEvent` keeps `aud`, `audienceSegment` moved), round-trip through `idKindOf`, Crockford-excluded letters rejected, monotonic ULID ordering, `findIdPrefixProblems` guard. |
| Domain decision functions (qa/finance/org/support/company/marketing) | **DONE** | Unit tests: unexecuted QA is not a production pass; tax booked as `tax_payable`; 78-role chart holds no `HUMAN_ONLY_AUTHORITIES`; escalation + opt-out; `nextPhase` wraps; `decideArm` never scales on clicks. |
| Config (`WORKER_ROLE`, CORS) | **DONE** | `packages/core/test/config.test.ts`: a `WORKER_ROLE` typo throws; CORS always includes the `PUBLIC_BASE_URL` origin; production is fail-closed. |
| Observability (metrics identity, logger redaction) | **DONE** | `packages/obs/test/*`: identity labels merge at scrape time; histogram emits `+Inf`; `apiKey`/`token`/`*.password` redacted; `Secret.toJSON` neutered. |
| API `/metrics` gate + CORS wiring | **DONE** | `apps/api/test/http-surface.test.ts`: `/metrics` 403 without a matching operator token; `/health` and `/ready` stay open; fail-closed CORS does not reflect an unknown origin. Redis rate-limit wiring is in `apps/api/src/index.ts` (`skipOnError: true`); not live-proven against hosted Key Value from this suite. |
| Worker `tolerateMissingCapability` | **DONE** | `apps/worker/test/handlers.test.ts`: `CredentialsMissingError` → `{ status: 'blocked' }`; `RateLimitError` rethrows. |
| Anthropic prompt-cache breakpoints | **DONE** | `packages/providers/test/anthropic-cache.test.ts`: last-tool + first/last-message breakpoints, ≤4, `cacheSystemPrompt: false` still disables the system breakpoint. |
| Agent executor truncation + BAND stranding | **DONE** | `packages/agents/test/executor.test.ts`: truncated tool results include an explicit omitted-count notice; a run that cannot claim a BAND assignment ends `failed`, not `running`. Reaper is wired from `loop.tick` and the nightly reconcile cron. |
| Verifier CLI | **DONE** (classify) | `apps/verifier/src/cli.ts` emits `dist/cli.js`; `classifyProbe` unit-tested. Missing credentials are BLOCKED (exit 0); a probe that ran and failed is FAILED (exit 1). A live `pnpm verify` against hosted Postgres was not executed in this pass. |
| Toolchain: clean build + lint | **DONE** | `pnpm clean && pnpm build` green from a clean state — a stale `.tsbuildinfo` previously produced a confident false failure (and can equally false-pass); `pnpm lint` (CommonJS flat config) exits 0 with 2 known dead-import warnings; `pnpm test` 617 passed / 13 skipped. |
| GitHub Actions CI | **PARTIAL** | `.github/workflows/ci.yml` exists (Node 22, corepack, frozen lockfile, clean build, Postgres service, test, lint). The same three steps passed locally. A GitHub-hosted run has not executed yet. |
| Operator console (`apps/site/console.html`) | **PARTIAL** | 17 structural tests pass (`apps/site/test/console.test.ts`): every `$('id')` resolves, every API path it calls is registered by a route file, the phase rail matches `LOOP_PHASE_ORDER`, the token never reaches `localStorage`, and no reassurance is emitted for an unread value. Rendering was verified against a **local mock**, not a live API — see below. |

---

## Built vs live-verified

| Area | Status | What is missing |
|---|---|---|
| Provider HTTP client | **PARTIAL** | Unit coverage exists; not every client path has a live call. |
| Stripe Payment Link + webhook ingest | **DONE** (those two methods) | Does not make the company loop DONE. |
| Render Workflows `tickCompanyLoop` | **DONE** (prize method) | Tick completed. Loop still **not DONE** (Brave). |
| Linq link/open | **DONE** (prize method) | HTTP 202 with Payment Link as `params.url`. Agent Pay still 2011. |
| Prize-track adapters | **PARTIAL** | Succeeded methods listed above. Blocked: Agent Pay 2011, Pioneer `card_required`, Terac $0, Replay recording-lost, Lovable OAuth, Dodo 401, Brave missing, Anthropic missing. |
| Operator console | **PARTIAL** | Renders correctly against a local mock of the nine read endpoints, and degrades honestly when the API is unreachable (every panel states the failure; no panel keeps a loading shimmer or a stale value). **Never exercised against the deployed `foundry-api`**, so the approve / deny / kill-switch-release write paths are unproven end to end — they are wired to `POST /api/approvals/:id/decide` and `POST /api/kill-switches/:scope/release` with payload shapes matched to the route Zod schemas, and nothing more than that has been shown. |

## Not complete (production)

- Company loop — **NOT COMPLETE** (discover blocked on Brave; Anthropic missing)
- Linq Agent Pay, Pioneer GLiNER2/GLiGuard inference, Terac launch, Replay QA pass, Dodo, Lovable MCP — **NOT COMPLETE**
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

See `VERIFICATION_EVIDENCE.md` and `BLOCKERS.md`.
