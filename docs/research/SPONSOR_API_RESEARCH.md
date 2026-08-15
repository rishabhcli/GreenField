# Sponsor & External API Research

**Research date: 2026-08-14.** Every fact below was fetched from the provider's own
documentation, OpenAPI spec, or package registry on that date. Facts that could not be
pinned to a primary source are marked **UNVERIFIED** and the adapters treat them as
assumptions to confirm before production activation.

No live API call was made against any provider — no credentials exist yet. Everything
here is *documented contract*, not *observed behaviour*. The verification harness
(`apps/verifier`) is what converts documented contract into observed behaviour, and only
it may write a `live_verified` record.

---

## 1. Terac — human expertise on demand

| Field | Value |
|---|---|
| REST base | `https://terac.com/api/external/v2` — **self-labelled "v2 beta"; shapes may change** |
| Auth | `Authorization: Bearer <API key>` |
| Rate limit | 100 requests/minute/key → `429 RATE_LIMITED` |
| Pagination | Cursor: `limit` (default 25, max 100) + `cursor`; response `{ data[], pagination: { next_cursor, has_more } }` |
| Idempotency | **Not documented.** Adapter supplies its own dedupe via a local idempotency table. |
| Sandbox | **None found.** UNVERIFIED. |
| MCP | `https://terac.com/api/mcp`, streamable HTTP, OAuth on first connect |
| SDK | **None.** Raw HTTP only. |

### Endpoints (paths directly verified)
- `POST /opportunities` — create a paid expert engagement.
  Required: `title` (1–200), `project_id`, `num_participants` (1–1000), `business_type`
  (`b2c`|`b2b`), `tasks[]` (each `{sequence, task_type, review_type, task_url, duration_minutes}`).
  Optional: `description` (≤5000), `filters[]`, `screening_questions[]`, `cross_quotas[]`
  (≤200), `device_types`, `expected_days_to_complete` (5–50000000), `feasibility_request_id`.
- `POST /feasibility/requests` — price/feasibility check before committing spend.
  Required: `taskDescription` (1–10000), `panelDescription` (1–10000).
  Optional: `submissionCount`, `timelineHours`, `requestorEmail`.
  Returns immediately `status: "RECEIVED"`, null pricing → poll until `"RESPONDED"`.
- `GET /projects` — cursor paginated.
- `GET /opportunities/{opportunityId}/submissions` — cursor paginated, `status` filter.
- `POST /hooks/subscriptions` — `{ target_url, event_types[] }`.
- `POST /hooks/subscriptions/{id}` — confirm (empty body) after answering the signed ping.

Operations confirmed to exist but whose exact path segments were **not** individually
verified: `getFeasibilityRequest`, `listFeasibilityRequests`, `createProject`,
`launchOpportunity`, `pauseOpportunity`, `resumeOpportunity`, `stopOpportunity`,
`getSubmission`, `approveSubmission`, `rejectSubmission`, `getWebhookSubscriptionSecret`,
`rotateWebhookSubscriptionSecret`, `listWebhookDeliveries`. The adapter routes these
through a single documented-path resolver so a corrected path is a one-line change.

### Webhooks
- Events verified: `submission.status.change`, `submission.approved`. (`listWebhookEventTypes`
  exists; full catalogue UNVERIFIED.)
- Signature header: `X-Terac-Request-Signature` =
  `base64(HMAC_SHA256(secret, timestamp + rawBody))` — **timestamp and body concatenated
  with no separator.** Timestamp header: `X-Terac-Request-Timestamp` (Unix seconds).
  Also sends `X-Event-ID` and `X-Timestamp` (ISO-8601).
- Retries: up to 12, first after 1 min, exponential to 12 h, ~2.5 days total. Retries on
  `5xx/408/429` only. 10 s delivery timeout.

### Error envelope
```json
{ "error": { "code": "BAD_REQUEST", "message": "...", "details": [{ "field": "...", "message": "..." }] } }
```
Codes: `BAD_REQUEST` 400, `UNAUTHORIZED` 401, `NOT_FOUND` 404, `CONFLICT` 409,
`RATE_LIMITED` 429, `INTERNAL_SERVER_ERROR` 500.

### MCP tools (names verified; full JSON schemas UNVERIFIED)
`terac_request_feasibility`, `terac_get_feasibility_request`, `terac_launch_draft_opportunity`,
`terac_get_submissions`, `terac_list_opportunities`, `terac_get_context`, `terac_pause_opportunity`.

---

## 2. Stripe — payments for physical goods

| Field | Value |
|---|---|
| Node SDK | `stripe@22.5.0` |
| API version | `2026-07-29.dahlia` (stable channel). A `.preview` channel of the same dated cut also exists; relationship UNVERIFIED — we pin the stable string explicitly. |
| Key prefixes | `sk_test_`/`sk_live_`, `pk_test_`/`pk_live_`, `rk_test_`/`rk_live_`, `sk_org_`. Mode is detected from the prefix; there is no introspection endpoint. |
| Idempotency | Header `Idempotency-Key`, ≤255 chars, V4 UUID recommended, keys pruned after ≥24 h. Same key + different body → error. |
| Webhook secret | `whsec_...`, max 16 endpoints/account, 24 h dual-secret rotation window |

### Checkout Session (physical goods)
`POST /v1/checkout/sessions`, `mode: payment`. Fields we use:
- `line_items` (max 100), `client_reference_id` (≤200), `metadata`
- `success_url` / `cancel_url`
- `shipping_address_collection.allowed_countries[]` (required when the object is present)
- `shipping_options[]` (max 5) with inline `shipping_rate_data`:
  `type: fixed_amount`, `fixed_amount.{amount,currency}`, `display_name`,
  `delivery_estimate.{minimum,maximum}.{unit,value}`, `tax_behavior`, `tax_code`
  (`txcd_92010001` Shipping / `txcd_00000000` Nontaxable)
- `automatic_tax.enabled`
- `payment_intent_data.{capture_method, description, metadata, receipt_email,
  statement_descriptor_suffix, shipping, transfer_group}`

Shipping rates are **fixed amount only** — they cannot scale with cart size.
`shipping_options` is `payment` mode only.

### Webhook verification
- Header `Stripe-Signature`: `t=<unix>,v1=<hmac_sha256_hex>,v0=<decoy>`. **Only accept `v1`.**
- Raw body required. Default tolerance **5 minutes**; never set tolerance 0.
- `stripe.webhooks.constructEvent(rawBody, sigHeader, endpointSecret)`.
- HTTPS + TLS 1.2/1.3 only. Live-mode retries for up to 3 days with backoff.

### Event names we handle (verbatim)
`checkout.session.completed`, `checkout.session.async_payment_succeeded`,
`checkout.session.async_payment_failed`, `checkout.session.expired`,
`payment_intent.succeeded`, `payment_intent.payment_failed`, `payment_intent.processing`,
`payment_intent.canceled`, `payment_intent.requires_action`,
`charge.succeeded`, `charge.failed`, `charge.refunded`, `charge.updated`,
`refund.created`, `refund.updated`, `refund.failed`,
`charge.dispute.created`, `charge.dispute.updated`, `charge.dispute.closed`,
`charge.dispute.funds_withdrawn`, `charge.dispute.funds_reinstated`,
`radar.early_fraud_warning.created`, `review.opened`, `review.closed`.

### Refunds & disputes
- `POST /v1/refunds` — `payment_intent`|`charge`, `amount`, `reason`
  (`duplicate`|`fraudulent`|`requested_by_customer`), `metadata`.
  Status: `pending`|`requires_action`|`succeeded`|`failed`|`canceled`.
- Disputes: `GET/POST /v1/disputes/{id}`, `POST /v1/disputes/{id}/close`.
  Status: `warning_needs_response`|`warning_under_review`|`warning_closed`|`needs_response`|
  `under_review`|`won`|`lost`|`prevented`. Evidence fields incl. `shipping_carrier`,
  `shipping_tracking_number`, `shipping_date`, `service_documentation`; `evidence_details.due_by`.

### Stripe Tax
`automatic_tax.enabled = true` requires an active registration covering the buyer's
jurisdiction, a `tax_code` per line item, **and a `tax_code` on the shipping rate**.

---

## 3. Lovable — programmatic site generation

| Field | Value |
|---|---|
| REST API | **Does not exist.** Docs: "More endpoints and integration options are on the way." |
| MCP | `https://mcp.lovable.dev`, **streamable HTTP only**, no stdio |
| Auth | **OAuth 2.1 + RFC 9728 only. No API keys.** |
| OAuth client id (public, for non-allowlisted-by-URL clients) | `6d465f583e1e4ce5801b1616f735670c` |
| Client allowlist | ChatGPT, Claude Desktop, claude.ai, Claude Code, Cursor, VS Code |
| Credits | MCP available on all plans incl. Free; only `create_project` and `send_message` consume build credits |
| Repo | `github.com/lovablelabs/mcp` (Apache-2.0) |

### Tools (names verified; per-tool JSON schemas UNVERIFIED)
Identity: `get_me`, `list_workspaces`, `get_workspace`.
Projects: `list_projects`, `get_project`, `create_project`, `deploy_project`
(*"deploys the app and returns a live URL"*), `remix_project`, `set_project_visibility`,
`list_template_projects`, `list_design_systems`.
Agent: `send_message`, `get_message`, `list_messages`.
Knowledge/skills: `get/set_workspace_knowledge`, `get/set_project_knowledge`,
`list/get/create/update/delete_workspace_skill`.
Code: `get_diff`, `list_files`, `read_file`, `list_edits`.
Database: `get_database_status`, `enable_database`, `query_database`.
Connectors: `list_connectors`, `list_connections`, `add_connector`, `remove_connector`.
Analytics: `get_project_analytics`, `get_project_analytics_trend`.
Uploads: `get_file_upload_url`.

### Consequence for architecture — important
The Lovable control surface is an **OAuth-gated MCP server restricted to an allowlist of
first-party chat clients**. A headless Render worker is not on that allowlist and cannot
mint an OAuth token unattended. Therefore:
- The site-generation capability is modelled as `site.generate` bound to Lovable via an
  **MCP client adapter** that requires an operator-completed OAuth device/browser flow, with
  the resulting token stored as a secret reference.
- Until that token exists the capability reports `blocked_missing_credentials` with exact
  instructions. It is never reported as working.
- Because generated code is exportable via GitHub sync and `read_file`/`get_diff`, the
  storefront pipeline does **not** depend on Lovable hosting: code is exported and deployed
  on Render, so the release/QA/rollback path stays under our control.

### Other Lovable surfaces
- "Build with URL": `https://lovable.dev/?autosubmit=true#prompt=<enc>&images=<url>&html=<url>`.
  Prompt ≤50,000 chars, ≤10 total attachments, public JPEG/PNG/WebP only.
- Webhooks (medium confidence, npm page was 403): headers `x-lovable-signature`,
  `x-lovable-timestamp`; signed string `${timestamp}.${rawBody}`; secret is a Lovable API
  key. Event catalogue UNVERIFIED, appears email-scoped today.
- Preview is **not data-isolated** from production — same backend and database.

---

## 4. Whop — commerce primitives

| Field | Value |
|---|---|
| Production REST | `https://api.whop.com/api/v1` |
| Sandbox REST | `https://sandbox-api.whop.com/api/v1` (dashboard `sandbox.whop.com`) |
| Auth | `Authorization: Bearer <API key>`; embedded apps also use `x-whop-user-token` JWT |
| API version header | `Api-Version-Date: 2026-07-23` (unpinned defaults to `2025-01-01` behaviour) |
| Rate limit | 600 req/min per operation per credential |
| Pagination | Relay cursors: `after`, `before`, `first`, `last`; response `page_info` + `total_count` |
| Idempotency | Header `Idempotency-Key`; 24 h replay; same key + different body → 400; concurrent → 409; replay marked `Idempotent-Replayed: true` |
| SDK | `@whop/sdk@0.0.42` (current, REST). `@whop/api` is **deprecated** (GraphQL). Also `@whop/checkout@0.6.0`, `@whop/cli@0.15.0` |
| GraphQL | Retired from current docs (old GraphQL doc URLs 301 away) |

### Endpoints used
- `GET /accounts/me` — identity probe, returns `biz_`-prefixed id. **This is our live probe.**
- `POST /products` — `company_id`, `title` (≤80), `description`, `visibility`, `plan_options`, `metadata`. Scopes `access_pass:create`, `access_pass:basic:read`.
- `GET /memberships` — filters `company_id`, `product_ids[]`, `plan_ids[]`, `statuses[]`
  (`trialing|active|past_due|completed|canceled|expired`), date ranges.
- `GET /payments?company_id=biz_...`, plus `create/retrieve/refund/retry/void-payment`, `list-fees`.
- `POST /webhooks` — `url`, `events[]`, `api_version_date`, `resource_id`; response carries `webhook_secret`.

### Webhooks
Standard Webhooks: headers `webhook-id`, `webhook-timestamp`, `webhook-signature` (`v1,<b64>`);
HMAC-SHA256 over `{webhook-id}.{webhook-timestamp}.{rawBody}`; reject timestamps >5 min.
Respond 2xx within 5 s; retries ~3 days, 30 s → 12 h backoff.

Events relevant to us: `payment.created`, `payment.succeeded`, `payment.failed`,
`payment.pending`, `refund.created`, `refund.updated`, `dispute.created`, `dispute.updated`,
`membership.activated`, `membership.deactivated`, `membership.trial_ending_soon`,
`membership.cancel_at_period_end_changed`, `product.created/updated/published`,
`plan.created/updated`, `shipment.created/updated`, `member.created`.
(The names `membership.went_valid` / `went_invalid` found in older third-party writeups
**do not exist** in the current catalogue.)

### Sandbox limitations
No payouts, no Apps & Messaging, no Apple/Google Pay. Test cards `4242…4242` (success),
`4000…0002` (declined), `4000…0341` (setup ok, later charge declines), `5385…5181` (3DS).

### Gating
API keys and app creation are self-serve. **Public marketplace listing is review-gated**
(`marketplace_status`: `not_available` → `pending_review` → `live_marketplace`), and app
production builds go through `draft|pending|approved|rejected`.

---

## 5. Render — production hosting

| Field | Value |
|---|---|
| Blueprint schema | `https://render.com/schema/render.yaml.json`; CLI ≥ 2.7.0 validates |
| REST API | `https://api.render.com/v1`, `Authorization: Bearer <key>` |
| MCP | `https://mcp.render.com/mcp` (hosted, OAuth or bearer) |
| Node default | `24.14.1` for services created after 2026-04-21; pin via `NODE_VERSION` > `.node-version` > `.nvmrc` > `engines.node` |

### render.yaml keys
Root: `services[]`, `databases[]`, `envVarGroups[]`, `previews`, optional `projects`/`ungrouped`.

Service: `name`, `type` (`web`|`pserv`|`worker`|`cron`|`keyvalue`), `runtime`
(`node`|`docker`|`image`|… — **`runtime` supersedes the older `env` key**), `plan`
(`free`|`starter`|`standard`|`pro`|`pro plus`|`pro max`|`pro ultra`), `region`
(`oregon`|`ohio`|`virginia`|`frankfurt`|`singapore`), `buildCommand`, `startCommand`,
`preDeployCommand`, `initialDeployHook`, `healthCheckPath`, `autoDeployTrigger`
(`commit`|`checksPass`|`off`), `rootDir`, `buildFilter.{include,ignore}`, `numInstances`,
`scaling.{minInstances,maxInstances,targetMemoryPercent,targetCPUPercent}`,
`disk.{name,mountPath,sizeGB}`, `maxShutdownDelaySeconds`, `ipAllowList`, `domains`,
`dockerfilePath`, `dockerContext`, `dockerCommand`, `schedule` (cron).

Env var references: `fromDatabase.{name,property}` (`connectionString`|`host`|`port`|`user`|
`password`|`database`), `fromService.{name,type,property}` (`host`|`port`|`hostport`|
`connectionString`), `fromGroup: <groupName>` (**per-variable, not a service-level list**),
`sync: false` (secret, prompted once at creation, excluded from previews, **not valid inside
`envVarGroups`**), `generateValue: true` (random 256-bit, base64).

Postgres `databases[]`: `name`, `databaseName`, `user`, `plan` (`free`|`basic-256mb`|
`basic-1gb`|`basic-4gb`|`pro-*`|`accelerated-*`), `diskSizeGB`, `region`,
`postgresMajorVersion`, `connectionPool: pgbouncer`, `ipAllowList`, `readReplicas`,
`highAvailability`. `name`/`databaseName`/`user`/`region`/`postgresMajorVersion` are immutable.

Key Value (Valkey 8, Redis-compatible) lives in `services[]` with `type: keyvalue`
(deprecated alias `redis`): `plan`, `region`, `maxmemoryPolicy`, `ipAllowList`
(empty array = internal-only). Internal URL `redis://red-xxxx:6379`; external is TLS-only
`rediss://`.

> **BullMQ requirement:** Render docs state *"For job queues, we recommend using `noeviction`
> to ensure that queued jobs are not lost."* BullMQ independently requires
> `maxmemory-policy: noeviction`. We set `maxmemoryPolicy: noeviction` explicitly rather than
> relying on the default, which sources reported inconsistently.

### Zero-downtime deploys & health checks
New instances start alongside old; traffic switches only when all new instances pass health
checks simultaneously; a failure cancels the deploy and reverts. **Adding a persistent disk
disables zero-downtime deploys** — so no service in this system mounts a disk.
Health check: 2xx/3xx within **5 s**. No `healthCheckPath` → TCP probe only.
15 s of failures → traffic removed; 60 s → instance restarted.

### REST API endpoints used
`GET /services`, `POST /services/{id}/deploys` (trigger), `GET /services/{id}/deploys`,
`POST /services/{id}/deploys/{deployId}/rollback`, `GET /events`, `GET /logs`,
`GET/PUT /services/{id}/env-vars`, Postgres and Key Value CRUD.

---

## 6. Linq — customer communications

| Field | Value |
|---|---|
| Base | `https://api.linqapp.com/api/partner` — all resources under `/v3/...` |
| Auth (V3) | `Authorization: Bearer <token>`; env `LINQ_API_V3_API_KEY` |
| Auth (V2, legacy) | `X-LINQ-INTEGRATION-TOKEN` — genuinely different header, not a doc error |
| Sandbox | Account-level mode on the **same host**; self-serve at `dashboard.linqapp.com/sandbox-signup`, capped **100 messages/day** |
| Rate limits | ~7,000 combined msgs/line/day recommended; burst 30 msgs/60 s per sender-recipient pair; violation → 429 error code `1007`. No `Retry-After` header confirmed. |
| Pagination | `cursor` + `limit` (chats 1–100 default 20; messages 1–100 default 50); response `next_cursor` |
| Idempotency | `message.idempotency_key` body field **and** `Idempotency-Key` header both documented (≤255 chars); canonical form UNVERIFIED — adapter sends both |
| SDKs | `@linqapp/sdk@0.39.0` (Node), `linq-python@0.25.0`, `github.com/linq-team/linq-go` |

### Messaging
One unified send endpoint; the protocol is an *outcome*, not a separate endpoint.
`POST /v3/messages` → **202 Accepted**
- `to[]` (E.164 or email, required), `from` (optional — omit for auto-select/failover)
- `message.parts[]` — `{type: "text"|"media"|"link"|"imessage_app", value|url|attachment_id}`
- `message.preferred_service` — `"iMessage"|"RCS"|"SMS"`
- `message.effect`, `message.reply_to.{message_id,part_index}`, `message.experience`
- Response: `{ chat_id, message_ids[], from_selection: { from, reason }, created_chat, trace_id }`

Also: `POST /v3/chats/{chatId}/messages`, `GET /v3/chats/{chatId}/messages`,
`GET/PATCH/DELETE /v3/messages/{messageId}`, reactions, typing indicators,
`POST /v3/chats/{chatId}/read`, `POST /v3/attachments` (≤100 MB pre-upload, ≤10 MB inline URL),
`POST /v3/capability_checks`. Text parts ≤10,000 chars; group chats ≤31 handles.

### Webhooks
`POST /v3/webhook-subscriptions` (`target_url` HTTPS, supports `?version=YYYY-MM-DD`;
`subscribed_events[]`) → returns a `whsec_`-prefixed secret.
Standard Webhooks headers `webhook-id`/`webhook-timestamp`/`webhook-signature`,
HMAC-SHA256 over `{id}.{timestamp}.{rawBody}`, reject >5 min old.
Legacy deprecated headers still sent: `X-Webhook-Event`, `X-Webhook-Subscription-ID`,
`X-Webhook-Timestamp`, `X-Webhook-Signature`.

Events we consume: `message.received`, `message.sent`, `message.delivered`
(**iMessage/RCS only, never SMS/MMS**), `message.read` (iMessage/RCS only), `message.failed`,
`reaction.added`, `chat.created`, `participant.added/removed`,
`phone_number.status_updated`, `call.initiated/ringing/answered/ended/failed/declined/no_answer`.

### Opt-out — platform enforced
Keywords (whole-message): `STOP`, `UNSUBSCRIBE`, `OPTOUT`, `CANCEL`, `END`, `QUIT`, `OPT OUT`.
Linq itself rejects further sends with **error code 2024 / HTTP 403**. Chats expose
`health_status: "OPTED_OUT"`. Separate org-level block list: `GET/POST /v3/blocked_handles`,
`DELETE /v3/blocked_handles/{handle}` (errors 2025 / 2026).

### Phone numbers — not self-serve
Docs: *"Numbers are provisioned by your Linq representative — there is no self-serve create
or delete endpoint on the V3 API."* We expose `GET /v3/phone_numbers`
(`status: ACTIVE|FLAGGED`, `reputation: HEALTHY|AT_RISK|CRITICAL`, `forwarding_number`) and
`PUT /v3/phone_numbers/{id}`. `GET /v3/available_number` is an onboarding-steering endpoint,
**not** a purchase endpoint.

### Voice — thinly documented
Endpoints exist under the OpenAPI "Calls" tag: `POST /v3/calls`,
`POST /v3/calls/{callId}/answer`, `POST /v3/calls/{callId}/hangup`. **Request/response schemas
are UNVERIFIED** (the 466 KB OpenAPI spec truncated on fetch) and no example payload exists
for any `call.*` event. The adapter implements the call endpoints against the documented
paths and marks the capability `configured_unverified` with this caveat recorded.

---

## 7. Superserve — persistent agent sandboxes

| Field | Value |
|---|---|
| Control plane | `https://api.superserve.ai`, header `X-API-Key: ss_live_...` |
| Data plane | `https://boxd-{id}.sandbox.superserve.ai` (or shared host + `X-Superserve-Sandbox-Id`), header `X-Access-Token` |
| MCP | `https://mcp.superserve.ai` (`Authorization: Bearer ss_live_...`) or `npx -y @superserve/mcp` |
| SDK | PyPI `superserve@0.8.2`; npm `@superserve/sdk` (registry fetch 403, existence corroborated via GitHub README) |
| OpenAPI | `github.com/superserve-ai/sandbox` → `api/openapi.yaml` |
| Access | Self-serve, no waitlist |

Endpoints: `POST/GET /sandboxes`, `GET/PATCH/DELETE /sandboxes/{id}`,
`POST /sandboxes/{id}/pause` (checkpoints memory + processes + filesystem, stops compute
billing), `/resume` (rotates access token), `/activate`,
`POST/DELETE /sandboxes/{id}/secrets`, `GET/POST/DELETE /sandboxes/{id}/preview-ports`,
`GET /sandboxes/{id}/network` (egress log).
Exec: `POST /exec` (`command`, `shell`, `timeout_s` → `stdout`, `stderr`, `exit_code`,
`truncated`), `POST /exec/stream` (SSE), `GET /exec/connect` (WS).
Files: `GET /sandboxes/{id}/files` (list), `GET /files?path=&format=zip`, `POST /files?path=`.

Create body: `name`, `from_template`, `timeout_seconds` (1–604800, **cap on active time, not
idle**), `auto_delete_seconds` (0–2592000), `metadata`, `env_vars`, `network`, `secrets`,
`preview_access` (`public`|`private`). Returns `id`, `status` (`active`|`paused`|`resuming`),
`vcpu_count`, `memory_mib`, `access_token`.

Error codes: `rate_limited`, `too_many_sandboxes` (paused don't count), `too_many_builds`,
`too_many_templates`. No published numeric rate limits. No agent-facing webhooks
(`POST /stripe/webhook` is billing-only).

---

## 8. Replay QA — autonomous QA release gate

| Field | Value |
|---|---|
| Base | `https://loop-qa.replay.io/api/v1` — **one source read `https://qa.replay.io` instead; the adapter reads `servers[].url` from the live OpenAPI at boot rather than hard-coding** |
| OpenAPI | `GET /api/v1/openapi.json` |
| Auth | `Authorization: Bearer lqa_...` (`lqa` = the internal "Loop QA" codename) |
| Pagination | `page` (default 1), `page_size` (default 20, max 100) |
| Rate limits / idempotency | Not documented. UNVERIFIED. |
| Launched | 2026-05-18, generally available, credit-metered on all plans incl. Free (25 credits/mo) |

Endpoints:
- `GET/POST /projects` — create: `name`, `target_url` required; optional `webhook_url`,
  `finished_webhook_url`, `logins`, `design_document`, `instructions`, `recording_id`,
  `use_reverse_proxy`, `enabled_polish_passes`, `budget`. Returns `exploration_id`, `url`.
- `GET/PATCH /projects/{id}`, `GET /projects/{id}/status`, `GET /projects/{id}/timing`,
  `GET /projects/{id}/reverse-proxy`.
- `GET /projects/{id}/bugs?status=open|fixed|wontfix|invalid`, `GET /bugs/{id}`,
  `PATCH /bugs/{id}` (`status`: `open|reopened|fixed|wontfix|invalid|judge-rejected|pr-closed`).
- `GET/POST /projects/{id}/journeys`, `GET /journeys/{id}`.
- **`POST /projects/{id}/explorations`** (optional `prompt`) — this is "run QA now".
  `GET /explorations/{id}` → discovered journeys + bugs.
- `GET /projects/{id}/test-runs?journey_id=`, `GET/POST /projects/{id}/versions`
  (`git_sha`, `branch_name` required; `deployed_url`, `timestamp`, `change_description`).

**No built-in pass/fail CI check is documented.** The gate is therefore implemented on our
side: after an exploration completes we poll `GET /projects/{id}/bugs?status=open`, classify
by severity, and block the release. Webhook event names, payload schema and signature scheme
for `webhook_url`/`finished_webhook_url` are **UNVERIFIED**, so the adapter treats the webhook
as an optimisation and polling as the authoritative path.

Separate general-purpose Replay MCP (recording inspection, not QA triggering):
`https://dispatch.replay.io/nut/mcp`, 25 tools.

---

## 9. BAND — agent coordination & governance

| Field | Value |
|---|---|
| Base | `https://app.band.ai/api/v1` |
| Auth | Header **`X-API-Key`**; `thnv_a_...` = agent key, `thnv_u_...` = human/user key. Human API also accepts `Authorization: Bearer <JWT>`. **Agent keys get 403 on Human API endpoints.** |
| WebSocket | `wss://app.band.ai/api/v1/socket/websocket?api_key={key}&vsn=2.0.0` — Phoenix Channels, frames `[join_ref, ref, topic, event, payload]`, **read-only server→client**; heartbeat 30 s, closes after 45 s idle; one connection per Agent ID, last-connect-wins |
| SDK | PyPI `band-sdk@1.6.0` (2026-08-03). **No npm package — docs state "npm: Not available (Python-only SDK)".** We implement a TypeScript HTTP + Phoenix-channel client. |
| Rebrand | Formerly **Thenvoi**; `docs.thenvoi.com` 301s to `docs.band.ai`; legacy naming persists in key prefixes and the MCP package name `thenvoi-mcp` |

Agent API: `GET /agent/me` (**our live probe**), `GET /agent/peers`,
`GET/POST /agent/contacts` (+ `/add`, `/remove`, `/requests`, `/requests/respond`),
`GET/POST/PATCH /agent/chats[/{id}]` (optional `task_id`),
`GET/POST /agent/chats/{id}/messages`, `GET /agent/chats/{id}/messages/next`,
`POST /agent/chats/{id}/messages/{id}/processing|processed|failed`,
`POST /agent/chats/{id}/events` (`tool_call`|`tool_result`|`thought`|`error`|`task` — visible
to humans, **do not route to other agents**),
`GET/POST/DELETE /agent/chats/{id}/participants`, `GET /agent/chats/{id}/context`
(rehydration), `POST /agent/chats/{id}/activity` (keep-alive),
`GET/PUT/POST /agent/chats/{id}/tasks[/history]`, `/board`,
`PUT/GET /agent/chats/{id}/files[/{id}]`,
`GET/POST /agent/memories[/{id}/supersede]`, `/archive`.

Human API: `/me/profile`, `POST /me/agents/register` (schema UNVERIFIED), `/me/agents[/{id}]`,
`/me/peers`, `/me/contacts...`, `/me/chats[/{id}]`, `/me/chats/{id}/messages`.

**Routing rule that shapes our design:** *"All messages require @mentions; messages without
them won't route to anyone"* and *"Agents only see messages that mention them."* Our
coordination layer therefore always addresses a specific agent handle.

**Governance reality check:** the marketing "control plane / governance" framing is broader
than the exposed API. Concretely verified primitives are: contacts as a mutual permission
handshake, @mention as the routing/authority primitive, one isolated execution per agent per
room, and `is_external`/`is_global` flags. **No role/policy/scope objects, audit-log endpoint
or approval-workflow API were found.** Consequently BAND is used for cross-agent
coordination and human participation, and the authoritative governance/approval/audit
functions are implemented in our own policy service — which is where they must live anyway,
since they gate real money.

No outbound webhooks found (UNVERIFIED-absence). Error shape:
`{"error": "unauthorized", "message": "Invalid or missing API key"}`.

---

## 10. Dodo Payments — Merchant of Record for eligible digital products

| Field | Value |
|---|---|
| Test base | `https://test.dodopayments.com` |
| Live base | `https://live.dodopayments.com` (distinct hostnames per mode, not a flag) |
| Auth | `Authorization: Bearer <API key>`; keys are mode-scoped and either read/write or read-only |
| SDK | npm **`dodopayments@2.46.0`** (not `@dodopayments/node`); PyPI `dodopayments@1.112.0` |
| Rate limits | Tier 0: 40 req/s burst, 240/min sustained. Headers `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset` |
| Pagination | `page_size` (default 10, max 100) + `page_number` (default 0); response `{items:[…]}` with **no total-count or next-page field** |
| Idempotency | **No general `Idempotency-Key` header.** Only isolated body fields (`POST /webhooks`, wallet ledger, usage `event_id`). Our adapter compensates with a local idempotency ledger keyed on our own operation id. |

Endpoints: `POST/GET /products`, `PATCH /products/{id}` (`tax_category`:
`digital_products|saas|e_book|edtech|live_tutoring`); **`POST /checkouts`** (required
`product_cart[]` of `{product_id, quantity}`; optional `customer`, `return_url`, `cancel_url`,
`metadata`, `discount_code`, `billing_currency`, `force_3ds`, `subscription_data`,
`allowed_payment_method_types`, `custom_fields`; returns `session_id`, `checkout_url`,
`client_secret`, `payment_id`); `POST/GET/PATCH /subscriptions`,
`POST /subscriptions/{id}/change-plan`; `POST/GET/PATCH /customers`,
`POST /customers/{id}/customer-portal/session`; `POST /refunds` (`payment_id` required,
`items[]` for partial); licensing `POST /license_keys` (auth) and **unauthenticated**
`POST /licenses/activate|validate|deactivate`.

`POST /payments` and `POST /subscriptions` are documented as **deprecated in favour of
Checkout Sessions** — we use Checkout Sessions.

Webhooks: Standard Webhooks, headers `webhook-id`/`webhook-timestamp`/`webhook-signature`,
HMAC-SHA256 over `{id}.{timestamp}.{rawBody}`; SDK helper `client.webhooks.unwrap(...)`; the
npm package depends on `standardwebhooks@^1.0.0`. Retries: 8 attempts (immediate, 5 s, 5 min,
30 min, 2 h, 5 h, 10 h, 10 h); 15 s timeout. Secret rotation keeps the old secret valid 24 h.

Events we consume: `payment.succeeded`, `payment.failed`, `payment.processing`,
`payment.cancelled`, `refund.succeeded`, `refund.failed`, `dispute.opened|accepted|challenged|
won|lost|expired|cancelled`, `subscription.active|renewed|on_hold|paused|cancelled|failed|
expired|plan_changed|updated`, `license_key.created`, `abandoned_checkout.detected|recovered`,
`dunning.started|recovered`, `entitlement_grant.created|delivered|failed|revoked`.

### Merchant acceptance — a hard compliance boundary
Dodo's supported categories are SaaS, AI products, digital goods, templates/plugins/apps.
**Physical goods are on the enumerated prohibited list** (alongside 30 other categories).
Live payouts additionally require KYC/KYB (Persona ID + liveness, bank verification, and for
entities registration docs, tax ID, director IDs, beneficial owners ≥10%), and the Product
Info Form is checked against the live website. `assertPaymentRoute()` in the commerce domain
rejects `dodo_merchant_of_record` for `physical_good` so this can never be misrepresented.

---

## 11. Sandbox0 — isolated execution with credential controls

| Field | Value |
|---|---|
| Base | `https://api.sandbox0.ai` (self-hosted override `SANDBOX0_BASE_URL`) |
| Auth | Team-scoped API key in `SANDBOX0_TOKEN`. **The literal HTTP header string is UNVERIFIED** — docs only show SDK constructors. Adapter sends `Authorization: Bearer` and records the assumption. |
| SDKs | Go `github.com/sandbox0-ai/sdk-go`; PyPI `sandbox0`; npm `sandbox0` (Node ≥18, Apache-2.0) |
| CLI | `s0` |
| Rate limits (self-hosted defaults) | `api_requests` 100 req/s burst 200; `sandbox_claims` 5/1000 ms; `active_sandboxes` 100; 429 with `error.code: quota_exceeded` + `Retry-After` |
| MCP | **Does not host one.** It offers MCP *tool-call firewalling* for agents inside the sandbox. |

Endpoints: `POST/GET /api/v1/sandboxes`, `GET /api/v1/sandboxes/{id}[/status]`,
`PUT /api/v1/sandboxes/{id}` (only `ttl`, `hard_ttl`, `resources.memory`, `network`,
`auto_resume`, `services`), `POST /api/v1/sandboxes/{id}/refresh`, `DELETE …`.
Status: `starting|running|paused|terminating|failed`.
Contexts (exec): `POST /contexts`, `POST /contexts/{id}/exec` → `output_raw`, `stdout`,
`stderr`, `exit_code`, `state`; `POST /contexts/{id}/input|restart`; `GET /contexts/{id}/ws`.
Files: `GET/POST/DELETE /files?path=`, `GET /files/list`, `POST /files/move`, `GET /files/stat`.
Volumes: `POST/GET/DELETE /api/v1/sandboxvolumes[/{id}]`.
Network policy: `GET/PUT /sandboxes/{id}/network` — `mode` (`allow-all`|`block-all`),
`egress.trafficRules` (ordered allow/deny by domain/CIDR/port), `egress.credentialRules`,
`egress.protocolRules` (incl. `protocol: mcp` with `mcp.tools.allowed/denied`, fail-closed).
Observability: `GET /sandboxes/{id}/metrics`, `/observability/logs`, `/observability/events`.

Previews: `POST …/previews` (`port`, `protocol`, `path`, `ttl_seconds` 30–3600) →
one-time-credential bootstrap URL that sets an exact-host, `Secure`, `HttpOnly`,
`SameSite=None`, partitioned cookie. Hostname pattern
`https://<sandbox_id>--p<port>.<region>.<root_domain>`; docs: *"The hostname is routing
information, not authorization."*

**Credential isolation — the reason we use Sandbox0 for untrusted code:** Credential Sources
(`static_headers`, `static_tls_client_certificate`, `static_username_password`,
`static_ssh_private_key`) plus Bindings with projections (`http_headers`,
`placeholder_substitution` — the sandbox only ever sees an opaque placeholder and the real
value is substituted at the egress boundary — `tls_client_certificate`, `ssh_proxy`), matched
by `credentialRules` with `failurePolicy: fail-closed`.

Webhooks: configured at sandbox creation (`url`, `secret`, `watch_dir`), immutable at runtime.
Events `sandbox.ready|paused|resumed|killed|deleted`, `process.started|exited|crashed`,
`file.modified`, `agent.event`. HMAC-SHA256, header **`X-Sandbox0-Signature`**, dedupe by
`event_id`, retries with backoff up to 24 h.

Note: pause checkpoints the encrypted root filesystem but **does not** preserve running
processes, memory, sockets or PIDs — unlike Superserve, whose pause does. That difference
determines which plane each workload runs on.

---

## 12. Solari by Pinetree Research — browsers, sandboxes, GUI computers

| Field | Value |
|---|---|
| Base | `https://api.getsolari.com` (single region `us-west`) |
| Auth | `Authorization: Bearer slr_live_<id>_<secret>`; create routes accept `Idempotency-Key: <uuid-v4>` |
| SDKs | npm `@solarisdk/browser@0.1.1` (depends on `patchright-core`), `@solarisdk/sandbox@0.1.2`, `@solarisdk/desktop@0.1.2`, `@solarisdk/core@0.1.2`; PyPI `solari-sandbox@0.2.0`, `solari-desktop@0.2.0` |
| MCP | `https://mcp.getsolari.com/mcp`, 27 tools |
| Limits | Concurrency-based per plan (Free 3 browsers/1 sandbox/1 h sessions → Pro 150/10/24 h); 429 `ConcurrencyLimitExceeded` |
| Note | `pinetreeresearch.com` is a parked domain; brand link confirmed via npm maintainer `pinetreeresearch` |

Browser: `POST /sessions` (`profileId`, `recording`, `stealth`, `captcha`, `webBotAuth`,
`proxy`) → `sessionId`, `wsEndpoint`, `cdpEndpoint`, `expiresAt`, `storageStateUrl`.
`DELETE /sessions/:id` → 204. `GET /sessions/:id/replay-url` (recording must have been on).
**Docs state `GET /sessions/:id` "always returns 404 in practice; route is non-functional"** —
the adapter never calls it and tracks session state locally.
WebSocket: `wss://…/ws/:sessionId` (Playwright protocol), `wss://…/cdp/:sessionId` (raw CDP),
`wss://…/ws/observe/:sessionId?token=` (live observer). URLs expire 90 minutes after creation.

Sandboxes: `POST /sandboxes` (`kind`, `template`, `fromSnapshot`, `cpu`, `memMb`, `diskGb`,
`envs`, `metadata`, `timeoutMs`, `lifecycle`, `record`, `volumes`) → `sandboxId`,
`controlUrl`, `expiresAt`, `streamUrl`, `recordingUrl`; `POST /sandboxes/:id/exec`;
`/pause`, `/resume`, `/timeout`, `/metrics`; presigned file up/download; snapshots
(`POST /sandboxes/:id/snapshots`, `/snapshots/:id/promote` → template); `POST /:id/revert`.

Desktops (GUI): `POST /desktops` → `sessionId`, `streamUrl` (`wss://…/stream/:id` serving raw
RFB/VNC bytes), `controlUrl`; `GET/DELETE /desktops/:id`, `/pause`, `/resume`.

Profiles: `client.profiles.create({name})` persists cookies/logins; attach via
`POST /sessions {profileId}`. Docs warn: *"Anyone with your API key can attach it to a session
and act as that account"* — so profile secrets are treated as high-privilege credentials and
gated behind the policy service.

Recording: `recording: true` → `GET /sessions/:id/replay-url`, plus NDJSON download.
Docs warn *"Recording captures input values by default"* — we disable recording on any
session that touches a credential field.

**Human takeover is UNVERIFIED.** `ws/observe` and the VNC `stream` are documented as
observation/embedding mechanisms; whether they inject two-way human control is not stated.
The takeover capability is therefore modelled as `unverifiable_no_public_api` until confirmed,
and the sourcing workflow's human-escalation path routes through the expert marketplace
instead of assuming browser takeover works.

No webhooks found. Health: `GET /health`, `GET /healthz` (unauthenticated).

---

## Cross-cutting observations that shaped the architecture

1. **Standard Webhooks is the de-facto standard.** Whop, Dodo and Linq all use
   `webhook-id` / `webhook-timestamp` / `webhook-signature` with HMAC-SHA256 over
   `{id}.{timestamp}.{rawBody}` and a 5-minute tolerance. One verifier implementation covers
   three sponsors. Stripe (`Stripe-Signature`, `t=`/`v1=`), Terac (base64 HMAC over
   `timestamp + rawBody`, **no separator**) and Sandbox0 (`X-Sandbox0-Signature`) each need
   their own verifier.

2. **Idempotency support is inconsistent.** Stripe and Whop have real `Idempotency-Key`
   headers. Solari has it on create routes. Dodo, Terac and Replay do not. The platform
   therefore owns a durable idempotency ledger keyed on our own operation id, and only
   *additionally* forwards a provider key where one is supported.

3. **Two sponsors cannot be driven headlessly today.** Lovable's MCP is OAuth-only and
   restricted to an allowlist of chat clients; Linq production phone numbers are provisioned
   by a human representative. Both are modelled as blocked capabilities with exact
   activation steps rather than pretended-working integrations.

4. **BAND's governance surface is narrower than its marketing.** Approval workflows, spend
   authority and audit logging are implemented in our own policy service, which is correct
   regardless, because those controls gate real money.

5. **Three overlapping compute planes** (Superserve, Sandbox0, Solari) are differentiated by
   real capability, not duplicated: Superserve pause preserves live processes and memory
   (long-lived agent workspaces); Sandbox0 offers egress credential substitution
   (untrusted model-generated code that must never see a real key); Solari offers browsers
   and GUI computers (supplier research where no API exists).
