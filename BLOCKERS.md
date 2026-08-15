# BLOCKERS

Production **NOT COMPLETE**. Loop **not DONE**.

Company `co_01M03F7RQW2M6540BY2GZHCFBW`: Workflows `tickCompanyLoop` **COMPLETED**; discover is still blocked on missing Brave (loop output). Do not treat catalog probes as `live_verified`.

---

## Human-only (do not retry as if they will pass)

| Track | Exact error | Human action |
|---|---|---|
| Discover / Brave | ~~missing~~ — **key present, direct live probe HTTP 200** (2026-08-15, real web results). Now set on `foundry-worker` + `foundry-api`. | **Unblocked at the credential layer.** A raw API 200 is *not* a verified prize method: `apps/verifier` still has to write the `integration_verifications` row, and the loop still has to complete a discover phase. Reddit keys remain absent. |
| Anthropic | `ANTHROPIC_API_KEY` missing | Issue an Anthropic key. |
| Linq Agent Pay | `POST /v3/payment_requests` **2011** `no connected payment account on file for your account` | Connect Stripe in Linq dashboard. Do **not** use Stripe Payment Link as `agentpay` `checkout_url`. Linq link/open already **HTTP 202**. |
| Pioneer inference | **403** `card_required`: `To run inference on Pioneer, subscribe to the Hobby or Pro plan at https://agent.pioneer.ai/billing.` | Confirm billing actually authorizes inference. Then probe GLiNER2-PII + GLiGuard. Catalog is not a prize-method pass. |
| Terac launch | Org credit **$0** | Add credit at https://terac.com/rishabh-bansal/settings/finance (billing access required; others get 404). |
| Dodo | **HTTP 401** on `GET /products` | Issue a working key. Physical goods stay refused. |
| Lovable | no OAuth (`LOVABLE_OAUTH_ACCESS_TOKEN` missing); promo code globally dead | Reissued promo + OAuth from allowlisted client. Lovable stays priority 1; `site.generate` now has a first-party priority-2 fallback (`foundry_sitegen`, Anthropic-backed), so the build phase is gated on `ANTHROPIC_API_KEY` rather than solely on this OAuth. |
| Egoist | `VendorApprovalRequiredError` (by design) | Request access at https://ego.ist/developers. Do not invent REST. |

---

### Dodo (this branch)

The **HTTP 401** row above is unchanged. Local tests cover physical-route refusal, signed digital webhook state, 401-not-success, and refund ledger by `re_*`. That does not make Dodo `live_verified`. See `PATCH.md` for Stripe-owned collect/checkout/refund splices.

---

## Machine-unblocked vs still blocked

| Item | Status |
|---|---|
| `foundry-api` | **healthy** (`https://foundry-api-8ih0.onrender.com`, `srv-da0bc249v7es7390p0s0`) |
| `foundry-worker` | **created** (`srv-da0c2gpt0dsc739ct370`) — created ≠ loop DONE |
| Stripe Payment Link | **live** (`plink_1U4lK242nB81EBguRPuIHrxS`) — **must be a $99 catalogue Price, not customer-typed amount**. Stripe cannot replace Payment Link line-item Prices via API; pin it in the Dashboard. Landing founding CTA still uses that URL. Do not mint a second link. |
| Stripe webhook ingest | **200** at `POST /webhooks/stripe` — already `live_verified`. Do not re-probe as unfinished. |
| Stripe physical e2e (paid session → refund → dispute) | **unit-closed, not live-proven.** Checkout/webhook/refund/dispute honesty is covered by executed unit tests. A hosted physical SKU has not been paid+refunded+disputed in this pass. |
| Band room | **live** `a70129cc-0663-4090-86b5-c5a98025532e` |
| Render `tickCompanyLoop` | **COMPLETED** `trn-0994gda0c8fvlk1mc73fl86u0` — prize method **`live_verified`**. Brave block is loop output, not a workflow failure. |
| Linq link/open iMessage App | **HTTP 202** chat `de316f38-5ead-4ded-8ca9-27a5c4851987` message `b63a89a7-7204-47e3-bbe4-32acf278f3a9` (Payment Link as `params.url`) |
| Solari / sandbox0 exec | **live** |
| Superserve pause | **proven** |
| Hosted Postgres + migrations | **done** (free instance expires 2026-09-14) |
| Hosted Key Value `noeviction` | **done** |
| Company loop | **blocked**: discover needs Brave verification row + Anthropic. Tick completed; loop **not DONE**. Console 404 is fixed: live `foundry-site` bakes `https://foundry-api-8ih0.onrender.com` and rewrites `/readiness/*` + `/api/*` to `foundry-api` (GET **200**). `CORS_ALLOWED_ORIGINS` on live `foundry-api` includes `https://foundry-site-ye1g.onrender.com` (single-key PUT + deploy **live**; CORS GET/OPTIONS **200/204** with matching ACAO). |
| Replay QA | **blocked**: **recording-lost** — not a pass. 0 product bugs ≠ pass. |
| Redis `CONFIG GET` | NOPERM on free KV; instance was created with `noeviction`. |

---

## BAND leftovers (not company-loop DONE)

| Item | Status |
|---|---|
| Live room | **live** `a70129cc-0663-4090-86b5-c5a98025532e` (Zero Human Co). Do not create a second room and call channels done. |
| Runtime `{ band }` wiring | **PATCH required** — `packages/runtime/src/context.ts` still passes a truthy unconfigured adapter into `OrgDispatcher`. Until `PATCH.md` is applied, `enqueueSystem` will try to post and throw instead of proceeding DB-only. |
| Bootstrap `createChat` | **PATCH required** — `ensureBandCoordinationRoom` must call `resolveCoordinationRoom` / pin `a70129cc-…` instead of opening a decorative chat. |
| Human in the room | **NOT COMPLETE** — `@mention` of another participant is mandatory; a room that contains only `foundry-dispatch` cannot hand off. No live human-participant proof. |
| `GET /agent/me` | Identity probe only. Not mesh-complete. Not `coordination.governance`. |
| Company loop | **not DONE** — BAND coordination does not unblock Brave / Anthropic. |

---

## Dashboard leftover

Copy gitignored `.env` names into Render env for `foundry-api` / `foundry-worker` when adding new secrets. `BRAVE_SEARCH_API_KEY` **is** present locally and has now been pushed to both services via the Render API. `CORS_ALLOWED_ORIGINS` is set on live `foundry-api` (single-key PUT, not a bulk replace). Reddit and **Anthropic** remain absent — Anthropic is the single key still gating the loop. `hackathon-sponsor-credentials.md` exists in the working tree and is gitignored — it is **not** tracked; do not `git add -f` it or commit `.env`.

---

## Render (this owner)

Do not treat this subsection as loop DONE.

| Item | Status |
|---|---|
| Workflows `tickCompanyLoop` | **COMPLETED** `trn-0994gda0c8fvlk1mc73fl86u0` — prize method **`live_verified`**. Do not mint a second success. `GET /v1/services` is the probe, not the pass. |
| `foundry-loop-tick` cron | **must stay absent** (double-fire). See `PATCH.md`. |
| Production storefront deploy | **blocked** until Replay writes a gating QA artefact `evaluateReleaseGate` will pass, and `RENDER_STOREFRONT_SERVICE_ID` names a real Render service. `foundry-site` is not that storefront. |
| `CORS_ALLOWED_ORIGINS` | Must include the generated storefront origin once it exists (fail-closed production). Landing origin `https://foundry-site-ye1g.onrender.com` is a separate host. |
| Localhost production | Refused by `assertProductionTopology` at boot and by `SiteDeployService` if Render returns a localhost URL. |

---

## Whop (this owner)

Do not treat this subsection as a prize-method pass. `GET /accounts/me` is not
a checkout and is not `live_verified`.

| Item | Status |
|---|---|
| Physical goods on Whop | **refused in code** before HTTP (`ValidationError` + `assertPaymentRoute`). Use Stripe for physical private-label. |
| Missing `WHOP_API_KEY` / `WHOP_COMPANY_ID` | **blocked** (`commerce.membership`), not a retryable failure. |
| Missing `WHOP_WEBHOOK_SECRET` | Existing `/webhooks/whop` returns **503**; adapter `verifyWebhook` throws `ConflictError`. Do not accept unsigned money events. |
| Live catalogue → checkout → paid webhook | **NOT COMPLETE**. Unit path is built. No live `prod_` / `ch_` / `payment.succeeded` evidence. |
| `POST /checkout/whop` | **unwired**. Splice is in `PATCH.md`. `/api/checkout` stays Stripe physical — do not steal that volume or Dodo's digital MoR claim. |
| API version | Pin `Api-Version-Date: 2026-07-23`. Unpinned requests silently become `2025-01-01` (`company_id`). |

---

## Replay QA (this owner) — 2026-08-15

Do not treat this subsection as a prize-method pass.

| Item | Status |
|---|---|
| Live exploration | **blocked**: **recording-lost** still true. Project `proj-foundry-superserve-storefront-msuqvlop`: 29 infra-failed, 2 incomplete, 0 passed, 0 bugs. |
| Production-gate localhost | **refused** in `QaOrchestrationService` (`isLocalTargetUrl`). |
| Loop `#assess('qa')` | Still completes on any finished latest run — splice `isReplayQaPhaseComplete` in `PATCH.md`. Until applied, a failed Replay row can advance the phase. |
| `REPLAY_QA_BLOCKER` in prize-tracks | Stale "status running" string. Import `@foundry/core`'s `REPLAY_QA_BLOCKER` (`PATCH.md`). |

---

## Compute / runtime sponsors (PLAN.md §12)

One subsection, three planes. Probes are not prize-method completion.

| Plane | Status |
|---|---|
| Superserve | Pause **proven** (VM state preserved). Missing `SUPERSERVE_API_KEY` is blocked. **No loop-phase artefact.** |
| sandbox0 | Exec **live**. Pause does **not** keep processes — not a Superserve equivalent. Missing `SANDBOX0_TOKEN` is blocked. **No loop-phase artefact.** |
| Solari | Exec **live**. Human takeover UNVERIFIED (throws; escalate via Terac). `POST /desktops` unverified (timed out). Unreviewed marketplace navigation is `PolicyDeniedError`. Discover can use `research.browser_session`; source has **no Solari quote artefact**. Missing `SOLARI_API_KEY` is blocked. `GET /health` / `GET /sandboxes` are probes. |

---

## Terac expert_validate (this pass)

Live launch is still blocked. Unit path is ready; splices in `PATCH.md` are not applied.

| Item | Status |
|---|---|
| Org credit | **$0**. Exact live refusal remains `TERAC_STUDY_BLOCKER` (`Required: $200.00, Available: $0.00`). Billing: https://terac.com/rishabh-bansal/settings/finance (members without billing access get 404). |
| `live_verified` | **No.** `apps/verifier` has not written a launch row after a real funded launch. `GET /projects` is a probe, not a pass. |
| Unfunded draft | Must not be treated as panel results. Service keeps status `priced` and returns `blockedOn`. |
| Webhook secret | `TERAC_WEBHOOK_SECRET` still required for `POST /webhooks/terac`. Missing secret → **503** (provider retries). Route exists; processor ingest splice is in `PATCH.md`. |
| Loop assessment | `ExpertReviewService.assessForLoop` re-derives from the review artefact. `LoopOrchestrator.#assessExpertValidate` still skips when the capability is unusable — splice in `PATCH.md`. |
