# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Autonomous Company Factory** is a production operating layer for autonomous companies. It orchestrates research, sourcing, brand development, commerce, marketing, and support operations through an agent organization (CEO/manager/specialist roles). The system is built as a Node.js monorepo using TypeScript with pnpm workspaces.

## Architecture

The project uses a layered architecture with shared, domain, and application layers:

### Packages (Core Libraries)

- **@foundry/core**: Base types, domain models, and shared schemas using Zod. Defines domains: research, sourcing, brand, commerce, marketing, support, governance, org, company, QA, finance. Also provides utilities for money, IDs, clock, retry logic, secrets, capabilities, and config.

- **@foundry/providers**: Third-party integrations for payments (Stripe, Dodo, Whop), AI (Anthropic SDK), and other services. Implements adapters for various sponsor platforms (Band, Linkedin, Brave Search, Solari, Superserve, etc.). Includes cost attribution for model inference.

- **@foundry/agents**: Agent implementation and orchestration logic for the autonomous organization.

- **@foundry/services**: High-level service layer that composes functionality from lower packages. Coordinates agents, providers, and domain logic.

- **@foundry/runtime**: Runtime execution engine for workflows and operations.

- **@foundry/db**: Database layer (uses PostgreSQL via render.com).

- **@foundry/queue**: Job queue abstraction (uses Redis).

- **@foundry/obs**: Observability and logging infrastructure.

### Applications

- **apps/api**: REST API server (Fastify) with CORS, rate limiting, and authentication. Exposes core operations.

- **apps/worker**: Async worker process for background jobs and scheduled tasks.

- **apps/verifier**: Verification CLI tool for validating operations and integrations.

- **apps/workflows**: Workflow orchestration and execution.

## Common Commands

### Build & Compile

```bash
pnpm build              # Full TypeScript compilation for all packages
pnpm clean              # Clean and rebuild everything
pnpm typecheck          # Type checking without emitting (faster feedback)
```

### Testing

```bash
pnpm test               # Run all tests once (vitest run)
pnpm test:watch         # Watch mode for development
pnpm test path/to/test  # Run specific test file
```

**Test Location**: Tests live in `packages/*/test/**/*.test.ts` and `apps/*/test/**/*.test.ts`.
**Test Framework**: Vitest with 20s timeout, 30s hook timeout.
**Coverage**: Runs against source files, not dist, ensuring stale builds don't mask issues.

### Linting & Code Quality

```bash
pnpm lint               # Run ESLint on entire codebase
pnpm preflight          # Full CI check: build + test + lint
```

### Database & Queue

```bash
pnpm migrate            # Run database migrations (PostgreSQL)
```

### Verification

```bash
pnpm verify             # Run verification harness for live integrations
```

## Development Workflow

1. **TypeScript Configuration**: The repo uses strict TypeScript (`strict: true`) with additional checks (`noUncheckedIndexedAccess`, `noImplicitOverride`). Source maps and declaration maps are enabled for debugging.

2. **Monorepo Structure**: Uses pnpm workspaces with TypeScript project references for proper build ordering. Each package is independently buildable via `tsc -b`.

3. **Import Aliases**: Packages are aliased as `@foundry/*` in vitest config for convenient imports. Resolve these via the main exports defined in each package.json.

4. **Testing Philosophy**: Integration tests that require live services are opt-in via environment flags and must self-report their skip status loudly (not silently pass). Tests run against source, not build artifacts.

5. **Git Strategy**: The codebase is actively under development with recent feature additions and integrations. Check git log for patterns on commit organization and scope.

## Key Dependencies

- **Node.js**: >=22.0.0 required
- **pnpm**: ^11.21.0 (workspace manager)
- **TypeScript**: ^5.9.2 (strict mode)
- **Vitest**: ^3.2.4 (test framework)
- **Fastify**: ^5.6.1 (API server)
- **Zod**: ^4.1.12 (schema validation)
- **@anthropic-ai/sdk**: ^0.117.1 (Claude integration)
- **Stripe, Dodo Payments, Whop**: Payment processors
- **ioredis**: Redis client for queue
- **PostgreSQL**: Database (via Render)

## Environment Configuration

The `.env` file (git-ignored) contains API keys and service credentials for:
- Payment processors (Stripe, Dodo, Whop)
- AI/Search services (Band, Brave Search, Solari)
- Infrastructure (Render, Redis, PostgreSQL)
- Webhooks and callback configurations

Never commit `.env`. Local integration tests read these for live probes.

## Build Output

Compiled output goes to `dist/` in each package and app. Source maps are generated for debugging. The build is incremental and composite, allowing individual package rebuilds.

## Notable Patterns

- **Cost Tracking**: The system explicitly tracks inference costs via `MODEL_PRICING_CENTS_PER_MTOK`. Every model in `MODEL_BY_TIER` must have pricing defined.

- **Verification Harnesses**: Live integration tests are organized as separate harnesses (e.g., `*-live.test.ts`, `superserve-replay-live.test.ts`) that skip themselves if credentials are missing.

- **Domain-Driven Design**: Core logic is organized by business domain (research, sourcing, brand, etc.), not by technical layer. Services orchestrate across domains.

- **Type Safety**: The codebase prioritizes type safety. Use Zod for runtime validation at system boundaries (APIs, external services).
