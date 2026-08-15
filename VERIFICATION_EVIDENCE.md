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
| Stripe Payment Link | Live: `plink_1U4lK242nB81EBguRPuIHrxS` / `https://buy.stripe.com/bJe7sE7Ti3nmbLYdjb2go00`. Single customer-chooses-price path. Do not mint a second link. |
| Stripe webhook ingest | `POST https://foundry-api-8ih0.onrender.com/webhooks/stripe` ingest **200**. Endpoint `we_1U4n7G42nB81EBguLAx6jzsB`. |
| Band room | `a70129cc-0663-4090-86b5-c5a98025532e` (Zero Human Co coordination). Dispatch still requires this room. |
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
| Discover / `research.web_search` | Brave key missing. Loop **not DONE**. |
| Anthropic | `ANTHROPIC_API_KEY` missing. |

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

Terac launch, Linq Agent Pay, Pioneer inference, and Replay QA are unchanged — still not prize-method passes.

---

## Historical verifier `probe()` rows (not prize-method `live_verified`)

A verifier run on 2026-08-15T18:40:37Z wrote 24 `integration_verifications` rows against hosted Postgres. Those rows record **adapter.probe()** outcomes. They must not be counted as prize-method `live_verified`.

Failed probe/config rows (still not live): dodo 401, lovable missing OAuth, egoist vendor approval, anthropic/meta_ads/google_ads/resend/cloudflare_dns/shippo/openai_images/brave_search/reddit missing keys, alibaba no verified public contract.
