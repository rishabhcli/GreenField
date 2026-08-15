-- Sourcing: suppliers, RFQs, quotes and landed-cost models.
--
-- The distinction this schema exists to protect: `supplier_quotes` rows are
-- things a supplier actually said, and `landed_cost_models.components[].basis`
-- records, per line, whether a number came from a quote, a freight API, a
-- contract rate, our own history, or an assumption. Margin figures downstream
-- carry the resulting grounded ratio, so a 38% margin from a real RFQ is never
-- confused with a 38% margin from a guess.

CREATE TABLE IF NOT EXISTS suppliers (
  id                       TEXT PRIMARY KEY,
  company_id               TEXT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  source_provider          TEXT NOT NULL,
  external_id              TEXT NOT NULL,
  profile_url              TEXT,
  legal_name               TEXT NOT NULL,
  display_name             TEXT NOT NULL,
  kind                     TEXT NOT NULL CHECK (kind IN (
                             'manufacturer','trading_company','contract_manufacturer',
                             'private_label_specialist','domestic_wholesaler','print_on_demand',
                             'contract_packer')),
  country_code             TEXT NOT NULL CHECK (char_length(country_code) = 2),
  region                   TEXT,
  years_active             INTEGER CHECK (years_active IS NULL OR years_active >= 0),
  employee_count_band      TEXT,
  -- Claimed by the supplier vs. independently confirmed. Never merged.
  claimed_certifications   TEXT[] NOT NULL DEFAULT '{}',
  verified_certifications  TEXT[] NOT NULL DEFAULT '{}',
  platform_signals         JSONB NOT NULL DEFAULT '{}'::jsonb,
  supports_private_label   BOOLEAN,
  supports_custom_packaging BOOLEAN,
  contact_channels         TEXT[] NOT NULL DEFAULT '{}',
  contact_handle           TEXT,
  risk_flags               TEXT[] NOT NULL DEFAULT '{}',
  discovered_via           TEXT NOT NULL CHECK (discovered_via IN (
                             'provider_api','browser_session','human_expert','manual_entry')),
  discovered_at            TIMESTAMPTZ NOT NULL,
  last_refreshed_at        TIMESTAMPTZ NOT NULL,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, source_provider, external_id)
);

DROP TRIGGER IF EXISTS suppliers_updated_at ON suppliers;
CREATE TRIGGER suppliers_updated_at BEFORE UPDATE ON suppliers
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX IF NOT EXISTS suppliers_country_idx ON suppliers (company_id, country_code);
CREATE INDEX IF NOT EXISTS suppliers_private_label_idx
  ON suppliers (company_id) WHERE supports_private_label IS TRUE;
CREATE INDEX IF NOT EXISTS suppliers_stale_idx ON suppliers (last_refreshed_at);

CREATE TABLE IF NOT EXISTS rfqs (
  id                  TEXT PRIMARY KEY,
  company_id          TEXT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  opportunity_id      TEXT NOT NULL REFERENCES opportunities(id) ON DELETE RESTRICT,
  supplier_id         TEXT NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
  specification       JSONB NOT NULL,
  -- Stored verbatim: the exact text sent to a real third party is an audit
  -- artefact, not a template to re-render later.
  message_body        TEXT NOT NULL,
  channel             TEXT NOT NULL CHECK (channel IN (
                        'email','platform_message','phone','web_form','whatsapp','wechat')),
  status              TEXT NOT NULL CHECK (status IN (
                        'draft','pending_approval','approved','sending','sent','delivery_failed',
                        'acknowledged','quoted','declined','expired','cancelled')),
  approval_id         TEXT REFERENCES approvals(id) ON DELETE SET NULL,
  sent_at             TIMESTAMPTZ,
  -- Proof the send actually happened, from the provider.
  external_message_id TEXT,
  delivery_error      TEXT,
  responded_at        TIMESTAMPTZ,
  expires_at          TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Outbound contact with a real supplier requires a recorded approval.
  CONSTRAINT rfqs_sent_requires_approval CHECK (
    status NOT IN ('sending','sent','acknowledged','quoted') OR approval_id IS NOT NULL
  ),
  -- A "sent" RFQ must have provider evidence that it was sent.
  CONSTRAINT rfqs_sent_has_evidence CHECK (
    status NOT IN ('sent','acknowledged','quoted') OR (sent_at IS NOT NULL AND external_message_id IS NOT NULL)
  )
);

DROP TRIGGER IF EXISTS rfqs_updated_at ON rfqs;
CREATE TRIGGER rfqs_updated_at BEFORE UPDATE ON rfqs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX IF NOT EXISTS rfqs_opportunity_idx ON rfqs (opportunity_id, status);
CREATE INDEX IF NOT EXISTS rfqs_awaiting_reply_idx
  ON rfqs (company_id, sent_at) WHERE status IN ('sent','acknowledged');
CREATE UNIQUE INDEX IF NOT EXISTS rfqs_one_open_per_supplier_idx
  ON rfqs (opportunity_id, supplier_id)
  WHERE status NOT IN ('cancelled','expired','declined');

CREATE TABLE IF NOT EXISTS supplier_quotes (
  id                                 TEXT PRIMARY KEY,
  company_id                         TEXT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  rfq_id                             TEXT NOT NULL REFERENCES rfqs(id) ON DELETE RESTRICT,
  supplier_id                        TEXT NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
  -- How the quote reached us. Every value names a channel that leaves a trace.
  received_via                       TEXT NOT NULL CHECK (received_via IN (
                                       'provider_api','email_inbound','browser_session',
                                       'human_expert_relay','manual_entry')),
  raw_response_ref                   TEXT,
  received_at                        TIMESTAMPTZ NOT NULL,
  currency                           TEXT NOT NULL CHECK (char_length(currency) = 3),
  price_tiers                        JSONB NOT NULL,
  moq                                INTEGER NOT NULL CHECK (moq > 0),
  sample_cost_minor                  BIGINT CHECK (sample_cost_minor IS NULL OR sample_cost_minor >= 0),
  sample_lead_time_days              INTEGER CHECK (sample_lead_time_days IS NULL OR sample_lead_time_days >= 0),
  tooling_setup_cost_minor           BIGINT NOT NULL DEFAULT 0 CHECK (tooling_setup_cost_minor >= 0),
  customisation_cost_per_unit_minor  BIGINT NOT NULL DEFAULT 0 CHECK (customisation_cost_per_unit_minor >= 0),
  packaging_cost_per_unit_minor      BIGINT NOT NULL DEFAULT 0 CHECK (packaging_cost_per_unit_minor >= 0),
  production_lead_time_days          INTEGER NOT NULL CHECK (production_lead_time_days > 0),
  incoterm                           TEXT NOT NULL CHECK (incoterm IN (
                                       'EXW','FCA','FOB','CFR','CIF','CPT','CIP','DAP','DPU','DDP')),
  origin_port                        TEXT,
  payment_terms                      TEXT,
  valid_until                        TIMESTAMPTZ,
  notes                              TEXT,
  verified_by_engagement_id          TEXT,
  created_at                         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT supplier_quotes_has_tiers CHECK (jsonb_array_length(price_tiers) >= 1)
);

CREATE INDEX IF NOT EXISTS supplier_quotes_rfq_idx ON supplier_quotes (rfq_id, received_at DESC);
CREATE INDEX IF NOT EXISTS supplier_quotes_supplier_idx ON supplier_quotes (supplier_id, received_at DESC);
CREATE INDEX IF NOT EXISTS supplier_quotes_valid_idx
  ON supplier_quotes (company_id, valid_until) WHERE valid_until IS NOT NULL;

CREATE TABLE IF NOT EXISTS landed_cost_models (
  id                   TEXT PRIMARY KEY,
  company_id           TEXT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  opportunity_id       TEXT NOT NULL REFERENCES opportunities(id) ON DELETE RESTRICT,
  quote_id             TEXT REFERENCES supplier_quotes(id) ON DELETE SET NULL,
  order_quantity       INTEGER NOT NULL CHECK (order_quantity > 0),
  currency             TEXT NOT NULL CHECK (char_length(currency) = 3),
  -- Array of {kind, amount, currency, basis, sourceRef, note}. Amounts are
  -- decimal strings at modelling scale so sub-cent per-unit allocations
  -- (tooling spread across a run) survive without float error.
  components           JSONB NOT NULL,
  destination_country  TEXT NOT NULL CHECK (char_length(destination_country) = 2),
  incoterm             TEXT NOT NULL,
  hs_code              TEXT,
  -- Denormalised results, recomputed on write, so reports and gates do not each
  -- re-derive them and risk disagreeing.
  landed_unit_cost     NUMERIC(20, 6) NOT NULL,
  grounded_ratio       DOUBLE PRECISION NOT NULL CHECK (grounded_ratio BETWEEN 0 AND 1),
  assumed_components   TEXT[] NOT NULL DEFAULT '{}',
  computed_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT landed_cost_has_components CHECK (jsonb_array_length(components) >= 1)
);

CREATE INDEX IF NOT EXISTS landed_cost_models_opportunity_idx
  ON landed_cost_models (opportunity_id, computed_at DESC);

CREATE TABLE IF NOT EXISTS sample_orders (
  id                  TEXT PRIMARY KEY,
  company_id          TEXT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  quote_id            TEXT NOT NULL REFERENCES supplier_quotes(id) ON DELETE RESTRICT,
  supplier_id         TEXT NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
  approval_id         TEXT REFERENCES approvals(id) ON DELETE SET NULL,
  quantity            INTEGER NOT NULL CHECK (quantity > 0),
  cost_minor          BIGINT NOT NULL CHECK (cost_minor >= 0),
  currency            TEXT NOT NULL CHECK (char_length(currency) = 3),
  status              TEXT NOT NULL CHECK (status IN (
                        'pending_approval','ordered','in_production','shipped','received',
                        'inspected','passed','failed','cancelled')),
  inspection_criteria JSONB NOT NULL DEFAULT '[]'::jsonb,
  inspection_result   JSONB,
  tracking_number     TEXT,
  ordered_at          TIMESTAMPTZ,
  received_at         TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Spending money with a supplier requires a recorded approval.
  CONSTRAINT sample_orders_purchase_requires_approval CHECK (
    status IN ('pending_approval','cancelled') OR approval_id IS NOT NULL
  )
);

DROP TRIGGER IF EXISTS sample_orders_updated_at ON sample_orders;
CREATE TRIGGER sample_orders_updated_at BEFORE UPDATE ON sample_orders
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX IF NOT EXISTS sample_orders_open_idx
  ON sample_orders (company_id, created_at DESC)
  WHERE status NOT IN ('passed','failed','cancelled');
