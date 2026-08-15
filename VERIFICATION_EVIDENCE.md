# VERIFICATION EVIDENCE

Status: **NOT COMPLETE**. Company loop is not DONE. `foundry-api` is not deployed.

Verifier **did run** on 2026-08-15T18:40:37Z against hosted Render Postgres (`foundry-postgres`, free, expires 2026-09-14) and wrote **24** `integration_verifications` rows. `live_verified` below means a **successful probe row** for that provider's `probe()`, not that every prize-track method works.

No **new** `live_verified` rows this pass. Terac probe was already `live_verified` (then 0 projects). Live REST+MCP since then created real project/study ids below. Launch is still unfunded.

---

## Harness

| Item | Value |
|---|---|
| Migrations | **5 applied** to Render Postgres (`0001`–`0005`) |
| Verifier | `apps/verifier` 2026-08-15T18:40:37Z |
| Rows | 24 (11 succeeded, 13 failed) — unchanged this pass |
| Typecheck / tests | `pnpm typecheck` pass; `pnpm test` **356 passed, 1 skipped** |
| Secrets in this file | **none** |

---

## Terac live study (not a new verifier row)

Created and re-read live on 2026-08-15. Launch retried via MCP `terac_launch_draft_opportunity`; still unfunded.

| Resource | Id | Status |
|---|---|---|
| Org slug | `rishabh-bansal` | live |
| Project (wired / `TERAC_PROJECT_ID`) | `iyuur8tks8ocsf250mcxsc80` | exists. Dashboard: `https://terac.com/rishabh-bansal/foundry-general-population-product-feedback-msuq69uk/opportunities` |
| Duplicate project (do not use) | `a2mlu6qhld2orwaywmylhmr7` | same name; accidental second create |
| Feasibility | `iu4tdil01i3xb805qlye2zdv` | attached to the draft (`feasibility_request_id`) |
| Opportunity / study | `ui73krvjvlip4x5vkruh7xkf` | **`draft`**, 5 participants, `b2c`, empty `filters` (General Population), CPI **$40.00**, total **$200.00** |
| Task | activity + `manual_review`, 8 min | Stimulus URL is the **one** Stripe Payment Link (`https://buy.stripe.com/bJe7sE7Ti3nmbLYdjb2go00`). Participants report buy/no-buy + price; company loop writes scorecard overrides from the verdict. |
| Screeners | `q0` consumer vs category pro; `q1` would-consider-private-label | live on the draft |
| Launch | **blocked** | MCP `terac_launch_draft_opportunity` `isError: true`: `Insufficient balance. Required: $200.00, Available: $0.00. The organization has to add credit before this launch can go through: https://terac.com/rishabh-bansal/settings/finance. Give that link to someone on the team with billing access instead of retrying - a member without it gets a 404 on that page.` REST `POST /opportunities/ui73krvjvlip4x5vkruh7xkf/launch` **HTTP 412** `PRECONDITION_FAILED` / `path: launchOpportunity` with the same message. `POST .../launch_draft` **HTTP 404** `NOT_FOUND`. |

Dashboard: `https://terac.com/rishabh-bansal/foundry-general-population-product-feedback-msuq69uk/opportunities/ui73krvjvlip4x5vkruh7xkf`

This is **not** `live_verified` as a launched study. The verifier probe is still `GET /projects`. Unfunded draft ≠ panel results. Before/after ranking is wired in `ExpertReviewService` (`expertVerdictOverrides`) and runs only after real submissions exist.

---

## `live_verified` (successful verifier row)

| Provider | Probe row detail | Prize-track caveat |
|---|---|---|
| **terac** | `GET /projects?limit=1` returned 0 projects (row at 18:40Z) | REST+MCP auth live. **Projects now exist** (see table above). Study remains **draft** — $0 org credit. |
| **stripe** | `GET /v1/balance` live mode | Payment Link `plink_1U4lK242nB81EBguRPuIHrxS` / `https://buy.stripe.com/bJe7sE7Ti3nmbLYdjb2go00` is the single customer-chooses-price agent payment path. Checkout Sessions remain storefront. Do not mint a second link. Inbound webhooks still need `STRIPE_WEBHOOK_SECRET`. |
| **whop** | `GET /accounts/me` `biz_Qv0M9IzQuuMRAZ` | Physical goods refused locally. Digital path reachable. |
| **render** | `GET /v1/services` returned 1 service | Workflow **created** (`foundry-workflows`, `wfl-da0b2b7lk1mc73fit5o0`). `POST /v1/task-runs` **202** (`trn-0994gda0b5qu1egvs738au0s0`) then **failed**: `Queue name cannot contain :` on **deployed GitHub main**. Local fix uses `environment.name` in `packages/queue/src/queues.ts`. **Not pushed** (no commit requested). Task-run not retried. |
| **linq** | `GET /v3/phone_numbers` 1 assigned line | **Agent Pay still blocked** (error 2011). iMessage `link` / `agentcard` paths do not need connected Stripe. Stripe plink is **not** used as agentpay `checkout_url`. |
| **superserve** | `GET /sandboxes?limit=1` | Earlier adapter probe: create → pause HTTP 204 → `paused` → delete. Pause preserves VM. |
| **replay** | `GET /projects` 0 projects at `https://loop-qa.replay.io/api/v1` | Auth live. Unexecuted QA ≠ pass. No foundry storefront URL (`foundry-api` not deployed). |
| **band** | `GET /agent/me` `@rishabh.rb/foundry-dispatch` | Dispatch requires Band. |
| **sandbox0** | `GET /api/v1/sandboxes?limit=1` | Not a prize track; probe succeeded. |
| **solari** | `GET /health` + sandboxes accepted | Not a prize track; probe succeeded. |
| **pioneer** | `GET /base-models?supports_inference=true` 106 models | **Inference still 403 `card_required`**. Catalog ≠ GLiNER2/GLiGuard run. No unpaid Fastino/GLiNER inference path found. Do not use as Claude proxy. |

---

## Failed verifier rows (not `live_verified`)

| Provider | Exact detail (truncated as stored) |
|---|---|
| dodo | HTTP 401 on products.list |
| lovable | missing `LOVABLE_OAUTH_ACCESS_TOKEN` |
| egoist | VendorApprovalRequiredError — request https://ego.ist/developers; no invented API |
| anthropic | missing `ANTHROPIC_API_KEY` |
| meta_ads | missing `META_ADS_ACCOUNT_ID` |
| google_ads | missing Google Ads token set |
| resend | missing `RESEND_API_KEY` |
| cloudflare_dns | missing `CLOUDFLARE_API_TOKEN` |
| shippo | missing `SHIPPO_API_TOKEN` |
| alibaba | no verified public Open Platform contract (GGS gate) |
| openai_images | missing `OPENAI_API_KEY` |
| brave_search | missing `BRAVE_SEARCH_API_KEY` |
| reddit | missing Reddit app credentials |

---

## Render Workflows (API, not Blueprint)

| Step | Result |
|---|---|
| `POST /v1/workflows` | **201** name `foundry-workflows` slug `foundry-workflows` |
| `POST /v1/workflowversions` | **201** → status **ready**; tasks: `tickCompanyLoop`, `runQaGate`, `collectResearch`, `reconcilePayments`, `operateCompany` |
| `POST /v1/task-runs` `{ task: "foundry-workflows/tickCompanyLoop", input: [{ companyId }] }` | **202** then failed on deployed code queue names (`Queue name cannot contain :`) |
| Blueprints | still cannot declare `type: workflow` |

---

## Infra provisioned this session (Render workspace Openclaw)

| Resource | Id / slug | Notes |
|---|---|---|
| Workflow | `wfl-da0b2b7lk1mc73fit5o0` / `foundry-workflows` | `RENDER_WORKFLOW_SLUG=foundry-workflows` in gitignored `.env` |
| Postgres 17 free | `dpg-da0b2smgekts739gp43g-a` | expires 2026-09-14; IP allowlist = verifier laptop |
| Key Value free | `red-da0b34flk1mc73fiunc0` | `maxmemoryPolicy: noeviction`; `CONFIG GET` is NOPERM (created with noeviction) |
| Existing web | `personal-ydgn` | unrelated repo; **no** DATABASE_URL/Redis env; used only as https stub for `PUBLIC_BASE_URL` until `foundry-api` exists |

`.env` is gitignored. Do not commit it.
