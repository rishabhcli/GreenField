-- Brand, storefront, QA, and the commerce core.
--
-- Two invariants are enforced here rather than trusted to application code:
--   * A production deployment must name the QA run that cleared it. The gate is
--     not advisory; a release with no QA evidence cannot be recorded as live.
--   * Refunds can never exceed captures, and every order-state change is an
--     append-only event with a provider event id, so a redelivered webhook
--     collapses instead of double-applying.

CREATE TABLE IF NOT EXISTS brand_identities (
  id                 TEXT PRIMARY KEY,
  company_id         TEXT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  opportunity_id     TEXT NOT NULL REFERENCES opportunities(id) ON DELETE RESTRICT,
  name               TEXT NOT NULL,
  legal_entity_name  TEXT,
  tagline            TEXT NOT NULL,
  positioning        TEXT NOT NULL,
  value_proposition  TEXT NOT NULL,
  target_segment     TEXT NOT NULL,
  tone_attributes    TEXT[] NOT NULL DEFAULT '{}',
  -- Every objective claim marketing may make, with its substantiation. The
  -- claims checker reads this; an unsupported claim blocks the creative.
  permitted_claims   JSONB NOT NULL DEFAULT '[]'::jsonb,
  prohibited_claims  TEXT[] NOT NULL DEFAULT '{}',
  palette            JSONB NOT NULL,
  typography         JSONB NOT NULL,
  domain             TEXT,
  name_candidates    JSONB NOT NULL DEFAULT '[]'::jsonb,
  status             TEXT NOT NULL DEFAULT 'draft'
                       CHECK (status IN ('draft','in_review','approved','retired')),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, name)
);

DROP TRIGGER IF EXISTS brand_identities_updated_at ON brand_identities;
CREATE TRIGGER brand_identities_updated_at BEFORE UPDATE ON brand_identities
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS creative_assets (
  id          TEXT PRIMARY KEY,
  company_id  TEXT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  brand_id    TEXT REFERENCES brand_identities(id) ON DELETE SET NULL,
  kind        TEXT NOT NULL CHECK (kind IN (
                'logo_primary','logo_mark','logo_wordmark','favicon','packaging_concept',
                'product_render','lifestyle_image','ad_static','ad_video','social_post',
                'email_header','og_image')),
  url         TEXT NOT NULL,
  mime_type   TEXT NOT NULL,
  width_px    INTEGER,
  height_px   INTEGER,
  bytes       BIGINT,
  -- Prompt and seed retained so any asset can be regenerated or explained.
  generation  JSONB NOT NULL,
  alt_text    TEXT,
  review_ids  TEXT[] NOT NULL DEFAULT '{}',
  status      TEXT NOT NULL DEFAULT 'generated'
                CHECK (status IN ('generated','in_review','approved','rejected','live','archived')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS creative_assets_brand_kind_idx ON creative_assets (brand_id, kind, created_at DESC);

/* -------------------------------------------------------------------------- */
/* Storefront                                                                  */
/* -------------------------------------------------------------------------- */

CREATE TABLE IF NOT EXISTS sites (
  id                    TEXT PRIMARY KEY,
  company_id            TEXT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  brand_id              TEXT NOT NULL REFERENCES brand_identities(id) ON DELETE RESTRICT,
  spec                  JSONB NOT NULL,
  status                TEXT NOT NULL CHECK (status IN (
                          'spec_drafted','generating','generated','code_exported','building',
                          'build_failed','preview_deployed','qa_running','qa_failed','qa_passed',
                          'release_blocked','production_deployed','rolled_back','retired')),
  generator_provider    TEXT,
  generator_project_id  TEXT,
  repository_url        TEXT,
  preview_url           TEXT,
  production_url        TEXT,
  hosting_service_id    TEXT,
  current_deployment_id TEXT,
  last_qa_run_id        TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS sites_updated_at ON sites;
CREATE TRIGGER sites_updated_at BEFORE UPDATE ON sites
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX IF NOT EXISTS sites_company_status_idx ON sites (company_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS site_builds (
  id            TEXT PRIMARY KEY,
  site_id       TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  reason        TEXT NOT NULL CHECK (reason IN ('initial','iteration','defect_fix','content_update')),
  instructions  TEXT,
  provider      TEXT NOT NULL,
  external_ref  TEXT,
  status        TEXT NOT NULL CHECK (status IN ('queued','running','succeeded','failed','cancelled')),
  -- Exported file map (path -> sha256), proving the code was actually retrieved
  -- rather than merely generated inside a vendor's UI.
  exported_files JSONB,
  error         TEXT,
  started_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS site_builds_site_idx ON site_builds (site_id, started_at DESC);

CREATE TABLE IF NOT EXISTS qa_runs (
  id                  TEXT PRIMARY KEY,
  company_id          TEXT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  site_id             TEXT REFERENCES sites(id) ON DELETE SET NULL,
  deployment_id       TEXT,
  kind                TEXT NOT NULL CHECK (kind IN (
                        'autonomous_exploration','browser_e2e','api_contract','payment_state',
                        'accessibility','security_smoke','data_integrity')),
  provider            TEXT NOT NULL,
  external_project_id TEXT,
  external_run_id     TEXT,
  target_url          TEXT NOT NULL,
  status              TEXT NOT NULL CHECK (status IN (
                        'queued','running','completed','failed','cancelled','provider_unavailable')),
  -- Flows the run actually exercised, not the flows we hoped it would.
  flows_covered       TEXT[] NOT NULL DEFAULT '{}',
  defect_counts       JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Populated when the QA provider was not activated. An unexecuted check is
  -- not a passing check, and this column is why the gate can tell them apart.
  unavailable_reason  TEXT,
  started_at          TIMESTAMPTZ,
  finished_at         TIMESTAMPTZ,
  evidence_url        TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT qa_runs_unavailable_has_reason CHECK (
    status <> 'provider_unavailable' OR unavailable_reason IS NOT NULL
  )
);

CREATE INDEX IF NOT EXISTS qa_runs_site_idx ON qa_runs (site_id, created_at DESC);
CREATE INDEX IF NOT EXISTS qa_runs_deployment_idx ON qa_runs (deployment_id) WHERE deployment_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS defects (
  id                  TEXT PRIMARY KEY,
  company_id          TEXT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  qa_run_id           TEXT NOT NULL REFERENCES qa_runs(id) ON DELETE CASCADE,
  provider            TEXT NOT NULL,
  external_id         TEXT,
  title               TEXT NOT NULL,
  description         TEXT NOT NULL,
  severity            TEXT NOT NULL CHECK (severity IN ('critical','high','medium','low','info')),
  affected_flow       TEXT,
  reproduction_steps  TEXT[] NOT NULL DEFAULT '{}',
  root_cause          TEXT,
  suggested_fix       TEXT,
  evidence_url        TEXT,
  status              TEXT NOT NULL DEFAULT 'open'
                        CHECK (status IN ('open','assigned','fixed','wontfix','invalid','reopened')),
  assigned_role_key   TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS defects_updated_at ON defects;
CREATE TRIGGER defects_updated_at BEFORE UPDATE ON defects
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX IF NOT EXISTS defects_open_idx
  ON defects (company_id, severity) WHERE status IN ('open','reopened','assigned');
CREATE UNIQUE INDEX IF NOT EXISTS defects_external_idx
  ON defects (provider, external_id) WHERE external_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS deployments (
  id                     TEXT PRIMARY KEY,
  company_id             TEXT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  site_id                TEXT REFERENCES sites(id) ON DELETE SET NULL,
  provider               TEXT NOT NULL CHECK (provider IN ('render','lovable')),
  external_deploy_id     TEXT,
  service_id             TEXT,
  environment            TEXT NOT NULL CHECK (environment IN ('preview','staging','production')),
  commit_sha             TEXT,
  status                 TEXT NOT NULL CHECK (status IN ('queued','building','live','failed','canceled','rolled_back')),
  url                    TEXT,
  -- Always know what to roll back to.
  previous_deployment_id TEXT REFERENCES deployments(id) ON DELETE SET NULL,
  gating_qa_run_id       TEXT REFERENCES qa_runs(id) ON DELETE RESTRICT,
  started_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at            TIMESTAMPTZ,
  logs_url               TEXT,
  error                  TEXT,
  -- The QA gate, enforced by the database: a production deploy cannot reach
  -- `live` without naming the QA run that cleared it.
  CONSTRAINT deployments_production_requires_qa CHECK (
    environment <> 'production' OR status <> 'live' OR gating_qa_run_id IS NOT NULL
  )
);

CREATE INDEX IF NOT EXISTS deployments_site_idx ON deployments (site_id, started_at DESC);
CREATE INDEX IF NOT EXISTS deployments_live_idx
  ON deployments (company_id, environment, started_at DESC) WHERE status = 'live';

ALTER TABLE sites DROP CONSTRAINT IF EXISTS sites_current_deployment_fk;
ALTER TABLE sites ADD CONSTRAINT sites_current_deployment_fk
  FOREIGN KEY (current_deployment_id) REFERENCES deployments(id) ON DELETE SET NULL;
ALTER TABLE sites DROP CONSTRAINT IF EXISTS sites_last_qa_run_fk;
ALTER TABLE sites ADD CONSTRAINT sites_last_qa_run_fk
  FOREIGN KEY (last_qa_run_id) REFERENCES qa_runs(id) ON DELETE SET NULL;
ALTER TABLE qa_runs DROP CONSTRAINT IF EXISTS qa_runs_deployment_fk;
ALTER TABLE qa_runs ADD CONSTRAINT qa_runs_deployment_fk
  FOREIGN KEY (deployment_id) REFERENCES deployments(id) ON DELETE SET NULL;

/* -------------------------------------------------------------------------- */
/* Catalogue                                                                   */
/* -------------------------------------------------------------------------- */

CREATE TABLE IF NOT EXISTS products (
  id                     TEXT PRIMARY KEY,
  company_id             TEXT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  opportunity_id         TEXT REFERENCES opportunities(id) ON DELETE SET NULL,
  brand_id               TEXT REFERENCES brand_identities(id) ON DELETE SET NULL,
  sku                    TEXT NOT NULL,
  name                   TEXT NOT NULL,
  kind                   TEXT NOT NULL CHECK (kind IN (
                           'physical_good','digital_good','subscription','service','membership')),
  description            TEXT NOT NULL,
  physical               JSONB,
  payment_route          TEXT NOT NULL CHECK (payment_route IN (
                           'stripe_direct','dodo_merchant_of_record','whop_checkout')),
  external_refs          JSONB NOT NULL DEFAULT '{}'::jsonb,
  price_minor            BIGINT NOT NULL CHECK (price_minor >= 0),
  currency               TEXT NOT NULL CHECK (char_length(currency) = 3),
  compare_at_price_minor BIGINT CHECK (compare_at_price_minor IS NULL OR compare_at_price_minor >= 0),
  supplier_id            TEXT REFERENCES suppliers(id) ON DELETE SET NULL,
  landed_cost_model_id   TEXT REFERENCES landed_cost_models(id) ON DELETE SET NULL,
  inventory_policy       TEXT NOT NULL DEFAULT 'track'
                           CHECK (inventory_policy IN ('track','continue_selling','preorder','made_to_order')),
  inventory_on_hand      INTEGER NOT NULL DEFAULT 0 CHECK (inventory_on_hand >= 0),
  inventory_reserved     INTEGER NOT NULL DEFAULT 0 CHECK (inventory_reserved >= 0),
  status                 TEXT NOT NULL DEFAULT 'draft'
                           CHECK (status IN ('draft','review','active','paused','discontinued')),
  compliance_approval_id TEXT REFERENCES approvals(id) ON DELETE SET NULL,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, sku),
  -- Mirrors assertPaymentRoute() in the domain: a physical good can only be
  -- sold on the rail whose merchant-acceptance terms actually cover it.
  CONSTRAINT products_physical_uses_direct_rail CHECK (
    kind <> 'physical_good' OR payment_route = 'stripe_direct'
  ),
  CONSTRAINT products_physical_has_dimensions CHECK (kind <> 'physical_good' OR physical IS NOT NULL),
  CONSTRAINT products_reserved_lte_on_hand CHECK (
    inventory_policy <> 'track' OR inventory_reserved <= inventory_on_hand
  )
);

DROP TRIGGER IF EXISTS products_updated_at ON products;
CREATE TRIGGER products_updated_at BEFORE UPDATE ON products
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX IF NOT EXISTS products_active_idx ON products (company_id) WHERE status = 'active';

/* -------------------------------------------------------------------------- */
/* Customers and orders                                                        */
/* -------------------------------------------------------------------------- */

CREATE TABLE IF NOT EXISTS customers (
  id                    TEXT PRIMARY KEY,
  company_id            TEXT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  email                 TEXT,
  phone_e164            TEXT,
  name                  TEXT,
  external_refs         JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Consent must record where and when it was captured; SMS compliance depends
  -- on being able to produce that record.
  marketing_consent     JSONB NOT NULL DEFAULT '{"email":false,"sms":false,"capturedAt":null,"capturedSource":null,"optedOutAt":null}'::jsonb,
  total_orders          INTEGER NOT NULL DEFAULT 0 CHECK (total_orders >= 0),
  lifetime_value_minor  BIGINT NOT NULL DEFAULT 0 CHECK (lifetime_value_minor >= 0),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT customers_reachable CHECK (email IS NOT NULL OR phone_e164 IS NOT NULL)
);

DROP TRIGGER IF EXISTS customers_updated_at ON customers;
CREATE TRIGGER customers_updated_at BEFORE UPDATE ON customers
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE UNIQUE INDEX IF NOT EXISTS customers_email_idx ON customers (company_id, lower(email)) WHERE email IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS customers_phone_idx ON customers (company_id, phone_e164) WHERE phone_e164 IS NOT NULL;

CREATE TABLE IF NOT EXISTS orders (
  id                     TEXT PRIMARY KEY,
  company_id             TEXT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  site_id                TEXT REFERENCES sites(id) ON DELETE SET NULL,
  order_number           TEXT NOT NULL,
  customer_id            TEXT NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  status                 TEXT NOT NULL CHECK (status IN (
                           'CREATED','CHECKOUT_STARTED','PAYMENT_PENDING','PAID','FULFILLMENT_QUEUED',
                           'FULFILLING','SHIPPED','DELIVERED','PAYMENT_FAILED','CANCELLED',
                           'REFUND_REQUESTED','PARTIALLY_REFUNDED','REFUNDED','RETURN_REQUESTED',
                           'RETURNED','DISPUTED','LOST_OR_DAMAGED','MANUAL_REVIEW')),
  payment_route          TEXT NOT NULL,
  currency               TEXT NOT NULL CHECK (char_length(currency) = 3),
  subtotal_minor         BIGINT NOT NULL CHECK (subtotal_minor >= 0),
  shipping_minor         BIGINT NOT NULL DEFAULT 0 CHECK (shipping_minor >= 0),
  tax_minor              BIGINT NOT NULL DEFAULT 0 CHECK (tax_minor >= 0),
  discount_minor         BIGINT NOT NULL DEFAULT 0 CHECK (discount_minor >= 0),
  total_minor            BIGINT NOT NULL CHECK (total_minor >= 0),
  amount_paid_minor      BIGINT NOT NULL DEFAULT 0 CHECK (amount_paid_minor >= 0),
  amount_refunded_minor  BIGINT NOT NULL DEFAULT 0 CHECK (amount_refunded_minor >= 0),
  shipping_address       JSONB,
  billing_address        JSONB,
  external_refs          JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Click ids and experiment arm captured at checkout, so revenue attributes
  -- back to the creative that produced it.
  attribution            JSONB NOT NULL DEFAULT '{}'::jsonb,
  supplier_reference     TEXT,
  three_pl_reference     TEXT,
  risk_level             TEXT NOT NULL DEFAULT 'unknown'
                           CHECK (risk_level IN ('normal','elevated','highest','unknown')),
  manual_review_reason   TEXT,
  placed_at              TIMESTAMPTZ,
  paid_at                TIMESTAMPTZ,
  shipped_at             TIMESTAMPTZ,
  delivered_at           TIMESTAMPTZ,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, order_number),
  -- Never refund more than was captured.
  CONSTRAINT orders_refund_within_capture CHECK (amount_refunded_minor <= amount_paid_minor),
  CONSTRAINT orders_totals_consistent CHECK (
    total_minor = subtotal_minor + tax_minor + shipping_minor - discount_minor
  ),
  CONSTRAINT orders_paid_has_timestamp CHECK (
    status NOT IN ('PAID','FULFILLMENT_QUEUED','FULFILLING','SHIPPED','DELIVERED') OR paid_at IS NOT NULL
  ),
  CONSTRAINT orders_manual_review_has_reason CHECK (
    status <> 'MANUAL_REVIEW' OR manual_review_reason IS NOT NULL
  )
);

DROP TRIGGER IF EXISTS orders_updated_at ON orders;
CREATE TRIGGER orders_updated_at BEFORE UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX IF NOT EXISTS orders_company_status_idx ON orders (company_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS orders_customer_idx ON orders (customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS orders_fulfilment_queue_idx
  ON orders (company_id, paid_at) WHERE status IN ('PAID','FULFILLMENT_QUEUED');
CREATE INDEX IF NOT EXISTS orders_needs_attention_idx
  ON orders (company_id, updated_at DESC)
  WHERE status IN ('MANUAL_REVIEW','DISPUTED','LOST_OR_DAMAGED','REFUND_REQUESTED');

CREATE TABLE IF NOT EXISTS order_line_items (
  id                      TEXT PRIMARY KEY,
  order_id                TEXT NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  product_id              TEXT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  sku                     TEXT NOT NULL,
  name                    TEXT NOT NULL,
  quantity                INTEGER NOT NULL CHECK (quantity > 0),
  unit_price_minor        BIGINT NOT NULL CHECK (unit_price_minor >= 0),
  subtotal_minor          BIGINT NOT NULL CHECK (subtotal_minor >= 0),
  tax_minor               BIGINT NOT NULL DEFAULT 0 CHECK (tax_minor >= 0),
  discount_minor          BIGINT NOT NULL DEFAULT 0 CHECK (discount_minor >= 0),
  -- Landed cost snapshotted at sale time, so historical margin stays accurate
  -- when supplier prices or freight rates later move.
  landed_unit_cost_minor  BIGINT CHECK (landed_unit_cost_minor IS NULL OR landed_unit_cost_minor >= 0),
  fulfilled_quantity      INTEGER NOT NULL DEFAULT 0 CHECK (fulfilled_quantity >= 0),
  refunded_quantity       INTEGER NOT NULL DEFAULT 0 CHECK (refunded_quantity >= 0),
  CONSTRAINT line_items_fulfilled_lte_quantity CHECK (fulfilled_quantity <= quantity),
  CONSTRAINT line_items_refunded_lte_quantity CHECK (refunded_quantity <= quantity)
);

CREATE INDEX IF NOT EXISTS order_line_items_order_idx ON order_line_items (order_id);
CREATE INDEX IF NOT EXISTS order_line_items_product_idx ON order_line_items (product_id);

-- Append-only. This is the order's real history; the `orders` row is a
-- materialised view of it that happens to be stored.
CREATE TABLE IF NOT EXISTS order_events (
  id                TEXT PRIMARY KEY,
  order_id          TEXT NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  kind              TEXT NOT NULL,
  from_status       TEXT,
  to_status         TEXT,
  actor             TEXT NOT NULL,
  external_event_id TEXT,
  payload           JSONB NOT NULL DEFAULT '{}'::jsonb,
  occurred_at       TIMESTAMPTZ NOT NULL,
  recorded_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Webhook idempotency at the order level: a redelivered provider event maps to
-- the same (order, external event) pair and is rejected as a duplicate.
CREATE UNIQUE INDEX IF NOT EXISTS order_events_external_unique
  ON order_events (order_id, external_event_id) WHERE external_event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS order_events_order_time_idx ON order_events (order_id, occurred_at, recorded_at);

DROP TRIGGER IF EXISTS order_events_append_only ON order_events;
CREATE TRIGGER order_events_append_only
  BEFORE UPDATE OR DELETE ON order_events
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

/* -------------------------------------------------------------------------- */
/* Payments, refunds, disputes, shipments                                      */
/* -------------------------------------------------------------------------- */

CREATE TABLE IF NOT EXISTS payments (
  id                     TEXT PRIMARY KEY,
  company_id             TEXT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  order_id               TEXT NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  provider               TEXT NOT NULL CHECK (provider IN ('stripe','dodo','whop')),
  external_id            TEXT NOT NULL,
  status                 TEXT NOT NULL CHECK (status IN (
                           'requires_payment_method','requires_action','processing','succeeded',
                           'failed','canceled','refunded','partially_refunded','disputed')),
  amount_minor           BIGINT NOT NULL CHECK (amount_minor >= 0),
  currency               TEXT NOT NULL CHECK (char_length(currency) = 3),
  -- NULL until the provider reports the fee. Never guessed.
  fee_minor              BIGINT CHECK (fee_minor IS NULL OR fee_minor >= 0),
  net_minor              BIGINT,
  payment_method_brand   TEXT,
  payment_method_last4   TEXT CHECK (payment_method_last4 IS NULL OR char_length(payment_method_last4) <= 4),
  risk_score             INTEGER,
  risk_level             TEXT,
  captured_at            TIMESTAMPTZ,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- One row per provider payment object. Reconciliation depends on this being
  -- exact: a second row for the same external id would double-count revenue.
  UNIQUE (provider, external_id)
);

DROP TRIGGER IF EXISTS payments_updated_at ON payments;
CREATE TRIGGER payments_updated_at BEFORE UPDATE ON payments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX IF NOT EXISTS payments_order_idx ON payments (order_id);
CREATE INDEX IF NOT EXISTS payments_reconcile_idx ON payments (company_id, provider, created_at DESC);

CREATE TABLE IF NOT EXISTS refunds (
  id            TEXT PRIMARY KEY,
  company_id    TEXT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  order_id      TEXT NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  payment_id    TEXT NOT NULL REFERENCES payments(id) ON DELETE RESTRICT,
  provider      TEXT NOT NULL,
  external_id   TEXT NOT NULL,
  amount_minor  BIGINT NOT NULL CHECK (amount_minor > 0),
  currency      TEXT NOT NULL CHECK (char_length(currency) = 3),
  reason        TEXT,
  status        TEXT NOT NULL CHECK (status IN ('pending','requires_action','succeeded','failed','canceled')),
  -- Who authorised it: an agent within its limit, or a named human above it.
  authorised_by TEXT NOT NULL,
  approval_id   TEXT REFERENCES approvals(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider, external_id)
);

DROP TRIGGER IF EXISTS refunds_updated_at ON refunds;
CREATE TRIGGER refunds_updated_at BEFORE UPDATE ON refunds
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX IF NOT EXISTS refunds_order_idx ON refunds (order_id, created_at DESC);

CREATE TABLE IF NOT EXISTS disputes (
  id                 TEXT PRIMARY KEY,
  company_id         TEXT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  order_id           TEXT REFERENCES orders(id) ON DELETE SET NULL,
  payment_id         TEXT REFERENCES payments(id) ON DELETE SET NULL,
  provider           TEXT NOT NULL,
  external_id        TEXT NOT NULL,
  amount_minor       BIGINT NOT NULL CHECK (amount_minor >= 0),
  currency           TEXT NOT NULL CHECK (char_length(currency) = 3),
  reason             TEXT,
  status             TEXT NOT NULL,
  evidence_due_by    TIMESTAMPTZ,
  evidence_submitted BOOLEAN NOT NULL DEFAULT FALSE,
  outcome            TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider, external_id)
);

DROP TRIGGER IF EXISTS disputes_updated_at ON disputes;
CREATE TRIGGER disputes_updated_at BEFORE UPDATE ON disputes
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX IF NOT EXISTS disputes_open_idx
  ON disputes (company_id, evidence_due_by)
  WHERE evidence_submitted = FALSE AND evidence_due_by IS NOT NULL;

CREATE TABLE IF NOT EXISTS shipments (
  id              TEXT PRIMARY KEY,
  company_id      TEXT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  order_id        TEXT NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  carrier         TEXT NOT NULL,
  service         TEXT,
  tracking_number TEXT,
  tracking_url    TEXT,
  label_url       TEXT,
  cost_minor      BIGINT CHECK (cost_minor IS NULL OR cost_minor >= 0),
  currency        TEXT,
  provider        TEXT,
  external_id     TEXT,
  status          TEXT NOT NULL CHECK (status IN (
                    'created','label_purchased','in_transit','out_for_delivery','delivered',
                    'exception','returned')),
  line_item_ids   TEXT[] NOT NULL DEFAULT '{}',
  shipped_at      TIMESTAMPTZ,
  delivered_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS shipments_updated_at ON shipments;
CREATE TRIGGER shipments_updated_at BEFORE UPDATE ON shipments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX IF NOT EXISTS shipments_order_idx ON shipments (order_id);
CREATE INDEX IF NOT EXISTS shipments_tracking_idx ON shipments (tracking_number) WHERE tracking_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS shipments_in_flight_idx
  ON shipments (company_id, shipped_at) WHERE status IN ('label_purchased','in_transit','out_for_delivery');
-- A duplicate label costs real money; this makes a double purchase impossible.
CREATE UNIQUE INDEX IF NOT EXISTS shipments_external_idx
  ON shipments (provider, external_id) WHERE external_id IS NOT NULL;
