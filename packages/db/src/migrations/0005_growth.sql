-- Growth, support and finance.
--
-- Two rules the schema enforces:
--   * No ad spend on unreviewed creative. `experiment_arms` cannot go live
--     unless its concept reached `human_approved`, and the concept cannot reach
--     that state without an expert review row behind it.
--   * The ledger is double entry. Every economic event is a transaction whose
--     legs sum to zero per currency, checked in application code before write
--     and re-checkable at any time by the data-integrity job.

CREATE TABLE IF NOT EXISTS creative_concepts (
  id             TEXT PRIMARY KEY,
  company_id     TEXT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  brand_id       TEXT NOT NULL REFERENCES brand_identities(id) ON DELETE RESTRICT,
  -- The specific belief this creative tests. A variant with no hypothesis is a
  -- cosmetic rewrite, and the experiment agent rejects it.
  hypothesis     TEXT NOT NULL,
  angle          TEXT NOT NULL,
  hook           TEXT NOT NULL,
  primary_text   TEXT NOT NULL,
  headline       TEXT NOT NULL,
  description    TEXT,
  call_to_action TEXT NOT NULL,
  asset_ids      TEXT[] NOT NULL DEFAULT '{}',
  landing_path   TEXT NOT NULL,
  claims_used    TEXT[] NOT NULL DEFAULT '{}',
  platform       TEXT NOT NULL CHECK (platform IN ('meta','google','organic','email','sms')),
  status         TEXT NOT NULL CHECK (status IN (
                   'draft','claims_check_failed','awaiting_human_review','human_rejected',
                   'human_approved','live','paused','retired')),
  review_ids     TEXT[] NOT NULL DEFAULT '{}',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Human review is a precondition for spend, not a nice-to-have.
  CONSTRAINT creative_concepts_approved_has_review CHECK (
    status NOT IN ('human_approved','live') OR array_length(review_ids, 1) >= 1
  )
);

DROP TRIGGER IF EXISTS creative_concepts_updated_at ON creative_concepts;
CREATE TRIGGER creative_concepts_updated_at BEFORE UPDATE ON creative_concepts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX IF NOT EXISTS creative_concepts_brand_status_idx
  ON creative_concepts (brand_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS creative_concepts_awaiting_review_idx
  ON creative_concepts (company_id, created_at) WHERE status = 'awaiting_human_review';

CREATE TABLE IF NOT EXISTS experiments (
  id                 TEXT PRIMARY KEY,
  company_id         TEXT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  brand_id           TEXT NOT NULL REFERENCES brand_identities(id) ON DELETE RESTRICT,
  name               TEXT NOT NULL,
  hypothesis         TEXT NOT NULL,
  platform           TEXT NOT NULL CHECK (platform IN ('meta','google','organic','email','sms')),
  objective          TEXT NOT NULL CHECK (objective IN (
                       'purchases','contribution_margin','add_to_cart','checkout_start','lead',
                       'click_through_rate')),
  audience_spec      JSONB NOT NULL,
  total_budget_minor BIGINT NOT NULL CHECK (total_budget_minor >= 0),
  currency           TEXT NOT NULL CHECK (char_length(currency) = 3),
  -- Every experiment must declare in advance when it stops. Running until
  -- someone notices is how ad budgets disappear.
  stop_conditions    JSONB NOT NULL,
  attribution_model  TEXT NOT NULL CHECK (attribution_model IN (
                       'platform_reported','first_party_click_id','blended')),
  status             TEXT NOT NULL CHECK (status IN (
                       'draft','pending_approval','approved','running','paused','concluded','aborted')),
  approval_id        TEXT REFERENCES approvals(id) ON DELETE SET NULL,
  started_at         TIMESTAMPTZ,
  ended_at           TIMESTAMPTZ,
  conclusion         TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT experiments_has_stop_conditions CHECK (jsonb_array_length(stop_conditions) >= 1),
  CONSTRAINT experiments_running_requires_approval CHECK (
    status NOT IN ('approved','running') OR approval_id IS NOT NULL
  )
);

DROP TRIGGER IF EXISTS experiments_updated_at ON experiments;
CREATE TRIGGER experiments_updated_at BEFORE UPDATE ON experiments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX IF NOT EXISTS experiments_running_idx
  ON experiments (company_id, started_at DESC) WHERE status = 'running';

CREATE TABLE IF NOT EXISTS experiment_arms (
  id                  TEXT PRIMARY KEY,
  experiment_id       TEXT NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,
  name                TEXT NOT NULL,
  creative_concept_id TEXT NOT NULL REFERENCES creative_concepts(id) ON DELETE RESTRICT,
  landing_path        TEXT NOT NULL,
  external_refs       JSONB NOT NULL DEFAULT '{}'::jsonb,
  daily_budget_minor  BIGINT NOT NULL CHECK (daily_budget_minor >= 0),
  status              TEXT NOT NULL CHECK (status IN (
                        'draft','pending_review','ready','live','paused','stopped','winner','loser')),
  stop_reason         TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (experiment_id, name),
  CONSTRAINT experiment_arms_stopped_has_reason CHECK (
    status NOT IN ('stopped','loser') OR stop_reason IS NOT NULL
  )
);

DROP TRIGGER IF EXISTS experiment_arms_updated_at ON experiment_arms;
CREATE TRIGGER experiment_arms_updated_at BEFORE UPDATE ON experiment_arms
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX IF NOT EXISTS experiment_arms_live_idx ON experiment_arms (experiment_id) WHERE status = 'live';

-- A live arm must point at human-approved creative. Enforced by trigger because
-- the check spans two tables.
CREATE OR REPLACE FUNCTION assert_arm_creative_reviewed()
RETURNS TRIGGER AS $$
DECLARE
  concept_status TEXT;
BEGIN
  IF NEW.status NOT IN ('live', 'ready') THEN
    RETURN NEW;
  END IF;
  SELECT status INTO concept_status FROM creative_concepts WHERE id = NEW.creative_concept_id;
  IF concept_status IS NULL THEN
    RAISE EXCEPTION 'Creative concept % does not exist', NEW.creative_concept_id;
  END IF;
  IF concept_status NOT IN ('human_approved', 'live') THEN
    RAISE EXCEPTION
      'Arm % cannot be % because creative concept % is "%" — human expert review is required before any spend',
      NEW.id, NEW.status, NEW.creative_concept_id, concept_status;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS experiment_arms_require_review ON experiment_arms;
CREATE TRIGGER experiment_arms_require_review
  BEFORE INSERT OR UPDATE ON experiment_arms
  FOR EACH ROW EXECUTE FUNCTION assert_arm_creative_reviewed();

CREATE TABLE IF NOT EXISTS metric_snapshots (
  id                         TEXT PRIMARY KEY,
  company_id                 TEXT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  scope                      TEXT NOT NULL CHECK (scope IN ('experiment','arm','campaign','site','company')),
  scope_ref_id               TEXT NOT NULL,
  -- Which system produced these counts. Platform-reported conversions and
  -- webhook-confirmed orders are never silently blended.
  source                     TEXT NOT NULL CHECK (source IN (
                               'platform_api','first_party','payment_provider','blended')),
  window_start               TIMESTAMPTZ NOT NULL,
  window_end                 TIMESTAMPTZ NOT NULL,
  currency                   TEXT NOT NULL CHECK (char_length(currency) = 3),
  impressions                BIGINT NOT NULL DEFAULT 0 CHECK (impressions >= 0),
  reach                      BIGINT NOT NULL DEFAULT 0 CHECK (reach >= 0),
  clicks                     BIGINT NOT NULL DEFAULT 0 CHECK (clicks >= 0),
  spend_minor                BIGINT NOT NULL DEFAULT 0 CHECK (spend_minor >= 0),
  landing_page_views         BIGINT NOT NULL DEFAULT 0 CHECK (landing_page_views >= 0),
  add_to_carts               BIGINT NOT NULL DEFAULT 0 CHECK (add_to_carts >= 0),
  checkout_starts            BIGINT NOT NULL DEFAULT 0 CHECK (checkout_starts >= 0),
  purchases                  BIGINT NOT NULL DEFAULT 0 CHECK (purchases >= 0),
  revenue_minor              BIGINT NOT NULL DEFAULT 0 CHECK (revenue_minor >= 0),
  refunds_minor              BIGINT NOT NULL DEFAULT 0 CHECK (refunds_minor >= 0),
  contribution_margin_minor  BIGINT NOT NULL DEFAULT 0,
  repeat_purchases           BIGINT NOT NULL DEFAULT 0 CHECK (repeat_purchases >= 0),
  support_contacts           BIGINT NOT NULL DEFAULT 0 CHECK (support_contacts >= 0),
  collected_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT metric_snapshots_window_ordered CHECK (window_end > window_start),
  -- Re-collecting the same window from the same source replaces rather than
  -- accumulates, which is what stops double-counted spend.
  UNIQUE (scope, scope_ref_id, source, window_start, window_end)
);

CREATE INDEX IF NOT EXISTS metric_snapshots_scope_idx
  ON metric_snapshots (scope, scope_ref_id, window_end DESC);
CREATE INDEX IF NOT EXISTS metric_snapshots_company_idx ON metric_snapshots (company_id, collected_at DESC);

/* -------------------------------------------------------------------------- */
/* Support                                                                     */
/* -------------------------------------------------------------------------- */

CREATE TABLE IF NOT EXISTS tickets (
  id                    TEXT PRIMARY KEY,
  company_id            TEXT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  customer_id           TEXT REFERENCES customers(id) ON DELETE SET NULL,
  order_id              TEXT REFERENCES orders(id) ON DELETE SET NULL,
  channel               TEXT NOT NULL CHECK (channel IN ('imessage','rcs','sms','voice','email','web_form')),
  external_chat_id      TEXT,
  subject               TEXT NOT NULL,
  intent                TEXT NOT NULL,
  intent_confidence     DOUBLE PRECISION NOT NULL CHECK (intent_confidence BETWEEN 0 AND 1),
  status                TEXT NOT NULL CHECK (status IN (
                          'open','awaiting_customer','awaiting_internal','escalated_to_human',
                          'resolved','closed')),
  priority              TEXT NOT NULL CHECK (priority IN ('low','normal','high','urgent')),
  escalation_reason     TEXT,
  escalated_at          TIMESTAMPTZ,
  assigned_role_key     TEXT,
  assigned_human        TEXT,
  resolution            TEXT,
  resolution_cost_minor BIGINT NOT NULL DEFAULT 0 CHECK (resolution_cost_minor >= 0),
  currency              TEXT,
  first_response_at     TIMESTAMPTZ,
  resolved_at           TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT tickets_escalated_has_reason CHECK (
    status <> 'escalated_to_human' OR escalation_reason IS NOT NULL
  )
);

DROP TRIGGER IF EXISTS tickets_updated_at ON tickets;
CREATE TRIGGER tickets_updated_at BEFORE UPDATE ON tickets
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX IF NOT EXISTS tickets_open_idx
  ON tickets (company_id, priority, created_at) WHERE status IN ('open','awaiting_internal');
CREATE INDEX IF NOT EXISTS tickets_escalated_idx
  ON tickets (company_id, escalated_at DESC) WHERE status = 'escalated_to_human';
CREATE INDEX IF NOT EXISTS tickets_chat_idx ON tickets (external_chat_id) WHERE external_chat_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS support_messages (
  id                  TEXT PRIMARY KEY,
  company_id          TEXT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  ticket_id           TEXT REFERENCES tickets(id) ON DELETE SET NULL,
  customer_id         TEXT REFERENCES customers(id) ON DELETE SET NULL,
  channel             TEXT NOT NULL CHECK (channel IN ('imessage','rcs','sms','voice','email','web_form')),
  direction           TEXT NOT NULL CHECK (direction IN ('inbound','outbound')),
  provider            TEXT NOT NULL,
  external_chat_id    TEXT,
  external_message_id TEXT,
  from_handle         TEXT NOT NULL,
  to_handle           TEXT NOT NULL,
  body                TEXT NOT NULL,
  attachments         JSONB NOT NULL DEFAULT '[]'::jsonb,
  status              TEXT NOT NULL CHECK (status IN (
                        'queued','sent','delivered','read','failed','blocked_opt_out','rejected')),
  failure_code        TEXT,
  failure_reason      TEXT,
  -- Which agent run authored an outbound message. Accountability for anything
  -- said to a real customer.
  authored_by_run_id  TEXT REFERENCES agent_runs(id) ON DELETE SET NULL,
  authored_by_human   TEXT,
  sent_at             TIMESTAMPTZ,
  delivered_at        TIMESTAMPTZ,
  read_at             TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT support_messages_outbound_has_author CHECK (
    direction = 'inbound' OR authored_by_run_id IS NOT NULL OR authored_by_human IS NOT NULL
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS support_messages_external_idx
  ON support_messages (provider, external_message_id) WHERE external_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS support_messages_ticket_idx ON support_messages (ticket_id, created_at);
CREATE INDEX IF NOT EXISTS support_messages_chat_idx ON support_messages (external_chat_id, created_at);

/* -------------------------------------------------------------------------- */
/* Finance                                                                     */
/* -------------------------------------------------------------------------- */

CREATE TABLE IF NOT EXISTS ledger_entries (
  id             TEXT PRIMARY KEY,
  company_id     TEXT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  -- Groups the legs of one economic event; the legs must net to zero.
  transaction_id TEXT NOT NULL,
  account        TEXT NOT NULL CHECK (account IN (
                   'cash_in_transit','cash_settled','inventory','prepaid_supplier',
                   'refunds_payable','tax_payable','disputes_reserved',
                   'product_revenue','shipping_revenue','discounts','refunds_issued',
                   'cogs_landed','payment_fees','fulfilment_costs','advertising_spend',
                   'expert_review_spend','infrastructure_spend','llm_inference_spend',
                   'messaging_spend','sampling_spend')),
  -- Positive = debit, negative = credit.
  amount_minor   BIGINT NOT NULL,
  currency       TEXT NOT NULL CHECK (char_length(currency) = 3),
  description    TEXT NOT NULL,
  source_type    TEXT NOT NULL,
  source_ref_id  TEXT NOT NULL,
  settled        BOOLEAN NOT NULL DEFAULT FALSE,
  occurred_at    TIMESTAMPTZ NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ledger_entries_nonzero CHECK (amount_minor <> 0)
);

CREATE INDEX IF NOT EXISTS ledger_entries_transaction_idx ON ledger_entries (transaction_id);
CREATE INDEX IF NOT EXISTS ledger_entries_account_idx ON ledger_entries (company_id, account, occurred_at DESC);
CREATE INDEX IF NOT EXISTS ledger_entries_source_idx ON ledger_entries (source_type, source_ref_id);
CREATE INDEX IF NOT EXISTS ledger_entries_unsettled_idx
  ON ledger_entries (company_id, occurred_at) WHERE settled = FALSE;

DROP TRIGGER IF EXISTS ledger_entries_append_only ON ledger_entries;
CREATE TRIGGER ledger_entries_append_only
  BEFORE DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Reads the books at any point in time. Used by the data-integrity checker to
-- prove the ledger balances, which is the one accounting invariant that must
-- never be merely assumed.
CREATE OR REPLACE VIEW ledger_transaction_balance AS
SELECT
  company_id,
  transaction_id,
  currency,
  SUM(amount_minor) AS net_minor,
  COUNT(*)          AS leg_count,
  MIN(occurred_at)  AS occurred_at
FROM ledger_entries
GROUP BY company_id, transaction_id, currency;

CREATE TABLE IF NOT EXISTS legal_documents (
  id               TEXT PRIMARY KEY,
  company_id       TEXT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  site_id          TEXT REFERENCES sites(id) ON DELETE SET NULL,
  kind             TEXT NOT NULL,
  version          INTEGER NOT NULL CHECK (version > 0),
  body_markdown    TEXT NOT NULL,
  -- The exact config snapshot the document was generated from. A policy that
  -- claims a 30-day return window must be traceable to a config that said 30.
  generated_from   JSONB NOT NULL,
  -- Honest status. `counsel_reviewed` can only be set by a human.
  review_status    TEXT NOT NULL DEFAULT 'machine_generated'
                     CHECK (review_status IN ('machine_generated','internal_reviewed','counsel_reviewed')),
  reviewed_by      TEXT,
  reviewed_at      TIMESTAMPTZ,
  effective_from   TIMESTAMPTZ,
  published_url    TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, kind, version),
  CONSTRAINT legal_documents_review_has_reviewer CHECK (
    review_status = 'machine_generated' OR (reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS legal_documents_current_idx ON legal_documents (company_id, kind, version DESC);
