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
| Lovable | no OAuth (`LOVABLE_OAUTH_ACCESS_TOKEN` missing); promo code globally dead | Reissued promo + OAuth from allowlisted client. |
| Egoist | `VendorApprovalRequiredError` (by design) | Request access at https://ego.ist/developers. Do not invent REST. |

---

## Machine-unblocked vs still blocked

| Item | Status |
|---|---|
| `foundry-api` | **healthy** (`https://foundry-api-8ih0.onrender.com`, `srv-da0bc249v7es7390p0s0`) |
| `foundry-worker` | **created** (`srv-da0c2gpt0dsc739ct370`) — created ≠ loop DONE |
| Stripe Payment Link | **live** (`plink_1U4lK242nB81EBguRPuIHrxS`) |
| Stripe webhook ingest | **200** at `POST /webhooks/stripe` |
| Band room | **live** `a70129cc-0663-4090-86b5-c5a98025532e` |
| Render `tickCompanyLoop` | **COMPLETED** `trn-0994gda0c8fvlk1mc73fl86u0` — prize method **`live_verified`**. Brave block is loop output, not a workflow failure. |
| Linq link/open iMessage App | **HTTP 202** chat `de316f38-5ead-4ded-8ca9-27a5c4851987` message `b63a89a7-7204-47e3-bbe4-32acf278f3a9` (Payment Link as `params.url`) |
| Solari / sandbox0 exec | **live** |
| Superserve pause | **proven** |
| Hosted Postgres + migrations | **done** (free instance expires 2026-09-14) |
| Hosted Key Value `noeviction` | **done** |
| Company loop | **blocked**: discover needs Brave. Anthropic missing. Tick completed; loop **not DONE**. |
| Replay QA | **blocked**: **recording-lost** — not a pass. 0 product bugs ≠ pass. |
| Redis `CONFIG GET` | NOPERM on free KV; instance was created with `noeviction`. |

---

## Dashboard leftover

Copy gitignored `.env` names into Render env for `foundry-api` / `foundry-worker` when adding new secrets. `BRAVE_SEARCH_API_KEY` **is** present locally and has now been pushed to both services via the Render API. Reddit and **Anthropic** remain absent — Anthropic is the single key still gating the loop. Do not commit `.env` or `hackathon-sponsor-credentials.md`.
