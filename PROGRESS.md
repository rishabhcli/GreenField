# PROGRESS

Status legend: **DONE** = built and verified by an executed test. **PARTIAL** = built,
not yet fully verified. **NOT COMPLETE** = not built, or built but a stated requirement
is unmet. `live_verified` is used only for prize methods that actually succeeded —
never for catalog/list probes, unexecuted work, or an accepted-but-failed run.

Last updated: 2026-08-15. Production **NOT COMPLETE**. Company loop **not DONE**.

Payments now charge **catalogue prices** (`zhc-backer` $25, `zhc-founding` $99, `zhc-operator` $299). The submitted Payment Link must be pinned to $99; landing copy no longer tells buyers to type an amount. Linq outreach is a first-class market-phase path (`linq.outreach` / `marketing.outreach`) and does not invent recipients.

---

## BAND (this branch — not company-loop DONE)

Coordination layer only. BAND is not a sandbox or model runtime. Probe
`GET /agent/me` is not mesh-complete.

| Item | Status | Evidence |
|---|---|---|
| Chain of command | **DONE** (unit) | Specialist `dispatch` → `PolicyDeniedError`. Non-direct-report denied. 78-role chart still holds no `HUMAN_ONLY_AUTHORITIES` (`packages/core/test/org.test.ts`, `packages/agents/test/policy-gate.test.ts`). |
| Room post before enqueue | **DONE** (unit) | `@mention` is posted before `queues.enqueue`. Failed send does not enqueue. |
| Executor missing assignment | **DONE** (unit) | Run without `bandChatId`/`bandMessageId` ends `failed`, not `running`. |
| `dispatch` vs `enqueueSystem` | **DONE** (unit) | Unconfigured `dispatch` refuses. `enqueueSystem` (support inbound) may proceed DB-only. Runtime must pass `{ band }` only when `band.isConfigured` — see `PATCH.md`. |
| Permissioned channels | **DONE** (unit) | Eight lanes (discovery, sourcing, marketing, support, engineering, finance, QA, incidents) are labels on the existing Zero Human Co room `a70129cc-0663-4090-86b5-c5a98025532e`, not extra chats. |
| Auditable handoffs | **DONE** (unit) | Successful dispatch writes `audit_events.action = band.handoff`. |
| Reaper | **DONE** (existing) | `reapOverdueRuns` still on the dispatcher; `loop.tick` / reconcile already call it. Not re-owned here. |
| Human in the room | **NOT COMPLETE** | Dispatch still needs a mentionable participant who is not the sending agent. No live proof a human is in `a70129cc-…`. |
| `coordination.governance` | **NOT COMPLETE** | Manifest evidence remains `marketing_claim_only`. |

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
| Opportunity scoring + selection gates | **DONE** | Unit tests: grounded-vs-assumed split, hard gates. `opportunity.select` now loads scorecard/quotes/economics and denies when `evaluateSelectionGates` fails (`packages/services/test/tools-catalog.test.ts`, `research-selection.test.ts`). |
| Landed cost + contribution margin | **DONE** | Unit tests: break-even CAC, negative-contribution detection. `LandedCostService.build` throws `ValidationError` when economics are incomplete or the margin gate fails — it no longer returns a passing model with a note. |
| Domain decision functions (qa/finance/org/support/company/marketing) | **DONE** | Unit tests: unexecuted QA is not a production pass; high-severity commerce-flow defects block preview as well as production; tax booked as `tax_payable`; 78-role chart holds no `HUMAN_ONLY_AUTHORITIES`; escalation + opt-out; `nextPhase` wraps; `decideArm` never scales on clicks; `decideArm` refuses `unitContributionMinor <= 0`; `summariseReview` treats a single expert reject as `rejected`. |
| PolicyGate live_verified for spend/contact/publish | **DONE** | `capabilityAvailableForAuthority` + PolicyGate: spend/contact/publish require `live_verified`; read-only collect may use `configured_unverified`. Agent tests against real Postgres. |
| BAND dispatcher vs executor | **DONE** | Runtime passes `{ band }` only when `band.isConfigured`. Agent-to-agent `dispatch` still requires BAND; `enqueueSystem` (support inbound) may proceed DB-only when BAND is unconfigured. |
| Linq inbound → support.inbound + opt-out consent | **DONE** | `ingestInbound` returns `messageId`; webhook processor enqueues `support.inbound`. Opt-out keywords call `customers.recordConsent(..., false)`. Runtime wires `LinqAdapter.setOptOutStateStore`. |
| Database schema | **DONE** | Applied to hosted Postgres. Invariant-violation attempts rejected; conventions are stated at the top of `packages/db/migrations/0001_foundation.sql`. |
| Budget reservation under concurrency | **DONE** | Integration: 10 concurrent reservations against a 5-slot budget grant exactly 5. |
| Idempotency ledger | **DONE** | Integration: concurrent claimants, replay, mismatched payload rejected. |
| Audit hash chain | **DONE** | Integration: chain verifies; tamper detected. |
| Webhook deduplication | **DONE** | Integration: redelivery recognised, signature headers redacted. |
| Double-entry ledger | **DONE** | Integration: balanced sale written, unbalanced rejected. |
| Agent run records | **DONE** | Integration: model from org-chart tier, unknown role refused. |
| ID prefix registry + collision guard | **DONE** | 28 unit tests (`packages/core/test/ids.test.ts`): distinct prefix per kind (pins the `aud` collision regression — `auditEvent` keeps `aud`, `audienceSegment` moved), round-trip through `idKindOf`, Crockford-excluded letters rejected, monotonic ULID ordering, `findIdPrefixProblems` guard. |
| Config (`WORKER_ROLE`, CORS, storefront service id) | **DONE** | `packages/core/test/config.test.ts`: a `WORKER_ROLE` typo throws; CORS always includes the `PUBLIC_BASE_URL` origin; production is fail-closed; optional `RENDER_STOREFRONT_SERVICE_ID` is copied onto runtime config. |
| Observability (metrics identity, logger redaction) | **DONE** | `packages/obs/test/*`: identity labels merge at scrape time; histogram emits `+Inf`; `apiKey`/`token`/`*.password` redacted; `Secret.toJSON` neutered. |
| API `/metrics` gate + CORS wiring | **DONE** | `apps/api/test/http-surface.test.ts`: `/metrics` 403 without a matching operator token; `/health` and `/ready` stay open; fail-closed CORS does not reflect an unknown origin. Redis rate-limit wiring is in `apps/api/src/index.ts` (`skipOnError: true`); not live-proven against hosted Key Value from this suite. |
| API operator gates (company mutators, governance reads, stuck webhooks) | **DONE** | `apps/api/test/http-surface.test.ts` + `company-routes.test.ts`: unauthenticated company mutators, all governance routes, and `GET /webhooks/stuck` return 403. Storefront checkout + `GET /api/orders/:id` stay public; order list/events stay gated. Checkout off-allowlist URLs 400. Audit actor is `operator` (client `decidedBy` ignored). Audit `limit` coerced 1–500 default 100. `timingSafeEqual` hashes both sides. Client `x-request-id` accepted only if `^[a-zA-Z0-9_-]{8,64}$`. |
| Commerce payment honesty (refunds, capture amounts, inventory) | **DONE** (unit) | Stripe `refund()` / `listPayments()` facades; paid amount must equal order total or MANUAL_REVIEW; `payment_intent.succeeded` uses `amount_received` and never PAID-with-0; `statusAfterRefund`; lost-dispute remaining captured; payments row upserted on capture; `RefundService.onDisputeOpened` from webhooks; checkout rejects tracked out-of-stock and calls `reserveInventory`; reconciliation uses `payments.checkout.physical`. Not live-proven against Stripe. |
| Worker `tolerateMissingCapability` | **DONE** | `apps/worker/test/handlers.test.ts`: `CredentialsMissingError` → `{ status: 'blocked' }`; `RateLimitError` rethrows. |
| Anthropic prompt-cache breakpoints | **DONE** | `packages/providers/test/anthropic-cache.test.ts`: last-tool + first/last-message breakpoints, ≤4, `cacheSystemPrompt: false` still disables the system breakpoint. |
| Agent executor truncation + BAND stranding | **DONE** | `packages/agents/test/executor.test.ts`: truncated tool results include an explicit omitted-count notice; a run that cannot claim a BAND assignment ends `failed`, not `running`. Reaper is wired from `loop.tick` and the nightly reconcile cron. |
| Verifier CLI | **DONE** (classify) | `apps/verifier/src/cli.ts` emits `dist/cli.js`; `classifyProbe` unit-tested. Missing credentials are BLOCKED (exit 0); a probe that ran and failed is FAILED (exit 1). A live `pnpm verify` against hosted Postgres was not executed in this pass. |
| Toolchain: clean build + lint | **DONE** | `pnpm clean && pnpm build` green from a clean state — a stale `.tsbuildinfo` previously produced a confident false failure (and can equally false-pass); `pnpm lint` (CommonJS flat config) exits 0 with 2 known dead-import warnings; `pnpm test` 624 passed / 13 skipped. |
| GitHub Actions CI | **PARTIAL** | `.github/workflows/ci.yml` exists (Node 22, corepack, frozen lockfile, clean build, Postgres service, test, lint). The same three steps passed locally. A GitHub-hosted run has not executed yet. |
| Operator console (`apps/site/console.html`) | **PARTIAL** | Structural tests pass (`apps/site/test/console.test.ts`): every `$('id')` resolves, every API path it calls is registered by a route file, the phase rail matches `LOOP_PHASE_ORDER`, the token never reaches `localStorage`, and no reassurance is emitted for an unread value. The storefronts deck is eight themed sites with local photography (`apps/site/storefronts/*`); it is static markup, not an API read. Rendering of live panels was verified against a **local mock**, not a live API — see below. |
| Landing site (`apps/site`) | **DONE** | Single long-scroll page split into four: `index.html` (home), `system.html` (loop, organization, integrations, governance), `evidence.html` (stats, charter, FAQ), `pricing.html` (tiers). Floating pill nav on scroll, real sponsor logos in `assets/sponsors/*` (each downloaded from the sponsor's own published favicon/logo), em-dash-free copy. Hero LED field is visible again (the `body.lp .hero-leds { display: none }` retirement is gone; ambient wash is the one hidden). Wave rest/damp/speed are pinned so the field reads as motion, not a static edge decoration. 29 tests pass (`apps/site/test/landing.test.ts`): references resolve on every page, honesty claims stay pinned to the page that owns them, the single Payment Link with tier attribution is still the only checkout path, and all twelve sponsor logo assets exist and are referenced. |

---

## Built vs live-verified

| Area | Status | What is missing |
|---|---|---|
| Provider HTTP client | **PARTIAL** | Unit coverage exists; not every client path has a live call. |
| Stripe Payment Link + webhook ingest | **DONE** (those two methods) | Does not make the company loop DONE. |
| Render Workflows `tickCompanyLoop` | **DONE** (prize method) | Tick completed. Loop still **not DONE** (Brave). |
| Linq link/open | **DONE** (prize method) | HTTP 202 with Payment Link as `params.url`. Agent Pay still 2011. |
| Prize-track adapters | **PARTIAL** | Succeeded methods listed above. Blocked: Agent Pay 2011, Pioneer `card_required`, Terac $0, Replay recording-lost, Lovable OAuth, Dodo 401, Brave missing, Anthropic missing. |
| Operator console | **PARTIAL** | Live HTTP 404 was the static host answering `GET /readiness/company` because `YELLOFIELD_API_BASE` was empty and the console used `window.location.origin`. Repo + live `foundry-site` now bake `https://foundry-api-8ih0.onrender.com` (`console-config.js` / `data-api` / `DEFAULT_API_BASE`; hashes match). Rewrites on `foundry-site` proxy `/readiness/*` and `/api/*` to `foundry-api` (live GET **200**). CORS from the site origin is **200/204** with matching ACAO after `CORS_ALLOWED_ORIGINS` PUT + `foundry-api` deploy. Approve / deny / kill-switch writes remain unproven in a browser session. Loop **not DONE**. |

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

---

## Stripe physical-goods commerce (this pass)

Owned path: Checkout Session `mode=payment` → signed webhook → order/ledger →
refund/dispute. Customer-typed amounts are refused. Webhooks are the only money
authority.

| Item | Status | Evidence |
|---|---|---|
| Checkout Session `mode=payment`; prices from DB | **DONE** (unit) | `createCheckoutSession` uses catalogue `unit_amount` via `stripeCataloguePriceData`. `/api/checkout` ignores client prices and calls `rejectCustomerTypedCheckoutAmount`. |
| `shipping_options` `fixed_amount` only | **DONE** (unit) | `stripeFixedAmountShippingRate` — `packages/providers/test/stripe-fixed-amount.test.ts`. |
| `assertPaymentRoute` physical → Stripe, never Dodo | **DONE** (unit) | Called on `/api/checkout`. `apps/api/test/commerce-physical.test.ts`. Core `assertPaymentRoute` already throws. Collect refuses `dodo_merchant_of_record`. |
| Webhook raw bytes, v1, 400 / 503 / `{duplicate:true}` | **DONE** (unit) | `apps/api/test/stripe-webhook.test.ts`. Ingest itself is already `live_verified`. |
| Paid amount = order total or `MANUAL_REVIEW`; never PAID-with-0 | **DONE** (unit) | `evaluatePaidCapture` + `packages/services/test/webhook-paid-amount.test.ts` + processor Stripe arm. `payment_intent.succeeded` uses `amount_received`. |
| `CREATED → PAID` legal | **DONE** | Core state machine + stripe-events fixture. |
| Refund ledger (`re_*`) + ceiling | **DONE** (unit) | `RefundService` refuses above captured-minus-refunded. Facade maps Stripe `re_*`. |
| Lost dispute reduces remaining captured | **DONE** (unit) | `lostDisputeRefundDelta` + processor `charge.dispute.closed`. |
| Reconciliation vs `payments.checkout.physical` | **DONE** (unit) | `packages/services/test/reconciliation.test.ts`. |
| Inventory reserve + tracked OOS reject | **DONE** (unit) | `/api/checkout` + `trackedProductOutOfStock`. |
| Founding Payment Link `plink_1U4lK242nB81EBguRPuIHrxS` | **`live_verified`** | $99 catalogue — do not mint a second link. Not re-probed this pass. |

Not live-proven: a hosted physical SKU paid, refunded, and disputed end-to-end.
That does not reopen Payment Link or webhook ingest.

---

## Linq spine (this slice)

Linq is the customer-communications path (PLAN.md §11). Owned files only: `packages/providers/src/linq/**`, `packages/providers/test/*linq*`, `packages/services/src/support/inbox.ts`, `packages/services/src/marketing/outreach.ts`, `packages/services/test/{linq-inbound,support-inbox}*`. Shared wiring is in `PATCH.md`.

| Path | Status | Evidence |
|---|---|---|
| Inbound webhook → `ingestInbound` `messageId` → enqueue `support.inbound` | **DONE** | `packages/services/test/linq-inbound.test.ts` |
| Opt-out keyword → `customers.recordConsent(..., false)` | **DONE** | `packages/services/test/support-inbox.test.ts`. Runtime `LinqAdapter.setOptOutStateStore(linqOptOutStateStore(repos))` — splice in `PATCH.md`. |
| Support reply through Linq; escalate legal / safety / chargeback / regulator; missing key blocked not thrown | **DONE** | `packages/services/test/support-inbox.test.ts`. Never invent shipment/refund/policy — unverifiable order-status escalates. |
| `marketing.outreach` / `linq.outreach` empty audience blocked; `sendLink` not Agent Pay | **DONE** (unit) | `packages/services/test/linq-inbound.test.ts`. Queue / handler / catalog / market-phase enqueue — `PATCH.md`. Recipients are never invented. |
| Linq link/open iMessage App | **`live_verified`** (do not regress) | HTTP 202 chat `de316f38-5ead-4ded-8ca9-27a5c4851987`. Stripe Payment Link is `params.url`, **not** `agentpay` `checkout_url`. |
| Agent Pay `POST /v3/payment_requests` | **NOT COMPLETE** (honest leftover) | Live **2011** no connected payment account. Classified as non-retryable `ValidationError` (`LINQ_AGENT_PAY_ERROR_2011` / `LINQ_AGENT_PAY_BLOCKER`). `packages/providers/test/linq-agentpay.test.ts`. Connect a Stripe account in the Linq dashboard; do not substitute Payment Link. |

---

## Render (this owner) — unit-tested, loop not DONE

Storefront deploy talks to the Render API. Lovable preview is never production.
`GET /v1/services` is the probe, not the pass. Workflows prize method remains
the completed `tickCompanyLoop` run `trn-0994gda0c8fvlk1mc73fl86u0` — not a
second minted success.

| Item | Status | Evidence |
|---|---|---|
| `assertProductionTopology` refuses localhost | **DONE** (unit) | `packages/providers/test/render-topology.test.ts` |
| Production deploy blocked without QA artefact | **DONE** (unit) | `packages/services/test/site-deploy.test.ts` — `evaluateReleaseGate` block, no `triggerDeploy` |
| Preview/staging do not set a production URL | **DONE** (unit) | same file |
| Localhost production URL refused | **DONE** (unit) | same file |
| Workflows `tickCompanyLoop` prize method | **`live_verified`** | existing `trn-0994gda0c8fvlk1mc73fl86u0` |
| Generated storefront live on Render | **NOT COMPLETE** | `RENDER_STOREFRONT_SERVICE_ID` must name a real service; `foundry-site` is the landing page |
| Company loop | **not DONE** | discover still blocked; this owner did not complete a launch phase |

See `PATCH.md` (Render section) for yaml/runtime follow-ups (`CORS_ALLOWED_ORIGINS`, worker `site.deploy` staging, no `foundry-loop-tick`).

---

## Lovable (this owner) — unit-tested, not live_verified

OAuth-only MCP at `https://mcp.lovable.dev`. No invented API-key path. Production
hosting is Render; a Lovable deploy URL is a generator preview only.
`SITE_HOSTING_NOTE` is unchanged. Promo-code paths stay dead.

| Item | Status | Evidence |
|---|---|---|
| Missing `LOVABLE_OAUTH_ACCESS_TOKEN` → blocked | **DONE** (unit) | `packages/providers/test/lovable-adapter.test.ts`, `packages/services/test/site-generate.test.ts` |
| `createSpec` writes `active_site_id` | **DONE** (unit) | `packages/services/test/site-create-spec.test.ts` |
| `generate` reads files before `generated`; empty files stay `spec_drafted` | **DONE** (unit) | `packages/services/test/site-generate.test.ts` |
| Idempotency `site.generate:{siteId}` completed claim replays, no re-create | **DONE** (unit) | same file |
| Lovable preview URL not stored as production host | **DONE** (unit) | same file |
| `spec_drafted` ≠ build complete | **DONE** (unit) | `siteBuildComplete` + same file. Loop `#assess('build')` already refuses `spec_drafted`. |
| MCP `create_project` / `list_files` / `read_file` / `deploy_project` request shape | **DONE** (unit) | `packages/providers/test/lovable-adapter.test.ts` (fake fetch; Bearer only, no `Lovable-API-Key`) |
| Lovable MCP `site.generate` live | **NOT COMPLETE** | No OAuth (`LOVABLE_OAUTH_ACCESS_TOKEN` missing); promo code globally dead |
| `foundry_sitegen` fallback (`site.generate` priority 2, Anthropic-backed) | **DONE** (unit) | `packages/providers/test/sitegen-adapter.test.ts` — strict `emit_files` tool use on `claude-sonnet-5`; zero files rejected; path traversal rejected; unknown project id throws; `deployProject` returns `{ url: null }` (no preview hosting; production hosting stays Render). Registry resolves `site.generate` to it only when `ANTHROPIC_API_KEY` is present, honestly `configured_unverified` until `apps/verifier` records a probe. |

Do not claim `live_verified` without OAuth **and** a real `tools/call`. Catalog/runtime splices: `PATCH.md` Lovable section (none required; do not regress).

---

## Whop (this owner)

Digital / membership / service / subscription catalogue + checkout only.
Physical private-label goods are refused before HTTP. Whop is not a
manufacturer, freight broker, landed-cost source, or Merchant of Record for
physical goods. `GET /accounts/me` is identity, **not** a checkout pass and
**not** `live_verified`.

Owned files: `packages/providers/src/whop/**`, `packages/providers/test/*whop*`,
`packages/services/src/commerce/whop.ts`, `packages/services/test/whop-checkout.test.ts`.
Route / queue / runtime splices are in `PATCH.md` (Whop section).

| Path | Status | Evidence |
|---|---|---|
| `Api-Version-Date: 2026-07-23` pin on every REST call | **DONE** (unit) | `packages/providers/test/whop-adapter.test.ts` — header present; sandbox host outside production; `account_id` not `company_id` |
| Physical `kind` refused with no HTTP | **DONE** (unit) | same file — `createProduct` / `createCheckout` / `createCheckoutConfiguration`; fetch spy not called |
| Products, checkout configuration, refunds against `/api/v1` | **DONE** (unit) | product + `plan_options`; `POST /checkout-configurations` with `internal_order_id` / `order_id`; refund `partial_amount` in major units |
| Webhook signature verify | **DONE** (unit) | Standard Webhooks accept / reject / missing `WHOP_WEBHOOK_SECRET` → `ConflictError`. Ingest 400/503/200-duplicate is the existing `/webhooks/whop` policy |
| Missing `WHOP_API_KEY` / `WHOP_COMPANY_ID` | **DONE** (unit) | adapter throws `CredentialsMissingError` before HTTP; service returns `blockedOn: commerce.membership` |
| Service catalogue → checkout metadata, no probe | **DONE** (unit) | `packages/services/test/whop-checkout.test.ts` — 6 passed. `probe()` is never called on the money path. Stripe/Dodo orders are refused. |
| Event map `payment.succeeded` credits once | **DONE** (unit) | `packages/providers/test/whop-events.test.ts` — `payment.created` carries no amount |
| Live Whop checkout / paid webhook | **NOT COMPLETE** | No live product → checkout → `payment.succeeded` run. Do not mark `live_verified` from `GET /accounts/me` |
| `POST /checkout/whop` + runtime wire | **NOT COMPLETE** | See `PATCH.md`. This owner did not edit `commerce.ts` routes, `catalog.ts`, or `runtime` |

---

## Replay QA (this owner) — 2026-08-15

Owned files only: `packages/providers/src/replay/**`, `packages/providers/test/*replay*`,
`packages/services/src/qa/orchestration.ts`, `packages/core/src/domain/qa.ts`,
`packages/core/test/qa.test.ts`, `packages/services/test/*qa*`. Shared splices in `PATCH.md`.

Unexecuted QA is not a pass. 0 product bugs after an infra-failed run is not a pass.

| Item | Status | Evidence |
|---|---|---|
| Create project → poll idle → read bugs; no second `POST /explorations` | **DONE** (unit) | `packages/providers/test/replay-orchestration.test.ts` |
| Timeout / `provider_unavailable` never recorded as completed | **DONE** (unit) | same file + `packages/services/test/qa-orchestration.test.ts` |
| `running` / `recording-lost` ≠ pass | **DONE** (unit) | `packages/core/test/qa.test.ts`, `packages/providers/test/replay-gate.test.ts` |
| Unexecuted required kind not a production pass | **DONE** (unit) | `packages/core/test/qa.test.ts` |
| High-severity commerce-flow defect blocks preview | **DONE** (unit) | `packages/core/test/qa.test.ts` |
| `isLocalTargetUrl` refused for production-gate runs | **DONE** (unit) | `packages/providers/test/replay-orchestration.test.ts`, `replay-adapter.test.ts` |
| Bug reports fed back as `qa_defect` artefacts (`site_builder`); no invented fixes | **DONE** (unit) | `packages/providers/test/replay-orchestration.test.ts` |
| Live Replay exploration completed | **NOT COMPLETE** | **recording-lost** still true. Project `proj-foundry-superserve-storefront-msuqvlop`: 29 infra-failed (recording-lost), 2 incomplete, 0 passed, 0 bugs. Idle ≠ pass. |

---

## Compute / runtime sponsors (PLAN.md §12)

One execution layer, three planes. Probes (`GET /sandboxes`, `GET /health`) are
**not** prize-method completion. Pause is not a shared primitive.

| Plane | Job | Status |
|---|---|---|
| Superserve | Persistent manager/specialist workspaces; pause **preserves VM state** | **`live_verified`** pause (do not regress). Identities `ss-ws-{function}-{company}` stay off foundry-api/worker. **No loop-phase artefact** — no phase queries for a persistent VM. |
| sandbox0 | Isolated untrusted/model-generated exec + fail-closed credential egress; pause does **not** keep processes | **`live_verified`** exec (do not regress). Identities `s0-exec-{function}-{company}`. **No loop-phase artefact** — no phase queries for isolated exec. |
| Solari | Real browser/GUI for research and compliant supplier discovery; human takeover UNVERIFIED (throws); never anti-bot as ToS bypass | **`live_verified`** exec (do not regress). Discover can persist `browser_session` evidence (URL+title only). Source has **no Solari quote artefact** — unreviewed marketplaces are `PolicyDeniedError`, no invented extract. Session replay: missing URL is blocked. |

Catalog names `research.browser` / `compute.sandbox_*`: see `PATCH.md`.

---

## Terac expert_validate (this pass)

Unit-tested path only. **Not** `live_verified`. Org credit remains **$0**; an unfunded draft is not panel results. `TERAC_STUDY_BLOCKER` is unchanged.

| Step | Status | Evidence |
|---|---|---|
| Feasibility request → poll until `RESPONDED` (or blocked) | **DONE** (unit) | `packages/services/test/expert-review.test.ts`: `RECEIVED` stays `pricing_pending` and does not launch; missing `TERAC_API_KEY` returns `blockedOn`, never throws. |
| Launch only when funded | **DONE** (unit) | `$0` `ValidationError` (`teracLaunchBlocked`) → review status `priced` + `blockedOn`. `toExpertReview` maps opportunity `draft` to `priced`, not `launched`. |
| `POST /webhooks/terac` HMAC + dedupe | **DONE** (unit) | `apps/api/test/terac-webhook.test.ts`: 503 if secret missing, 400 on bad sig, 200 `{duplicate:true}` on redelivery. HMAC is timestamp concatenated with raw body (no separator). |
| Submissions → `ExpertReview` only when complete | **DONE** (unit) | `toExpertReview` throws without critique / expert id / timestamp. Service `poll` / `ingestWebhook` skip incomplete rows rather than fabricating them. |
| `summariseReview` reject-one → `rejected` | **DONE** (unit) | Existing core test plus `expert-review.test.ts` poll/ingest: a single approved reject sets verdict `rejected`. |
| `assessForLoop` re-derives from the artefact | **DONE** (unit) | Completed reject artefact → `verdict: 'rejected'` (not an invented pass). Priced/$0 review → phase incomplete + `blockedOn`. Loop `#assessExpertValidate` splice is in `PATCH.md`. |
| Tools `expert.request_review` / `expert.poll` | **PARTIAL** | `expert.request_review` is already in the catalog (PolicyGate `expert.engage_paid`). `expert.poll` tool + webhook-processor + handler `expertJobOutcome` splice: `PATCH.md`. |

Prize method `terac_launch_draft_opportunity` / REST launch: **NOT COMPLETE** (live `$0` credit). Do not treat `GET /projects` as a pass.

---

## Digital product line (this pass)

`co_01M03F7RQW2M6540BY2GZHCFBW` is switched from physical goods to a digital
product line. The physical path could not complete: `#assessSource` gates on a
grounded supplier quote, and the live matrix reports `sourcing.rfq_submit` /
`sourcing.supplier_profile` as `unverifiable_no_public_api` and
`sourcing.quote_retrieve` as `unsupported_by_provider`, so no quote can ever
arrive. `risk.maxSupplierPurchaseWithoutHumanMinor` stays `0` — that boundary
was not relaxed, it was made irrelevant by not buying goods.

| Step | Status | Evidence |
|---|---|---|
| `commerce.productLine: 'physical' \| 'digital'`, defaulting to `physical` | **DONE** | `packages/core/test/company.test.ts`: default applies to a config written before the field existed; `productLineOf` falls back to `physical` on an absent/drifted/unreadable config. JSONB column, no migration. |
| `source` completes on a digital line with the reason recorded | **DONE** | `packages/services/test/loop-digital-line.test.ts`: `performed: false`, reason names the product line, `groundedQuoteCount` reports the real count. No supplier, RFQ or quote row is written. |
| Physical `source` behaviour unchanged | **DONE** | Same file: still waits for the first quote, still blocks on `sourcing.supplier_search`, still completes on real grounded quotes; a config with no `productLine` is treated as physical. |
| Digital unit economics from measured cost | **DONE** | `packages/services/test/digital-economics.test.ts`: `inference_compute` is `observed_actual` from `agent_runs.cost_minor_usd`; `hosting_delivery` stays `assumption`; Stripe's published schedule is `contract_rate`; `quote_id` is NULL and `incoterm` is `not_applicable`. |
| Refusals rather than invented numbers | **DONE** | Same file: no recorded inference → refuse; no selling price → refuse; margin below gate → refuse; non-USD → refuse to convert without an FX rate; caller component claiming `supplier_quote` → refuse. Nothing is persisted in any refusal. |
| Live row flipped | **DONE** | `productLine: "digital"` written through `CompanyRepository.updateConfig` (so it passes `CompanyConfig` on write); mission first clause rewritten, honesty sentence verbatim; every other config field byte-identical. `LoopOrchestrator.assess` run read-only against the live DB returns `complete: true` for `source` with the recorded reason. |

Deliberately marked `assumption`: **per-unit hosting/bandwidth**. Hosting is
billed per month, not per delivered unit, and nothing measures bytes served per
order — so it is carried at zero and tagged, exactly as unquoted freight is on
the physical path. At the contribution layer this demotes the whole landed line
to `assumption`, which is correct: a digital model must not read as fully
grounded on the strength of the one input that was measured.

Fixed on the way: `LandedCostRepository.listForCompany` ordered by a
`created_at` column `landed_cost_models` does not have, so `model_economics`
threw instead of assessing.

## Research clustering: 0 clusters from 700+ evidence rows (2026-08-16)

| Step | Status | Evidence |
|---|---|---|
| Diagnose why `research.cluster_pain_points` always returned `{"clusters":0}` | **DONE** | Two structural defects, both reproduced by running the shipped `clusterEvidence` against the live corpus: a `minConfidence: 0.5` read floor above the `0.4` the collector writes (180 of 213 rows invisible), and a same-`source_domain` requirement that made `independent_source_count` structurally 1 and `opportunitiesCreated` unreachable. |
| Cluster on subject matter across domains | **DONE** | IDF-weighted star clustering in `packages/services/src/research/cluster.ts`; live run `{"clusters":19,"opportunitiesCreated":16,"evidenceConsidered":708}`, 16 pain points with more than one independent source, max 37 distinct domains. |
| Read floor agrees with the collector | **DONE** | `CLUSTERABLE_EVIDENCE_MIN_CONFIDENCE = 0.35`: above the 0.3 that marks unverifiable evidence, below the 0.4 the search path writes. |
| Pain points state a pain in the evidence's own words | **DONE** | Statement is the best real sentence in the cluster (published text over page title, complaint language over vocabulary match); never a URL, never a search-engine placeholder. Labels use only words the evidence used. |
| `evidence_count` / `independent_source_count` are true | **DONE** | One item per cluster; `recomputeStats` no longer aggregates across the competitor `unnest`, which counted an item once per competitor named. |
| Regression tests | **DONE** | `packages/services/test/research-cluster.test.ts`, 18 tests on fixtures shaped like real collector output. `pnpm test` 1042 passed / 13 skipped. |
| Stale derived state removed from the live DB | **DONE** | 72 pain points, 90 links, 72 graph nodes and one fabricated `probe` opportunity deleted; `evidence_items` (733 rows) untouched. |

Still NOT COMPLETE: evidence carries no severity, purchase intent or sentiment —
the collector writes the schema defaults — so `median_severity` is 0 on every
pain point and the `pain_severity` score dimension stays ungrounded. Fixing that
needs a grounded extraction pass over the stored summary/excerpt; inferring it
from a search snippet would be invention.
