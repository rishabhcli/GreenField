/**
 * The agent organisation: CEO, functional managers, and specialist subagents.
 *
 * The org chart is data, not code branches. Each role declares the authorities
 * it may hold, the capabilities it needs, the tools it may call and the model
 * that runs it, so adding a function means adding a row — and so the policy
 * service can answer "may this agent do that?" without asking the agent.
 */

import { z } from 'zod';
import type { Authority } from './governance.js';
import type { Capability } from '../capability.js';

export const ModelTier = z.enum(['executive', 'manager', 'specialist', 'fast']);
export type ModelTier = z.infer<typeof ModelTier>;

/**
 * Model per tier. Executive and manager decisions allocate capital and choose
 * strategy, so they run on the strongest reasoning model; specialists do
 * bounded, high-volume work.
 */
export const MODEL_BY_TIER: Readonly<Record<ModelTier, string>> = {
  executive: 'claude-opus-5',
  manager: 'claude-opus-5',
  specialist: 'claude-sonnet-5',
  fast: 'claude-haiku-4-5',
};

/**
 * List price per million tokens, in USD minor units (cents), verified
 * 2026-08-15. Used to attribute inference spend per agent role — an autonomous
 * company that cannot say what its own thinking cost is not running on real
 * unit economics.
 */
export const MODEL_PRICING_CENTS_PER_MTOK: Readonly<
  Record<string, { input: number; output: number; note?: string }>
> = {
  'claude-opus-5': { input: 500, output: 2500 },
  'claude-sonnet-5': {
    input: 300,
    output: 1500,
    note: 'introductory $2/$10 per MTok applies through 2026-08-31; list price used here so budgets do not under-reserve when it ends',
  },
  'claude-haiku-4-5': { input: 100, output: 500 },
  'claude-opus-4-8': { input: 500, output: 2500 },
};

export const OrgFunction = z.enum([
  'executive',
  'research',
  'sourcing',
  'brand',
  'commerce',
  'growth',
  'customer_ops',
  'finance',
  'engineering',
  'qa',
  'legal',
]);
export type OrgFunction = z.infer<typeof OrgFunction>;

export interface RoleDefinition {
  /** Stable key used in the DB, in BAND handles and in audit logs. */
  readonly key: string;
  readonly title: string;
  readonly func: OrgFunction;
  readonly tier: ModelTier;
  /** Manager this role reports to; null for the CEO. */
  readonly reportsTo: string | null;
  /** What this role is accountable for, injected into its system prompt. */
  readonly mandate: string;
  /** Concrete outputs it must produce. */
  readonly deliverables: readonly string[];
  readonly authorities: readonly Authority[];
  /** Platform capabilities the role needs; a blocked one degrades the role. */
  readonly requiredCapabilities: readonly Capability[];
  /** Tool names from the agent tool registry this role may call. */
  readonly tools: readonly string[];
  /** Per-action spend ceiling in USD minor units; null = no independent spend. */
  readonly spendCeilingMinorUsd: number | null;
  /** Roughly how long one run of this role should take before it is a problem. */
  readonly runBudgetSeconds: number;
}

/* -------------------------------------------------------------------------- */
/* Executive                                                                   */
/* -------------------------------------------------------------------------- */

const CEO: RoleDefinition = {
  key: 'ceo',
  title: 'Chief Executive Agent',
  func: 'executive',
  tier: 'executive',
  reportsTo: null,
  mandate:
    'You are accountable for one thing: building a company that makes durable, profitable revenue. ' +
    'You do not perform the work; you set the mission, choose which opportunity to pursue, allocate ' +
    'capital inside the limits the human owner granted, decide launch / kill / pivot, resolve conflicts ' +
    'between managers, and set KPI targets. You decide from structured evidence — scorecards, quotes, ' +
    'margin models, experiment results — and you say plainly when the evidence is too thin to decide. ' +
    'You never approve spend that policy has not cleared, and you never claim a result the data does not show.',
  deliverables: [
    'operating plan with explicit KPI targets and stop conditions',
    'opportunity selection decision with written rationale and the evidence it rests on',
    'capital allocation across research, sampling, inventory and advertising',
    'launch / no-launch decision per storefront',
    'kill / continue / scale decision per experiment and per product',
    'escalations to the human owner for anything outside granted authority',
  ],
  authorities: [
    'research.collect',
    'expert.engage_paid',
    'supplier.contact',
    'supplier.purchase_sample',
    'brand.publish',
    'site.deploy_production',
    'ads.create_campaign',
    'ads.increase_budget',
    'payments.configure',
  ],
  requiredCapabilities: ['llm.reasoning', 'coordination.agent_mesh'],
  tools: [
    'company.get_state',
    'opportunity.list',
    'opportunity.get_scorecard',
    'opportunity.select',
    'opportunity.kill',
    'finance.get_contribution_report',
    'finance.get_budget_status',
    'marketing.get_experiment_results',
    'marketing.decide_arms',
    'governance.request_approval',
    'governance.set_budget',
    'governance.engage_kill_switch',
    'org.dispatch_manager',
    'org.get_manager_reports',
    'band.post_message',
    'audit.write_decision',
  ],
  spendCeilingMinorUsd: 250_00,
  runBudgetSeconds: 600,
};

/* -------------------------------------------------------------------------- */
/* Managers                                                                    */
/* -------------------------------------------------------------------------- */

function manager(
  key: string,
  title: string,
  func: OrgFunction,
  mandate: string,
  deliverables: readonly string[],
  authorities: readonly Authority[],
  requiredCapabilities: readonly Capability[],
  tools: readonly string[],
  spendCeilingMinorUsd: number | null,
): RoleDefinition {
  return {
    key,
    title,
    func,
    tier: 'manager',
    reportsTo: 'ceo',
    mandate,
    deliverables,
    authorities,
    requiredCapabilities: ['llm.reasoning', ...requiredCapabilities],
    tools: ['org.dispatch_specialist', 'org.report_to_ceo', 'band.post_message', ...tools],
    spendCeilingMinorUsd,
    runBudgetSeconds: 900,
  };
}

const MANAGERS: readonly RoleDefinition[] = [
  manager(
    'research_manager',
    'Research & Market Intelligence Manager',
    'research',
    'Turn public demand signals into defensible opportunity scorecards. You own evidence quality. ' +
      'A pain point with forty posts from one subreddit is weaker than one with twelve posts across six ' +
      'independent sources, and you must say so. You never let a model-generated plausible-sounding pain ' +
      'point enter the pipeline without retrievable sources behind it.',
    [
      'evidence packets with URLs, timestamps, excerpts and confidence',
      'pain-point clusters with independent-source counts',
      'opportunity graph nodes and edges',
      'candidate opportunity scorecards with per-dimension rationale',
    ],
    ['research.collect', 'expert.engage_paid'],
    ['research.web_search', 'research.browser_session', 'expert.structured_review'],
    [
      'research.run_collection',
      'research.cluster_pain_points',
      'research.verify_evidence',
      'opportunity.create',
      'opportunity.score',
      'expert.request_review',
    ],
    100_00,
  ),
  manager(
    'sourcing_manager',
    'Product & Sourcing Manager',
    'sourcing',
    'Find suppliers who can actually make and private-label the product, get real quotes, and produce a ' +
      'landed-cost model that separates quoted numbers from assumptions. You never present an assumption ' +
      'as a quote. If a supplier has not replied, the quote does not exist.',
    [
      'comparable supplier bids with MOQ, tiers, lead time and incoterm',
      'private-label and packaging capability confirmation',
      'landed-cost model with per-component basis',
      'sample plan and QC criteria',
      'product risk flags',
    ],
    ['supplier.contact', 'supplier.purchase_sample'],
    ['sourcing.supplier_search', 'sourcing.rfq_submit', 'research.browser_session'],
    [
      'sourcing.search_suppliers',
      'sourcing.get_supplier',
      'sourcing.draft_rfq',
      'sourcing.send_rfq',
      'sourcing.parse_quote',
      'sourcing.build_landed_cost',
      'finance.compute_contribution',
    ],
    500_00,
  ),
  manager(
    'brand_manager',
    'Brand & Creative Manager',
    'brand',
    'Create a brand that converts. Naming, positioning, identity, packaging direction and page copy are ' +
      'commercial instruments, not decoration. Every objective claim you approve must have substantiation ' +
      'recorded against it, because an unsupportable claim costs an ad account and invites a regulator.',
    [
      'brand name candidates with domain and preliminary trademark signals',
      'positioning and value proposition',
      'logo and identity variants',
      'packaging direction within supplier constraints',
      'product page and FAQ copy',
      'claim substantiation register',
    ],
    ['brand.publish', 'expert.engage_paid'],
    ['asset.image_generation', 'domain.availability_check', 'expert.structured_review'],
    [
      'brand.generate_names',
      'brand.check_domains',
      'brand.research_trademark_preliminary',
      'brand.create_identity',
      'brand.generate_asset',
      'brand.draft_page_content',
      'expert.request_review',
    ],
    150_00,
  ),
  manager(
    'commerce_manager',
    'Commerce & Web Manager',
    'commerce',
    'Ship a storefront that takes real money reliably. You own site generation, checkout wiring, order ' +
      'state, webhook processing and deployment. A page that renders is not a working checkout; the ' +
      'definition of done is a payment webhook that reconciles to an order row.',
    [
      'generated and exported storefront code',
      'wired checkout for the correct payment route',
      'webhook handlers with signature verification',
      'order persistence and state transitions',
      'production deployment record with rollback target',
    ],
    ['site.deploy_preview', 'site.deploy_production', 'payments.configure'],
    ['site.generate', 'site.iterate', 'platform.hosting', 'platform.deploy_control', 'payments.checkout.physical'],
    [
      'site.create_spec',
      'site.generate',
      'site.export_code',
      'site.deploy',
      'site.rollback',
      'commerce.create_product',
      'commerce.configure_checkout',
      'commerce.collect_payment',
      'qa.request_gate',
    ],
    200_00,
  ),
  manager(
    'growth_manager',
    'Growth & Marketing Manager',
    'growth',
    'Acquire customers profitably. Generate hypotheses, get human expert review before spending, run ' +
      'controlled experiments, and read the results honestly. Clicks are not success. Revenue without ' +
      'contribution margin is not success. When a variant loses, diagnose the failure mode and write a new ' +
      'hypothesis — never just raise the budget.',
    [
      'ICP and core-pain definition',
      'creative concepts with explicit hypotheses',
      'human-reviewed creative before any spend',
      'experiment definitions with stop conditions',
      'per-arm decisions with the data behind them',
      'CAC and contribution-margin reporting',
    ],
    ['ads.create_campaign', 'ads.increase_budget', 'expert.engage_paid', 'messaging.send_marketing'],
    ['ads.campaign_manage', 'ads.metrics_read', 'expert.structured_review'],
    [
      'marketing.create_concept',
      'marketing.check_claims',
      'expert.request_review',
      'marketing.create_experiment',
      'marketing.launch_arm',
      'marketing.pause_arm',
      'marketing.scale_arm',
      'marketing.collect_metrics',
      'finance.compute_contribution',
    ],
    300_00,
  ),
  manager(
    'customer_ops_manager',
    'Customer Operations Manager',
    'customer_ops',
    'Answer customers accurately and fast, using only verified order and policy data. You never invent a ' +
      'shipment status, a refund outcome or a policy. Legal threats, safety incidents, injury, chargeback ' +
      'threats, suspected fraud, high-value refunds and regulator or media contact always escalate.',
    [
      'ticket triage and resolution within policy',
      'accurate order-status answers sourced from order records',
      'refund and return decisions inside approved limits',
      'escalation packets for sensitive cases',
      'product feedback routed back to sourcing and brand',
    ],
    ['messaging.send_customer', 'payments.refund'],
    ['messaging.sms', 'messaging.inbound_webhook'],
    [
      'support.list_tickets',
      'support.get_order_context',
      'support.classify_intent',
      'support.send_reply',
      'support.issue_refund',
      'support.escalate',
      'commerce.collect_payment',
    ],
    50_00,
  ),
  manager(
    'finance_manager',
    'Finance & Unit Economics Manager',
    'finance',
    'Own the truth about money. Reconcile every payment against provider records, maintain the revenue and ' +
      'COGS ledgers, track ad spend, and compute contribution margin per order and per cohort. When the ' +
      'numbers say the business is losing money on every sale, say it immediately and loudly.',
    [
      'payment reconciliation report with unmatched items listed',
      'revenue and COGS ledger',
      'contribution margin by product, channel and cohort',
      'ad-spend tracking against budget',
      'refund and fraud monitoring',
      'forward projection with stated assumptions',
    ],
    ['payments.configure'],
    ['payments.webhooks'],
    [
      'finance.reconcile_payments',
      'finance.get_ledger',
      'finance.compute_contribution',
      'finance.get_budget_status',
      'finance.forecast',
      'finance.flag_anomaly',
    ],
    null,
  ),
  manager(
    'engineering_manager',
    'Engineering & Reliability Manager',
    'engineering',
    'Keep the platform running and safe. Own deployments, health, incident response, secret hygiene and ' +
      'sandbox policy. Untrusted model-generated code runs in an isolated plane with credential ' +
      'substitution, never against production secrets.',
    [
      'healthy services with passing health checks',
      'incident timeline and remediation',
      'sandbox and egress policy enforcement',
      'dependency and secret hygiene report',
    ],
    ['infrastructure.provision'],
    ['platform.hosting', 'platform.deploy_control', 'platform.log_read', 'compute.isolated_execution'],
    [
      'infra.get_service_health',
      'infra.list_deployments',
      'infra.trigger_deploy',
      'infra.rollback',
      'infra.read_logs',
      'sandbox.create',
      'sandbox.exec',
      'workflows.start_task',
      'incident.open',
      'incident.resolve',
    ],
    100_00,
  ),
  manager(
    'qa_manager',
    'QA Manager',
    'qa',
    'You hold a veto. No storefront reaches production with a failing critical commerce flow. Run the ' +
      'autonomous QA gate, the contract tests and the payment-state tests, and block the release when they ' +
      'fail. A green homepage is not a passing gate.',
    [
      'QA gate result per release with the evidence attached',
      'defect reports routed to the responsible agent',
      'critical-flow coverage: home, product, cart, checkout, success, failure, support, policies',
      'release block or release approval',
    ],
    ['site.deploy_preview'],
    ['qa.autonomous_exploration', 'qa.release_gate'],
    [
      'qa.create_project',
      'qa.run_exploration',
      'qa.get_bugs',
      'qa.evaluate_gate',
      'qa.block_release',
      'qa.approve_release',
    ],
    50_00,
  ),
  manager(
    'legal_manager',
    'Legal & Compliance Manager',
    'legal',
    'You are not counsel and you never claim to be. You assemble the policy surface from the real business ' +
      'configuration, screen the product category for restrictions, check advertising claims against their ' +
      'substantiation, and escalate anything requiring actual legal judgement to a qualified human. Every ' +
      'document you produce carries its generation basis and its review status.',
    [
      'terms of sale, privacy, cookie, shipping, returns and SMS terms generated from real configuration',
      'restricted and prohibited product screening result',
      'advertising claim substantiation review',
      'data retention and privacy checks',
      'preliminary trademark and domain research with explicit non-clearance disclaimer',
      'escalation packets for a human professional',
    ],
    ['legal.publish_policy', 'expert.engage_paid'],
    ['expert.structured_review'],
    [
      'legal.generate_policy_document',
      'legal.screen_product_category',
      'legal.check_ad_claims',
      'legal.check_data_retention',
      'legal.research_trademark_preliminary',
      'legal.escalate_to_human',
      'expert.request_review',
    ],
    100_00,
  ),
];

/* -------------------------------------------------------------------------- */
/* Specialists                                                                 */
/* -------------------------------------------------------------------------- */

function specialist(
  key: string,
  title: string,
  reportsTo: string,
  func: OrgFunction,
  mandate: string,
  tools: readonly string[],
  authorities: readonly Authority[] = [],
  requiredCapabilities: readonly Capability[] = [],
): RoleDefinition {
  return {
    key,
    title,
    func,
    tier: 'specialist',
    reportsTo,
    mandate,
    deliverables: [],
    authorities,
    requiredCapabilities: ['llm.reasoning', ...requiredCapabilities],
    tools: ['org.report_to_manager', ...tools],
    spendCeilingMinorUsd: null,
    runBudgetSeconds: 600,
  };
}

const SPECIALISTS: readonly RoleDefinition[] = [
  // Research
  specialist('community_researcher', 'Community Researcher', 'research_manager', 'research',
    'Collect real discussions from public communities. Every item you return must carry a URL or external id and a retrieval timestamp, or it is not evidence.',
    ['research.search_communities', 'research.fetch_thread', 'research.record_evidence'], ['research.collect'], ['research.web_search']),
  specialist('review_miner', 'Product Review Miner', 'research_manager', 'research',
    'Mine product and competitor reviews for repeated failure modes, and record the exact review text where storage is permitted.',
    ['research.search_listings', 'research.fetch_reviews', 'research.record_evidence'], ['research.collect'], ['research.web_search']),
  specialist('search_researcher', 'Search & Trends Researcher', 'research_manager', 'research',
    'Gather search, trend and keyword signals that indicate real demand volume and commercial intent.',
    ['research.web_search', 'research.record_evidence'], ['research.collect'], ['research.web_search']),
  specialist('competitor_analyst', 'Competitor Analyst', 'research_manager', 'research',
    'Profile incumbents: price points, positioning, review complaints, and the specific weaknesses a new entrant can exploit.',
    ['research.web_search', 'research.browse', 'research.record_evidence'], ['research.collect'], ['research.browser_session']),
  specialist('pain_clusterer', 'Pain-Point Clusterer', 'research_manager', 'research',
    'Cluster evidence into distinct pain points. Count independent source domains, not raw items — echo chambers inflate weak signals.',
    ['research.cluster_pain_points', 'research.get_evidence']),
  specialist('evidence_verifier', 'Evidence Verifier', 'research_manager', 'research',
    'Re-fetch a sample of evidence and confirm the source still says what the summary claims. Flag anything unverifiable and lower its confidence.',
    ['research.get_evidence', 'research.refetch_source', 'research.update_confidence'], [], ['research.web_search']),
  specialist('market_sizer', 'Market-Sizing Estimator', 'research_manager', 'research',
    'Estimate addressable demand and category spend, stating every assumption separately from every observed figure.',
    ['research.web_search', 'opportunity.record_dimension']),

  // Sourcing
  specialist('supplier_finder', 'Supplier Finder', 'sourcing_manager', 'sourcing',
    'Find suppliers capable of producing the concept. Prefer provider APIs; use a recorded browser session only where the site permits it.',
    ['sourcing.search_suppliers', 'sourcing.record_supplier', 'research.browse'], [], ['sourcing.supplier_search']),
  specialist('private_label_verifier', 'Private-Label Capability Verifier', 'sourcing_manager', 'sourcing',
    'Confirm each supplier can actually apply our branding and packaging, and record the constraints (print method, minimums, artwork format).',
    ['sourcing.get_supplier', 'sourcing.update_supplier']),
  specialist('rfq_drafter', 'RFQ Drafter', 'sourcing_manager', 'sourcing',
    'Write a specific, answerable RFQ: quantities, materials, customisation, packaging, certifications, destination, incoterm and sample request.',
    ['sourcing.draft_rfq']),
  specialist('supplier_outreach', 'Supplier Outreach Agent', 'sourcing_manager', 'sourcing',
    'Send approved RFQs and track responses. You may only send after an approval exists; record the provider message id as proof of delivery.',
    ['sourcing.send_rfq', 'sourcing.check_responses'], ['supplier.contact'], ['sourcing.rfq_submit']),
  specialist('quote_parser', 'Quote Parser', 'sourcing_manager', 'sourcing',
    'Convert supplier replies into structured quotes. Never fill a field the supplier did not state; leave it null and say what is missing.',
    ['sourcing.parse_quote', 'sourcing.record_quote']),
  specialist('landed_cost_analyst', 'Landed-Cost Analyst', 'sourcing_manager', 'sourcing',
    'Build the landed-cost stack. Tag every component with its basis, and report the grounded ratio prominently.',
    ['sourcing.build_landed_cost', 'fulfilment.get_rate_quote', 'finance.compute_contribution']),
  specialist('sample_coordinator', 'Sample & QC Coordinator', 'sourcing_manager', 'sourcing',
    'Plan sample ordering and define the inspection criteria the sample must pass before any production commitment.',
    ['sourcing.request_sample', 'sourcing.record_inspection'], ['supplier.purchase_sample']),
  specialist('product_risk_reviewer', 'Product Risk Reviewer', 'sourcing_manager', 'sourcing',
    'Identify safety, regulatory, IP and shipping-restriction risk for the concept and category, and escalate anything above the risk ceiling.',
    ['legal.screen_product_category', 'opportunity.record_dimension']),

  // Brand
  specialist('naming_agent', 'Naming Agent', 'brand_manager', 'brand',
    'Generate distinctive, pronounceable names that fit the positioning and are unlikely to collide with an existing mark.',
    ['brand.generate_names']),
  specialist('trademark_domain_checker', 'Trademark & Domain Checker', 'brand_manager', 'brand',
    'Run preliminary domain and trademark searches. State clearly that this is not a clearance opinion and escalate ambiguous cases.',
    ['brand.check_domains', 'brand.research_trademark_preliminary'], [], ['domain.availability_check']),
  specialist('positioning_copywriter', 'Positioning & Copy Agent', 'brand_manager', 'brand',
    'Write positioning and page copy that names the customer pain in their own words and promises only what we can substantiate.',
    ['brand.draft_page_content', 'brand.update_identity']),
  specialist('identity_designer', 'Logo & Identity Generator', 'brand_manager', 'brand',
    'Produce logo and identity variants and a palette and type system that survive being shrunk to a favicon and printed on a box.',
    ['brand.generate_asset'], [], ['asset.image_generation']),
  specialist('packaging_designer', 'Packaging Concept Agent', 'brand_manager', 'brand',
    'Design packaging direction that the chosen supplier can actually produce within their stated print method and minimums.',
    ['brand.generate_asset', 'sourcing.get_supplier'], [], ['asset.image_generation']),
  specialist('product_page_writer', 'Product Page Content Agent', 'brand_manager', 'brand',
    'Write the product page: hero, benefits, objections, specs, FAQ, shipping and returns. Optimise for conversion, not for word count.',
    ['brand.draft_page_content']),
  specialist('creative_variant_generator', 'Creative Variant Generator', 'brand_manager', 'brand',
    'Generate distinct creative angles — not cosmetic rewrites. Each variant must test a different belief about why someone buys.',
    ['marketing.create_concept', 'brand.generate_asset']),

  // Commerce
  specialist('site_builder', 'Storefront Builder', 'commerce_manager', 'commerce',
    'Drive the site generator to build and iterate the storefront from the site spec, then export the code so it is independently deployable.',
    ['site.generate', 'site.iterate', 'site.export_code'], [], ['site.generate', 'site.iterate']),
  specialist('integration_engineer', 'Integration Engineer', 'commerce_manager', 'commerce',
    'Wire the storefront to the platform APIs: catalogue, cart, checkout creation, order confirmation and support contact.',
    ['site.iterate', 'commerce.configure_checkout']),
  specialist('checkout_engineer', 'Checkout Engineer', 'commerce_manager', 'commerce',
    'Configure the payment route correctly for the product kind and verify the session carries shipping collection, tax and metadata.',
    ['commerce.configure_checkout', 'commerce.create_product'], ['payments.configure'], ['payments.checkout.physical']),
  specialist('order_state_engineer', 'Order State Engineer', 'commerce_manager', 'commerce',
    'Ensure every webhook maps to a legal order transition, that duplicates are idempotent and that late events cannot move an order backwards.',
    ['commerce.get_order', 'commerce.replay_webhook', 'commerce.reconcile_order']),
  specialist('analytics_engineer', 'Analytics Engineer', 'commerce_manager', 'commerce',
    'Instrument the funnel end to end so click ids survive to the order row and attribution is first-party wherever possible.',
    ['site.iterate', 'marketing.configure_attribution']),
  specialist('deployment_agent', 'Deployment Agent', 'commerce_manager', 'commerce',
    'Deploy to preview, gate on QA, promote to production, and always know the exact deployment to roll back to.',
    ['site.deploy', 'site.rollback', 'infra.get_service_health'], ['site.deploy_preview', 'site.deploy_production'], ['platform.deploy_control']),

  // Growth
  specialist('ad_strategist', 'Ad Strategist', 'growth_manager', 'growth',
    'Turn the pain evidence into testable acquisition hypotheses with a named audience, a promise and a measurable objective.',
    ['marketing.create_concept', 'marketing.create_experiment']),
  specialist('meta_ads_operator', 'Meta Ads Operator', 'growth_manager', 'growth',
    'Operate Meta campaigns within budget and policy. Never exceed an approved budget and never launch unreviewed creative.',
    ['marketing.launch_arm', 'marketing.pause_arm', 'marketing.collect_metrics'], ['ads.create_campaign'], ['ads.campaign_manage']),
  specialist('google_ads_operator', 'Google Ads Operator', 'growth_manager', 'growth',
    'Operate Google campaigns within budget and policy, with the same constraints as Meta.',
    ['marketing.launch_arm', 'marketing.pause_arm', 'marketing.collect_metrics'], ['ads.create_campaign'], ['ads.campaign_manage']),
  specialist('experiment_agent', 'Creative Experiment Agent', 'growth_manager', 'growth',
    'Run the test properly: hold everything constant except the variable, wait for the minimum data, then decide with the statistics.',
    ['marketing.create_experiment', 'marketing.collect_metrics', 'marketing.decide_arms']),
  specialist('funnel_analyst', 'Funnel Analyst', 'growth_manager', 'growth',
    'Find where the money leaks — impression to click, click to landing, landing to cart, cart to paid — and name the single biggest fixable drop.',
    ['marketing.get_experiment_results', 'marketing.collect_metrics']),
  specialist('budget_allocator', 'Budget Allocator', 'growth_manager', 'growth',
    'Move budget toward the arms with positive contribution per purchase, inside the approved ceiling and never in one large jump.',
    ['marketing.scale_arm', 'marketing.pause_arm', 'finance.get_budget_status'], ['ads.increase_budget']),
  specialist('attribution_analyst', 'Attribution Analyst', 'growth_manager', 'growth',
    'Reconcile platform-reported conversions against payment-confirmed orders and report the gap rather than picking the flattering number.',
    ['marketing.collect_metrics', 'finance.reconcile_payments']),

  // Customer ops
  specialist('support_agent', 'Customer Support Agent', 'customer_ops_manager', 'customer_ops',
    'Answer customers from verified order and policy data only. If you do not know, say so and escalate.',
    ['support.get_order_context', 'support.send_reply', 'support.escalate'], ['messaging.send_customer'], ['messaging.sms']),
  specialist('order_status_agent', 'Order Status Agent', 'customer_ops_manager', 'customer_ops',
    'Report shipment status strictly from carrier and order records. Never estimate a delivery date the carrier has not given.',
    ['support.get_order_context', 'fulfilment.get_tracking', 'support.send_reply'], ['messaging.send_customer']),
  specialist('refund_triage_agent', 'Refund & Returns Triage Agent', 'customer_ops_manager', 'customer_ops',
    'Apply the published returns policy consistently. Refunds above your limit go to approval, not to your judgement.',
    ['support.get_order_context', 'support.issue_refund', 'support.escalate'], ['payments.refund']),
  specialist('feedback_collector', 'Product Feedback Collector', 'customer_ops_manager', 'customer_ops',
    'Turn support conversations into structured product and sourcing feedback, including defect rates by batch.',
    ['support.list_tickets', 'research.record_evidence']),
  specialist('escalation_agent', 'Escalation Agent', 'customer_ops_manager', 'customer_ops',
    'Package sensitive cases — legal threats, safety, injury, fraud, regulator or media — for a human with the full timeline attached.',
    ['support.escalate', 'governance.request_approval', 'legal.escalate_to_human']),

  // Finance
  specialist('reconciliation_agent', 'Payment Reconciliation Agent', 'finance_manager', 'finance',
    'Match every provider payment object to an order. Unmatched items are reported, never silently dropped.',
    ['finance.reconcile_payments', 'commerce.get_order']),
  specialist('revenue_ledger_agent', 'Revenue Ledger Agent', 'finance_manager', 'finance',
    'Maintain double-entry revenue, fee, refund and COGS entries so the ledger always balances.',
    ['finance.write_ledger_entry', 'finance.get_ledger']),
  specialist('cogs_estimator', 'COGS Estimator', 'finance_manager', 'finance',
    'Keep landed cost current as freight, duty and supplier prices move, and restate margin when they do.',
    ['sourcing.build_landed_cost', 'finance.compute_contribution']),
  specialist('ad_spend_tracker', 'Ad Spend Tracker', 'finance_manager', 'finance',
    'Track spend against budget in near real time and raise the alarm before a limit is breached, not after.',
    ['marketing.collect_metrics', 'finance.get_budget_status', 'finance.flag_anomaly']),
  specialist('margin_calculator', 'Contribution Margin Calculator', 'finance_manager', 'finance',
    'Compute contribution margin per order, product, channel and cohort, always separating grounded inputs from assumptions.',
    ['finance.compute_contribution', 'finance.get_ledger']),
  specialist('forecasting_agent', 'Forecasting Agent', 'finance_manager', 'finance',
    'Project cash, inventory and margin forward with explicit assumptions and a stated confidence interval.',
    ['finance.forecast', 'finance.get_ledger']),
  specialist('fraud_monitor', 'Fraud & Refund Monitor', 'finance_manager', 'finance',
    'Watch refund rate, dispute rate and risk scores for patterns, and flag anomalies before they become chargebacks.',
    ['finance.flag_anomaly', 'commerce.get_order']),

  // Engineering
  specialist('platform_engineer', 'Core Platform Engineer', 'engineering_manager', 'engineering',
    'Keep the control plane healthy: migrations applied, queues draining, workers alive, health checks honest.',
    ['infra.get_service_health', 'infra.read_logs', 'queue.get_stats']),
  specialist('integration_reliability_engineer', 'Integration Reliability Engineer', 'engineering_manager', 'engineering',
    'Watch provider error rates, breaker states and rate-limit headroom, and degrade gracefully rather than hammering a failing vendor.',
    ['infra.read_logs', 'provider.get_health', 'provider.reset_breaker']),
  specialist('security_engineer', 'Security Engineer', 'engineering_manager', 'engineering',
    'Enforce secret hygiene, least privilege and egress policy. Any secret found in a log or a generated site is an incident.',
    ['security.scan_secrets', 'compliance.scan_pii', 'compliance.guard_prompt', 'sandbox.set_egress_policy', 'incident.open']),
  specialist('devops_agent', 'DevOps Agent', 'engineering_manager', 'engineering',
    'Own deploys, environment configuration and rollback. Every production deploy must have a known-good predecessor.',
    ['infra.trigger_deploy', 'infra.rollback', 'infra.list_deployments', 'workflows.start_task'], ['infrastructure.provision'], ['platform.deploy_control', 'platform.workflows']),
  specialist('incident_responder', 'Incident Response Agent', 'engineering_manager', 'engineering',
    'Run incidents: detect, contain, communicate, resolve, and write the timeline while it is still accurate.',
    ['incident.open', 'incident.resolve', 'infra.read_logs', 'governance.engage_kill_switch']),
  specialist('sandbox_policy_agent', 'Sandbox Policy Agent', 'engineering_manager', 'engineering',
    'Decide which execution plane each workload belongs on and enforce credential isolation for anything model-generated.',
    ['sandbox.create', 'sandbox.exec', 'sandbox.set_egress_policy', 'sandbox.destroy'], ['infrastructure.provision'], ['compute.isolated_execution', 'compute.persistent_sandbox']),

  // QA
  specialist('replay_qa_operator', 'Autonomous QA Operator', 'qa_manager', 'qa',
    'Drive the autonomous QA agent against the deployed storefront and collect the bug reports with their reproductions.',
    ['qa.create_project', 'qa.run_exploration', 'qa.get_bugs'], ['site.deploy_preview'], ['qa.autonomous_exploration']),
  specialist('contract_test_agent', 'API Contract Test Agent', 'qa_manager', 'qa',
    'Assert that every provider response still matches the contract the adapter expects, and fail loudly when a vendor changes shape.',
    ['qa.run_contract_tests', 'provider.get_health']),
  specialist('e2e_agent', 'Browser E2E Agent', 'qa_manager', 'qa',
    'Walk the real purchase path in a real browser: home, product, cart, checkout, success and failure, plus mobile layout.',
    ['qa.run_e2e', 'research.browse'], [], ['research.browser_session']),
  specialist('payment_state_tester', 'Payment State Test Agent', 'qa_manager', 'qa',
    'Exercise the payment state machine including duplicate webhooks, out-of-order delivery and refund races.',
    ['qa.run_payment_tests', 'commerce.replay_webhook']),
  specialist('accessibility_checker', 'Accessibility Checker', 'qa_manager', 'qa',
    'Check contrast, focus order, labels, alt text and keyboard operability. Inaccessible checkout is lost revenue and legal exposure.',
    ['qa.run_accessibility']),
  specialist('security_smoke_tester', 'Security Smoke Test Agent', 'qa_manager', 'qa',
    'Probe for exposed secrets, missing security headers, open redirects and unauthenticated write endpoints on the storefront.',
    ['qa.run_security_smoke', 'security.scan_secrets']),
  specialist('data_integrity_checker', 'Data Integrity Checker', 'qa_manager', 'qa',
    'Verify invariants: order totals equal line sums, refunds never exceed captures, ledger balances, audit chain is unbroken.',
    ['qa.run_data_integrity', 'finance.get_ledger', 'audit.verify_chain']),

  // Legal
  specialist('policy_assembler', 'Policy Document Assembler', 'legal_manager', 'legal',
    'Generate the policy surface from the real business configuration — entity, jurisdiction, product, shipping, returns, data practices — never from boilerplate.',
    ['legal.generate_policy_document', 'company.get_state']),
  specialist('ad_claims_checker', 'Advertising Claims Checker', 'legal_manager', 'legal',
    'Check every objective claim in creative against its recorded substantiation and block anything unsupported.',
    ['legal.check_ad_claims', 'brand.get_identity']),
  specialist('category_compliance_researcher', 'Product Category Compliance Researcher', 'legal_manager', 'legal',
    'Research what the product category actually requires: certifications, labelling, warnings, age limits, import restrictions.',
    ['legal.screen_product_category', 'research.web_search'], [], ['research.web_search']),
  specialist('privacy_checker', 'Data Retention & Privacy Checker', 'legal_manager', 'legal',
    'Verify what personal data we hold, why, for how long, and that the privacy policy matches the actual system behaviour.',
    ['legal.check_data_retention', 'company.get_state', 'compliance.scan_pii', 'compliance.guard_prompt']),
  specialist('shipping_restrictions_checker', 'Shipping & Restricted Goods Checker', 'legal_manager', 'legal',
    'Screen the product against carrier and destination restrictions, hazardous-goods rules and import prohibitions.',
    ['legal.screen_product_category', 'fulfilment.get_rate_quote']),
  specialist('trademark_researcher', 'Preliminary Trademark Researcher', 'legal_manager', 'legal',
    'Search registries for conflicting marks and report findings as preliminary research requiring counsel review, never as clearance.',
    ['legal.research_trademark_preliminary'], [], ['research.web_search']),
  specialist('legal_escalation_agent', 'Legal Escalation Agent', 'legal_manager', 'legal',
    'Package matters needing real legal judgement for a qualified human, with the facts, the question and the deadline.',
    ['legal.escalate_to_human', 'expert.request_review', 'governance.request_approval']),
];

/* -------------------------------------------------------------------------- */
/* Registry                                                                    */
/* -------------------------------------------------------------------------- */

export const ORG_CHART: readonly RoleDefinition[] = [CEO, ...MANAGERS, ...SPECIALISTS];

const BY_KEY = new Map(ORG_CHART.map((r) => [r.key, r]));

export function roleByKey(key: string): RoleDefinition | undefined {
  return BY_KEY.get(key);
}

export function directReports(key: string): readonly RoleDefinition[] {
  return ORG_CHART.filter((r) => r.reportsTo === key);
}

export function managers(): readonly RoleDefinition[] {
  return ORG_CHART.filter((r) => r.tier === 'manager');
}

export function specialistsOf(managerKey: string): readonly RoleDefinition[] {
  return ORG_CHART.filter((r) => r.reportsTo === managerKey && r.tier === 'specialist');
}

/** Every distinct tool name referenced by the org chart. */
export function allReferencedTools(): readonly string[] {
  return [...new Set(ORG_CHART.flatMap((r) => r.tools))].sort();
}

/** Validates the chart is well-formed. Run at boot; a broken chart is fatal. */
export function validateOrgChart(): readonly string[] {
  const problems: string[] = [];
  const keys = new Set<string>();
  for (const role of ORG_CHART) {
    if (keys.has(role.key)) problems.push(`duplicate role key "${role.key}"`);
    keys.add(role.key);
  }
  for (const role of ORG_CHART) {
    if (role.reportsTo !== null && !keys.has(role.reportsTo)) {
      problems.push(`role "${role.key}" reports to unknown role "${role.reportsTo}"`);
    }
    if (role.tier === 'executive' && role.reportsTo !== null) {
      problems.push(`executive role "${role.key}" must not report to anyone`);
    }
    if (role.tier !== 'executive' && role.reportsTo === null) {
      problems.push(`role "${role.key}" has no manager`);
    }
  }
  const ceos = ORG_CHART.filter((r) => r.tier === 'executive');
  if (ceos.length !== 1) problems.push(`expected exactly one executive role, found ${ceos.length}`);
  return problems;
}

/* -------------------------------------------------------------------------- */
/* Runtime records                                                             */
/* -------------------------------------------------------------------------- */

export const AgentRunStatus = z.enum([
  'queued',
  'running',
  'awaiting_tool',
  'awaiting_approval',
  'awaiting_human',
  'succeeded',
  'failed',
  'cancelled',
  'timed_out',
]);
export type AgentRunStatus = z.infer<typeof AgentRunStatus>;

export const AgentRun = z.object({
  id: z.string().min(1),
  companyId: z.string().min(1),
  roleKey: z.string().min(1),
  /** Run that dispatched this one, forming the delegation tree. */
  parentRunId: z.string().nullable(),
  objective: z.string().min(1),
  inputRefs: z.record(z.string(), z.unknown()).default({}),
  status: AgentRunStatus,
  model: z.string().min(1),
  /** Structured result the caller can act on, not a chat transcript. */
  output: z.record(z.string(), z.unknown()).nullable(),
  error: z.string().nullable(),
  toolCallCount: z.number().int().nonnegative().default(0),
  inputTokens: z.number().int().nonnegative().default(0),
  outputTokens: z.number().int().nonnegative().default(0),
  costMinorUsd: z.number().int().nonnegative().default(0),
  /** BAND room this run coordinates in, when coordination is active. */
  coordinationRoomId: z.string().nullable().default(null),
  /** Sandbox backing this run, when it needs persistent workspace. */
  sandboxId: z.string().nullable().default(null),
  startedAt: z.string().datetime().nullable(),
  finishedAt: z.string().datetime().nullable(),
  deadlineAt: z.string().datetime(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type AgentRun = z.infer<typeof AgentRun>;

export const AgentMessage = z.object({
  id: z.string().min(1),
  runId: z.string().min(1),
  sequence: z.number().int().nonnegative(),
  role: z.enum(['system', 'user', 'assistant', 'tool_result']),
  /** Serialised content blocks. Stored so a run is fully replayable. */
  content: z.unknown(),
  toolName: z.string().nullable(),
  toolUseId: z.string().nullable(),
  isError: z.boolean().default(false),
  createdAt: z.string().datetime(),
});
export type AgentMessage = z.infer<typeof AgentMessage>;
