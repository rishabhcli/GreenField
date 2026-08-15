# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Autonomous Company Factory** — a production operating layer that runs a company end to end (research → sourcing → brand → commerce → marketing → support) through a CEO/manager/specialist agent organization. Node 22+, TypeScript strict, pnpm workspaces, deployed entirely on Render.

## The rule that explains most of the code

Nothing in this system may assert that an integration works. It may only ask the capability registry, and the registry returns `live_verified` only when **both** (a) every required secret is present and well-formed, and (b) a dated row in `integration_verifications` records a successful non-destructive live probe. `apps/verifier` is the only writer of that row.

This is not a convention, it is load-bearing structure (`packages/core/src/capability.ts`). Downstream consequences you will hit constantly:

- **Missing credentials are a correct state, not a bug to work around.** A provider with no key reports `blocked_missing_credentials` with remediation text. The rest of the system stays testable.
- **Never fabricate a fallback.** No invented search results, supplier quotes, orders, analytics, or "integration complete" flags. If a requirement is not actually satisfied, status stays NOT COMPLETE.
- **Probes are not passes.** `adapter.probe()` results and catalog/list calls must never be reported as a verified prize method.
- **Blocked ≠ failed.** In worker handlers, a missing capability returns a blocked result; it does not throw. Throwing means "retry me", and retrying a job that waits on an unissued API key burns the retry budget. See `tolerateMissingCapability` in `apps/worker/src/handlers.ts`.

`PLAN.md` is the authoritative specification; `GOAL_MODE_PROMPT.md` is a 3,999-char compact restatement of it. `PROGRESS.md` / `BLOCKERS.md` / `VERIFICATION_EVIDENCE.md` carry current status and must be updated as part of each change (DONE = built *and* verified by an executed test).

## Commands

```bash
pnpm build           # tsc -b tsconfig.build.json (composite project references)
pnpm typecheck       # identical to build plus --pretty — it DOES emit, not a noEmit check
pnpm clean           # tsc -b --clean && rm -rf packages/*/dist apps/*/dist
pnpm test            # vitest run — currently 549 passed / 13 skipped
pnpm test path/to/file.test.ts
pnpm test:watch
pnpm migrate         # node packages/db/dist/cli/migrate.js — requires a build first
```

**One root script is broken; don't trust it:**

| Script | Problem | Use instead |
| --- | --- | --- |
| `pnpm verify` | points at `apps/verifier/dist/cli.js`, which does not exist (and there is no `src/cli.ts`) | `pnpm --filter @foundry/verifier start` |

`pnpm lint` is **not** broken anymore. It is a CommonJS flat config (`eslint.config.js`) that passes — exit 0 with exactly two warnings, both dead imports in files deliberately left untouched. `pnpm preflight` (`build && test && lint`) is green.

### Tests

Tests live in `packages/*/test/**/*.test.ts` and `apps/*/test/**/*.test.ts`. Vitest aliases `@foundry/*` to each package's **`src/index.ts`**, so tests run against source — a stale `dist` cannot make a broken change look green.

Live integration tests are opt-in and skip loudly rather than silently passing:

```bash
LIVE_PROBES=1 pnpm test        # provider live harnesses (*-live.test.ts, band-handoff, pioneer-inference)
LIVE_DISCOVER=1 pnpm test      # packages/services/test/research-collect-live.test.ts
TEST_POSTGRES_ADMIN_URL=...    # packages/db/test/repositories.test.ts (defaults to localhost)
```

Each `*-live.test.ts` hand-rolls a dotenv reader that walks up to the repo `.env`, so no separate dotenv step is needed. `band-handoff` and `pioneer-inference` additionally require their provider key to be set.

## Architecture

### Dependency direction (strictly one-way)

```
core → {db, obs, providers, queue} → agents → services → runtime → apps/{api,worker,workflows,verifier}
```

`services` never imports `runtime`. **`packages/runtime` is not a workflow engine — it is the composition root** (~420 lines, three files). Every app boots the same three lines:

```ts
const ctx = await buildContext({ serviceName, expectedMigrations: EXPECTED_MIGRATIONS, installSchedules });
const services = wireRuntime(ctx);
const boot = await bootstrapOperatingCompany(ctx);
```

The context owns connections, config and `shutdown()`; the service container owns business logic. A service must never be able to close a pool or read an env var — `process.env` access is confined to `packages/core/src/config.ts` and `secrets.ts`.

### `packages/core` — pure, zero I/O

Flat barrel (`import { X } from '@foundry/core'`; no subpath exports). Two blocks: cross-cutting primitives (`errors`, `money`, `ids`, `clock`, `retry`, `secrets`, `capability`, `config`) and `domain/*` (research, sourcing, brand, commerce, marketing, support, governance, org, company, qa, finance).

Domain files are Zod schemas plus **pure decision functions** — `evaluatePolicy`, `computeComposite`, `computeLandedCost`, `canTransition`, `decideArm`, `evaluateReleaseGate`, `assertBalanced`. These are the actual business logic and are exhaustively unit-tested.

- **Errors, not Results.** A 13-member `ErrorCategory` union drives retry and HTTP status mechanically. Only `rate_limited`, `provider_unavailable`, `timeout` are retryable; unclassified errors are non-retryable by design. Never string-match provider messages, and never re-wrap a `FoundryError` — that destroys the category. The `{ok} | {!ok}` result idiom exists only in `packages/agents`, because a policy denial is information the model must read, not an exception.
- **Money** is a frozen `bigint` minor-units class; it refuses to truncate precision or mix currencies, and `allocate()` guarantees parts sum exactly to the whole. Two-tier convention: `Money` for computation, plain integers named `*Minor` / `*MinorUsd` at every schema and DB boundary.
- **IDs** are prefixed ULIDs via `newId('order')` → `ord_01J9…`, monotonic within a millisecond so rows sort by insertion order. The `Id<K>` brand is optional and unused as an annotation — the convention is enforced at runtime by `newId`/`assertId`, not by the type system.
- **Secrets** are `Secret` objects whose `toString`/`toJSON`/`inspect` are all neutered. `assertModeMatchesEnvironment` refuses to boot a `sk_test_` key in production, or a live key outside it.
- **Provenance is the cross-domain invariant.** `research.Provenance` has no `generated`/`model_asserted` variant; `sourcing.CostBasis` separates quoted from assumed; `DimensionScore.grounded` yields `groundedWeightRatio`. An opportunity cannot be selected without a real supplier quote and a contribution margin.

### The agent organization

There is **no `Agent` class**. An agent is (1) a `RoleDefinition` row in `ORG_CHART` (`packages/core/src/domain/org.ts`) — data, not code, (2) a durable `agent_runs` row, and (3) one generic `AgentExecutor` that runs any role. 78 roles: 1 CEO + 10 managers + 67 specialists, built by two factory functions.

`tier` is one field with four consequences: model (`MODEL_BY_TIER`), reasoning effort (`effortForTier`), governance actor kind, and dispatch rights. **Chain of command is enforced in code, not in the prompt** — `OrgDispatcher.dispatch` throws `PolicyDeniedError` if a specialist tries to delegate or if the target is not a direct report, because the org chart *is* the authority model.

Every tool carries a required `authority`; there is no unguarded tool. `ToolRegistry.register` rejects any `jsonSchema` that isn't `type: 'object'` with `additionalProperties: false`, and `buildCompanyTools` throws at boot if the org chart references a tool the catalog doesn't define.

**`PolicyGate` is the single choke point** for anything that spends money, contacts a third party, publishes publicly, or touches a customer. It evaluates policy → reserves budget atomically → writes the audit event → opens an approval request, in that order. The budget reservation is authoritative: if it loses a race, the allow is re-denied. Denials return as values and are handed back to the model as tool results.

`HUMAN_ONLY_AUTHORITIES` (`legal.sign_agreement`, `finance.move_funds`, `governance.override`) may never be held by software, regardless of configuration. Several thresholds are `0`, meaning "always requires a human": supplier contact and production purchase, production deploy, policy publication, marketing sends.

BAND is a hard dependency of dispatch by design — the room post happens *before* the enqueue, and the executor refuses to start a run with no BAND assignment. Removing it breaks dispatch on purpose.

### Execution model

Four entry points converge on one queue → worker → service → provider spine.

1. **Webhooks** (`POST /webhooks/:provider`) — the money path: verify signature → `recordIfNew` dedupe → enqueue → 200. Never processed inline. Raw bytes are preserved by a buffer content-type parser because every scheme signs exact bytes. Status codes are deliberate: **503** when the signing secret is missing (provider retries, nothing lost), **400** on signature failure (not 401 — the provider must not retry a body that will never verify), 200 `{duplicate:true}` on redelivery.
2. **The operating loop** — `loop.tick` every 10 min → `LoopOrchestrator`, the real state machine. 15 ordered phases (`observe → discover → … → decide → replan`) with state in the `loop_cycles` table. `tick()` is one small step: assess → block, advance, or drive. **There is no in-memory state to restore** — each `#assess` re-derives completion by querying for the artefact the phase promised, so a restarted worker just ticks again. Judgement phases dispatch an agent; mechanical phases enqueue directly.
3. **Agent dispatch** — `agent.run` → `AgentExecutor` → Anthropic tool loop → `PolicyGate` → tool → service → provider.
4. **Render crons / Workflows** — see Deployment.

**Two independent idempotency layers.** Queue-level: `enqueue` derives a BullMQ `jobId` from `payload.idempotencyKey`. DB-level: `repos.idempotency.claim(key, scope)` returns `claimed | in_progress | completed`, and a `completed` claim **replays the stored result rather than calling the provider again**. Keys are string-templated, never random (`refund:${orderId}:${amount}`, `${cycleId}:${phase}:${suffix}`). This ledger exists because Dodo, Terac, Replay, Render and BAND have no idempotency header of their own.

### Providers

Every adapter extends `ProviderAdapter` and implements exactly two things: a `ProviderManifest` and a non-destructive `probe()`. 24 manifests (14 sponsor, 10 external); the factory map lives outside the package in `packages/runtime/src/context.ts`, so a provider with a manifest but no factory shows up at `/readiness/providers` as unimplemented rather than failing inside a job.

**Adapters never call `fetch` directly.** `ProviderHttpClient` centralises retry, circuit breaker, client-side token-bucket rate limiting, error classification (401/403 → auth, 429 → rate-limited with `retry-after`, ≥500 → unavailable), and Zod validation of every response — a mismatch is a `ProviderContractError`, never coerced. Retryability is derived, so an unkeyed POST is never retried. SDK-based adapters (Anthropic, Stripe) set the SDK's own retries to 0 and translate into the same taxonomy.

Inference cost is computed in `estimateCostMinorUsd` (cents, rounded up, with explicit 1.25× cache-write and 0.1× cache-read multipliers), written per loop step so a killed run still reports what it consumed, and rolled up per role. An unpriced model logs a warning and returns 0 — silence is wrong, but inventing a price is worse. The invariant that every model in `MODEL_BY_TIER` has pricing is enforced **only by `packages/providers/test/anthropic-cost.test.ts`**, not at boot.

### Database

No ORM, no query builder. Four helpers (`q`, `qOne`, `qMaybe`, `exec`) each take a Zod row schema — validating on read is deliberate, because a renamed column otherwise surfaces as `undefined` propagating into a margin calculation. BIGINT is parsed to number with a safe-integer check; NUMERIC stays a string.

A `Repositories` class is constructed once from the pool and handed to services, so no service can issue ad hoc SQL that bypasses an invariant. Repositories take `Queryable = Pool | PoolClient`, so any repository composes inside a transaction.

Four transaction wrappers with distinct uses: plain, serializable (bounded retry on 40001 — for predicate conflicts like the audit chain's `MAX(chain_position)`), **row-lock under READ COMMITTED** (order transitions; SERIALIZABLE here produced a retry storm for ordinary lock contention), and advisory-lock.

Schema conventions, stated at the top of `0001_foundation.sql`:
- Enums are `TEXT + CHECK`, never Postgres `ENUM` types.
- Money is `BIGINT` minor units plus an explicit `TEXT` currency column. **There is no FLOAT, REAL or MONEY column anywhere.**
- Timestamps are `TIMESTAMPTZ`; every service runs UTC. IDs are `TEXT` holding prefixed ULIDs.

Migrations are `NNNN_name.sql`, **forward-only, append-only, sha256-checksummed**. Editing an applied migration aborts the run (`--accept-drift` only if the DB already matches). The whole run holds an advisory lock so two instances can't race. Because `tsc` ignores `.sql`, `packages/db` builds with `tsc -b && node ./scripts/copy-sql.mjs`.

`audit_events` is append-only (a trigger refuses UPDATE/DELETE) and hash-chained, verifiable via `GET /api/audit/verify`.

### API

Fastify with `logger: false` (pino is configured centrally in `@foundry/obs`). An `onRequest` hook derives a `traceId` and wraps the request in `withContext`, an `AsyncLocalStorage` that pino's `mixin` injects into every log line. `/health` and `/ready` are excluded from request logging.

`src/errors.ts` exists because Fastify reads `error.statusCode` while Foundry errors expose `httpStatus` — without it a `ValidationError` serves as 500. It walks the `cause` chain and duck-types `isFoundryError` in case `instanceof` fails across duplicate `@foundry/core` copies. Note that `routes/company.ts` also has its own `sendFoundryError` helper for explicit-return paths, so two conventions coexist.

Auth covers **only** governance routes: a bearer `OPERATOR_API_TOKEN` compared in constant time, failing closed — with no token configured, every mutating governance route refuses. Commerce and company routes are unauthenticated by design and compensate by never trusting client input (prices come from the database). Webhooks authenticate by signature. Rate limiting is global at 300/min per IP with `/webhooks/*` exempted, because a provider retry storm is legitimate traffic and dropping it loses money state.

## Adding things

**A queue** needs four coordinated edits: `QUEUE_NAMES`, `JOB_SCHEMAS`, and `QUEUE_POLICIES` in `packages/queue/src/contracts.ts` (the latter two are `satisfies`-enforced, so a missing entry fails to compile), plus a handler in `apps/worker/src/handlers.ts` — and a decision about which `WORKER_ROLE` consumes it. Every payload extends `JobEnvelope` (`companyId`, `traceId`, `originRunId`, `idempotencyKey`) and is validated on both enqueue and dequeue. **Never put `:` in a job id** — BullMQ 5 rejects it; use `jobKey()`/`bullmqId()`.

**A migration** means bumping `EXPECTED_MIGRATIONS` (currently `6`) in **all six entrypoints together**: `apps/api/src/index.ts`, `apps/worker/src/index.ts`, `apps/worker/src/cron/{loop-tick,reconcile}.ts`, `apps/workflows/src/index.ts`, `apps/verifier/src/index.ts`.

**A provider** means a manifest entry, a barrel line, and a factory in the runtime registry wiring.

**A tool** must be registered in `packages/services/src/tools/catalog.ts` or boot throws.

## Deployment

`render.yaml` **is** the deployment — there is no local mode, and a localhost/laptop architecture is never completion. `assertProductionTopology` refuses to boot production pointed at localhost.

Seven services, all built with `corepack enable && pnpm install --frozen-lockfile && pnpm run build`: `foundry-api` (web, ×2 for rolling deploys, `healthCheckPath: /ready`), `foundry-worker` and `foundry-agents` (the **same binary**, split by `WORKER_ROLE` into complementary queue sets so a stuck agent run can't starve order processing), two crons (`verify` every 6h, `reconcile` daily), and `foundry-site` as static assets. The operating loop is **not** a cron: it is driven by the repeatable `loop.tick` job (`OPERATING_LOOP_CRON`, `*/10`), declared in `packages/queue/src/contracts.ts` and installed only by the `agents` worker — the `foundry-loop-tick` Render cron was removed because it double-fired alongside the repeatable job (see the comment in `render.yaml`). `apps/worker/src/cron/loop-tick.ts` still exists but is no longer wired to any schedule.

- Migrations run as `preDeployCommand`, never in `startCommand` — that would race N instances.
- **No `disk:` anywhere, deliberately** — a disk pins a service to one instance and disables zero-downtime deploys.
- Key Value is `maxmemoryPolicy: noeviction`; eviction means dropping paid orders awaiting fulfilment. `assertEvictionPolicy` enforces this at boot in production (an unreadable policy is tolerated elsewhere — the free tier answers `CONFIG GET` with NOPERM).
- Only the `agents` worker installs BullMQ schedules; otherwise every instance re-registers and cron fires N times.
- **Render Workflows cannot be declared in a Blueprint** — there is no `type: workflow`. `apps/workflows` is created via the API/Dashboard and needs `RENDER_WORKFLOW_SLUG`. Its tasks are thin adapters onto services, and each builds and tears down a full `AppContext`.
- Services start without any provider secrets; each simply reports `blocked_missing_credentials` until its key is present **and** a probe succeeds.

`apps/site` is a static landing page (not the generated storefront). It has no `package.json` and no `tsconfig.json`, so it is neither a pnpm workspace package nor part of `tsc -b` — but `apps/site/test/landing.test.ts` still runs under `pnpm test`, and it pins honesty claims in the copy (`'NOT COMPLETE'`, `'probe verified'`, `'Illustrative operating view'`). Overstating readiness in the landing page breaks the test suite.

## Compliance boundaries enforced in code

- `assertPaymentRoute` throws if a physical good is routed through Dodo — Dodo is Merchant of Record for digital products only, and physical goods are on its prohibited list. Misrouting would misstate who bears tax liability.
- `CREATED → PAID` is a legal transition (skipping `CHECKOUT_STARTED`) because money arriving is authoritative and a webhook can win the race against our own checkout-start write.
- Payment webhooks, not the browser redirect, are authoritative for money state.
- QA has veto power over release; production deploy returns blocked without a gating QA run.
- Never invent shipment status, refunds, or policies. Escalate legal threats, safety incidents, chargebacks, and regulator/media inquiries.

## Notes

- `.env` and `hackathon-sponsor-credentials.md` are gitignored and must never be committed. When adding a secret, its **name** must also be added to the Render env group.
- **`tsc -b` incremental state can lie.** A stale `.tsbuildinfo` has produced a confident false failure (a package typechecking against an outdated `.d.ts`) and can equally produce a false pass. After changing a cross-package type, verify with `pnpm clean && pnpm build` rather than a bare `pnpm build`. `pnpm test` is type-blind (vitest → esbuild strips types) and cannot catch this.
- The `Clock` interface is consumed by `retry.ts` and `packages/providers`, but is **not** threaded through `packages/agents` — `PolicyGate.evaluate` calls `new Date()` directly.
- `QueueEvents` is imported and closed in `packages/queue/src/queues.ts` but never instantiated (dead code).
- No enforced commit convention; git history uses freeform subjects.
