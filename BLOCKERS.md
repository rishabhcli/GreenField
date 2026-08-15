# BLOCKERS

Production **NOT COMPLETE**. Loop **not DONE**.

---

## Human-only (do not retry as if they will pass)

| Track | Exact error | Human action |
|---|---|---|
| Linq Agent Pay | `POST /v3/payment_requests` **2011** `no connected payment account on file for your account` | Connect Stripe in Linq dashboard. Do **not** use Stripe Payment Link as `agentpay` `checkout_url`. |
| Pioneer inference | **403** `card_required`: `To run inference on Pioneer, subscribe to the Hobby or Pro plan at https://agent.pioneer.ai/billing.` | Confirm billing actually authorizes inference. Then probe GLiNER2-PII + GLiGuard. Catalog probe is already `live_verified`. |
| Dodo | **HTTP 401** on `GET /products` | Issue a working key. Physical goods stay refused. |
| Lovable | missing `LOVABLE_OAUTH_ACCESS_TOKEN`; promo code globally dead | Reissued promo + OAuth from allowlisted client. |
| Egoist | `VendorApprovalRequiredError` (by design) | Request access at https://ego.ist/developers. Do not invent REST. |

---

## Machine-unblocked vs still blocked

| Item | Status |
|---|---|
| Hosted Postgres + 5 migrations | **done** (free instance expires 2026-09-14) |
| Hosted Key Value `noeviction` | **done** |
| Verifier rows | **done** — 11 `live_verified` |
| Render Workflow service + registered tasks | **done** via `POST /v1/workflows` |
| `POST /v1/task-runs` accepted | **202** |
| Workflow **task success** | **blocked**: deployed GitHub `main` still uses BullMQ queue names `environment:name`. Local fix: `environment.name` in `packages/queue/src/queues.ts`. **Push/deploy required** (user did not ask to commit). |
| `foundry-api` web service | **not created**. `PUBLIC_BASE_URL` currently stubs `https://personal-ydgn.onrender.com` (unrelated personal app) so the verifier can boot with TLS. |
| Terac General Population study | **blocked**: 0 Terac projects. Create a project in Terac, then MCP `terac_request_feasibility` / `terac_launch_draft_opportunity`. |
| Replay QA gate | **blocked**: 0 Replay projects / no live storefront URL. Unexecuted QA ≠ pass. |
| Stripe webhook ingest | **blocked**: `STRIPE_WEBHOOK_SECRET` unset. Submit Payment Link + read-only `rk_` to organizers (never `sk_`). |
| Redis `CONFIG GET` | NOPERM on free KV; instance was created with `noeviction`. |

---

## Dashboard leftover

Copy gitignored `.env` (`DATABASE_URL`, `REDIS_URL`, `RENDER_WORKFLOW_SLUG`, `BAND_AGENT_API_KEY`) into Render env for any new `foundry-api` / worker. Do not commit `.env` or `hackathon-sponsor-credentials.md`.
