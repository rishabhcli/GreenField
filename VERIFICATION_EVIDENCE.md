# VERIFICATION EVIDENCE

Status: **NOT COMPLETE**. Company loop is **not DONE**. Production is **not complete**.

`live_verified` below means the **prize-relevant method succeeded**. Adapter `probe()` (GET /projects, catalog, GET /v1/services, GET /v1/balance, GET /sandboxes, …) is **not** `live_verified`.

Last updated: 2026-08-15. Secrets in this file: **none**.

---

## Company loop

| Item | Live fact |
|---|---|
| Company | `co_01M03F7RQW2M6540BY2GZHCFBW` |
| Workflows `tickCompanyLoop` | **COMPLETED** `trn-0994gda0c8fvlk1mc73fl86u0` |
| Tick action / discover | **no longer blocked on `research.web_search`** — `BRAVE_SEARCH_API_KEY` present, verifier probe passed 2026-08-16T00:07:59Z, capability `live_verified`. Cycle `task_01M03F84J1T2EVH9BNN0A66WG3` is `running` at phase `discover`, incomplete: 221 `evidence_items`, 0 `opportunities`. A `live_verified` capability is not a Brave prize-method pass. |
| Anthropic | `ANTHROPIC_API_KEY` missing |
| Loop | **not DONE** |

---

## `live_verified` (prize method succeeded)

| Method | Evidence |
|---|---|
| Stripe Payment Link | Live: `plink_1U4lK242nB81EBguRPuIHrxS` / `https://buy.stripe.com/bJe7sE7Ti3nmbLYdjb2go00`. Must charge the founding catalogue price ($99), not a customer-typed amount. Do not mint a second link. |
| Stripe webhook ingest | `POST https://foundry-api-8ih0.onrender.com/webhooks/stripe` ingest **200**. Endpoint `we_1U4n7G42nB81EBguLAx6jzsB`. |
| Band room | `a70129cc-0663-4090-86b5-c5a98025532e` (Zero Human Co coordination). Dispatch still requires this room. `GET /agent/me` is not mesh-complete. |
| Render Workflows `tickCompanyLoop` | **COMPLETED** `trn-0994gda0c8fvlk1mc73fl86u0` for `co_01M03F7RQW2M6540BY2GZHCFBW`. Brave/`research.web_search` block is the tick's loop output, not a workflow failure. |
| Linq link/open iMessage App | **HTTP 202** chat `de316f38-5ead-4ded-8ca9-27a5c4851987` message `b63a89a7-7204-47e3-bbe4-32acf278f3a9`. Stripe Payment Link as `params.url` (not `agentpay` `checkout_url`). |
| Superserve pause | Pause **proven** — VM state preserved across pause/resume. Distinct from sandbox0. |
| Solari exec | Exec **live**. |
| sandbox0 exec | Exec **live**. sandbox0 pause does **not** keep processes; not equivalent to Superserve pause. |

---

## Not `live_verified` (prize method did not succeed)

| Method | Exact live result |
|---|---|
| Linq Agent Pay `POST /v3/payment_requests` | **2011** no connected payment account. Stripe Payment Link is **not** `agentpay` `checkout_url`. Link/open **is** `live_verified`. |
| Pioneer `POST /inference` (GLiNER2-PII / GLiGuard) | **403** `card_required`. Catalog GET is not inference. |
| Terac launch (`terac_launch_draft_opportunity` / REST launch) | Org credit **$0**. Unfunded draft ≠ panel results. |
| Replay QA exploration completed | **recording-lost** (infra-failed). 0 product bugs ≠ pass. No clean report. |
| Lovable MCP site.generate | No OAuth (`LOVABLE_OAUTH_ACCESS_TOKEN` missing). |
| Dodo products/checkout | **HTTP 401**. |
| Discover / `research.web_search` | **`live_verified`** as of 2026-08-16T00:07:59.031Z. `apps/verifier` (`pnpm verify`) ran the manifest probe `GET /res/v1/web/search?q=foundry&count=1` and wrote a passing `integration_verifications` row: `brave_search  PROBE OK  live_verified  returned 1 result(s)` (352ms). Registry resolves `research.web_search` → provider `brave_search`, state `live_verified`, `usable=true`. No hand-inserted row, no stub. Discover is still **not complete** — 221 `evidence_items`, 0 `opportunities`; clustering is the open item. Loop **not DONE**. |
| Anthropic | `ANTHROPIC_API_KEY` missing. |

### Lovable (this owner)

Unit path is brand spec → MCP generate → files retrieved → site row generated.
`spec_drafted` is not complete. Production host is Render, never a Lovable
preview URL. Promo-code paths stay dead.

| Check | Result |
|---|---|
| Missing `LOVABLE_OAUTH_ACCESS_TOKEN` | `blocked_missing_credentials` (unit). Blocker text unchanged. |
| Completed `site.generate:{siteId}` | Replays; does not re-create (unit). |
| `deploy_project` URL | Preview only; not stored as `production_url` (unit). |
| Live `tools/call` | **not executed**. No OAuth (`LOVABLE_OAUTH_ACCESS_TOKEN` missing). Not `live_verified`. |

Dodo unit tests on this branch do not change the **HTTP 401** row. A fixture-signed digital path is not a live checkout. Physical goods stay refused.

---

## Infra (not a prize-method pass by itself)

| Resource | Id / slug | Live fact |
|---|---|---|
| `foundry-api` | `srv-da0bc249v7es7390p0s0` | **healthy** `https://foundry-api-8ih0.onrender.com` |
| `foundry-worker` | `srv-da0c2gpt0dsc739ct370` | **created** |
| Workflow | `wfl-da0b2b7lk1mc73fit5o0` / `foundry-workflows` | `tickCompanyLoop` **COMPLETED** `trn-0994gda0c8fvlk1mc73fl86u0` |
| Postgres 17 free | `dpg-da0b2smgekts739gp43g-a` | expires 2026-09-14 |
| Key Value free | `red-da0b34flk1mc73fiunc0` | `maxmemoryPolicy: noeviction` |

`.env` is gitignored. Do not commit it.

---

## Stripe physical-goods (unit close-out; do not re-probe live ingest)

Payment Link `plink_1U4lK242nB81EBguRPuIHrxS` and `POST /webhooks/stripe` ingest
**200** remain the live facts. This pass did **not** mint a second link and did
**not** re-run those probes.

Executed unit tests (2026-08-15) for remaining e2e holes:

- amount mismatch → `MANUAL_REVIEW` (`webhook-paid-amount`, webhook-processor)
- refund ceiling (`packages/services/test/refunds.test.ts`)
- duplicate webhook 200 `{duplicate:true}` (`apps/api/test/stripe-webhook.test.ts`)
- physical-via-Dodo throws (`commerce-physical`, collect-amount)
- tracked OOS reject (`commerce-physical`, `checkout-inventory`)
- `shipping_options` `fixed_amount` only; catalogue `unit_amount`; no `custom_unit_amount`
- lost dispute remaining captured (`lostDisputeRefundDelta`)

Loop wiring fixes (2026-08-15) are **unit-tested only** (`packages/services/test/loop-assess-build.test.ts`, `site-create-spec.test.ts`, `unit-contribution.test.ts`). They do not make the company loop DONE and are not `live_verified`.

Policy/domain P0s (selection gates on `opportunity.select`, arm contribution refuse, economics margin-gate fail, PolicyGate `live_verified` for spend/contact/publish, BAND dispatcher vs executor, Linq inbound → `support.inbound`, opt-out consent, `summariseReview` single-reject, QA preview commerce-flow) are **unit-tested only**. They do not make the company loop DONE and are not `live_verified`.

## BAND (unit evidence — not company-loop DONE)

Executed 2026-08-15 against source (`vitest run` on this branch). Not a live prize-method expansion.

| Check | Result |
|---|---|
| Specialist delegate | `PolicyDeniedError` / do not delegate |
| Non-direct-report | `PolicyDeniedError` |
| Unconfigured `dispatch` | refuses; enqueue count 0 |
| Unconfigured `enqueueSystem` | DB-only enqueue proceeds (support inbound) |
| Missing BAND assignment | executor row `failed`, not `running` |
| Channel labels | eight PLAN §2 lanes; finance handoff posts `CHANNEL=finance` into `a70129cc-…` |
| Audit | `audit_events.action = band.handoff` |
| Room reuse | `resolveCoordinationRoom` does not `createChat` when the live room is listed |
| Probe | `GET /agent/me` detail has no "mesh complete"; `coordination.governance` stays `marketing_claim_only` |

Runtime `{ band }` wiring and bootstrap room pin are in `PATCH.md`, not applied on this branch.

---

## Render Workflows prize method (completed task-run)

Recorded 2026-08-15. This is the prize method for **Best use of Render (Workflows)**. `GET /v1/services` remains the probe, not the pass.

| Item | Value |
|---|---|
| Request | `POST /v1/task-runs` task `foundry-workflows/tickCompanyLoop` |
| Task run | `trn-0994gda0c8fvlk1mc73fl86u0` |
| Status | **completed** |
| Company | `co_01M03F7RQW2M6540BY2GZHCFBW` |
| Tick result | action blocked on `research.web_search` (missing `BRAVE_SEARCH_API_KEY`) |

That tick result is honest **company-loop Discover** output. It is **not** a workflow failure and **not** a Render prize-method blocker. Brave remains missing (see Discover / `research.web_search` above). Do not treat missing Brave as `platform.workflows` `blockedOn`.

### Render storefront deploy (unit-tested, not live)

`packages/providers/test/render-topology.test.ts` + `packages/services/test/site-deploy.test.ts` (2026-08-15): localhost production topology refused; production deploy returns `blockedOn.capability = qa.release_gate` when `evaluateReleaseGate` has no artefact (no Render `triggerDeploy`); preview/staging never write `productionUrl`; localhost service URL refused as production. This is not a live storefront deploy and does **not** make the company loop DONE.

Terac launch, Linq Agent Pay, Pioneer inference, and Replay QA are unchanged — still not prize-method passes.

---

## API operator gates (unit-tested, not live-proven)

`apps/api/test/http-surface.test.ts` (2026-08-15): company mutators, every governance route, and `GET /webhooks/stuck` return 403 without a bearer token. `/health` and `/ready` stay open. Checkout + `GET /api/orders/:id` stay public. This is a local vitest result, not a probe against `foundry-api`.

Live HTTP status only (2026-08-15, after `foundry-api` deploy `dep-da0ehrou01pc73905m20` **live** and `foundry-site` rewrite + asset deploy): `GET https://foundry-api-8ih0.onrender.com/ready` **200**, `GET /readiness/company` **200**. Same paths on the static host now rewrite to the API: `GET https://foundry-site-ye1g.onrender.com/readiness/company` **200**, `GET /ready` **200**, `GET /api/companies` **200**. Live `console-config.js` assigns `https://foundry-api-8ih0.onrender.com` (sha256 prefix matches repo). CORS from `https://foundry-site-ye1g.onrender.com`: `GET /readiness/company` **200** ACAO match, `OPTIONS /readiness/company` **204** ACAO match; `evil.example` gets no ACAO. Not a prize method. Not `live_verified`. Loop **not DONE**.

Landing hero LED field (2026-08-16): `apps/site/test/landing.test.ts` asserts `#heroLeds` is present and that neither `.hero-leds` nor `body.lp .hero-leds` is `display: none` (28 tests passed locally). Live `foundry-site` deploy `dep-da0gjv0ae00c73fn8vdg` is **live** on commit `d301f8b`; `GET https://foundry-site-ye1g.onrender.com/assets/styles.css` has no `display: none` on `.hero-leds`, and `index.html` still includes `#heroLeds`. Not a prize method.

## Terac expert_validate (this pass)

Not a prize-method pass. Tests below are local/unit. They do not write `integration_verifications`.

| Claim | Evidence | Not evidence |
|---|---|---|
| HMAC over `timestamp + rawBody`, 400 / 503 / 200 duplicate | `apps/api/test/terac-webhook.test.ts` (2026-08-15, vitest) | A live Terac delivery against `foundry-api` |
| `$0` launch stays blocked; unfunded draft ≠ launched | `packages/services/test/expert-review.test.ts` + `toExpertReview` draft → `priced` | `GET /projects` probe |
| Reject-one → `rejected` | `summariseReview` unit test + poll/ingest in `expert-review.test.ts` | An invented verdict or empty panel |
| Missing capability → blocked, not thrown | `requestReview` / `poll` / `expertJobOutcome` in `expert-review.test.ts`; worker `tolerateMissingCapability` still wraps throws | Retrying `expert.poll` until a key appears |
| Webhook ingest refreshes then records only complete submissions | `ingestWebhook` unit test; incomplete critique is skipped | Trusting the webhook body as the submission |
| `assessForLoop` re-derives from the artefact | Completed reject → `verdict: 'rejected'`; priced/$0 → incomplete + `blockedOn` | In-memory loop state; current `#assessExpertValidate` until `PATCH.md` is applied |

Live blocker (unchanged): org credit **$0** — `TERAC_STUDY_BLOCKER`. Do not mark Terac `live_verified` until `apps/verifier` writes the row after a real funded launch.

---

## Historical verifier `probe()` rows (not prize-method `live_verified`)

A verifier run on 2026-08-15T18:40:37Z wrote 24 `integration_verifications` rows against hosted Postgres. Those rows record **adapter.probe()** outcomes. They must not be counted as prize-method `live_verified`.

Failed probe/config rows (still not live): dodo 401, lovable missing OAuth, egoist vendor approval, anthropic/meta_ads/google_ads/resend/cloudflare_dns/shippo/openai_images/brave_search/reddit missing keys, alibaba no verified public contract.

The landing page must not treat those 24 probe rows as current live_verified status. The integration table is an illustrative snapshot dated 2026-08-15; live state is the operator console. `apps/verifier` is the only writer of `integration_verifications` — the worker `verification.probe` handler no longer records rows, and that queue is not on `SCHEDULED_JOBS`. Alibaba search/profile evidence is `marketing_claim_only` (adapter always throws `VendorApprovalRequiredError`).

---

## Replay QA (this owner) — 2026-08-15

Unit path is storefront URL → `ensureProjectForTarget` (create starts exploration) →
`waitForProjectIdle` → `listBugs` → `toQaRunFromProject` → `evaluateReleaseGate`.
No second `POST /explorations`. `LIVE_PROBES=1` was not run in this pass.

| Check | Result |
|---|---|
| `running` / `recording-lost` ≠ pass | Unit: `packages/core/test/qa.test.ts`, `packages/providers/test/replay-gate.test.ts` |
| Unexecuted kind not a production pass | Unit: `packages/core/test/qa.test.ts` |
| High-severity commerce-flow blocks preview | Unit: `packages/core/test/qa.test.ts` |
| Localhost production-gate target refused | Unit: `packages/providers/test/replay-orchestration.test.ts` |
| Live exploration completed | **recording-lost** still true (2026-08-15). Project `proj-foundry-superserve-storefront-msuqvlop`: 29 `infra-failed` test runs mentioning recording-lost, 2 incomplete, 0 passed, 0 product bugs. Idle `finished_at` ≠ pass. Not `live_verified`. |

---

## Whop (this owner) — not `live_verified`

`GET /accounts/me` is the documented live **probe**. A 200 that returns the
configured `biz_` id is identity only. It is **not** a checkout pass and must
not be recorded as prize-method `live_verified`.

| Claim | Evidence (2026-08-15) |
|---|---|
| Physical kind refused, no HTTP | `pnpm test packages/providers/test/whop-adapter.test.ts` — 14 passed. Fetch spy not called on `physical_good`. |
| Version pin `2026-07-23` | Same file. Every mocked REST call sends `Api-Version-Date`. Sandbox host `https://sandbox-api.whop.com/api/v1` outside production. |
| Webhook verify | Same file. Standard Webhooks accept / reject; missing `WHOP_WEBHOOK_SECRET` refuses. |
| Missing key blocked | Adapter: `CredentialsMissingError` names `WHOP_API_KEY` / `WHOP_COMPANY_ID` before HTTP. Service: `packages/services/test/whop-checkout.test.ts` — 6 passed, `blockedOn.capability = commerce.membership`, `probe()` never called. |
| Order-linked metadata | Checkout body includes `internal_order_id` + `order_id`. Event map: `packages/providers/test/whop-events.test.ts` — 11 passed; only `payment.succeeded` carries a money delta. |
| Live checkout | **NOT COMPLETE**. No live product / checkout configuration / `payment.succeeded` webhook. Do not promote a probe row. |

---

## Compute / runtime sponsors (PLAN.md §12)

Probes (`GET /sandboxes`, `GET /health`) are **not** `live_verified`. Pause is
not a shared primitive. Unit evidence from this pass; live exec/pause facts
are unchanged.

| Plane | Live fact | This-pass unit evidence | Loop-phase artefact |
|---|---|---|---|
| Superserve | Pause **proven** — VM state preserved. Distinct from sandbox0. | `superserve-sandbox0-pause-semantics.test.ts`, `superserve-identities.test.ts`, `superserve-adapter.test.ts` | **None** |
| sandbox0 | Exec **live**. Pause does **not** keep processes. | same pause-semantics file + `sandbox0-identities.test.ts` + `sandbox0-adapter.test.ts` | **None** |
| Solari | Exec **live**. | `solari-navigate.test.ts` (no fabricated DOM), `solari-compliance.test.ts` (ToS/robots `PolicyDeniedError`), `solari-browser-sourcing.test.ts`, `solari-replay.test.ts` (missing URL blocked) | Discover: `browser_session` evidence possible. Source: **no quote artefact**. |

---

## Blocked-cycle recovery (2026-08-16)

A `blocked` `loop_cycles` row could not retract itself. `LoopOrchestrator`
re-derived the block on every tick, but the only writer that ever cleared
`status` / `blocked_reason` / `blocked_on_capability` was
`LoopCycleRepository.advance`, which runs solely when a phase is **complete**.
So a cycle blocked at `discover` on a then-missing `BRAVE_SEARCH_API_KEY` kept
naming that key as the reason the company was stuck for the four hours after the
key was set and `apps/verifier` recorded a passing probe — while the same ticks
were happily driving the phase's work. That stale row is read by
`GET /api/company/loop`, `/readiness` and the CEO's own `company.status` tool.

| Fact | Evidence |
|---|---|
| Probe is real | `pnpm verify` 2026-08-16T00:07:59Z — `brave_search  PROBE OK  live_verified  GET /web/search?q=foundry&count=1 returned 1 result(s)` (352ms). Written by `apps/verifier`, the only legitimate writer. |
| Registry agrees | `ctx.capabilities.resolveCapability('research.web_search')` → `{ provider: 'brave_search', state: 'live_verified', usable: true, lastVerifiedAt: 2026-08-16T00:07:59.031Z }`. |
| Stale row proven | `task_01M03F84J1T2EVH9BNN0A66WG3` was `status='blocked'`, `blocked_on_capability='research.web_search'`, `blocked_reason` from 2026-08-15T19:44Z, while the live assessment returned `{ complete: false, blockedOn: null }`. |
| Fix | `packages/services/src/loop/orchestrator.ts` — `#tickExclusive` retracts the stored block once an assessment produces no `blockedOn`, before advancing or driving. |
| Test | `packages/services/test/loop-recovery.test.ts` — 4 tests: retracts a stale block mid-phase, advances a previously blocked cycle, **keeps** the block when the capability is genuinely unavailable, and writes no unblock on a cycle that was never blocked. |
| Live row after | `status='running'`, `blocked_reason=NULL`, `blocked_on_capability=NULL`. |

This is a derived status field, not a verification record. Nothing here inserts
into `integration_verifications`.

---

## Agent-run resilience: dropped Postgres connections and runaway loops (2026-08-16)

Two live `agent_runs` failures on hosted Render infra, and what each turned out
to be. Neither is a verification record; nothing here writes
`integration_verifications`.

| Fact | Evidence |
|---|---|
| `run_01M03XWGXJZBFS49SWRRK9VVGE` died on `Connection terminated unexpectedly` | `pg` builds that error at `pg/lib/client.js:204` as a bare `Error` with no SQLSTATE, no `errno`, no `severity`. `mapPostgresError` (`packages/db/src/pool.ts`) returned `toFoundryError(...)` → `InternalError` → `category: 'internal'` → non-retryable, so `WorkerSet.#process` (`packages/queue/src/queues.ts:295`) converted it to a BullMQ `UnrecoverableError`. A transient network drop permanently killed the job. |
| Connection loss was also escaping classification entirely | Every transaction helper called `pool.connect()` **outside** its `try`, so a failure during checkout never reached `mapPostgresError`. Now routed through a `connect()` wrapper. |
| Keepalive was off | `pg` defaults `keepAlive: false`. Against `dpg-*.oregon-postgres.render.com` over the public internet, an idle socket the network has discarded still looks alive to the pool until a query uses it. Now `keepAlive: true, keepAliveInitialDelayMillis: 10_000`. |
| Pool `error` handler | Already present and correct (`pool.on('error')`); the comment now records *why* it must exist (an unhandled EventEmitter `error` would take the worker down). |
| Classification test | `packages/db/test/pool-errors.test.ts` — 35 tests. Codeless connection-loss messages → `provider_unavailable`; codeless timeout messages → `timeout`; socket/DNS `code`s and class-08/57 SQLSTATEs → `provider_unavailable`; `08007` deliberately stays `internal` (the transaction may already have committed); an unrecognised codeless message still fails closed to `internal`. |
| `run_01M03WYC2BKWWN5KGGBXWMT2YP` lost ~7 minutes of work | The executor already persisted every message and called `addUsage` per step, so `agent_messages` and `agent_runs.cost_minor_usd` were correct — but the catch path returned `iterations: 0, costMinorUsd: 0, finalText: ''`, so the job result and the audit event reported a run that looked like it never started. Now reports the accumulated figures and the last assistant text. |
| No wall-clock cap inside the run | `agent.run` carries `deadlineAt` in its payload; the handler dropped it and the executor never read `agent_runs.deadline_at`. The only bound was the queue's 15-minute abort, which kills mid-request. The executor now stops before an iteration it cannot finish within `DEADLINE_MARGIN_MS` of the deadline and closes the row out as `timed_out`. |
| No cap on an unproductive loop | Nothing detected an agent re-calling a tool that returns an unchanging result. `UnproductiveLoopDetector` stops the run after `MAX_BARREN_ITERATIONS` (3) consecutive iterations in which every tool call repeated an earlier (tool, input, result) triple. |
| Executor tests | `packages/agents/test/executor.test.ts` — 15 tests. Six cover the detector directly; four drive the real `AnthropicAdapter.runToolLoop` with only the HTTP call stubbed: barren-loop stop, deadline stop before any spend, malformed deadline ignored, and crash-mid-loop salvage. |
| Suite | Verified in a clean worktree at `c44cb9a` with only these six files applied: `pnpm clean && pnpm build` exit 0, `pnpm test` **960 passed / 13 skipped**, exit 0 (baseline 914 + 46 new). |

Not verified: no live probe was run against Render Postgres to reproduce the
socket drop, and the fixes were not exercised on hosted infra. `keepAlive` is
argued from `pg`'s default and the topology, not from a captured packet trace.

---

## Pain-point clustering produced zero clusters from 700+ real evidence rows (2026-08-16)

`research.cluster_pain_points` returned `{"clusters":0,"opportunitiesCreated":0}`
on every call, so no opportunity could ever be discovered and the whole loop
stalled at `discover`. Two independent defects, both proved against the live
corpus rather than argued.

| Fact | Evidence |
|---|---|
| The read filter sat above the confidence the collector writes | `ResearchClusterService.cluster` passed `minConfidence: 0.5`; `braveHitToDraft` (`packages/services/src/research/collect.ts:604`) writes `0.4` for every non-news web hit. Live distribution at the time: 213 rows total, **27** at ≥ 0.5, 180 Brave rows at 0.4. Running the shipped `clusterEvidence` against the live rows: 55 rows visible → **0 clusters**; all 246 rows → 2 clusters. |
| Grouping required two items to share a domain | `groupByDomainOverlap` skipped any candidate whose `source_domain` differed from the seed's, so every cluster had `independent_source_count = 1` and the `< 2` gate in the same file made `opportunitiesCreated` structurally unreachable. The one live run that did form clusters recorded `{"clusters":2,"opportunitiesCreated":0}`. |
| Labels were page titles, so the labelled path only grouped literal re-collections | `firstLabel` grouped on an exact `pain_point_labels[0]` match, and the collector stores `title.slice(0, 80)` there. The two live `pain_points` rows carried a truncated URL and a truncated title as their `statement`. |
| `evidence_count` was 0 with three rows linked | Not a clustering bug: `recomputeStats` aborted with `42702 column reference "independent_source_count" is ambiguous` (fixed in `f8926d2`), leaving the column at its default after `linkEvidence` had already committed. Verbatim in `agent_messages` at `00:00:23` and `00:00:29`. |
| `evidence_count` could also over-count | `recomputeStats` aggregated across a `LEFT JOIN LATERAL unnest(competitors_mentioned)`, counting an item once per competitor it mentions. The aggregate now runs over a `linked` CTE with the competitor unnest isolated in its own CTE. |
| Fix: clustering is now on subject matter, across domains | IDF-weighted star clustering (`packages/services/src/research/cluster.ts`). Items link when the terms they share carry ≥ 65% of the rarer item's specificity (Σ idf²), or when ≥ 60% of the shorter item's words appear in the other. Clusters are built around the highest-degree item, so a peripheral item cannot claim two neighbours, fail `minClusterSize` and take the real cluster down with it. Each item lands in one cluster, so `evidence_count` stays a true count. |
| Fix: the read floor now agrees with the producer | `CLUSTERABLE_EVIDENCE_MIN_CONFIDENCE = 0.35` — above the `0.3` that `refetch` and `research.update_confidence` clamp unverifiable evidence to, below the `0.4` the search path writes. |
| Fix: statements are verbatim evidence | The statement is the highest-scoring real sentence in the cluster — published text over page title, complaint language over vocabulary match, never a bare URL or a search-engine "we cannot provide a description" placeholder. Labels are built only from words the evidence used, shown in the most common surface form the corpus wrote them in. |
| Live run, real service, real repositories, 708 rows | `ResearchClusterService.cluster` → `{"clusters":19,"opportunitiesCreated":16,"evidenceConsidered":708}` in 36s. 19 pain points written, **16 with `independent_source_count` > 1**, max 37 distinct domains, 229 evidence rows linked. Top rows: `[ev=53 indep=37]` property maintenance software; `[ev=38 indep=25]` tenant maintenance requests; `[ev=30 indep=11]` late payments/invoices; `[ev=8 indep=7]` lien waivers; `[ev=10 indep=6]` multi-channel inventory sync. |
| Tests | `packages/services/test/research-cluster.test.ts` — 18 tests over fixtures shaped like real collector output (`<strong>` highlighting, `&#x27;` entities, titles in `pain_point_labels`, bare-URL summaries). Pins clusters > 0, cross-domain membership, statement is never a URL and never invented, label words all occur in the evidence, one item per cluster, determinism, placeholder rows never cluster, and that the service reads at a floor ≤ 0.4 but > 0.3. |
| Suite | `pnpm build` exit 0; `pnpm test` **1042 passed / 13 skipped**, exit 0; `pnpm lint` 0 errors (the two known warnings). |

Not fixed, and still true: `median_severity` is 0 on every pain point because
`severity` is 0 on every evidence row — the collector never classifies severity,
purchase intent or sentiment, and deriving them from a search snippet without a
grounded extraction pass would be invention. `DimensionScore.grounded` already
makes that visible to scoring rather than hiding it.

Live derived state written by the old code path was deleted so the loop restarts
clean: 72 pain points, 90 `pain_point_evidence` links, 72 `graph_nodes`, and one
fabricated `opportunities` row (`title: "probe"`, `pain_point_ids: ["__invalid_probe__"]`)
that would have completed the `discover` gate on nothing. `evidence_items` (733
rows) was not touched.
