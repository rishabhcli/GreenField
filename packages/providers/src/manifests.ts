/**
 * Provider manifests — the machine-readable integration record.
 *
 * Every field here was taken from the provider's own documentation on the date
 * recorded in `docs[].verifiedOn`. `capabilities[].evidence` is the honesty
 * mechanism: `documented_api` means we found the endpoint, `documented_mcp_tool`
 * means we found the tool, `marketing_claim_only` means the vendor advertises it
 * but published no usable reference, and `explicitly_unsupported` means we
 * checked and the answer is no. The capability registry refuses to report a
 * `marketing_claim_only` capability as working, and `INTEGRATIONS.md` is
 * generated from this file so the docs can never drift from the code.
 */

import {
  prefixMode,
  type ProviderManifest,
  type SecretSpec,
} from '@foundry/core';

const VERIFIED = '2026-08-14';

/* -------------------------------------------------------------------------- */
/* Secret specs                                                                */
/* -------------------------------------------------------------------------- */

export const SECRETS = {
  stripeSecretKey: {
    env: 'STRIPE_SECRET_KEY',
    description: 'Stripe secret API key (sk_test_… or sk_live_…, or a restricted rk_… key)',
    required: true,
    obtainFrom: 'https://dashboard.stripe.com/apikeys',
    pattern: /^(sk|rk)_(test|live)_[A-Za-z0-9]{16,}$/,
    detectMode: prefixMode(['sk_test_', 'rk_test_'], ['sk_live_', 'rk_live_']),
  },
  stripeWebhookSecret: {
    env: 'STRIPE_WEBHOOK_SECRET',
    description: 'Stripe webhook endpoint signing secret (whsec_…)',
    required: true,
    obtainFrom: 'https://dashboard.stripe.com/webhooks — create an endpoint for /webhooks/stripe',
    pattern: /^whsec_[A-Za-z0-9+/=_-]{16,}$/,
  },
  stripePublishableKey: {
    env: 'STRIPE_PUBLISHABLE_KEY',
    description: 'Stripe publishable key, safe to embed in the storefront',
    required: false,
    obtainFrom: 'https://dashboard.stripe.com/apikeys',
    pattern: /^pk_(test|live)_[A-Za-z0-9]{16,}$/,
    detectMode: prefixMode(['pk_test_'], ['pk_live_']),
    publicSafe: true,
  },

  teracApiKey: {
    env: 'TERAC_API_KEY',
    description: 'Terac external API key for the expert marketplace',
    required: true,
    obtainFrom: 'Terac dashboard → organization settings → API keys',
  },
  teracWebhookSecret: {
    env: 'TERAC_WEBHOOK_SECRET',
    description: 'Signing secret for the Terac webhook subscription',
    required: false,
    obtainFrom: 'POST /hooks/subscriptions then read it via getWebhookSubscriptionSecret',
  },
  teracProjectId: {
    env: 'TERAC_PROJECT_ID',
    description: 'Terac project id that expert opportunities are created under',
    required: false,
    obtainFrom: 'GET /projects, or create one in the Terac dashboard',
  },

  lovableOauthToken: {
    env: 'LOVABLE_OAUTH_ACCESS_TOKEN',
    description:
      'OAuth 2.1 access token for the Lovable MCP server. Lovable issues no API keys; this token must be ' +
      'produced by an operator completing the browser OAuth flow, because the MCP server restricts ' +
      'connections to an allowlist of first-party chat clients',
    required: true,
    obtainFrom:
      'Connect https://mcp.lovable.dev from an allowlisted client (Claude Code: /mcp) and export the ' +
      'resulting access token, or run the documented OAuth 2.1 flow with client id 6d465f583e1e4ce5801b1616f735670c',
  },
  lovableWebhookSecret: {
    env: 'LOVABLE_WEBHOOK_SECRET',
    description: 'Secret used to verify x-lovable-signature on inbound Lovable webhooks',
    required: false,
    obtainFrom: 'Lovable dashboard (exact location unconfirmed — see INTEGRATIONS.md caveat)',
  },

  whopApiKey: {
    env: 'WHOP_API_KEY',
    description: 'Whop account or app API key (server-side only)',
    required: true,
    obtainFrom: 'https://whop.com/dashboard/developer (sandbox: https://sandbox.whop.com/dashboard/developer)',
  },
  whopCompanyId: {
    env: 'WHOP_COMPANY_ID',
    description: 'Whop business id (biz_…) that products and payments belong to',
    required: true,
    obtainFrom: 'GET /accounts/me returns the biz_-prefixed id',
    pattern: /^biz_[A-Za-z0-9]+$/,
  },
  whopWebhookSecret: {
    env: 'WHOP_WEBHOOK_SECRET',
    description: 'Whop webhook signing secret (Standard Webhooks)',
    required: false,
    obtainFrom: 'Returned as webhook_secret from POST /webhooks',
  },

  renderApiKey: {
    env: 'RENDER_API_KEY',
    description: 'Render REST API key for deploys, env vars, logs and rollback',
    required: true,
    obtainFrom: 'https://dashboard.render.com/u/settings#api-keys',
  },
  renderOwnerId: {
    env: 'RENDER_OWNER_ID',
    description: 'Render workspace/owner id that services are created under',
    required: false,
    obtainFrom: 'GET https://api.render.com/v1/owners',
  },
  renderStorefrontServiceId: {
    env: 'RENDER_STOREFRONT_SERVICE_ID',
    description: 'Render service id hosting the generated storefront',
    required: false,
    obtainFrom: 'GET https://api.render.com/v1/services',
  },

  linqApiKey: {
    env: 'LINQ_API_V3_API_KEY',
    description: 'Linq V3 bearer token for iMessage/RCS/SMS/Voice',
    required: true,
    obtainFrom: 'https://dashboard.linqapp.com → API → Overview → Generate new token',
  },
  linqWebhookSecret: {
    env: 'LINQ_WEBHOOK_SECRET',
    description: 'whsec_ secret returned when creating the Linq webhook subscription',
    required: false,
    obtainFrom: 'POST /v3/webhook-subscriptions returns the signing secret',
  },
  linqFromNumber: {
    env: 'LINQ_FROM_NUMBER',
    description: 'E.164 number provisioned for this business by a Linq representative',
    required: false,
    obtainFrom: 'Linq provisions numbers manually; GET /v3/phone_numbers lists what is assigned',
  },

  superserveApiKey: {
    env: 'SUPERSERVE_API_KEY',
    description: 'Superserve control-plane API key (ss_live_…)',
    required: true,
    obtainFrom: 'https://superserve.ai → dashboard → API keys',
    pattern: /^ss_(live|test)_[A-Za-z0-9]+$/,
    detectMode: prefixMode(['ss_test_'], ['ss_live_']),
  },

  replayApiKey: {
    env: 'REPLAY_API_KEY',
    description: 'Replay QA API key (lqa_…)',
    required: true,
    obtainFrom: 'Replay app → team Settings → API Keys → Add',
    pattern: /^lqa_[A-Za-z0-9]+$/,
  },
  replayProjectId: {
    env: 'REPLAY_PROJECT_ID',
    description: 'Replay QA project id for the storefront under test',
    required: false,
    obtainFrom: 'Created by POST /api/v1/projects on first run',
  },

  bandAgentApiKey: {
    env: 'BAND_AGENT_API_KEY',
    description: 'BAND agent API key (thnv_a_…) used by agents to post and read messages',
    required: true,
    obtainFrom: 'https://app.band.ai → Agents → New Agent → External Agent',
    pattern: /^thnv_a_[A-Za-z0-9]+$/,
  },
  bandUserApiKey: {
    env: 'BAND_USER_API_KEY',
    description: 'BAND human API key (thnv_u_…) for registering agents and human participation',
    required: false,
    obtainFrom: 'https://app.band.ai → profile → API keys',
    pattern: /^thnv_u_[A-Za-z0-9]+$/,
  },

  dodoApiKey: {
    env: 'DODO_API_KEY',
    description: 'Dodo Payments API key (mode-scoped: test or live)',
    required: true,
    obtainFrom: 'Dodo dashboard → Developer → API Keys',
  },
  dodoWebhookSecret: {
    env: 'DODO_WEBHOOK_SECRET',
    description: 'Dodo webhook signing secret (Standard Webhooks)',
    required: false,
    obtainFrom: 'Dodo dashboard → Developer → Webhooks → endpoint → Overview',
  },

  sandbox0Token: {
    env: 'SANDBOX0_TOKEN',
    description: 'Sandbox0 team-scoped API token',
    required: true,
    obtainFrom: 's0 apikey create --name foundry --role developer --raw',
  },
  sandbox0WebhookSecret: {
    env: 'SANDBOX0_WEBHOOK_SECRET',
    description: 'HMAC secret configured on the sandbox at creation time',
    required: false,
    obtainFrom: 'Chosen by us and passed as `webhook.secret` when creating a sandbox',
  },

  solariApiKey: {
    env: 'SOLARI_API_KEY',
    description: 'Solari API key (slr_live_<id>_<secret>)',
    required: true,
    obtainFrom: 'https://console.getsolari.com → API keys',
    pattern: /^slr_(live|test)_[A-Za-z0-9_-]+$/,
    detectMode: prefixMode(['slr_test_'], ['slr_live_']),
  },

  anthropicApiKey: {
    env: 'ANTHROPIC_API_KEY',
    description: 'Anthropic API key powering the CEO, manager and specialist agents',
    required: true,
    obtainFrom: 'https://console.anthropic.com/settings/keys',
    pattern: /^sk-ant-[A-Za-z0-9_-]{20,}$/,
  },

  metaAdsAccessToken: {
    env: 'META_ADS_ACCESS_TOKEN',
    description: 'Meta Marketing API long-lived system-user access token',
    required: true,
    obtainFrom: 'https://business.facebook.com → System Users → Generate token (ads_management scope)',
  },
  metaAdsAccountId: {
    env: 'META_ADS_ACCOUNT_ID',
    description: 'Meta ad account id (act_…)',
    required: true,
    obtainFrom: 'Meta Ads Manager → account overview',
  },

  googleAdsDeveloperToken: {
    env: 'GOOGLE_ADS_DEVELOPER_TOKEN',
    description: 'Google Ads API developer token',
    required: true,
    obtainFrom: 'https://ads.google.com → Tools → API Center (requires approval)',
  },
  googleAdsRefreshToken: {
    env: 'GOOGLE_ADS_REFRESH_TOKEN',
    description: 'OAuth refresh token for the Google Ads account',
    required: true,
    obtainFrom: 'Google OAuth 2.0 consent flow with the adwords scope',
  },
  googleAdsClientId: {
    env: 'GOOGLE_ADS_CLIENT_ID',
    description: 'Google OAuth client id',
    required: true,
    obtainFrom: 'https://console.cloud.google.com → APIs & Services → Credentials',
  },
  googleAdsClientSecret: {
    env: 'GOOGLE_ADS_CLIENT_SECRET',
    description: 'Google OAuth client secret',
    required: true,
    obtainFrom: 'https://console.cloud.google.com → APIs & Services → Credentials',
  },
  googleAdsCustomerId: {
    env: 'GOOGLE_ADS_CUSTOMER_ID',
    description: 'Google Ads customer id, digits only',
    required: true,
    obtainFrom: 'Google Ads UI, top-right account selector',
  },

  resendApiKey: {
    env: 'RESEND_API_KEY',
    description: 'Transactional email API key',
    required: true,
    obtainFrom: 'https://resend.com/api-keys',
    pattern: /^re_[A-Za-z0-9_-]+$/,
  },
  cloudflareApiToken: {
    env: 'CLOUDFLARE_API_TOKEN',
    description: 'Cloudflare API token with DNS edit and domain-registrar read scope',
    required: true,
    obtainFrom: 'https://dash.cloudflare.com/profile/api-tokens',
  },
  cloudflareAccountId: {
    env: 'CLOUDFLARE_ACCOUNT_ID',
    description: 'Cloudflare account id used for registrar and DNS calls',
    required: true,
    obtainFrom: 'Cloudflare dashboard → account home → right sidebar',
  },
  shippoApiToken: {
    env: 'SHIPPO_API_TOKEN',
    description: 'Shippo API token for carrier rate quotes, labels and tracking',
    required: true,
    obtainFrom: 'https://apps.goshippo.com/settings/api',
    detectMode: prefixMode(['shippo_test_'], ['shippo_live_']),
  },
  alibabaAppKey: {
    env: 'ALIBABA_APP_KEY',
    description: 'Alibaba.com Open Platform app key for supplier and product search',
    required: true,
    obtainFrom: 'https://openapi.alibaba.com → create an app (approval required)',
  },
  alibabaAppSecret: {
    env: 'ALIBABA_APP_SECRET',
    description: 'Alibaba.com Open Platform app secret',
    required: true,
    obtainFrom: 'https://openapi.alibaba.com → app credentials',
  },
  openaiImagesApiKey: {
    env: 'OPENAI_API_KEY',
    description: 'API key for image generation used in logo, packaging and ad creative',
    required: true,
    obtainFrom: 'https://platform.openai.com/api-keys',
  },
} as const satisfies Record<string, SecretSpec>;

/* -------------------------------------------------------------------------- */
/* Manifests                                                                   */
/* -------------------------------------------------------------------------- */

export const TERAC_MANIFEST: ProviderManifest = {
  id: 'terac',
  displayName: 'Terac',
  tier: 'sponsor',
  summary:
    'Expert marketplace that sources, verifies, hires and pays human experts on demand. Used for the ' +
    'human-judgement layer: opportunity validation, evidence quality review, ad and brand creative review, ' +
    'category compliance opinions and supplier-quote sanity checks.',
  docs: [
    { url: 'https://terac.com/docs/developers/reference', verifiedOn: VERIFIED, note: 'endpoint index' },
    { url: 'https://terac.com/docs/developers/guides/authentication', verifiedOn: VERIFIED },
    { url: 'https://terac.com/docs/developers/guides/webhooks', verifiedOn: VERIFIED },
    { url: 'https://terac.com/docs/developers/guides/errors', verifiedOn: VERIFIED },
    { url: 'https://terac.com/mcp', verifiedOn: VERIFIED, note: 'MCP tool names' },
  ],
  authMethod: 'bearer_token',
  secrets: [SECRETS.teracApiKey, SECRETS.teracWebhookSecret, SECRETS.teracProjectId],
  baseUrls: { production: 'https://terac.com/api/external/v2' },
  capabilities: [
    {
      capability: 'expert.source_and_hire',
      priority: 1,
      evidence: { kind: 'documented_api', detail: 'POST /opportunities creates a paid expert engagement' },
    },
    {
      capability: 'expert.structured_review',
      priority: 1,
      evidence: {
        kind: 'documented_api',
        detail: 'GET /opportunities/{id}/submissions returns expert submissions with attestations',
      },
    },
    {
      capability: 'expert.payment',
      priority: 1,
      evidence: {
        kind: 'documented_api',
        detail: 'Pay-per-verified-completion billing is handled by Terac; submissions that fail review do not bill',
      },
    },
  ],
  webhooks: [
    {
      path: '/webhooks/terac',
      signatureHeader: 'X-Terac-Request-Signature',
      signatureScheme: 'hmac_sha256_hex',
      events: ['submission.status.change', 'submission.approved'],
      requiresRawBody: true,
    },
  ],
  rateLimit: { requestsPerWindow: 100, windowMs: 60_000, note: 'documented: 100 requests/minute per API key' },
  liveProbe: {
    description: 'GET /projects?limit=1 — read-only listing that proves the key is accepted',
    mutatesState: false,
  },
  failureBehaviour:
    'Errors use {error:{code,message,details}}. 429 RATE_LIMITED is retried with backoff; 401 and 409 are ' +
    'terminal. The API is self-labelled v2 beta, so response-shape drift is treated as a contract error and ' +
    'surfaced rather than coerced.',
  retryStrategy: 'Exponential backoff on 429/5xx only, max 5 attempts. Never retry a POST /opportunities without a dedupe check, because it commits spend.',
  idempotency:
    'Terac documents no Idempotency-Key header. The platform keys every engagement creation on a local ' +
    'idempotency ledger entry so a retried job cannot buy the same expert panel twice.',
};

export const STRIPE_MANIFEST: ProviderManifest = {
  id: 'stripe',
  displayName: 'Stripe',
  tier: 'sponsor',
  summary:
    'Payment infrastructure for physical-goods commerce where the operating company is the merchant of ' +
    'record. Checkout Sessions, webhooks as the authoritative money state, refunds, disputes and Radar.',
  docs: [
    { url: 'https://docs.stripe.com/api/versioning', verifiedOn: VERIFIED, note: 'current API version 2026-07-29.dahlia' },
    { url: 'https://docs.stripe.com/api/checkout/sessions/create', verifiedOn: VERIFIED },
    { url: 'https://docs.stripe.com/webhooks', verifiedOn: VERIFIED },
    { url: 'https://docs.stripe.com/api/refunds', verifiedOn: VERIFIED },
    { url: 'https://docs.stripe.com/api/disputes', verifiedOn: VERIFIED },
    { url: 'https://docs.stripe.com/keys', verifiedOn: VERIFIED },
  ],
  authMethod: 'bearer_token',
  secrets: [SECRETS.stripeSecretKey, SECRETS.stripeWebhookSecret, SECRETS.stripePublishableKey],
  baseUrls: { production: 'https://api.stripe.com', test: 'https://api.stripe.com' },
  capabilities: [
    {
      capability: 'payments.checkout.physical',
      priority: 1,
      evidence: {
        kind: 'documented_api',
        detail: 'POST /v1/checkout/sessions with shipping_address_collection and shipping_options (payment mode)',
      },
    },
    { capability: 'payments.webhooks', priority: 1, evidence: { kind: 'documented_api', detail: 'Stripe-Signature v1 HMAC-SHA256, 5 minute tolerance' } },
    { capability: 'payments.refund', priority: 1, evidence: { kind: 'documented_api', detail: 'POST /v1/refunds' } },
    { capability: 'payments.dispute', priority: 1, evidence: { kind: 'documented_api', detail: 'GET/POST /v1/disputes, POST /v1/disputes/{id}/close' } },
    {
      capability: 'payments.tax_calculation',
      priority: 1,
      evidence: {
        kind: 'documented_api',
        detail: 'automatic_tax.enabled on Checkout Sessions; requires an active registration and per-line tax_code',
      },
    },
    { capability: 'commerce.catalog', priority: 2, evidence: { kind: 'documented_api', detail: 'Products and Prices API' } },
  ],
  webhooks: [
    {
      path: '/webhooks/stripe',
      signatureHeader: 'Stripe-Signature',
      signatureScheme: 'stripe_v1_hmac_sha256',
      events: [
        'checkout.session.completed',
        'checkout.session.async_payment_succeeded',
        'checkout.session.async_payment_failed',
        'checkout.session.expired',
        'payment_intent.succeeded',
        'payment_intent.payment_failed',
        'payment_intent.processing',
        'payment_intent.canceled',
        // 3DS or similar pending customer action. Subscribed so the order shows
        // PAYMENT_PENDING rather than sitting in CHECKOUT_STARTED indefinitely.
        'payment_intent.requires_action',
        'charge.succeeded',
        'charge.failed',
        'charge.refunded',
        'charge.updated',
        'refund.created',
        'refund.updated',
        'refund.failed',
        'charge.dispute.created',
        'charge.dispute.updated',
        'charge.dispute.closed',
        'charge.dispute.funds_withdrawn',
        'charge.dispute.funds_reinstated',
        'radar.early_fraud_warning.created',
        'review.opened',
        'review.closed',
      ],
      requiresRawBody: true,
    },
  ],
  liveProbe: {
    description: 'GET /v1/balance — read-only, confirms the key is valid and reports which mode it is in',
    mutatesState: false,
  },
  failureBehaviour:
    'card_error and invalid_request_error are terminal; api_error and 5xx are retried. A signature failure ' +
    'returns 400 and the event is not processed — never trusted on redirect alone.',
  retryStrategy: 'Payment retry policy: 3 attempts, 25s deadline, always with an Idempotency-Key.',
  idempotency: 'Header Idempotency-Key on every POST, derived deterministically from our own operation id so a retry replays rather than duplicates.',
};

export const LOVABLE_MANIFEST: ProviderManifest = {
  id: 'lovable',
  displayName: 'Lovable',
  tier: 'sponsor',
  summary:
    'AI full-stack development platform used to generate and iterate storefronts programmatically through ' +
    'its MCP server, then export real code that we deploy and test ourselves.',
  docs: [
    { url: 'https://docs.lovable.dev/integrations/lovable-mcp-server', verifiedOn: VERIFIED },
    { url: 'https://github.com/lovablelabs/mcp', verifiedOn: VERIFIED, note: 'OAuth 2.1 + RFC 9728' },
    { url: 'https://docs.lovable.dev/integrations/github', verifiedOn: VERIFIED, note: 'code export via GitHub sync' },
    { url: 'https://docs.lovable.dev/integrations/lovable-api', verifiedOn: VERIFIED, note: 'confirms no REST API today' },
  ],
  authMethod: 'mcp_oauth',
  secrets: [SECRETS.lovableOauthToken, SECRETS.lovableWebhookSecret],
  baseUrls: { production: 'https://mcp.lovable.dev' },
  capabilities: [
    { capability: 'site.generate', priority: 1, evidence: { kind: 'documented_mcp_tool', detail: 'create_project' } },
    { capability: 'site.iterate', priority: 1, evidence: { kind: 'documented_mcp_tool', detail: 'send_message, get_message, list_messages' } },
    { capability: 'site.export_code', priority: 1, evidence: { kind: 'documented_mcp_tool', detail: 'list_files, read_file, get_diff, plus GitHub sync' } },
    { capability: 'site.publish_preview', priority: 2, evidence: { kind: 'documented_mcp_tool', detail: 'deploy_project returns a live URL' } },
  ],
  webhooks: [
    {
      path: '/webhooks/lovable',
      signatureHeader: 'x-lovable-signature',
      signatureScheme: 'hmac_sha256_hex',
      events: [],
      requiresRawBody: true,
    },
  ],
  vendorApproval: {
    required: true,
    how:
      'The Lovable MCP server authenticates with OAuth 2.1 only — it issues no API keys — and restricts ' +
      'connections to an allowlist of first-party clients (ChatGPT, Claude Desktop, claude.ai, Claude Code, ' +
      'Cursor, VS Code). A headless worker is not on that allowlist. An operator must complete the browser ' +
      'OAuth flow from an allowlisted client and place the resulting access token in LOVABLE_OAUTH_ACCESS_TOKEN. ' +
      'Until then this capability is blocked, not broken.',
  },
  liveProbe: { description: 'MCP tools/call get_me — read-only identity check', mutatesState: false },
  failureBehaviour:
    'MCP transport errors are retried; an expired OAuth token surfaces as an auth error that requires operator ' +
    're-authorisation rather than an automatic retry loop.',
  retryStrategy: 'Long-running policy (6 attempts, up to 120s spacing) because site generation is slow and bursty.',
  idempotency:
    'No idempotency mechanism is documented. Project creation is keyed on a local idempotency ledger entry so ' +
    'a retried build job reuses the existing project instead of creating a second one.',
};

export const WHOP_MANIFEST: ProviderManifest = {
  id: 'whop',
  displayName: 'Whop',
  tier: 'sponsor',
  summary:
    'Business and commerce API used for digital/membership commerce primitives: catalogue, plans, ' +
    'memberships, payments and webhooks. Physical private-label sourcing and fulfilment are never attributed ' +
    'to Whop.',
  docs: [
    { url: 'https://docs.whop.com/developer/api/getting-started', verifiedOn: VERIFIED },
    { url: 'https://docs.whop.com/developer/guides/authentication', verifiedOn: VERIFIED },
    { url: 'https://docs.whop.com/developer/guides/webhooks', verifiedOn: VERIFIED },
    { url: 'https://docs.whop.com/developer/api/idempotency', verifiedOn: VERIFIED },
    { url: 'https://docs.whop.com/developer/guides/sandbox', verifiedOn: VERIFIED },
  ],
  authMethod: 'bearer_token',
  secrets: [SECRETS.whopApiKey, SECRETS.whopCompanyId, SECRETS.whopWebhookSecret],
  baseUrls: { production: 'https://api.whop.com/api/v1', test: 'https://sandbox-api.whop.com/api/v1' },
  capabilities: [
    { capability: 'commerce.catalog', priority: 1, evidence: { kind: 'documented_api', detail: 'POST /products, plans API' } },
    { capability: 'commerce.membership', priority: 1, evidence: { kind: 'documented_api', detail: 'GET /memberships with status filters' } },
    {
      capability: 'payments.checkout.digital_mor',
      priority: 2,
      evidence: { kind: 'documented_api', detail: 'checkout embed + payments API; Whop is the platform of record for its own checkout' },
    },
    { capability: 'payments.webhooks', priority: 3, evidence: { kind: 'documented_api', detail: 'Standard Webhooks over payment/membership/dispute events' } },
    {
      capability: 'payments.checkout.physical',
      priority: 99,
      evidence: {
        kind: 'explicitly_unsupported',
        detail:
          'Whop is a digital/membership commerce platform. Attributing physical private-label sourcing, ' +
          'manufacturing or landed-cost quotation to it would be a false claim.',
      },
    },
  ],
  webhooks: [
    {
      path: '/webhooks/whop',
      signatureHeader: 'webhook-signature',
      signatureScheme: 'standard_webhooks',
      events: [
        'payment.created',
        'payment.succeeded',
        'payment.failed',
        'payment.pending',
        'refund.created',
        'refund.updated',
        'dispute.created',
        'dispute.updated',
        'membership.activated',
        'membership.deactivated',
        'membership.trial_ending_soon',
        'product.created',
        'product.updated',
        'plan.created',
        'plan.updated',
      ],
      requiresRawBody: true,
    },
  ],
  rateLimit: { requestsPerWindow: 600, windowMs: 60_000, note: 'documented: 600 req/min per operation per credential' },
  liveProbe: { description: 'GET /accounts/me — read-only identity check returning the biz_ id', mutatesState: false },
  failureBehaviour:
    '409 on a concurrent duplicate idempotency key is retried once after backoff; 400 with the same key and a ' +
    'different body is terminal and indicates a bug in our request construction.',
  retryStrategy: 'Standard policy with Idempotency-Key on all writes; 24h replay window on the provider side.',
  idempotency: 'Header Idempotency-Key; replays are marked with Idempotent-Replayed: true on the response.',
};

export const RENDER_MANIFEST: ProviderManifest = {
  id: 'render',
  displayName: 'Render',
  tier: 'sponsor',
  summary:
    'Production hosting for the control plane: web service, private services, background workers, cron jobs, ' +
    'managed Postgres and Key Value, health checks, zero-downtime deploys, logs and rollback.',
  docs: [
    { url: 'https://render.com/docs/blueprint-spec', verifiedOn: VERIFIED },
    { url: 'https://render.com/docs/health-checks', verifiedOn: VERIFIED },
    { url: 'https://render.com/docs/key-value', verifiedOn: VERIFIED },
    { url: 'https://api-docs.render.com/reference/authentication', verifiedOn: VERIFIED },
    { url: 'https://render.com/docs/node-version', verifiedOn: VERIFIED },
  ],
  authMethod: 'bearer_token',
  secrets: [SECRETS.renderApiKey, SECRETS.renderOwnerId, SECRETS.renderStorefrontServiceId],
  baseUrls: { production: 'https://api.render.com/v1' },
  capabilities: [
    { capability: 'platform.hosting', priority: 1, evidence: { kind: 'documented_api', detail: 'render.yaml blueprint: web, pserv, worker, cron, keyvalue, Postgres' } },
    { capability: 'platform.deploy_control', priority: 1, evidence: { kind: 'documented_api', detail: 'POST /services/{id}/deploys, rollback-deploy' } },
    { capability: 'platform.log_read', priority: 1, evidence: { kind: 'documented_api', detail: 'GET /logs, GET /events' } },
  ],
  rateLimit: { requestsPerWindow: 300, windowMs: 60_000, note: 'no published limit; conservative self-imposed ceiling' },
  liveProbe: { description: 'GET /v1/services?limit=1 — read-only listing', mutatesState: false },
  failureBehaviour:
    'Deploy failures surface as a deploy status of `build_failed` or `update_failed`; the deployment record ' +
    'retains the previous live deploy id so rollback is always a single call.',
  retryStrategy: 'Standard policy for read endpoints; deploy triggers are never blindly retried because a duplicate deploy wastes a build and can flap traffic.',
  idempotency: 'No idempotency header. Deploy triggers are guarded by a local lock keyed on service id plus commit sha.',
};

export const LINQ_MANIFEST: ProviderManifest = {
  id: 'linq',
  displayName: 'Linq',
  tier: 'sponsor',
  summary:
    'Communications API for iMessage, RCS, SMS and Voice. Gives each launched company a real customer-support ' +
    'messaging endpoint; inbound messages become tickets and agents reply through the same thread.',
  docs: [
    { url: 'https://docs.linqapp.com/getting-started/authentication/', verifiedOn: VERIFIED },
    { url: 'https://docs.linqapp.com/guides/webhooks/events/', verifiedOn: VERIFIED },
    { url: 'https://docs.linqapp.com/guides/phone-numbers/', verifiedOn: VERIFIED },
    { url: 'https://cdn.linqapp.com/openapi/linq-api-v3.yaml', verifiedOn: VERIFIED, note: 'OpenAPI spec; Calls section truncated on fetch' },
  ],
  authMethod: 'bearer_token',
  secrets: [SECRETS.linqApiKey, SECRETS.linqWebhookSecret, SECRETS.linqFromNumber],
  baseUrls: { production: 'https://api.linqapp.com/api/partner' },
  capabilities: [
    { capability: 'messaging.sms', priority: 1, evidence: { kind: 'documented_api', detail: 'POST /v3/messages with message.preferred_service' } },
    { capability: 'messaging.imessage', priority: 1, evidence: { kind: 'documented_api', detail: 'same endpoint; service is reported in from_selection' } },
    { capability: 'messaging.rcs', priority: 1, evidence: { kind: 'documented_api', detail: 'same endpoint; RCS is one of the preferred_service values' } },
    {
      capability: 'messaging.voice',
      priority: 1,
      evidence: {
        kind: 'documented_api',
        detail:
          'POST /v3/calls, /answer, /hangup exist under the OpenAPI "Calls" tag, but request/response schemas ' +
          'were not retrievable and no call.* payload example is published',
      },
    },
    { capability: 'messaging.inbound_webhook', priority: 1, evidence: { kind: 'documented_api', detail: 'POST /v3/webhook-subscriptions, Standard Webhooks signing' } },
  ],
  webhooks: [
    {
      path: '/webhooks/linq',
      signatureHeader: 'webhook-signature',
      signatureScheme: 'standard_webhooks',
      events: [
        'message.received',
        'message.sent',
        'message.delivered',
        'message.read',
        'message.failed',
        'reaction.added',
        'chat.created',
        'participant.added',
        'participant.removed',
        'phone_number.status_updated',
        'call.initiated',
        'call.ringing',
        'call.answered',
        'call.ended',
        'call.failed',
        'call.declined',
        'call.no_answer',
      ],
      requiresRawBody: true,
    },
  ],
  rateLimit: {
    requestsPerWindow: 30,
    windowMs: 60_000,
    note: 'documented burst: 30 messages/60s per sender-recipient pair; ~7,000 combined messages/line/day recommended',
  },
  vendorApproval: {
    required: true,
    how:
      'Production phone numbers are provisioned by a Linq representative — the V3 API has no self-serve number ' +
      'create endpoint. A sandbox token and test number are self-serve at dashboard.linqapp.com/sandbox-signup ' +
      '(capped at 100 messages/day). Messaging capability stays blocked until LINQ_FROM_NUMBER names a real ' +
      'assigned line returned by GET /v3/phone_numbers.',
  },
  liveProbe: { description: 'GET /v3/phone_numbers — read-only, also confirms which lines are assigned and healthy', mutatesState: false },
  failureBehaviour:
    'Error 2024 (HTTP 403) means the recipient opted out and is terminal — never retried and never overridden ' +
    'automatically. Error 1007 (HTTP 429) is a rate limit and is retried with backoff. message.delivered and ' +
    'message.read fire only on iMessage and RCS, so their absence on SMS is not treated as a failure.',
  retryStrategy: 'Standard policy on 429/5xx. Sends always carry an idempotency key so a retry cannot double-message a customer.',
  idempotency: 'message.idempotency_key body field and Idempotency-Key header are both documented; the adapter sends both because the canonical form is unconfirmed.',
};

export const SUPERSERVE_MANIFEST: ProviderManifest = {
  id: 'superserve',
  displayName: 'Superserve',
  tier: 'sponsor',
  summary:
    'Persistent Firecracker microVM sandboxes. Used for long-running manager and specialist agent workspaces ' +
    'whose jobs span hours or days, because pausing checkpoints memory and running processes, not just disk.',
  docs: [
    { url: 'https://docs.superserve.ai/api-reference/sandboxes/create-a-new-sandbox.md', verifiedOn: VERIFIED },
    { url: 'https://docs.superserve.ai/sandbox/lifecycle.md', verifiedOn: VERIFIED },
    { url: 'https://docs.superserve.ai/api-key.md', verifiedOn: VERIFIED },
    { url: 'https://raw.githubusercontent.com/superserve-ai/sandbox/refs/heads/main/api/openapi.yaml', verifiedOn: VERIFIED },
  ],
  authMethod: 'api_key_header',
  secrets: [SECRETS.superserveApiKey],
  baseUrls: { production: 'https://api.superserve.ai' },
  capabilities: [
    {
      capability: 'compute.persistent_sandbox',
      priority: 1,
      evidence: {
        kind: 'documented_api',
        detail: 'POST /sandboxes with timeout_seconds up to 7 days; pause checkpoints memory, processes and filesystem',
      },
    },
    { capability: 'compute.isolated_execution', priority: 2, evidence: { kind: 'documented_api', detail: 'POST /exec, /exec/stream, GET /exec/connect' } },
  ],
  rateLimit: { requestsPerWindow: 300, windowMs: 60_000, note: 'no published numeric limit; error codes rate_limited and too_many_sandboxes exist' },
  liveProbe: { description: 'GET /sandboxes?limit=1 — read-only listing scoped to the team', mutatesState: false },
  failureBehaviour:
    'too_many_sandboxes is terminal until sandboxes are paused (paused ones do not count against the quota); ' +
    'rate_limited is retried. The data-plane access token rotates on resume, so it is re-read after every resume.',
  retryStrategy: 'Long-running policy. The SDK retries only GET/DELETE automatically, so our client owns retry for the rest.',
  idempotency: 'No idempotency header. Sandbox creation is keyed on the agent run id via metadata so a retried job reattaches instead of creating a second VM.',
};

export const REPLAY_MANIFEST: ProviderManifest = {
  id: 'replay',
  displayName: 'Replay QA',
  tier: 'sponsor',
  summary:
    'Autonomous QA agent that explores a deployed web app, writes its own tests, records sessions and files ' +
    'root-caused bug reports. Wired as the release gate: no storefront reaches production without a completed ' +
    'exploration and a clean critical-flow result.',
  docs: [
    { url: 'https://docs.replay.io/basics/replay-qa/overview', verifiedOn: VERIFIED },
    { url: 'https://loop-qa.replay.io/api/v1/openapi.json', verifiedOn: VERIFIED, note: 'live OpenAPI spec' },
    { url: 'https://docs.replay.io/reference/ci-workflows/generate-api-key', verifiedOn: VERIFIED },
  ],
  authMethod: 'bearer_token',
  secrets: [SECRETS.replayApiKey, SECRETS.replayProjectId],
  baseUrls: { production: 'https://loop-qa.replay.io/api/v1' },
  capabilities: [
    {
      capability: 'qa.autonomous_exploration',
      priority: 1,
      evidence: { kind: 'documented_api', detail: 'POST /projects/{id}/explorations, GET /explorations/{id}' },
    },
    {
      capability: 'qa.release_gate',
      priority: 1,
      evidence: {
        kind: 'documented_api',
        detail:
          'GET /projects/{id}/bugs?status=open plus POST /projects/{id}/versions. Replay documents no built-in ' +
          'pass/fail CI check, so the gate decision is computed on our side from the open-bug list.',
      },
    },
  ],
  webhooks: [
    {
      path: '/webhooks/replay',
      signatureScheme: 'none',
      events: [],
      requiresRawBody: false,
    },
  ],
  liveProbe: { description: 'GET /api/v1/projects?page_size=1 — read-only listing', mutatesState: false },
  failureBehaviour:
    'The canonical API host differed between two documentation reads (loop-qa.replay.io vs qa.replay.io), so ' +
    'the adapter reads servers[].url from the live OpenAPI document at startup instead of trusting a constant. ' +
    'Webhook event names and signature scheme are undocumented, so polling is the authoritative path and the ' +
    'webhook is only an optimisation.',
  retryStrategy: 'Long-running policy; explorations are asynchronous and polled with backoff until terminal.',
  idempotency: 'No idempotency header. Project creation is keyed on the site id so re-running a build reuses the project.',
};

export const BAND_MANIFEST: ProviderManifest = {
  id: 'band',
  displayName: 'BAND',
  tier: 'sponsor',
  summary:
    'Interaction infrastructure for distributed agents. Provides the task-scoped rooms where the CEO, managers, ' +
    'specialists and invited humans coordinate, with contacts as the permission handshake and @mention as the ' +
    'routing primitive. Authoritative approval, spend authority and audit remain in our own policy service.',
  docs: [
    { url: 'https://docs.band.ai/api/agent-api/agent-api-identity.md', verifiedOn: VERIFIED },
    { url: 'https://docs.band.ai/api/agent-api/agent-api-messages.md', verifiedOn: VERIFIED },
    { url: 'https://docs.band.ai/api/agent-api/agent-api-chats.md', verifiedOn: VERIFIED },
    { url: 'https://docs.band.ai/websocket/overview.md', verifiedOn: VERIFIED },
    { url: 'https://docs.band.ai/core-concepts.md', verifiedOn: VERIFIED },
  ],
  authMethod: 'api_key_header',
  secrets: [SECRETS.bandAgentApiKey, SECRETS.bandUserApiKey],
  baseUrls: { production: 'https://app.band.ai/api/v1' },
  capabilities: [
    {
      capability: 'coordination.agent_mesh',
      priority: 1,
      evidence: {
        kind: 'documented_api',
        detail: 'POST /agent/chats, POST /agent/chats/{id}/messages with @mention routing, /agent/peers, /agent/contacts',
      },
    },
    {
      capability: 'coordination.governance',
      priority: 2,
      evidence: {
        kind: 'marketing_claim_only',
        detail:
          'The landing page describes an interaction control plane for "delegation, authority, approval and ' +
          'audit", but no role, policy, scope, audit-log or approval-workflow endpoints appear in the OpenAPI ' +
          'path list. Contacts (mutual permission) and @mention (routing) are the concrete primitives.',
      },
    },
  ],
  liveProbe: { description: 'GET /agent/me — the docs explicitly recommend calling this on startup to confirm connection', mutatesState: false },
  failureBehaviour:
    'Agent keys receive 403 on Human API paths, which is a configuration error and terminal. The WebSocket is ' +
    'read-only and closes after 45s of inactivity with one connection per agent id under a last-connect-wins ' +
    'policy, so the client heartbeats every 30s and treats a displacement as a reconnect, not an error.',
  retryStrategy: 'Standard policy on 5xx. Message sends are not retried blindly because a duplicate @mention re-triggers the recipient agent.',
  idempotency: 'No idempotency header documented. Message sends carry our own message id in the body so duplicates are detectable downstream.',
};

export const DODO_MANIFEST: ProviderManifest = {
  id: 'dodo',
  displayName: 'Dodo Payments',
  tier: 'sponsor',
  summary:
    'Merchant of Record for eligible digital products and SaaS: global payments, tax compliance and ' +
    'transaction liability. Used only for digital add-ons, memberships and subscriptions — never for physical ' +
    'goods, which its merchant-acceptance policy prohibits.',
  docs: [
    { url: 'https://docs.dodopayments.com/api-reference/introduction', verifiedOn: VERIFIED },
    { url: 'https://docs.dodopayments.com/api-reference/checkout-sessions/create', verifiedOn: VERIFIED },
    { url: 'https://docs.dodopayments.com/developer-resources/webhooks', verifiedOn: VERIFIED },
    { url: 'https://docs.dodopayments.com/miscellaneous/merchant-acceptance', verifiedOn: VERIFIED, note: 'physical goods are prohibited' },
    { url: 'https://docs.dodopayments.com/miscellaneous/test-mode-vs-live-mode', verifiedOn: VERIFIED },
  ],
  authMethod: 'bearer_token',
  secrets: [SECRETS.dodoApiKey, SECRETS.dodoWebhookSecret],
  baseUrls: { production: 'https://live.dodopayments.com', test: 'https://test.dodopayments.com' },
  capabilities: [
    {
      capability: 'payments.checkout.digital_mor',
      priority: 1,
      evidence: { kind: 'documented_api', detail: 'POST /checkouts with product_cart[]; Dodo is Merchant of Record' },
    },
    { capability: 'payments.webhooks', priority: 2, evidence: { kind: 'documented_api', detail: 'Standard Webhooks, 51 documented event types' } },
    { capability: 'payments.refund', priority: 2, evidence: { kind: 'documented_api', detail: 'POST /refunds with optional partial items[]' } },
    { capability: 'payments.tax_calculation', priority: 2, evidence: { kind: 'documented_api', detail: 'Tax handled by Dodo as Merchant of Record for eligible categories' } },
    {
      capability: 'payments.checkout.physical',
      priority: 99,
      evidence: {
        kind: 'explicitly_unsupported',
        detail:
          'Physical goods appear on Dodo\'s enumerated prohibited-category list. Claiming Dodo is Merchant of ' +
          'Record for a physical private-label product would misstate who bears tax and transaction liability.',
      },
    },
  ],
  webhooks: [
    {
      path: '/webhooks/dodo',
      signatureHeader: 'webhook-signature',
      signatureScheme: 'standard_webhooks',
      events: [
        'payment.succeeded',
        'payment.failed',
        'payment.processing',
        'payment.cancelled',
        'refund.succeeded',
        'refund.failed',
        'dispute.opened',
        'dispute.accepted',
        'dispute.challenged',
        'dispute.won',
        'dispute.lost',
        'subscription.active',
        'subscription.renewed',
        'subscription.cancelled',
        'subscription.failed',
        'subscription.expired',
        'subscription.plan_changed',
        'license_key.created',
        'abandoned_checkout.detected',
        'abandoned_checkout.recovered',
        'dunning.started',
        'dunning.recovered',
      ],
      requiresRawBody: true,
    },
  ],
  rateLimit: { requestsPerWindow: 240, windowMs: 60_000, note: 'documented tier 0: 40 req/s burst, 240/min sustained' },
  vendorApproval: {
    required: true,
    how:
      'Live payouts require KYC/KYB: identity verification via Persona, bank verification, and for registered ' +
      'entities registration documents, tax id, director ids and beneficial owners at 10% or more. The Product ' +
      'Info Form is checked against the live website, which must already show pricing, terms, privacy, refund ' +
      'policy and contact details. Typical timeline 1-3 business days plus a monitoring review.',
  },
  liveProbe: { description: 'GET /products?page_size=1 — read-only listing', mutatesState: false },
  failureBehaviour: '429 carries X-RateLimit-Reset and is retried; 401 is terminal. POST /payments and POST /subscriptions are deprecated in favour of Checkout Sessions and are not used.',
  retryStrategy: 'Payment retry policy: 3 attempts with a hard deadline.',
  idempotency:
    'Dodo documents no general Idempotency-Key header — only isolated body fields on POST /webhooks and the ' +
    'wallet ledger. Every checkout creation is therefore gated on our own idempotency ledger before the call ' +
    'is made, and the resulting session id is stored against that key.',
};

export const SANDBOX0_MANIFEST: ProviderManifest = {
  id: 'sandbox0',
  displayName: 'Sandbox0',
  tier: 'sponsor',
  summary:
    'Isolated execution with network-level credential substitution. This is where untrusted, model-generated ' +
    'code runs: the sandbox sees an opaque placeholder and the real credential is injected at the egress ' +
    'boundary, so generated code can call an API it can never read the key for.',
  docs: [
    { url: 'https://sandbox0.ai/docs/sandbox/get-started', verifiedOn: VERIFIED },
    { url: 'https://sandbox0.ai/docs/sandbox/credential/egress-auth', verifiedOn: VERIFIED },
    { url: 'https://sandbox0.ai/docs/sandbox/network', verifiedOn: VERIFIED },
    { url: 'https://sandbox0.ai/docs/sandbox/webhooks', verifiedOn: VERIFIED },
    { url: 'https://sandbox0.ai/docs/sandbox/previews', verifiedOn: VERIFIED },
  ],
  authMethod: 'bearer_token',
  secrets: [SECRETS.sandbox0Token, SECRETS.sandbox0WebhookSecret],
  baseUrls: { production: 'https://api.sandbox0.ai' },
  capabilities: [
    { capability: 'compute.isolated_execution', priority: 1, evidence: { kind: 'documented_api', detail: 'POST /api/v1/sandboxes, POST /contexts/{id}/exec' } },
    {
      capability: 'compute.credential_isolation',
      priority: 1,
      evidence: {
        kind: 'documented_api',
        detail:
          'Credential Sources and Bindings with placeholder_substitution projection; credentialRules with ' +
          'failurePolicy fail-closed; TLS terminate-reoriginate',
      },
    },
    { capability: 'compute.persistent_sandbox', priority: 2, evidence: { kind: 'documented_api', detail: 'Volumes API plus ttl/hard_ttl; note that pause does NOT preserve running processes' } },
    { capability: 'site.publish_preview', priority: 3, evidence: { kind: 'documented_api', detail: 'POST /previews with one-time-credential bootstrap URL and partitioned session cookie' } },
  ],
  webhooks: [
    {
      path: '/webhooks/sandbox0',
      signatureHeader: 'X-Sandbox0-Signature',
      signatureScheme: 'hmac_sha256_hex',
      events: [
        'sandbox.ready',
        'sandbox.paused',
        'sandbox.resumed',
        'sandbox.killed',
        'sandbox.deleted',
        'process.started',
        'process.exited',
        'process.crashed',
        'file.modified',
        'agent.event',
      ],
      requiresRawBody: true,
    },
  ],
  rateLimit: { requestsPerWindow: 6000, windowMs: 60_000, note: 'documented self-hosted default: 100 req/s, burst 200' },
  liveProbe: { description: 'GET /api/v1/sandboxes — read-only listing', mutatesState: false },
  failureBehaviour:
    'Quota failures return 429 with error.code quota_exceeded and Retry-After. The exact HTTP auth header ' +
    'string is not published (docs only show SDK constructors), so the adapter sends Authorization: Bearer and ' +
    'records that as an assumption to confirm on first live probe.',
  retryStrategy: 'Standard policy honouring Retry-After.',
  idempotency: 'No idempotency header. Sandbox claims are keyed on the agent run id in metadata.',
};

export const SOLARI_MANIFEST: ProviderManifest = {
  id: 'solari',
  displayName: 'Solari by Pinetree Research',
  tier: 'sponsor',
  summary:
    'Cloud browsers, sandboxes and full GUI computers through one API. Used for compliant public-web research ' +
    'and supplier discovery where no API exists, with persistent profiles and session recording for auditability.',
  docs: [
    { url: 'https://docs.getsolari.com/api-reference/browser', verifiedOn: VERIFIED },
    { url: 'https://docs.getsolari.com/api-reference/sandboxes', verifiedOn: VERIFIED },
    { url: 'https://docs.getsolari.com/api-reference/desktops', verifiedOn: VERIFIED },
    { url: 'https://docs.getsolari.com/profiles', verifiedOn: VERIFIED },
    { url: 'https://docs.getsolari.com/recording', verifiedOn: VERIFIED },
  ],
  authMethod: 'bearer_token',
  secrets: [SECRETS.solariApiKey],
  baseUrls: { production: 'https://api.getsolari.com' },
  capabilities: [
    {
      capability: 'research.browser_session',
      priority: 1,
      evidence: { kind: 'documented_api', detail: 'POST /sessions returns cdpEndpoint and a Playwright-protocol wsEndpoint' },
    },
    { capability: 'research.gui_computer', priority: 1, evidence: { kind: 'documented_api', detail: 'POST /desktops returns streamUrl (RFB/VNC) and controlUrl' } },
    { capability: 'research.session_recording', priority: 1, evidence: { kind: 'documented_api', detail: 'recording:true then GET /sessions/{id}/replay-url' } },
    { capability: 'compute.isolated_execution', priority: 3, evidence: { kind: 'documented_api', detail: 'POST /sandboxes and POST /sandboxes/{id}/exec' } },
    { capability: 'sourcing.supplier_search', priority: 2, evidence: { kind: 'documented_api', detail: 'browser automation against supplier marketplaces where their terms permit it' } },
  ],
  rateLimit: { requestsPerWindow: 300, windowMs: 60_000, note: 'concurrency-limited rather than rate-limited; 429 ConcurrencyLimitExceeded' },
  liveProbe: { description: 'GET /health — unauthenticated pool probe, followed by GET /sandboxes?limit=1 to exercise the key', mutatesState: false },
  failureBehaviour:
    'GET /sessions/{id} is documented as non-functional and always 404s, so session state is tracked locally. ' +
    'WebSocket URLs expire 90 minutes after creation. Recording captures input values by default, so recording ' +
    'is disabled on any session that will touch a credential field.',
  retryStrategy: 'Long-running policy; 429 ConcurrencyLimitExceeded is retried with wide spacing rather than by opening more sessions.',
  idempotency: 'Create routes accept Idempotency-Key with a V4 UUID; the adapter supplies one on every session and sandbox creation.',
};

/* -------------------------------------------------------------------------- */
/* Non-sponsor externals                                                       */
/* -------------------------------------------------------------------------- */

export const ANTHROPIC_MANIFEST: ProviderManifest = {
  id: 'anthropic',
  displayName: 'Anthropic',
  tier: 'external',
  summary: 'Model inference for the CEO, manager and specialist agents.',
  docs: [{ url: 'https://docs.claude.com/en/api/overview', verifiedOn: VERIFIED }],
  authMethod: 'api_key_header',
  secrets: [SECRETS.anthropicApiKey],
  baseUrls: { production: 'https://api.anthropic.com' },
  capabilities: [
    { capability: 'llm.reasoning', priority: 1, evidence: { kind: 'documented_api', detail: 'POST /v1/messages' } },
    { capability: 'llm.structured_output', priority: 1, evidence: { kind: 'documented_api', detail: 'tool use with JSON schema input_schema' } },
  ],
  rateLimit: { requestsPerWindow: 1000, windowMs: 60_000, note: 'tier dependent; 429 carries retry-after' },
  liveProbe: { description: 'POST /v1/messages with max_tokens=1 and a one-token prompt — smallest possible real call', mutatesState: false },
  failureBehaviour: 'overloaded_error and 5xx are retried; invalid_request_error is terminal. Token budgets are enforced per agent run.',
  retryStrategy: 'Standard policy honouring retry-after.',
  idempotency: 'Inference is stateless; agent runs are made idempotent by the run record rather than by a provider key.',
};

export const META_ADS_MANIFEST: ProviderManifest = {
  id: 'meta_ads',
  displayName: 'Meta Ads',
  tier: 'external',
  summary: 'Paid acquisition on Meta. Campaign, ad set, creative and insights management.',
  docs: [{ url: 'https://developers.facebook.com/docs/marketing-apis', verifiedOn: VERIFIED }],
  authMethod: 'bearer_token',
  secrets: [SECRETS.metaAdsAccessToken, SECRETS.metaAdsAccountId],
  baseUrls: { production: 'https://graph.facebook.com/v21.0' },
  capabilities: [
    { capability: 'ads.campaign_manage', priority: 1, evidence: { kind: 'documented_api', detail: 'POST /act_{id}/campaigns, /adsets, /ads' } },
    { capability: 'ads.creative_upload', priority: 1, evidence: { kind: 'documented_api', detail: 'POST /act_{id}/adimages and /adcreatives' } },
    { capability: 'ads.metrics_read', priority: 1, evidence: { kind: 'documented_api', detail: 'GET /{object}/insights' } },
  ],
  vendorApproval: {
    required: true,
    how:
      'Requires a Meta business account, an ad account with a funded payment method, and a system user token ' +
      'with ads_management. New ad accounts are subject to review and spend limits.',
  },
  liveProbe: { description: 'GET /act_{account_id}?fields=account_status,currency — read-only', mutatesState: false },
  failureBehaviour: 'Error code 17 / 613 are throttling and retried; code 190 is an expired token and terminal until re-authorised.',
  retryStrategy: 'Standard policy. Budget changes are never retried without re-reading current spend first.',
  idempotency: 'No idempotency header. Campaign creation is keyed on the experiment arm id stored in the campaign name and our idempotency ledger.',
};

export const GOOGLE_ADS_MANIFEST: ProviderManifest = {
  id: 'google_ads',
  displayName: 'Google Ads',
  tier: 'external',
  summary: 'Paid acquisition on Google search and display.',
  docs: [{ url: 'https://developers.google.com/google-ads/api/docs/start', verifiedOn: VERIFIED }],
  authMethod: 'oauth2_authorization_code',
  secrets: [
    SECRETS.googleAdsDeveloperToken,
    SECRETS.googleAdsClientId,
    SECRETS.googleAdsClientSecret,
    SECRETS.googleAdsRefreshToken,
    SECRETS.googleAdsCustomerId,
  ],
  baseUrls: { production: 'https://googleads.googleapis.com/v18' },
  capabilities: [
    { capability: 'ads.campaign_manage', priority: 2, evidence: { kind: 'documented_api', detail: 'CampaignService, AdGroupService mutate endpoints' } },
    { capability: 'ads.creative_upload', priority: 2, evidence: { kind: 'documented_api', detail: 'AdGroupAdService with responsive search ad assets' } },
    { capability: 'ads.metrics_read', priority: 2, evidence: { kind: 'documented_api', detail: 'GoogleAdsService.SearchStream with GAQL' } },
  ],
  vendorApproval: {
    required: true,
    how: 'A developer token must be approved in the Google Ads API Center. Basic access is granted before production access.',
  },
  liveProbe: { description: 'GoogleAdsService.SearchStream with a customer query limited to 1 row — read-only', mutatesState: false },
  failureBehaviour: 'RESOURCE_EXHAUSTED is retried; AUTHENTICATION_ERROR requires refreshing the OAuth token before any retry.',
  retryStrategy: 'Standard policy, with an access-token refresh attempted once before treating auth failure as terminal.',
  idempotency: 'Mutate requests are idempotent when supplied with the same resource names; the adapter reads before writing.',
};

export const RESEND_MANIFEST: ProviderManifest = {
  id: 'resend',
  displayName: 'Resend',
  tier: 'external',
  summary: 'Transactional email: order confirmations, shipping notifications, support replies and RFQ delivery.',
  docs: [{ url: 'https://resend.com/docs/api-reference/introduction', verifiedOn: VERIFIED }],
  authMethod: 'bearer_token',
  secrets: [SECRETS.resendApiKey],
  baseUrls: { production: 'https://api.resend.com' },
  capabilities: [{ capability: 'email.transactional', priority: 1, evidence: { kind: 'documented_api', detail: 'POST /emails' } }],
  liveProbe: { description: 'GET /domains — read-only listing of verified sending domains', mutatesState: false },
  failureBehaviour: '429 is retried; a 403 for an unverified domain is terminal and blocks the email capability with a clear remediation.',
  retryStrategy: 'Standard policy.',
  idempotency: 'Header Idempotency-Key is supported on POST /emails and is always supplied.',
};

export const CLOUDFLARE_MANIFEST: ProviderManifest = {
  id: 'cloudflare_dns',
  displayName: 'Cloudflare',
  tier: 'external',
  summary: 'Domain availability checks and DNS records for launched storefronts.',
  docs: [{ url: 'https://developers.cloudflare.com/api/', verifiedOn: VERIFIED }],
  authMethod: 'bearer_token',
  secrets: [SECRETS.cloudflareApiToken, SECRETS.cloudflareAccountId],
  baseUrls: { production: 'https://api.cloudflare.com/client/v4' },
  capabilities: [
    { capability: 'domain.availability_check', priority: 1, evidence: { kind: 'documented_api', detail: 'GET /accounts/{id}/registrar/domains and registrar search' } },
    { capability: 'domain.dns_manage', priority: 1, evidence: { kind: 'documented_api', detail: 'POST /zones/{zone}/dns_records' } },
  ],
  liveProbe: { description: 'GET /user/tokens/verify — read-only token validity check', mutatesState: false },
  failureBehaviour: 'Cloudflare returns 200 with success:false for domain errors, so the adapter checks the success flag rather than the HTTP status alone.',
  retryStrategy: 'Standard policy.',
  idempotency: 'DNS record creation reads existing records first and patches rather than duplicating.',
};

export const SHIPPO_MANIFEST: ProviderManifest = {
  id: 'shippo',
  displayName: 'Shippo',
  tier: 'external',
  summary: 'Multi-carrier shipping: rate quotes for landed-cost modelling, label purchase and tracking.',
  docs: [{ url: 'https://docs.goshippo.com/shippoapi/public-api/', verifiedOn: VERIFIED }],
  authMethod: 'api_key_header',
  secrets: [SECRETS.shippoApiToken],
  baseUrls: { production: 'https://api.goshippo.com' },
  capabilities: [
    { capability: 'fulfilment.rate_quote', priority: 1, evidence: { kind: 'documented_api', detail: 'POST /shipments returns rates' } },
    { capability: 'fulfilment.label_purchase', priority: 1, evidence: { kind: 'documented_api', detail: 'POST /transactions' } },
    { capability: 'fulfilment.tracking', priority: 1, evidence: { kind: 'documented_api', detail: 'GET /tracks/{carrier}/{number}' } },
  ],
  liveProbe: { description: 'GET /addresses?results=1 — read-only listing', mutatesState: false },
  failureBehaviour: 'Rate requests that return zero rates are a business condition, not an error, and are reported as such to the landed-cost analyst.',
  retryStrategy: 'Standard policy. Label purchase is never retried without checking for an existing transaction, because a duplicate label costs money.',
  idempotency: 'Transactions accept a metadata field that carries our order id; the adapter checks for an existing transaction before purchasing.',
};

export const ALIBABA_MANIFEST: ProviderManifest = {
  id: 'alibaba',
  displayName: 'Alibaba.com Open Platform',
  tier: 'external',
  summary: 'Supplier and product discovery for private-label sourcing.',
  docs: [{ url: 'https://openapi.alibaba.com/doc/doc.htm', verifiedOn: VERIFIED }],
  authMethod: 'hmac_signed_request',
  secrets: [SECRETS.alibabaAppKey, SECRETS.alibabaAppSecret],
  baseUrls: { production: 'https://openapi-api.alibaba.com/rest' },
  capabilities: [
    { capability: 'sourcing.supplier_search', priority: 1, evidence: { kind: 'documented_api', detail: 'product and supplier search endpoints on the Open Platform' } },
    { capability: 'sourcing.supplier_profile', priority: 1, evidence: { kind: 'documented_api', detail: 'supplier detail endpoints' } },
    {
      capability: 'sourcing.rfq_submit',
      priority: 1,
      evidence: {
        kind: 'marketing_claim_only',
        detail:
          'RFQ submission availability depends on the approved app scope and is not confirmed for a general ' +
          'developer account. Until confirmed, RFQs are delivered by email or a recorded browser session.',
      },
    },
  ],
  vendorApproval: {
    required: true,
    how: 'An Alibaba Open Platform app must be created and approved, and API scopes are granted per app. Approval is manual.',
  },
  liveProbe: { description: 'A signed read-only category or product search call with a single result', mutatesState: false },
  failureBehaviour: 'Signature errors are terminal and indicate a clock skew or secret problem; the adapter surfaces the server timestamp for diagnosis.',
  retryStrategy: 'Standard policy.',
  idempotency: 'Search is read-only. RFQ submission is guarded by the local idempotency ledger.',
};

export const OPENAI_IMAGES_MANIFEST: ProviderManifest = {
  id: 'openai_images',
  displayName: 'Image Generation',
  tier: 'external',
  summary: 'Logo, packaging concept, product render and ad creative image generation.',
  docs: [{ url: 'https://platform.openai.com/docs/api-reference/images', verifiedOn: VERIFIED }],
  authMethod: 'bearer_token',
  secrets: [SECRETS.openaiImagesApiKey],
  baseUrls: { production: 'https://api.openai.com/v1' },
  capabilities: [
    { capability: 'asset.image_generation', priority: 1, evidence: { kind: 'documented_api', detail: 'POST /v1/images/generations' } },
  ],
  liveProbe: { description: 'GET /v1/models — read-only listing', mutatesState: false },
  failureBehaviour: 'Content-policy rejections are terminal and are reported back to the creative agent as a prompt problem, not retried.',
  retryStrategy: 'Standard policy on 429/5xx only.',
  idempotency: 'Generation requests carry a deterministic seed and our asset id so a retry is detectable.',
};

/* -------------------------------------------------------------------------- */
/* Registry                                                                    */
/* -------------------------------------------------------------------------- */

export const ALL_MANIFESTS: readonly ProviderManifest[] = [
  TERAC_MANIFEST,
  STRIPE_MANIFEST,
  LOVABLE_MANIFEST,
  WHOP_MANIFEST,
  RENDER_MANIFEST,
  LINQ_MANIFEST,
  SUPERSERVE_MANIFEST,
  REPLAY_MANIFEST,
  BAND_MANIFEST,
  DODO_MANIFEST,
  SANDBOX0_MANIFEST,
  SOLARI_MANIFEST,
  ANTHROPIC_MANIFEST,
  META_ADS_MANIFEST,
  GOOGLE_ADS_MANIFEST,
  RESEND_MANIFEST,
  CLOUDFLARE_MANIFEST,
  SHIPPO_MANIFEST,
  ALIBABA_MANIFEST,
  OPENAI_IMAGES_MANIFEST,
];

export const SPONSOR_MANIFESTS: readonly ProviderManifest[] = ALL_MANIFESTS.filter((m) => m.tier === 'sponsor');

/** Every environment variable the system can consume, for the readiness report. */
export function allSecretSpecs(): readonly SecretSpec[] {
  const seen = new Map<string, SecretSpec>();
  for (const manifest of ALL_MANIFESTS) {
    for (const spec of manifest.secrets) seen.set(spec.env, spec);
  }
  return [...seen.values()].sort((a, b) => (a.env < b.env ? -1 : 1));
}
