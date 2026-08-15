# Shared splices (Stripe physical-goods)

Stripe-owned files are listed in the agent brief. These notes are for the
shared surfaces that Stripe cannot own wholesale.

## Already spliced (Stripe event arms)

- `packages/services/src/commerce/webhook-processor.ts`
  - Stripe `#map` still calls `mapStripeEventToOrderTransition`.
  - `evaluatePaidCapture` reject → `MANUAL_REVIEW` (amount mismatch / zero capture).
  - Lost `charge.dispute.closed` uses `lostDisputeRefundDelta` (remaining captured).
  - `refund.created` writes the refund ledger with Stripe `re_*` as `externalId`.
- `apps/api/src/routes/webhooks.ts` already implements raw bytes, Stripe-Signature
  v1, **400** bad sig, **503** missing `STRIPE_WEBHOOK_SECRET`, **200**
  `{duplicate:true}`. Tests: `apps/api/test/stripe-webhook.test.ts`.

## Do not splice

- `packages/services/src/tools/catalog.ts` — do not mint a second Payment Link.
  Agent collection must reuse `plink_1U4lK242nB81EBguRPuIHrxS` at the $99
  catalogue Price. Stripe `createPaymentLink` retrieves that id; it does not
  call `paymentLinks.create`.
- `render.yaml` — no Stripe change.
- `packages/providers/src/dodo/**`, `whop/**`, `linq/**`.

## Leftover for other owners

- Hackathon catalogue rows in `default-config.ts` are `kind: service`. Physical
  SKUs still go through `assertCheckoutPaymentRoute` on `/api/checkout`.
- A live paid Checkout Session → ledger → refund/dispute against hosted Stripe
  has not been re-probed. Payment Link + webhook ingest remain the live facts.

---

# Replay QA shared splices

Replay-owned files: `packages/providers/src/replay/**`, `packages/providers/test/*replay*`,
`packages/services/src/qa/orchestration.ts`, `packages/core/src/domain/qa.ts`,
`packages/core/test/qa.test.ts`, `packages/services/test/*qa*`.

Do not edit `site/deploy.ts`, `lovable/**`, or `loop/orchestrator.ts` wholesale.
Do not edit `render.yaml`. Apply only the hunks below.

## 1. `packages/services/src/loop/orchestrator.ts` — `#assessQa`

Current code completes the `qa` phase on any finished latest run (including
`failed` / `provider_unavailable` / a `payment_state` row). That lets the loop
leave QA without a clean Replay exploration.

Replace the completion check with `isReplayQaPhaseComplete` from `@foundry/core`.
Map persisted rows into gate input. Complete only when the production gate
would pass. `running`, `recording-lost`, `infra-failed`, and high-severity
commerce-flow defects must keep the phase incomplete.

```ts
import { isReplayQaPhaseComplete } from '@foundry/core';

const runs = await this.deps.repos.build.qa.runsForSite(company.active_site_id, 50);
const defects = await this.deps.repos.build.qa.openDefects(companyId, company.active_site_id);
if (!isReplayQaPhaseComplete({
  runs: runs.map((r) => ({
    kind: r.kind,
    status: r.status,
    flowsCovered: r.flows_covered,
    unavailableReason: r.unavailable_reason,
  })),
  openDefects: defects.map((d) => ({
    severity: d.severity,
    affectedFlow: d.affected_flow,
    status: d.status,
  })),
})) {
  return { complete: false, detail: 'Replay QA has no clean completed exploration' };
}
```

`drive('qa')` already enqueues `qa.run` with `blockingForRelease: true`. Keep that.

## 2. `packages/services/src/loop/orchestrator.ts` — `drive('launch')`

`gating.status !== 'passed'` is wrong: `qa_runs.status` is never `passed`
(`completed` / `failed` / `running` / `provider_unavailable`). Require a
completed `autonomous_exploration` plus `isReplayQaPhaseComplete`. Do not
promote on a recording-lost or still-running row.

## 3. `packages/db/src/repositories/build.ts`

- `evaluateGate` preview `requiredRunKinds` is `browser_e2e`. Orchestration
  uses `autonomous_exploration`. Align preview to `['autonomous_exploration']`.
- `finishRun` does not persist `unavailable_reason`. Persist
  `recording-lost` / `infra-failed` so a restarted worker still blocks the gate
  (orchestration overlays the reason in-process today).

## 4. `packages/services/src/org/prize-tracks.ts`

Import the honest blocker from core. Do not keep the stale "finished with
status running" string after a recording-lost run exists.

```ts
import { REPLAY_QA_BLOCKER } from '@foundry/core';
```

`REPLAY_QA_BLOCKER` stays set until a clean completed exploration exists.
0 product bugs after infra-failed is not `live_verified`.

## 5. `packages/services/src/site/deploy.ts`

Already refuses `gating.status !== 'completed'` and re-evaluates
`evaluateReleaseGate`. No change required unless `#assessQa` starts completing
on failed rows — then keep the completed-run check.

## Do not splice

- A second `POST /explorations` after `POST /projects`.
- Treating 0 bugs + `recording-lost` as a pass.
- Localhost / loopback as a production-gate Replay target.
- Invented suggested fixes for Replay bugs. Artefacts are recorded defects
  assigned to `site_builder`.

---

# Lovable catalog / runtime (no splice required)

Lovable-owned files: `packages/providers/src/lovable/**`, `packages/providers/test/*lovable*`,
`packages/services/src/site/build.ts`, `packages/services/test/site-create-spec.test.ts`,
`packages/services/test/site-generate.test.ts`. Do not edit `site/deploy.ts`,
`replay/**`, `qa/**`, `catalog.ts`, `runtime`, or `render.yaml` for this track.

## Already wired — do not regress

**`packages/runtime/src/context.ts`**
```ts
lovable: (ctx: AdapterContext) => new LovableAdapter(ctx),
```

**`packages/services/src/tools/catalog.ts`**
- `site.create_spec` → `s.site.createSpec` (writes `companies.active_site_id`)
- `site.generate` / `site.iterate` → `s.site.generate`
- `site.export_code` → `s.site.exportCode`

`site.generate` now retrieves files (`list_files` + `read_file`) before marking
`generated`, persists `generator_project_id` + `exported_files`, and calls
`deploy_project` only as a preview. Idempotency key is `site.generate:{siteId}`;
a completed claim replays and does not re-create.

## Do not splice

- An invented `LOVABLE_API_KEY` / `Lovable-API-Key` path. Official docs: OAuth only.
- Promo-code redemption. Promo-code paths stay dead.
- `live_verified` for Lovable without `LOVABLE_OAUTH_ACCESS_TOKEN` **and** a real
  MCP `tools/call` (not `tools/list`, not `probe()` alone).
- Storing a `*.lovable.app` deploy URL as `production_url` or as the Render host.
  `SITE_HOSTING_NOTE` must stay. Production hosting is Render.
- Treating `spec_drafted` as build-complete. `#assess('build')` must keep
  requiring generated artefacts (`generator_project_id` + retrieved files).
  Helper: `siteBuildComplete` in `packages/services/src/site/build.ts`.

---

# Whop shared splices

Whop-owned files: `packages/providers/src/whop/**`, `packages/providers/test/*whop*`,
`packages/services/src/commerce/whop.ts`, `packages/services/test/whop-checkout.test.ts`.

Whop is the agentic digital/membership commerce primitive. It does **not** take
Stripe physical volume and it is **not** Merchant of Record for physical goods
(Dodo holds that claim for eligible digital SKUs only). `GET /accounts/me` is
an identity probe, not a checkout pass — do not mark `live_verified` from it.

`POST /webhooks/whop` and `commerce.webhook` already exist. Keep the money-webhook
policy: **503** when `WHOP_WEBHOOK_SECRET` is missing, **400** on signature
failure, **200** `{duplicate:true}` on redelivery. Do not process Whop inline.

## Do not splice

- Physical SKUs onto `whop_checkout` (adapter + `assertPaymentRoute` throw before HTTP).
- Whop into `payments.checkout.physical` (Stripe) or as a replacement for Dodo MoR.
- `collect.ts` / `refunds.ts` / `catalog.ts` changes that steal those rails.
- Treating `probe()` / `GET /accounts/me` as a prize-method pass.

---

### 1. `packages/services/src/index.ts`

```ts
export * from './commerce/whop.js';
```

---

### 2. `packages/services/src/tools/host.ts` + `packages/runtime/src/services.ts`

```ts
import type { WhopCommerceService } from '../commerce/whop.js';
// CompanyToolHost:
readonly whop: WhopCommerceService;
```

```ts
import { WhopCommerceService } from '@foundry/services';
// buildServices:
whop: new WhopCommerceService(deps),
```

Do not resolve Whop through `forCapability('payments.checkout.digital_mor')` —
that capability is Dodo's MoR rail (priority 1). The service uses
`providers.adapter('whop')` and blocks on `commerce.membership`.

---

### 3. `apps/api/src/routes/commerce.ts` — `POST /checkout/whop`

Do **not** fold this into `/api/checkout` (that path is Stripe physical). New
route, same honesty rules: prices from the catalogue, order created before the
session, webhook is authoritative.

```ts
app.post('/checkout/whop', async (request, reply) => {
  const body = CreateCheckout.parse(request.body);
  // allowlist success/cancel URLs the same way as /api/checkout
  const product = await ctx.repos.commerce.products.bySku(companyId, body.items[0]!.sku);
  if (product.kind === 'physical_good' || product.payment_route !== 'whop_checkout') {
    throw new ValidationError(
      'Whop cannot sell physical goods. Use Stripe as merchant of record for physical products.',
    );
  }
  // create customer + order with paymentRoute: 'whop_checkout' (existing repos)
  const started = await services.whop.startCheckout({
    companyId,
    orderId: order.order.id,
    productKind: product.kind,
    planId: product.external_refs['whop_plan'],
    productId: product.external_refs['whop_product'],
    idempotencyKey: idempotencyKey('whop-checkout', order.order.id),
  });
  if (!started.ok) {
    return reply.code(503).send({
      error: started.blockedOn?.reason ?? 'Whop checkout is blocked',
      blockedOn: started.blockedOn,
    });
  }
  await ctx.repos.commerce.orders.applyEvent({
    orderId: order.order.id,
    kind: 'checkout_started',
    toStatus: 'CHECKOUT_STARTED',
    actor: 'api:checkout/whop',
    payload: { checkoutId: started.data!.checkoutId },
  });
  return reply.send({
    orderId: order.order.id,
    orderNumber: order.order.order_number,
    checkoutUrl: started.data!.checkoutUrl,
  });
});
```

Catalogue a membership/digital SKU first via `services.whop.catalogueProduct`
(internal/operator path). That writes `payment_route = whop_checkout` and
`external_refs.whop_product` / `whop_plan`.

Today `/api/checkout` throws for any non-`stripe_direct` route. Leave that
throw in place for Dodo; only `/checkout/whop` should call Whop.

---

### 4. Env (single-key PUT, never bulk replace)

| Name | Required | Why |
|---|---|---|
| `WHOP_API_KEY` | yes | Bearer for `https://api.whop.com/api/v1` (sandbox: `https://sandbox-api.whop.com/api/v1`) |
| `WHOP_COMPANY_ID` | yes | `biz_…` account id. Pinned `Api-Version-Date: 2026-07-23` bodies use `account_id`. |
| `WHOP_WEBHOOK_SECRET` | for ingest | Standard Webhooks. Missing → 503, never unverified money state. |

Unpinned requests silently fall back to `2025-01-01` (`company_id`). The adapter
refuses that: every request sends `Api-Version-Date: 2026-07-23`.

---

# Compute / runtime sponsors (Superserve, sandbox0, Solari)

PLAN.md §12 is one execution layer with three distinct jobs. Do not collapse
these into one adapter. This owner must not edit `catalog.ts` or `org.ts`.

`GET /sandboxes` and `GET /health` are probes, not prize-method completion.
Preserve: Superserve pause (VM state preserved), sandbox0 exec, Solari exec.
sandbox0 pause does **not** equal Superserve pause.

## Already true in adapters (do not regress)

- Identities per business function: `ss-ws-*`, `s0-exec-*`, `slr-browse-*`.
  Names containing `foundry-api` / `foundry-worker` throw.
- Untrusted/model-generated code → sandbox0 only.
- Persistent multi-hour → Superserve only.
- Browser/GUI → Solari only.
- Solari navigate does not invent result URLs (`selectResultUrls`).
- Robots/ToS refusal is `PolicyDeniedError` (`assertRobotsNotOverridden`).
- Missing replay URL → `ProviderContractError`, not a fabricated URL.

## `packages/services/src/tools/catalog.ts`

Keep org-chart names `research.browse` and `sandbox.create` / `sandbox.exec` /
`sandbox.set_egress_policy` / `sandbox.destroy` (boot fails if they disappear).
Add `research.browser` and `compute.sandbox_{create,exec,pause}` routed by
**workload**, not by "first usable sandbox id".

- `research.browser` — Solari `createBrowserSession`. Same honesty as
  `research.browse`: no invented HTML. Optional `recording`; `getReplayUrl`
  after the session ends; missing URL is blocked.
- `compute.sandbox_create` — `untrusted_model_code` →
  `Sandbox0Adapter.claimOrCreateSandbox` with `businessFunction` + `companyId`.
  `persistent_multi_hour` → `SuperserveAdapter.ensureSandboxForAgentRun` with
  the same identity fields. Never the API process.
- `compute.sandbox_exec` — require `plane: 'sandbox0' | 'superserve'` matching
  the id attached at create. Do not exec a sandbox0 command on a Superserve VM.
- `compute.sandbox_pause` — return `pausePreservesVmState: true` (Superserve)
  or `pausePreservesProcesses: false` (sandbox0). HTTP 200 is not proof the
  sandbox0 VM is paused.

Also fix today's `sandbox.exec`: it prefers Superserve then sandbox0 on the
same `run.sandbox_id` and can cross planes. Route by the provider recorded at
create.

If `allReferencedTools()` gains `research.browser` / `compute.sandbox_*`,
those names must be registered or boot throws.

## Do not splice

- `loop/orchestrator.ts` wholesale. Discover already blocks on
  `research.browser_session` when Brave is unusable. Source still completes on
  grounded quotes — Solari does not invent those.
- brave-search, anthropic, Replay, Lovable, Stripe.
- Treating `GET /sandboxes` or `GET /health` as `live_verified`.
- Using Solari `stealth`/`captcha` to skip robots/ToS.
- Running model-generated code in the API/worker process or on Superserve.

---

# PATCH — runtime BAND wiring

Do not treat this file as a completed company-loop change. It is the BAND-owned
instruction for `packages/runtime`, which this branch must not edit.

## Required: pass `{ band }` only when configured

`packages/runtime/src/context.ts` currently does:

```ts
const dispatcher = new OrgDispatcher(repos, queues, band ? { band } : undefined);
```

That is wrong for the dispatch / `enqueueSystem` split. An unconfigured
`BandAdapter` is still a truthy object, so `enqueueSystem` (support inbound)
would attempt a room post, throw `CredentialsMissingError`, and retry-burn.

Change both call sites to the same predicate the executor already uses:

```ts
const band = providers.adapter('band') as BandAdapter | undefined;
const coordination = band?.isConfigured ? { band } : undefined;

const executor = new AgentExecutor({
  repos,
  llm,
  tools,
  gate,
  band: coordination?.band,
});
const dispatcher = new OrgDispatcher(repos, queues, coordination);
```

Effects after the patch:

- Agent-to-agent `OrgDispatcher.dispatch` still requires BAND. Unconfigured →
  `ValidationError`, no enqueue.
- `enqueueSystem` may proceed DB-only when BAND is unconfigured.
- When BAND *is* configured, both paths post the room assignment before enqueue.
- A specialist run with no `bandChatId` / `bandMessageId` still ends `failed`,
  not `running`.

Delete the comment that says "Always wire the adapter so a missing BAND key
fails dispatch." That comment describes the old, broken coupling.

## Required: reuse the live Zero Human Co room

`packages/runtime/src/bootstrap.ts` `ensureBandCoordinationRoom` currently
`createChat`s when `config.integrations.bandChatId` is empty. That can open a
decorative second room and call the mesh done.

After this branch, call:

```ts
import { ZERO_HUMAN_CO_COORDINATION_ROOM_ID } from '@foundry/providers';

const resolved = await band.resolveCoordinationRoom({
  configuredChatId: config.integrations?.bandChatId ?? ZERO_HUMAN_CO_COORDINATION_ROOM_ID,
  companyName: company.name,
});
```

`resolveCoordinationRoom` returns the live room
`a70129cc-0663-4090-86b5-c5a98025532e` from `listChats` when it is present, and
only `createChat`s if that room is genuinely absent. Persist `resolved.chatId`
as `integrations.bandChatId`. Do not create one room per function and call
that "channels."

## Do not claim

- `GET /agent/me` probe is identity confirmation, not "mesh complete."
- `coordination.governance` remains `marketing_claim_only`.
- Company loop is **not DONE**.

---

# Dodo routing splices

Dodo-owned code lives in `packages/providers/src/dodo/**`, `packages/providers/test/dodo*`, and `packages/services/src/commerce/dodo.ts`. Stripe-owned files were not edited. Apply these splices so digital MoR actually ships.

Physical goods stay on Stripe. Eligible digital add-on / membership / data product / subscription uses Dodo as Merchant of Record. `assertPaymentRoute('physical_good', 'dodo_merchant_of_record')` throws — do not fall through to Stripe as a silent "fix", and do not claim Dodo MoR for a bottle.

## 1. `packages/services/src/commerce/collect.ts`

In `#ensureCheckoutUrl`, after loading the order, branch on `order.payment_route` (or the line items' product `payment_route`):

```ts
import { DodoCommerceService } from './dodo.js';

if (order.payment_route === 'dodo_merchant_of_record') {
  const dodo = await new DodoCommerceService(this.deps).startDigitalCheckout({
    companyId: order.company_id,
    orderId: order.id,
    returnUrl: `${this.deps.publicBaseUrl}/?paid=1`,
    cancelUrl: `${this.deps.publicBaseUrl}/#pricing`,
    idempotencyKey: `${idempotencyKey}:dodo-checkout`,
  });
  if (!dodo.ok) return null; // caller already maps blockedOn
  return dodo.data?.checkoutUrl ?? null;
}
// existing Stripe physical path unchanged
```

Do not send a Dodo order through `StripeAdapter.createCheckoutSession`.

## 2. `apps/api/src/routes/commerce.ts` (`POST /api/checkout`)

Replace the `paymentRoute !== 'stripe_direct'` hard-throw with:

```ts
if (paymentRoute === 'dodo_merchant_of_record') {
  const started = await new DodoCommerceService(deps).startDigitalCheckout({
    companyId,
    orderId: order.order.id,
    returnUrl: body.successUrl,
    cancelUrl: body.cancelUrl,
    customerEmail: body.email,
    idempotencyKey: idempotencyKey('dodo', order.order.id, 'checkout'),
  });
  if (!started.ok) {
    throw new ValidationError(started.blockedOn?.reason ?? 'Dodo checkout blocked', {
      orderId: order.order.id,
      paymentRoute,
    });
  }
  return { orderId: order.order.id, checkoutUrl: started.data?.checkoutUrl };
}
if (paymentRoute !== 'stripe_direct') {
  throw new ValidationError(`Payment route "${paymentRoute}" has no active adapter…`);
}
```

Physical checkout stays on Stripe. Mixing Stripe + Dodo line items in one cart is already rejected (`routes.size > 1`).

## 3. `packages/services/src/commerce/refunds.ts`

When `order.payment_route === 'dodo_merchant_of_record'` (or `order.external_refs.dodo_payment_id` is set), do not read `stripe_payment_intent`. Delegate:

```ts
if (order.payment_route === 'dodo_merchant_of_record') {
  const dodo = await new DodoCommerceService(this.deps).issueRefund({
    companyId: order.company_id,
    orderId: order.id,
    amountMinor: request.amountMinor,
    reason: request.reason,
    actorId: request.actorId,
  });
  if (!dodo.ok) return { outcome: 'refused', reason: dodo.blockedOn?.reason ?? 'Dodo refund blocked' };
  return { outcome: 'refunded', refundId: dodo.data.refundId, amountMinor: dodo.data.amountMinor };
}
```

Keep the policy gate / kill-switch / ceiling checks in `RefundService.issue` *before* this branch. Dodo has no Idempotency-Key header — `issueRefund` keys the local ledger `refund:${orderId}:${amount}`.

## 4. `packages/services/src/commerce/webhook-processor.ts` `#onApplied`

The Dodo `#map` arm already aliases `refund` = `refund_id` (`re_*`). Persist money rows:

```ts
if (provider === 'dodo') {
  const dodo = new DodoCommerceService(this.deps);
  if (intent.orderStatus === 'PAID') await dodo.recordCapturedPayment(order, intent);
  if (intent.kind === 'refund_issued') await dodo.recordWebhookRefund(order, intent);
}
```

Ledger lookup must use `dodoRefundLedgerId(intent.externalIds)` (refund id), never `payment_id`.

## 5. `apps/worker/src/handlers.ts` `finance.reconcile`

`payments.byExternalId('stripe', payload.refundExternalId)` will not find a Dodo `re_*` refund. After recording the refunds row, look up by **refund** external id and provider `dodo` when `order.payment_route === 'dodo_merchant_of_record'`. Do not treat the payment id as the refund id.

`tolerateMissingCapability` currently catches `CredentialsMissingError` but not `ProviderAuthError`. Dodo HTTP 401 is classified as auth. `DodoCommerceService` converts 401 to `blockedOn` so a Dodo job does not burn retries. Optionally also catch `ProviderAuthError` in the wrapper.

## 6. `packages/runtime/src/services.ts`

Optional: `dodo: new DodoCommerceService(deps)` on the container. Call sites can also `new DodoCommerceService(deps)` until that lands.

## Status (Dodo only)

Live `GET /products` remains **HTTP 401** — credential blocker, not `live_verified`, not a Stripe test-mode launder. Physical goods stay refused. Local unit tests cover: `assertPaymentRoute` throw, digital signed-webhook state machine, 401 classified as failed probe, refund ledger by `re_*`.

---

# PATCH — Terac expert_validate splices

Owned Terac path is implemented in `packages/providers/src/terac/**` and
`packages/services/src/research/expert.ts`. These edits were out of scope
(catalog / queue / runtime / webhook processor / loop). Do not claim
`live_verified`: org credit is still **$0**.

## 1. `packages/services/src/tools/catalog.ts`

`expert.request_review` already exists (`authority: 'expert.engage_paid'`,
`capability: 'expert.structured_review'`). Add `expert.poll` next to it.
Poll can launch after feasibility `RESPONDED`, so it is consequential spend.

```ts
import { expertJobOutcome } from '../research/expert.js';

tool(
  {
    name: 'expert.poll',
    description:
      'Poll a Terac expert review until RESPONDED/submissions. Missing capability or $0 credit returns blocked, never a fabricated verdict.',
    authority: 'expert.engage_paid',
    capability: 'expert.structured_review',
    consequential: true,
    input: z.object({ expertReviewId: Id }),
    execute: async (input) => expertJobOutcome(await s.experts.poll(input.expertReviewId)),
  },
  s,
),
```

Optional: add `'expert.poll'` to the org-chart tool lists that already include
`'expert.request_review'` in `packages/core/src/domain/org.ts`. Catalog may
define a tool the chart does not use; the reverse throws at boot.

`packages/services/test/tools-catalog.test.ts` already expects
`expert.request_review`. Extend that list with `expert.poll` if you add the tool.

## 2. `packages/services/src/commerce/webhook-processor.ts`

`POST /webhooks/terac` already verifies HMAC, returns 400/503/200 duplicate, and
enqueues `commerce.webhook`. `#map` has no Terac case, so the job is currently
`unhandled`. Ingest is a refresh, not a money transition:

```ts
import { ExpertReviewService } from '../research/expert.js';

// inside process(), after the linq branch, before this.#map:
if (event.provider === 'terac') {
  const experts = new ExpertReviewService(this.deps);
  const ingested = await experts.ingestWebhook(event.payload);
  if (ingested.blockedOn && ingested.status === 'ignored') {
    await this.deps.repos.webhooks.markIgnored(webhookEventId, ingested.blockedOn.reason);
    return { outcome: 'ignored', reason: ingested.blockedOn.reason };
  }
  await this.deps.repos.webhooks.markProcessed(webhookEventId, event.company_id ?? undefined);
  return {
    outcome: 'ingested',
    reason: ingested.verdict
      ? `terac review ${ingested.reviewId} verdict ${ingested.verdict}`
      : `terac review ${ingested.reviewId} status ${ingested.status}`,
  };
}
```

`ingestWebhook` re-fetches submissions and records a row only when critique +
expert identity + timestamp exist. It does not invent a verdict.

## 3. `packages/services/src/loop/orchestrator.ts`

Replace `#assessExpertValidate` so the cycle re-derives from the review
artefact. Today's body completes with `performed: false` when the capability
is unusable, and ignores a `killed` opportunity whose review verdict is
`rejected`.

```ts
async #assessExpertValidate(companyId: string): Promise<PhaseAssessment> {
  const experts = new ExpertReviewService(this.deps);
  const assessment = await experts.assessForLoop(companyId);
  return {
    complete: assessment.complete,
    detail: assessment.detail,
    blockedOn: assessment.blockedOn
      ? { capability: assessment.blockedOn.capability, remediation: assessment.blockedOn.reason }
      : undefined,
    outputs: {
      expert_validate: {
        performed: assessment.performed,
        verdict: assessment.verdict,
        ...(assessment.blockedOn ? { reason: assessment.blockedOn.reason } : {}),
      },
    },
  };
}
```

`drive('expert_validate')` already calls `experts.request` and enqueues
`expert.poll`. No queue-contract change.

## 4. `apps/worker/src/handlers.ts`

`expert.poll` already wraps `tolerateMissingCapability` (thrown missing key →
`{ status: 'blocked' }`). The service now *returns* `blockedOn` instead of
throwing on missing key / $0 credit. Map that so BullMQ does not record a
successful job that is still waiting on credit:

```ts
import { expertJobOutcome } from '@foundry/services';

'expert.poll': async (payload) =>
  tolerateMissingCapability(async () => {
    const run = async (id: string) => expertJobOutcome(await services.experts.poll(id));
    if (payload.expertReviewId) return { polls: [await run(payload.expertReviewId)] };
    const polls = [];
    for (const companyId of await companyIds(payload.companyId)) {
      for (const review of await ctx.repos.research.expertReviews.listOpen(companyId)) {
        polls.push(await run(review.id));
      }
    }
    return { polls };
  }),
```

## 5. Do not splice

- `packages/queue/src/contracts.ts` — `expert.poll` already exists.
- `packages/runtime/src/services.ts` — `experts: new ExpertReviewService(deps)` already exists.
- `render.yaml` — no new service.
- Do not mark Terac `live_verified`. `TERAC_STUDY_BLOCKER` remains the live fact
  (`Available: $0.00`). `apps/verifier` has not written a launch row.
