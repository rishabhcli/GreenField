-- Foundation: companies, governance, audit, idempotency, webhooks, agent runtime.
--
-- Conventions used throughout this schema:
--   * Enums are TEXT + CHECK rather than Postgres ENUM types. Adding a value to
--     a CHECK is a cheap ALTER; adding one to an ENUM type in a transaction is
--     restricted, and removing one is effectively impossible. The domain here
--     is still evolving, so flexibility wins.
--   * Money is BIGINT minor units plus an explicit TEXT currency column. There
--     is no FLOAT, REAL or MONEY column anywhere in this database.
--   * Timestamps are TIMESTAMPTZ. Every service runs in UTC.
--   * Identifiers are TEXT holding prefixed ULIDs from @foundry/core, so they
--     sort chronologically and are self-describing in logs.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Keeps updated_at honest without every writer remembering to set it.
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

/* -------------------------------------------------------------------------- */
/* Companies                                                                   */
/* -------------------------------------------------------------------------- */

CREATE TABLE IF NOT EXISTS companies (
  id                      TEXT PRIMARY KEY,
  name                    TEXT NOT NULL,
  mission                 TEXT NOT NULL,
  stage                   TEXT NOT NULL CHECK (stage IN (
                            'initialising','researching','evaluating_opportunities','sourcing',
                            'building_brand','building_storefront','pre_launch_qa','launched',
                            'scaling','pivoting','wound_down')),
  -- The full CompanyConfig. Legal documents are generated from this and only
  -- from this, which is why a missing field blocks document generation.
  config                  JSONB NOT NULL,
  selected_opportunity_id TEXT,
  active_brand_id         TEXT,
  active_site_id          TEXT,
  kpi_targets             JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS companies_updated_at ON companies;
CREATE TRIGGER companies_updated_at BEFORE UPDATE ON companies
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS loop_cycles (
  id                    TEXT PRIMARY KEY,
  company_id            TEXT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  cycle_number          INTEGER NOT NULL CHECK (cycle_number > 0),
  phase                 TEXT NOT NULL CHECK (phase IN (
                          'observe','discover','score','expert_validate','select','source',
                          'model_economics','brand','build','qa','launch','market','measure',
                          'decide','replan')),
  status                TEXT NOT NULL CHECK (status IN ('running','blocked','completed','aborted')),
  blocked_reason        TEXT,
  blocked_on_capability TEXT,
  phase_outputs         JSONB NOT NULL DEFAULT '{}'::jsonb,
  ceo_decision          TEXT,
  ceo_decision_rationale TEXT,
  started_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  phase_entered_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at          TIMESTAMPTZ,
  UNIQUE (company_id, cycle_number)
);

CREATE INDEX IF NOT EXISTS loop_cycles_company_status_idx
  ON loop_cycles (company_id, status, cycle_number DESC);

/* -------------------------------------------------------------------------- */
/* Governance                                                                  */
/* -------------------------------------------------------------------------- */

CREATE TABLE IF NOT EXISTS actors (
  id                  TEXT PRIMARY KEY,
  company_id          TEXT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  kind                TEXT NOT NULL CHECK (kind IN (
                        'ceo_agent','manager_agent','specialist_agent','human_operator','system_job')),
  handle              TEXT NOT NULL,
  role_key            TEXT,
  authorities         TEXT[] NOT NULL DEFAULT '{}',
  -- NULL means "no independent spend authority"; every spend needs approval.
  spend_ceiling_minor BIGINT CHECK (spend_ceiling_minor IS NULL OR spend_ceiling_minor >= 0),
  currency            TEXT NOT NULL DEFAULT 'USD' CHECK (char_length(currency) = 3),
  active              BOOLEAN NOT NULL DEFAULT TRUE,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, handle)
);

DROP TRIGGER IF EXISTS actors_updated_at ON actors;
CREATE TRIGGER actors_updated_at BEFORE UPDATE ON actors
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS budgets (
  id                 TEXT PRIMARY KEY,
  company_id         TEXT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  scope              TEXT NOT NULL CHECK (scope IN (
                       'company_total','research','expert_review','sampling','inventory',
                       'advertising','infrastructure','messaging','llm_inference')),
  window_kind        TEXT NOT NULL CHECK (window_kind IN ('daily','weekly','monthly','lifetime')),
  limit_minor        BIGINT NOT NULL CHECK (limit_minor >= 0),
  currency           TEXT NOT NULL CHECK (char_length(currency) = 3),
  reserved_minor     BIGINT NOT NULL DEFAULT 0 CHECK (reserved_minor >= 0),
  spent_minor        BIGINT NOT NULL DEFAULT 0 CHECK (spent_minor >= 0),
  window_started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  warn_at_ratio      DOUBLE PRECISION NOT NULL DEFAULT 0.8 CHECK (warn_at_ratio BETWEEN 0 AND 1),
  hard_stop          BOOLEAN NOT NULL DEFAULT TRUE,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- The invariant that makes a spend cap real rather than advisory.
  CONSTRAINT budgets_not_overcommitted CHECK (reserved_minor + spent_minor <= limit_minor),
  UNIQUE (company_id, scope, window_kind)
);

DROP TRIGGER IF EXISTS budgets_updated_at ON budgets;
CREATE TRIGGER budgets_updated_at BEFORE UPDATE ON budgets
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS approvals (
  id                     TEXT PRIMARY KEY,
  company_id             TEXT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  request                TEXT NOT NULL,
  authority              TEXT NOT NULL,
  requested_by_actor_id  TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
  subject_ref_id         TEXT,
  amount_minor           BIGINT CHECK (amount_minor IS NULL OR amount_minor >= 0),
  currency               TEXT CHECK (currency IS NULL OR char_length(currency) = 3),
  evidence_refs          TEXT[] NOT NULL DEFAULT '{}',
  risk_notes             TEXT[] NOT NULL DEFAULT '{}',
  status                 TEXT NOT NULL CHECK (status IN ('pending','approved','rejected','expired','auto_approved')),
  decided_by             TEXT,
  decided_at             TIMESTAMPTZ,
  decision_rationale     TEXT,
  expires_at             TIMESTAMPTZ NOT NULL,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- A decided approval must record who decided and when.
  CONSTRAINT approvals_decision_complete CHECK (
    status IN ('pending','expired') OR (decided_by IS NOT NULL AND decided_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS approvals_pending_idx
  ON approvals (company_id, created_at DESC) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS approvals_subject_idx ON approvals (subject_ref_id) WHERE subject_ref_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS kill_switches (
  id           TEXT PRIMARY KEY,
  company_id   TEXT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  scope        TEXT NOT NULL CHECK (scope IN (
                 'all','outbound_spend','supplier_contact','customer_messaging','marketing_messaging',
                 'ad_spend','site_publishing','payments_capture','fulfilment','agent_execution','external_browsing')),
  engaged      BOOLEAN NOT NULL,
  reason       TEXT NOT NULL,
  engaged_by   TEXT NOT NULL,
  engaged_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  released_by  TEXT,
  released_at  TIMESTAMPTZ
);

-- Only one engaged switch per scope at a time; history is retained by keeping
-- released rows, which have engaged = FALSE.
CREATE UNIQUE INDEX IF NOT EXISTS kill_switches_engaged_unique
  ON kill_switches (company_id, scope) WHERE engaged;
CREATE INDEX IF NOT EXISTS kill_switches_history_idx ON kill_switches (company_id, scope, engaged_at DESC);

CREATE TABLE IF NOT EXISTS policy_decisions (
  id              TEXT PRIMARY KEY,
  company_id      TEXT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  actor_id        TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
  authority       TEXT NOT NULL,
  action          TEXT NOT NULL,
  subject_ref_id  TEXT,
  amount_minor    BIGINT,
  currency        TEXT,
  outcome         TEXT NOT NULL CHECK (outcome IN ('allow','require_approval','deny')),
  reasons         JSONB NOT NULL,
  approval_id     TEXT REFERENCES approvals(id) ON DELETE SET NULL,
  decided_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS policy_decisions_company_time_idx ON policy_decisions (company_id, decided_at DESC);
CREATE INDEX IF NOT EXISTS policy_decisions_denied_idx
  ON policy_decisions (company_id, decided_at DESC) WHERE outcome = 'deny';

/* -------------------------------------------------------------------------- */
/* Audit — append only                                                         */
/* -------------------------------------------------------------------------- */

-- No UPDATE or DELETE path exists in the repository API for this table, and the
-- hash chain makes an out-of-band edit detectable: each row's hash covers the
-- previous row's hash, so changing any historical row breaks every hash after it.
CREATE TABLE IF NOT EXISTS audit_events (
  id             TEXT PRIMARY KEY,
  company_id     TEXT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  kind           TEXT NOT NULL,
  actor_id       TEXT NOT NULL,
  actor_kind     TEXT NOT NULL,
  action         TEXT NOT NULL,
  subject_type   TEXT,
  subject_ref_id TEXT,
  outcome        TEXT NOT NULL CHECK (outcome IN ('success','failure','denied','pending')),
  detail         JSONB NOT NULL DEFAULT '{}'::jsonb,
  amount_minor   BIGINT,
  currency       TEXT,
  previous_hash  TEXT,
  hash           TEXT NOT NULL,
  occurred_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Monotonic per-company position, so the chain has a definite order even when
  -- two events share a timestamp.
  chain_position BIGINT NOT NULL,
  UNIQUE (company_id, chain_position),
  UNIQUE (company_id, hash)
);

CREATE INDEX IF NOT EXISTS audit_events_company_time_idx ON audit_events (company_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS audit_events_subject_idx ON audit_events (subject_ref_id, occurred_at DESC)
  WHERE subject_ref_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS audit_events_kind_idx ON audit_events (company_id, kind, occurred_at DESC);

-- Belt and braces: refuse UPDATE/DELETE at the database level too, so a
-- mistaken ad-hoc psql session cannot quietly rewrite history.
CREATE OR REPLACE FUNCTION forbid_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'Table % is append-only; % is not permitted', TG_TABLE_NAME, TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_events_append_only ON audit_events;
CREATE TRIGGER audit_events_append_only
  BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

/* -------------------------------------------------------------------------- */
/* Integration verification                                                    */
/* -------------------------------------------------------------------------- */

-- The only table that may promote a capability to "live_verified". Rows are
-- written exclusively by the verification harness after a real, dated,
-- non-destructive call against the provider.
CREATE TABLE IF NOT EXISTS integration_verifications (
  id           TEXT PRIMARY KEY,
  provider     TEXT NOT NULL,
  capability   TEXT,
  succeeded    BOOLEAN NOT NULL,
  detail       TEXT NOT NULL,
  evidence     JSONB NOT NULL DEFAULT '{}'::jsonb,
  environment  TEXT NOT NULL CHECK (environment IN ('production','staging','preview')),
  checked_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS integration_verifications_latest_idx
  ON integration_verifications (provider, environment, checked_at DESC);

/* -------------------------------------------------------------------------- */
/* Idempotency ledger                                                          */
/* -------------------------------------------------------------------------- */

-- Several integrated providers (Dodo, Terac, Replay, Render, BAND) publish no
-- idempotency header. This table is how the platform stays idempotent anyway:
-- a caller claims a key before acting and records the result against it, so a
-- retried job replays instead of duplicating a charge, an RFQ or a purchase.
CREATE TABLE IF NOT EXISTS idempotency_keys (
  key           TEXT PRIMARY KEY,
  scope         TEXT NOT NULL,
  company_id    TEXT,
  status        TEXT NOT NULL CHECK (status IN ('in_progress','completed','failed')),
  request_hash  TEXT,
  result        JSONB,
  error         TEXT,
  attempts      INTEGER NOT NULL DEFAULT 1 CHECK (attempts > 0),
  claimed_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at  TIMESTAMPTZ,
  -- Stale in-progress claims are reclaimable after this instant, so a worker
  -- that died mid-operation does not wedge the key forever.
  lease_expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idempotency_keys_scope_idx ON idempotency_keys (scope, claimed_at DESC);
CREATE INDEX IF NOT EXISTS idempotency_keys_stale_idx
  ON idempotency_keys (lease_expires_at) WHERE status = 'in_progress';

/* -------------------------------------------------------------------------- */
/* Webhook events                                                              */
/* -------------------------------------------------------------------------- */

-- The unique constraint on (provider, external_event_id) is the webhook
-- deduplication mechanism. Every payment provider redelivers; without this a
-- redelivered charge.refunded would refund twice in the ledger.
CREATE TABLE IF NOT EXISTS webhook_events (
  id                 TEXT PRIMARY KEY,
  provider           TEXT NOT NULL,
  external_event_id  TEXT NOT NULL,
  event_type         TEXT NOT NULL,
  signature_verified BOOLEAN NOT NULL,
  payload            JSONB NOT NULL,
  headers            JSONB NOT NULL DEFAULT '{}'::jsonb,
  status             TEXT NOT NULL DEFAULT 'received'
                       CHECK (status IN ('received','processing','processed','failed','ignored')),
  process_attempts   INTEGER NOT NULL DEFAULT 0,
  last_error         TEXT,
  company_id         TEXT,
  received_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at       TIMESTAMPTZ,
  UNIQUE (provider, external_event_id)
);

CREATE INDEX IF NOT EXISTS webhook_events_unprocessed_idx
  ON webhook_events (provider, received_at) WHERE status IN ('received','failed');
CREATE INDEX IF NOT EXISTS webhook_events_type_idx ON webhook_events (provider, event_type, received_at DESC);

/* -------------------------------------------------------------------------- */
/* Agent runtime                                                               */
/* -------------------------------------------------------------------------- */

CREATE TABLE IF NOT EXISTS agent_runs (
  id                   TEXT PRIMARY KEY,
  company_id           TEXT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  role_key             TEXT NOT NULL,
  parent_run_id        TEXT REFERENCES agent_runs(id) ON DELETE SET NULL,
  objective            TEXT NOT NULL,
  input_refs           JSONB NOT NULL DEFAULT '{}'::jsonb,
  status               TEXT NOT NULL CHECK (status IN (
                         'queued','running','awaiting_tool','awaiting_approval','awaiting_human',
                         'succeeded','failed','cancelled','timed_out')),
  model                TEXT NOT NULL,
  output               JSONB,
  error                TEXT,
  tool_call_count      INTEGER NOT NULL DEFAULT 0,
  input_tokens         BIGINT NOT NULL DEFAULT 0,
  output_tokens        BIGINT NOT NULL DEFAULT 0,
  cost_minor_usd       BIGINT NOT NULL DEFAULT 0,
  coordination_room_id TEXT,
  sandbox_id           TEXT,
  started_at           TIMESTAMPTZ,
  finished_at          TIMESTAMPTZ,
  deadline_at          TIMESTAMPTZ NOT NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS agent_runs_updated_at ON agent_runs;
CREATE TRIGGER agent_runs_updated_at BEFORE UPDATE ON agent_runs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX IF NOT EXISTS agent_runs_company_status_idx ON agent_runs (company_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS agent_runs_role_idx ON agent_runs (company_id, role_key, created_at DESC);
CREATE INDEX IF NOT EXISTS agent_runs_parent_idx ON agent_runs (parent_run_id) WHERE parent_run_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS agent_runs_overdue_idx
  ON agent_runs (deadline_at) WHERE status IN ('queued','running','awaiting_tool');

CREATE TABLE IF NOT EXISTS agent_messages (
  id          TEXT PRIMARY KEY,
  run_id      TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  sequence    INTEGER NOT NULL CHECK (sequence >= 0),
  role        TEXT NOT NULL CHECK (role IN ('system','user','assistant','tool_result')),
  content     JSONB NOT NULL,
  tool_name   TEXT,
  tool_use_id TEXT,
  is_error    BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (run_id, sequence)
);

CREATE INDEX IF NOT EXISTS agent_messages_run_idx ON agent_messages (run_id, sequence);

CREATE TABLE IF NOT EXISTS sandboxes (
  id            TEXT PRIMARY KEY,
  company_id    TEXT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  provider      TEXT NOT NULL CHECK (provider IN ('superserve','sandbox0','solari')),
  external_id   TEXT NOT NULL,
  purpose       TEXT NOT NULL,
  run_id        TEXT REFERENCES agent_runs(id) ON DELETE SET NULL,
  status        TEXT NOT NULL CHECK (status IN ('creating','active','paused','terminated','failed')),
  -- Egress policy actually applied, so a security review can read what was
  -- enforced rather than what was intended.
  egress_policy JSONB,
  preview_url   TEXT,
  metadata      JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  terminated_at TIMESTAMPTZ,
  UNIQUE (provider, external_id)
);

DROP TRIGGER IF EXISTS sandboxes_updated_at ON sandboxes;
CREATE TRIGGER sandboxes_updated_at BEFORE UPDATE ON sandboxes
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX IF NOT EXISTS sandboxes_active_idx ON sandboxes (company_id, provider) WHERE status = 'active';
