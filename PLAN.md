# PLAN.md — Autonomous Company Factory

## 0. Purpose

Build a production-grade, end-to-end autonomous-company operating system in which a top-level CEO agent is accountable for the company’s strategy and operating state, manager agents own major functions, and specialist subagents execute concrete work. The system continuously discovers real consumer pain points, validates opportunities, sources a private-label physical product, builds a brand and storefront, launches and optimizes marketing, accepts real payments, coordinates fulfillment and support, measures business performance, and recursively improves the company.

The product is not a mock “AI CEO dashboard.” It is the operating layer for a real company. Every claimed capability must either work end to end against a real service/API or be explicitly marked unavailable until the required account, approval, credential, supplier, or legal prerequisite exists. No fake integrations, simulated orders, fabricated supplier quotes, hard-coded “success” states, or placeholder production claims are allowed.

The system must make strong and innovative use of the hackathon sponsors where their real capabilities fit. Sponsor usage must be functional, measurable, and visible in the product architecture rather than decorative logo placement.

---



## 1. Core Product Thesis

The system repeatedly runs a closed business loop:

1. Observe public market conversations and demand signals.
2. Extract recurring frustrations, unmet needs, breakage patterns, complaints, workarounds, willingness-to-pay signals, and competitor weaknesses.
3. Cluster these signals into candidate pain points.
4. Score each opportunity for severity, frequency, audience size, monetizability, competition, sourcing feasibility, shipping economics, legal risk, marketing tractability, and expected contribution margin.
5. Ask real human experts for judgment where machine-only research is weak.
6. Select a product opportunity.
7. Find suppliers able to produce or private-label an appropriate product.
8. Determine real unit economics, including MOQ, customization, packaging, freight, duties/tariffs where applicable, taxes/fees where applicable, payment fees, expected returns, fulfillment, and a landed-cost estimate.
9. Contact suppliers, request quotes/samples/terms, and compare offers.
10. Create the company/brand identity, product positioning, name, logo, packaging direction, creative system, and storefront.
11. Configure commerce, real checkout, webhooks, inventory/order state, shipping/fulfillment integrations, refunds, and support.
12. Generate ad concepts and website creative.
13. Send high-impact creative through human expert review.
14. Launch controlled marketing experiments.
15. Measure impressions, clicks, CTR, CPC, conversion rate, CAC, revenue, gross margin, refund rate, support burden, repeat purchase, and other business signals.
16. Kill weak variants, scale stronger variants within spend/risk limits, and generate new variants.
17. Run autonomous QA on the site and workflows.
18. Feed operational results back to the CEO agent.
19. Re-plan.
20. Repeat.

The company therefore behaves as a persistent, auditable organization rather than a one-shot chain of prompts.

---



## 2. Sponsor Capability Map



### Terac — Human expertise on demand

Use Terac as the human judgment and expert-labor layer. Terac describes itself as an expert marketplace and an “expert labor MCP” that can let AI systems source, hire, verify, and pay humans on demand.

Required product roles:

- Product-category experts who can sanity-check whether a discovered pain point is real.
- Consumer research experts who evaluate whether evidence is meaningful or just noisy internet chatter.
- Marketing experts who review ad creative for “human quality” versus generic AI slop.
- Brand/creative experts who compare logo, landing-page, packaging, and ad variants.
- Domain experts for regulated or safety-sensitive product categories.
- Optional human escalation for supplier negotiation or quality-control review.
- Structured expert feedback must be captured and fed back into the agent system, not discarded as a chat transcript.



### Stripe — Payment infrastructure

Use Stripe for eligible storefront payment flows where the operating business remains the seller/merchant.

Required roles:

- Checkout/payment collection.
- Products/prices or equivalent commerce objects where appropriate.
- Webhooks as the authoritative source of payment lifecycle state.
- Refund/payment-status handling.
- Fraud/risk capabilities when available and appropriate.
- Reconciliation into internal order and finance ledgers.
- Test-mode integration during development and production-mode readiness checks before claiming live commerce.



### Lovable — AI full-stack app development

Lovable is a full-stack AI development platform that can build, iterate, and deploy web applications using natural language, and currently exposes an MCP server that allows external AI agents to create projects, send messages, inspect code, and deploy apps.

Required roles:

- Programmatic creation/iteration of product storefronts and landing pages.
- Generate real editable code, not screenshots.
- Connect generated sites to the rest of the platform through APIs.
- Maintain a reusable site-generation contract so the company can create a new branded storefront for a new opportunity without custom hand work.
- Prefer Git synchronization/export where needed so generated code is independently testable and deployable.



### Whop — Agentic business/commerce operations

Use Whop where its current API/CLI capabilities provide a real business primitive.

Required roles may include:

- Checkout/payment primitives where appropriate.
- Catalog/product/pricing operations where supported.
- Business-level operations via API/CLI.
- Webhooks and order-linked metadata.
- Team/business operations when applicable.
- Payout/global business primitives where supported.

Do not falsely attribute physical product sourcing, manufacturing, or landed-cost quotation to Whop.

### Render — Production hosting and background execution

Use Render for durable hosted application services rather than treating Lovable publication as the only runtime.

Required roles:

- Public API/backend service.
- Private services for internal components where appropriate.
- Background workers for queues and asynchronous jobs.
- Managed datastore(s) where appropriate.
- Health checks.
- Production deployment pipeline.
- Zero-downtime deployment behavior where supported by the selected service type.
- Central logs and operational visibility.
- Hosting of the core control plane and business APIs.



### Linq — Customer communications

Linq provides communications APIs for iMessage, RCS, SMS, and Voice.

Required roles:

- Give each launched company/product a customer-support messaging endpoint.
- Inbound customer messages become support tickets/events.
- Customer-support agents can respond through Linq.
- Escalate sensitive/refund/legal/safety situations according to policy.
- Persist conversation state in the business record.
- Use rich messaging capabilities where useful.
- Support handoff between agents and authorized humans without losing context.



### Superserve — Persistent agent sandboxes

Superserve provides persistent, secure sandboxes for AI agents.

Required roles:

- Long-running manager or specialist agent workspaces.
- Persistent filesystem/state for agents whose jobs span hours or days.
- Isolated execution for model-generated work.
- Safe handling of tool execution.
- Versioned/persistent state where useful.
- Separate sandbox identities for business functions so a failure in one does not corrupt the company control plane.



### Replay — Autonomous QA

Replay QA explores live web apps, records sessions, detects bugs, and produces root-cause/fix information; it also advertises an API for embedding QA as a quality gate.

Required roles:

- Every generated storefront must pass a Replay QA gate before production release.
- Run QA again after meaningful deployment changes.
- Capture bug reports and feed them back to the engineering/site-building agents.
- Block release when critical commerce flows fail.
- Exercise homepage → product → cart/checkout → success/failure states where possible.
- Use recordings/root-cause reports as evidence in the release record.



### BAND — Multi-agent and human coordination

BAND is interaction infrastructure for distributed AI agents. Its current platform describes an Agentic Mesh for collaboration and an interaction control plane for governance.

Required roles:

- CEO ↔ manager ↔ specialist coordination.
- Task-scoped rooms/channels for product discovery, sourcing, marketing, support, engineering, finance, QA, and incidents.
- Permission-controlled communication.
- Agent discovery/delegation where appropriate.
- Human expert participation in the same governed collaboration layer where feasible.
- Auditable task handoffs.
- Governance rules that prevent an agent from silently assuming authority it does not have.
- Preserve the underlying agent runtimes; BAND is the coordination/governance layer, not a replacement for every framework or sandbox.



### Dodo Payments — Merchant of Record for eligible digital products

Dodo Payments currently documents its Merchant-of-Record offering around digital products/SaaS, handling global payments, tax compliance, fraud, and related transaction liability.

Required use:

- Integrate Dodo when the autonomous company sells an eligible digital product, software add-on, membership, data product, service, or subscription where Dodo’s merchant-acceptance rules permit it.
- Do not claim Dodo is the Merchant of Record for a physical private-label bottle or other physical good unless its current terms/docs explicitly support that category.
- Where both Stripe and Dodo are present, make the routing/product-category distinction explicit.



### Sandbox0 — Isolated execution infrastructure

Sandbox0 describes its service as AI-agent infrastructure for isolated execution, persistent workspaces, credentials, and runtime controls.

Required roles:

- Run untrusted/model-generated code and automation in isolated environments.
- Ephemeral or persistent workspaces depending on job type.
- Credential isolation and controlled egress.
- Preview generated apps without prematurely publishing them.
- Use a separate security boundary from the production control plane.



### Solari by Pinetree Research — Browsers, sandboxes, and computers for agents

Solari is Pinetree Research’s infrastructure for AI agents, providing cloud browsers, sandboxes, and full GUI computers through one API.

Required roles:

- Real browser sessions for public-web research when an API is unavailable or insufficient.
- Persistent browser profiles where permitted.
- Human takeover for login/CAPTCHA or other appropriate human-in-the-loop steps.
- Full GUI computer sessions for workflows that require ordinary human-facing software.
- Session recording/replay for auditability.
- Sandboxes for code/tool execution when Solari is the better fit for that workload.
- Supplier discovery and research through compliant web interaction.
- Never use “anti-bot” capability as permission to violate a site’s Terms of Service, robots rules, access controls, rate limits, or applicable law.

---



## 3. Non-Sponsor External Integrations

The architecture must allow additional services without contaminating the core domain model.

Create adapters/interfaces for:

- Supplier marketplaces and sourcing platforms.
- Freight/landed-cost services.
- Shipping carriers / 3PLs.
- Tax calculation if physical commerce requires it and the payment stack does not cover it.
- Meta Ads.
- Google Ads.
- Analytics/attribution.
- Email.
- Domain/DNS.
- Product-image generation or photography workflows.
- Inventory/warehouse systems.

No adapter may fabricate availability. If credentials or access are missing, the system must show a blocked dependency with exact setup instructions and keep the rest of the system testable.

---



## 4. Agent Organization



### CEO Agent

Single accountable executive agent.

Owns:

- Company mission.
- Opportunity selection.
- Capital allocation within configured limits.
- Launch/no-launch decisions.
- Manager hiring/spawning.
- KPI targets.
- Risk policy.
- Kill/continue/pivot decisions.
- Cross-functional conflict resolution.
- Final operating plan.

The CEO does not personally perform every task. It delegates, reviews evidence, and makes decisions from structured reports.

### Research / Market Intelligence Manager

Subagents:

- Reddit/community researcher.
- Forum/review miner.
- Search/research agent.
- Competitor analyst.
- Pain-point clusterer.
- Evidence verifier.
- Market-sizing estimator.

Outputs:

- Evidence packets with URLs/source IDs, timestamps, excerpts/summaries, confidence, and duplication controls.
- Pain-point graphs.
- Candidate opportunity scorecards.



### Product & Sourcing Manager

Subagents:

- Supplier finder.
- Private-label capability verifier.
- RFQ drafter.
- Supplier outreach agent.
- Quote parser.
- Landed-cost analyst.
- Sample/quality workflow coordinator.
- Product-risk reviewer.

Outputs:

- Comparable supplier bids.
- MOQ.
- Customization options.
- Logo/packaging constraints.
- Sample availability.
- Lead times.
- Shipping terms.
- Cost stack.
- Risk flags.



### Brand & Creative Manager

Subagents:

- Naming agent.
- Trademark/domain preliminary checker.
- Positioning/copy agent.
- Logo/identity generator.
- Packaging concept agent.
- Product-page content agent.
- Creative variant generator.

Outputs:

- Brand system.
- Product story.
- Landing-page content.
- Ad concept library.
- Creative packages sent to Terac reviewers.



### Commerce / Web Manager

Subagents:

- Lovable site-builder agent.
- Integration engineer.
- Checkout engineer.
- Order-state engineer.
- Analytics engineer.
- Deployment agent.

Outputs:

- Live storefront.
- API connections.
- Payment flow.
- Order persistence.
- webhook processing.
- deployment record.



### Growth / Marketing Manager

Subagents:

- Ad strategist.
- Meta Ads operator.
- Google Ads operator.
- Creative experiment agent.
- Funnel analyst.
- Budget allocator.
- Attribution analyst.

Loop:

1. Generate variants.
2. Terac human review.
3. Launch controlled A/B or multivariate test.
4. Wait for statistically/operationally meaningful evidence.
5. Compare performance.
6. Pause losers.
7. Scale winners within policy.
8. Generate next hypotheses.
9. Repeat.



### Customer Operations Manager

Subagents:

- Linq support agent.
- Order-status agent.
- Refund/returns triage agent.
- Product feedback collector.
- Escalation agent.



### Finance / Unit Economics Manager

Subagents:

- Payment reconciliation.
- Revenue ledger.
- COGS estimator.
- Ad-spend tracker.
- Contribution-margin calculator.
- Forecasting agent.
- Fraud/refund monitor.



### Engineering / Reliability Manager

Subagents:

- Core platform engineer.
- Integration engineer.
- Security engineer.
- DevOps agent.
- Incident-response agent.
- Sandbox policy agent.



### QA Manager

Subagents:

- Replay QA operator.
- API contract test agent.
- Browser E2E agent.
- Payment-state test agent.
- Accessibility checker.
- Security smoke-test agent.
- Data-integrity checker.

QA has veto power over release when defined critical conditions fail.

### Legal / Compliance Manager

This is not a substitute for licensed counsel.

Subagents:

- Terms/privacy/cookie document assembler.
- Advertising-claims checker.
- Product-category compliance researcher.
- Data-retention/privacy checker.
- Shipping/restricted-goods checker.
- Trademark/domain preliminary researcher.
- Escalation agent to Terac/legal professional when real legal judgment is required.

---



## 5. Opportunity Discovery Pipeline



### Inputs

Collect diverse evidence:

- Reddit discussions and comments.
- Product reviews.
- Competitor reviews.
- Forums.
- YouTube/video comments where accessible and allowed.
- Public social discussions where accessible and allowed.
- Search trends or keyword data when available.
- Existing product listings.
- Q&A pages.
- Return/complaint themes.
- Community posts describing hacks/workarounds.
- “I wish…” and “why doesn’t…” language.
- Repeated reports of breakage, bad design, inconvenience, safety problems, high price, poor availability, difficult setup, or missing feature.



### Evidence model

Every evidence item stores:

- Source.
- URL or external ID.
- Access timestamp.
- Author identifier only when needed and legally/ethically appropriate.
- Raw excerpt where permitted.
- Normalized summary.
- Pain-point label(s).
- Product/category label(s).
- Sentiment.
- Severity.
- Frequency signal.
- Purchase-intent signal.
- Workaround signal.
- Competitor mentioned.
- Geographic relevance.
- Confidence.
- Duplicate/near-duplicate hash.
- Compliance metadata.



### Opportunity graph

Nodes:

- Pain points.
- User segments.
- Products.
- Competitors.
- Desired outcomes.
- Failure modes.
- Workarounds.
- Price points.
- Suppliers.
- Ads/creative hypotheses.

Edges:

- user-segment → experiences → pain-point
- pain-point → caused-by → failure-mode
- pain-point → currently-solved-by → competitor
- pain-point → workaround → workaround
- pain-point → could-be-solved-by → product concept
- product concept → sourceable-from → supplier
- product concept → targeted-by → ad hypothesis

The CEO should be able to inspect why the system believes an opportunity exists.

---



## 6. Opportunity Scoring

Create a weighted score, but never hide the underlying evidence.

Dimensions:

- Pain severity.
- Frequency.
- Number/diversity of independent sources.
- Clear buyer identity.
- Willingness to pay.
- Existing spend in category.
- Competitor dissatisfaction.
- Product differentiation potential.
- Private-label feasibility.
- MOQ.
- Sample speed.
- Manufacturing lead time.
- Landed cost.
- Expected selling price.
- Gross margin.
- Expected contribution margin after payment fees, fulfillment, refunds, and ads.
- Shipping complexity.
- Return risk.
- Product safety/regulatory risk.
- IP/trademark/patent risk indicators.
- Ad-policy risk.
- Seasonality.
- Market saturation.
- Creative/marketing tractability.

Terac reviewers can override or annotate machine scores, but the override must be recorded with rationale.

---



## 7. Supplier and Private-Label System

No named sponsor currently substitutes for a dedicated physical-goods supplier network. Build a provider-neutral sourcing layer.

### Supplier adapter contract

Each provider must support as many as are realistically available:

- Search products.
- Search factories/suppliers.
- Fetch supplier profile.
- Fetch product details.
- Private-label/customization capability.
- MOQ.
- Price tiers.
- Sample cost.
- Packaging options.
- Lead time.
- Shipping quote.
- Incoterm.
- Destination.
- Contact channel.
- RFQ submission.
- Quote retrieval.

When there is no API:

- Use Solari browser/computer automation only where permitted.
- Record the session.
- Require human takeover for anti-automation checkpoints where appropriate.
- Store structured output with source traceability.



### Landed-cost model

At minimum:
landed unit cost =
unit manufacturing cost

- customization
- packaging
- allocated tooling/setup
- inspection/QC
- domestic origin freight
- international freight
- insurance
- duties/tariffs
- customs/brokerage
- destination freight
- fulfillment receiving
- expected damage/loss allocation

Then compute:
contribution margin =
net selling price

- landed unit cost
- outbound fulfillment/shipping subsidy
- payment fees
- expected returns/refunds
- ad CAC
- variable support cost
- other variable platform fees

The system must keep assumptions separate from confirmed supplier values.

---



## 8. Brand and Site Generation

For every selected product:

1. Create brand-name candidates.
2. Run preliminary domain availability checks.
3. Run preliminary trademark/conflict research and escalate ambiguous cases.
4. Select name based on positioning and legal-risk signals.
5. Produce logo/identity variants.
6. Produce packaging direction compatible with supplier customization constraints.
7. Draft value proposition.
8. Draft product page.
9. Draft FAQ.
10. Draft shipping/returns information.
11. Draft required policy pages based on real business configuration.
12. Build site through Lovable MCP.
13. Sync/export code if needed.
14. Integrate backend APIs.
15. Deploy on Render.
16. Run Replay QA.
17. Fix.
18. Re-run.
19. Release only after quality gates pass.

---



## 9. Commerce and Order Flow

Required production state machine:

CREATED
→ CHECKOUT_STARTED
→ PAYMENT_PENDING
→ PAID
→ FULFILLMENT_QUEUED
→ FULFILLING
→ SHIPPED
→ DELIVERED

Exceptional branches:
PAYMENT_FAILED
CANCELLED
REFUND_REQUESTED
PARTIALLY_REFUNDED
REFUNDED
RETURN_REQUESTED
RETURNED
CHARGEBACK/DISPUTE
LOST/DAMAGED
MANUAL_REVIEW

Payment webhooks, not the browser redirect, are authoritative for money state.

Every order must have:

- internal order ID.
- external payment IDs.
- customer ID.
- product/SKU.
- amount/currency.
- shipping address.
- fulfillment status.
- supplier/3PL reference.
- support history.
- refund/dispute history.
- event audit log.

---



## 10. Marketing Loop



### Pre-launch

- Define ICP/user segment.
- Define core pain.
- Define promise.
- Define claims that are actually supportable.
- Generate multiple hooks.
- Generate copy/creative variants.
- Send top candidates to Terac marketing expert(s).
- Store ratings and comments.
- Revise.



### Launch

Use external ad-platform adapters such as Meta Ads and Google Ads.

For each experiment:

- hypothesis.
- audience.
- creative.
- copy.
- landing page.
- budget.
- start time.
- stop conditions.
- KPI objective.
- attribution method.



### Evaluation

Measure:

- impressions.
- reach.
- clicks.
- CTR.
- CPC.
- landing-page engagement.
- add-to-cart.
- checkout start.
- conversion rate.
- CAC.
- revenue.
- contribution margin.
- refund rate.
- repeat purchase when available.

Do not optimize solely for clicks. The CEO cares about profitable, supportable growth.

### Recursive creative loop

If an ad is weak:

1. Do not just increase spend.
2. Identify failure mode.
3. Generate a new hypothesis.
4. Create new creative.
5. Terac human review.
6. Launch controlled test.
7. Compare.
8. Scale only within policy.

This loop continues throughout the life of the company.

---



## 11. Linq Customer-Support Loop

Inbound iMessage/RCS/SMS/Voice event
→ identify customer/order
→ classify intent
→ answer from verified policy/order data
→ take allowed action
→ update ticket/order
→ escalate when needed
→ follow up
→ write resolution to company memory

Never invent shipment status, refunds, or policies.

Sensitive categories that should usually escalate:

- legal threats.
- safety incidents.
- serious injury.
- chargeback threats.
- suspected fraud.
- high-value refund beyond agent limit.
- regulator/media inquiry.
- ambiguity about a contractual promise.

---



## 12. Runtime Architecture



### Control plane on Render

Services:

- API gateway.
- auth.
- company service.
- agent registry.
- task service.
- opportunity service.
- evidence service.
- supplier service.
- product/catalog service.
- brand/site service.
- commerce/order service.
- payment service.
- marketing service.
- messaging/support service.
- QA service.
- policy/governance service.
- audit service.



### Job system

Use durable queues/workers for:

- research tasks.
- supplier scans.
- site builds.
- deployments.
- QA.
- ad reporting.
- creative generation.
- support follow-up.
- reconciliation.



### Execution planes

- Superserve: persistent long-running agent sandboxes.
- Sandbox0: isolated execution/persistent workspace/credential-controlled jobs.
- Solari: browser, sandbox, and full-computer interaction.
- Render: durable services and workers.
- BAND: cross-agent/human interaction and governance, not raw compute.

Choose the execution environment by workload rather than duplicating identical responsibilities everywhere.

---



## 13. Security and Governance

Mandatory:

- Secrets never stored in prompts, source code, logs, or generated sites.
- Per-integration secrets.
- Least privilege.
- Separate development/staging/production credentials.
- Network egress controls for agent sandboxes.
- Allowlisted domains for sensitive credentials where infrastructure supports it.
- Idempotency for payment/order actions.
- Rate limits.
- Budget limits.
- Spend caps.
- Supplier purchase/order approval thresholds.
- No autonomous legal signature unless the system is explicitly authorized to do so.
- Immutable or append-only audit events for critical actions.
- Human escalation path.
- Rollback/kill switch.

Even if the end goal is minimal human input, the production system must recognize legal ownership, bank/payment-account authority, ad-account authority, contractual authority, and regulatory accountability. The CEO agent can decide; execution must remain inside permissions granted by the real business owner.

---



## 14. Legal and Compliance Surface

Before launch, generate/configure the appropriate set for the actual business:

- Terms of Service / Terms of Sale.
- Privacy Policy.
- Cookie/analytics disclosures where applicable.
- Shipping policy.
- Returns/refunds policy.
- Contact/support information.
- Business identity disclosures required by the operating jurisdiction.
- Marketing consent / SMS terms where applicable.
- Messaging opt-out handling.
- Warranty statements if offered.
- Product safety warnings.
- Country/state-specific notices as needed.
- Tax handling appropriate to physical goods.
- Advertising substantiation records for objective claims.
- IP/trademark review checkpoints.
- Supplier certifications where required by category.
- Restricted/prohibited product screening.
- Consumer-product compliance screening.
- Import/customs compliance.

Legal text must be generated from configuration and reviewed for jurisdiction/product context; do not blindly paste boilerplate and call it compliant.

---



## 15. Testing Arm



### Unit tests

Core deterministic business logic:

- scores.
- margin math.
- state transitions.
- policy decisions.
- webhook verification.
- idempotency.



### Integration tests

- Stripe test-mode.
- Whop sandbox/test capabilities when available.
- Linq test workflows.
- Lovable project creation contract.
- Render deployment health.
- BAND messaging/permissions.
- sandbox lifecycle.
- supplier adapter mocks plus real non-destructive contract checks.
- ad adapters in non-spending/dev mode where possible.



### Browser E2E

- homepage.
- product page.
- add-to-cart.
- checkout initiation.
- payment success/failure in test mode.
- confirmation.
- support contact.
- policy links.
- mobile layout.



### Replay QA

Must run as a separate autonomous quality gate on deployed preview/staging and on production-relevant releases.

### Chaos/failure tests

- webhook duplicate.
- webhook delay.
- supplier API failure.
- ad API failure.
- worker crash.
- sandbox loss.
- site deployment failure.
- messaging provider outage.
- payment success with redirect failure.
- refund race.
- duplicate order submission.

---



## 16. Recursive Build/Verification Loop

For every implementation slice:

1. Re-read GOAL_MODE_PROMPT.md.
2. Identify the exact requirement being implemented.
3. Implement the smallest complete production slice.
4. Run unit tests.
5. Run integration tests relevant to the slice.
6. Run static/type/security checks.
7. Exercise the real integration where credentials/access permit.
8. Record evidence.
9. Check whether any previous assumption was invalidated.
10. Fix regressions.
11. Update Markdown progress files.
12. Re-read GOAL_MODE_PROMPT.md.
13. Only then start the next slice.

If a requirement is not actually satisfied, status must remain NOT COMPLETE.

---



## 17. Required Project Markdown

At minimum maintain:

- `GOAL_MODE_PROMPT.md`
- `PLAN.md`
- `ARCHITECTURE.md`
- `SPONSORS.md`
- `INTEGRATIONS.md`
- `DATA_MODEL.md`
- `AGENTS.md`
- `SECURITY.md`
- `LEGAL_COMPLIANCE.md`
- `TESTING.md`
- `RUNBOOK.md`
- `PRODUCTION_CHECKLIST.md`
- `PROGRESS.md`
- `DECISIONS.md`
- `BLOCKERS.md`
- `VERIFICATION_EVIDENCE.md`

Each integration entry must record:

- official docs used.
- date verified.
- auth method.
- scopes/permissions.
- test environment.
- production environment.
- webhook/event model.
- rate limits where known.
- failure behavior.
- retry/idempotency strategy.
- current status.

---



## 18. Production Completion Criteria

Do not call the project complete because the UI looks good.

Completion means, simultaneously:

- CEO/manager/subagent hierarchy exists and works.
- BAND-backed coordination/governance works where integrated.
- persistent/isolated execution works.
- research can collect and normalize real evidence.
- opportunity scoring works.
- human expert review through Terac is integrated or has a clearly demonstrated live integration path dependent only on account authorization.
- supplier discovery works through at least one real provider/path.
- private-label capability is represented.
- quote/landed-cost pipeline works with real or explicitly marked quoted data.
- brand creation works.
- Lovable can be programmatically used to create/iterate a site.
- site code is deployable.
- Render production deployment works.
- real payment integration is present.
- payment webhooks reconcile orders.
- order/fulfillment state is implemented.
- customer messaging through Linq is implemented.
- marketing adapter architecture works and at least one real ad platform can be connected.
- human creative review feeds the marketing loop.
- Replay QA is wired as a release gate.
- support workflows work.
- audit logs work.
- secrets are safe.
- legal/policy surfaces exist for the configured business.
- tests pass.
- no fake “success.”
- no known critical defect remains.
- production runbooks exist.
- a new company/product can be launched through the same architecture without rewriting the platform.

If any item is false, the system is not fully production-ready.

---



## 19. Research Baseline Used to Normalize Sponsor Roles

Verified against current official or first-party pages on August 14, 2026:

- Terac: expert marketplace / expert labor MCP for sourcing, verifying, hiring, and paying human experts.
- Stripe: payments/Checkout/Billing/API/webhooks.
- Lovable: full-stack AI development platform and Lovable MCP server for programmatic project creation/iteration/deployment.
- Whop: business/commerce API and CLI primitives.
- Render: web services, private services, workers, datastores, deployment and operational hosting.
- Linq: APIs for iMessage, RCS, SMS, and Voice.
- Superserve: persistent secure sandboxes for agents.
- Replay: autonomous QA that explores web apps and reports root cause/fixes; API available for embedded quality gates.
- BAND: interaction infrastructure for distributed AI agents, with collaboration mesh and governance/control-plane concepts.
- Dodo Payments: Merchant of Record for eligible digital products/SaaS; do not misapply this to physical private-label goods.
- Sandbox0: isolated execution, persistent workspaces, credentials, and runtime controls for AI agents.
- Solari by Pinetree Research: cloud browsers, sandboxes, and GUI computers for AI agents.

Official sites:

- [https://terac.com/](https://terac.com/)
- [https://stripe.com/](https://stripe.com/)
- [https://docs.lovable.dev/](https://docs.lovable.dev/)
- [https://whop.com/](https://whop.com/)
- [https://render.com/docs](https://render.com/docs)
- [https://linqapp.com/](https://linqapp.com/)
- [https://superserve.ai/](https://superserve.ai/)
- [https://www.replay.io/](https://www.replay.io/)
- [https://www.band.ai/](https://www.band.ai/)
- [https://docs.dodopayments.com/](https://docs.dodopayments.com/)
- [https://sandbox0.ai/](https://sandbox0.ai/)
- [https://getsolari.com/](https://getsolari.com/)

---



## 20. Binding Goal Mode Overflow and Production Only Directive

The Goal Mode prompt is intentionally constrained to exactly 3,999 characters. Any important implementation detail that does not fit inside that compact prompt remains binding through this `PLAN.md`. The character limit must never be interpreted as permission to discard the detailed architecture, sponsor roles, agent hierarchy, sourcing requirements, fulfillment requirements, QA requirements, security requirements, legal requirements, testing requirements, or production completion criteria already defined in this plan.

### Missing live API keys must not block construction

Do not keep trying to build on live API keys which the user does not have yet. Missing live API keys are not a reason to stop, loop on authentication, keep retrying unavailable live services, or leave the rest of the system unfinished.

Focus on building the whole system, which is complex on its own, **as if it is a live system**.

For every integration whose live credentials are not yet available, build the complete production integration surface around the documented API:

- provider interface and adapter;
- authentication boundary and secret references;
- request and response contracts;
- webhook handlers;
- signature verification;
- durable state transitions;
- production queues and jobs;
- retries and backoff;
- idempotency;
- rate limit handling;
- error classification;
- observability;
- audit events;
- deployment configuration;
- production environment configuration;
- verification harnesses;
- explicit activation checklist for inserting valid production credentials later.

Do not fabricate credentials. Do not claim a successful live call occurred when it did not. Do not repeatedly stop implementation to demand keys that are not currently available. Do not lower the production standard because the keys are missing. The intended result is that once valid credentials and any required vendor approvals exist, the production integration can be activated without redesigning the system.

### Production only target

Do not attempt to build the product locally as the development target. Everything must be geared for production only.

The target architecture from the first meaningful implementation decision must be the real hosted production architecture. A developer laptop, localhost server, local database, local only queue, local only worker, or temporary local workflow is never the product architecture and is never a definition of completion.

If local execution is temporarily used as a tool to write, compile, test, package, or inspect code, that local execution is only a means of producing or verifying artifacts whose destination and architecture are production. Do not build a separate toy local architecture that later has to be replaced.

Production first means using the real patterns expected in the deployed system from the beginning:

- durable hosted services;
- production persistence;
- production workers and queues;
- production secret handling;
- production networking assumptions;
- health checks;
- logs and observability;
- security controls;
- rate limits;
- retries;
- idempotency;
- budget and spend controls;
- purchase limits;
- kill switches;
- rollback;
- deployment automation;
- staging or provider test environments only when they are part of validating a production integration, never as the final architecture.



### Maximum marketing and money making impact

This is **not a passion product**.

It is a **leap of faith for software that takes marketing to the next level**.

The system must be optimized for **maximum marketing and money making impact** rather than novelty for novelty's sake. Product decisions should be evaluated by their ability to create demand, conversion, contribution margin, scalable acquisition, retention where applicable, and durable commercial advantage.

Marketing is not a decorative function that begins after the product is built. Marketing, distribution, positioning, pricing, creative quality, offer design, landing page conversion, human review, advertising experiments, attribution, acquisition economics, and profit must influence product selection and company strategy from the beginning.

The autonomous company should aggressively learn what makes money while remaining inside legal, ethical, platform, budget, and authority constraints. It should prefer evidence backed commercial opportunities over founder taste. It should kill weak ideas, weak ads, weak landing pages, weak offers, or weak products when the evidence says they are not economically competitive, then redeploy effort toward better opportunities.

The CEO and Growth organization must continuously optimize toward commercially meaningful results rather than vanity metrics. Clicks without purchases are not success. Revenue without contribution margin is not automatically success. An attractive website without acquisition or conversion is not success. A clever agent architecture without a viable business loop is not success.

### Character limit precedence rule

When the compact `GOAL_MODE_PROMPT.md` cannot contain a detailed requirement because of its exact 3,999 character constraint, **this plan is the authoritative overflow specification**. The compact prompt and this plan are one combined operating specification. Requirements present here remain mandatory even when they are not repeated in the compact prompt.  
  
While you build the application, use Opus 5 the  coordinator for multiple subagents which are Sonnet 5 Max reasoning. Have separate Opus 5 agents validate all of the code and test everything at each step. Use the loop to iterate and fix anything that breaks. Also as you build this, functionality comes first (END TO END FUNCTIONALITY IS CRUCIAL). THEN, once the working version is confirmed and is THOROUGHLY tested, you need to make it business quality -- the BEST quality. First build the infrastructure then you must improve on everything that has been built over and over and ensure that it is a business YOU would use or a business that BILL GATES would sell to smart people.