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
| Tick action / discover | **blocked** on `research.web_search` — `BRAVE_SEARCH_API_KEY` missing. Loop output, not a workflow failure. Not a Brave success. |
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
| Discover / `research.web_search` | 2026-08-15: `BRAVE_SEARCH_API_KEY` present, `GET /res/v1/web/search` → **HTTP 200** with real web results; key pushed to `foundry-worker` + `foundry-api` (Render API, HTTP 200 each). **Not `live_verified`** — a hand-run curl is not `apps/verifier` writing an `integration_verifications` row. Loop **not DONE**. |
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
