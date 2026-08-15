-- Research: evidence, pain points, the opportunity graph, scorecards and
-- human expert review.
--
-- The provenance columns are not metadata decoration. `source_url`/`external_id`
-- plus `retrieved_at` plus `provenance` are what make an opportunity score
-- auditable back to material that was actually fetched, and the CHECK below
-- refuses a row that has neither a URL nor an external id — there is no way to
-- store an "insight" with no source behind it.

CREATE TABLE IF NOT EXISTS evidence_items (
  id                       TEXT PRIMARY KEY,
  company_id               TEXT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  source_kind              TEXT NOT NULL CHECK (source_kind IN (
                             'reddit_post','reddit_comment','product_review','forum_thread','q_and_a',
                             'video_comment','social_post','news_article','blog_post','marketplace_listing',
                             'support_thread','search_trend','expert_statement','customer_message')),
  source_url               TEXT,
  external_id              TEXT,
  source_domain            TEXT NOT NULL,
  retrieved_at             TIMESTAMPTZ NOT NULL,
  authored_at              TIMESTAMPTZ,
  provenance               JSONB NOT NULL,
  compliance               JSONB NOT NULL,

  excerpt                  TEXT,
  summary                  TEXT NOT NULL,
  language                 TEXT NOT NULL DEFAULT 'en',

  pain_point_labels        TEXT[] NOT NULL DEFAULT '{}',
  category_labels          TEXT[] NOT NULL DEFAULT '{}',
  competitors_mentioned    TEXT[] NOT NULL DEFAULT '{}',

  sentiment                DOUBLE PRECISION NOT NULL CHECK (sentiment BETWEEN -1 AND 1),
  severity                 SMALLINT NOT NULL CHECK (severity BETWEEN 0 AND 10),
  purchase_intent          TEXT NOT NULL CHECK (purchase_intent IN ('none','weak','moderate','strong')),
  workaround_described     BOOLEAN NOT NULL DEFAULT FALSE,
  willingness_to_pay_cents BIGINT CHECK (willingness_to_pay_cents IS NULL OR willingness_to_pay_cents >= 0),
  geography                TEXT,
  engagement_score         INTEGER,

  confidence               DOUBLE PRECISION NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  dedupe_hash              TEXT NOT NULL,
  superseded_by_evidence_id TEXT REFERENCES evidence_items(id) ON DELETE SET NULL,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Evidence must be traceable to something that can be re-fetched.
  CONSTRAINT evidence_has_source CHECK (source_url IS NOT NULL OR external_id IS NOT NULL),
  -- An excerpt may only be stored when the compliance record permits it.
  CONSTRAINT evidence_excerpt_permitted CHECK (
    excerpt IS NULL OR (compliance ->> 'excerptStoragePermitted')::boolean IS TRUE
  )
);

-- Near-duplicate suppression: the same post scraped twice collapses to one row.
CREATE UNIQUE INDEX IF NOT EXISTS evidence_items_dedupe_idx ON evidence_items (company_id, dedupe_hash);
CREATE INDEX IF NOT EXISTS evidence_items_domain_idx ON evidence_items (company_id, source_domain);
CREATE INDEX IF NOT EXISTS evidence_items_labels_idx ON evidence_items USING GIN (pain_point_labels);
CREATE INDEX IF NOT EXISTS evidence_items_category_idx ON evidence_items USING GIN (category_labels);
CREATE INDEX IF NOT EXISTS evidence_items_retrieved_idx ON evidence_items (company_id, retrieved_at DESC);
-- Only high-confidence, non-superseded evidence feeds scoring.
CREATE INDEX IF NOT EXISTS evidence_items_scorable_idx
  ON evidence_items (company_id, confidence DESC)
  WHERE superseded_by_evidence_id IS NULL AND confidence >= 0.5;

CREATE TABLE IF NOT EXISTS pain_points (
  id                        TEXT PRIMARY KEY,
  company_id                TEXT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  label                     TEXT NOT NULL,
  statement                 TEXT NOT NULL,
  segment                   TEXT NOT NULL,
  category_labels           TEXT[] NOT NULL DEFAULT '{}',
  evidence_count            INTEGER NOT NULL DEFAULT 0 CHECK (evidence_count >= 0),
  -- Distinct source domains, not raw item count. This is the anti-echo-chamber
  -- measure the selection gate reads.
  independent_source_count  INTEGER NOT NULL DEFAULT 0 CHECK (independent_source_count >= 0),
  median_severity           DOUBLE PRECISION NOT NULL DEFAULT 0 CHECK (median_severity BETWEEN 0 AND 10),
  purchase_intent_ratio     DOUBLE PRECISION NOT NULL DEFAULT 0 CHECK (purchase_intent_ratio BETWEEN 0 AND 1),
  workaround_ratio          DOUBLE PRECISION NOT NULL DEFAULT 0 CHECK (workaround_ratio BETWEEN 0 AND 1),
  competitors_mentioned     TEXT[] NOT NULL DEFAULT '{}',
  first_observed_at         TIMESTAMPTZ NOT NULL,
  last_observed_at          TIMESTAMPTZ NOT NULL,
  embedding                 DOUBLE PRECISION[],
  status                    TEXT NOT NULL DEFAULT 'candidate'
                              CHECK (status IN ('candidate','validated','rejected','archived')),
  rejection_reason          TEXT,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT pain_points_independent_lte_total CHECK (independent_source_count <= evidence_count),
  UNIQUE (company_id, label)
);

DROP TRIGGER IF EXISTS pain_points_updated_at ON pain_points;
CREATE TRIGGER pain_points_updated_at BEFORE UPDATE ON pain_points
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX IF NOT EXISTS pain_points_ranked_idx
  ON pain_points (company_id, independent_source_count DESC, median_severity DESC)
  WHERE status IN ('candidate','validated');

-- Join table so an evidence item can support several pain points and a pain
-- point can be justified by many items, without array containment scans.
CREATE TABLE IF NOT EXISTS pain_point_evidence (
  pain_point_id TEXT NOT NULL REFERENCES pain_points(id) ON DELETE CASCADE,
  evidence_id   TEXT NOT NULL REFERENCES evidence_items(id) ON DELETE CASCADE,
  similarity    DOUBLE PRECISION,
  linked_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (pain_point_id, evidence_id)
);

CREATE INDEX IF NOT EXISTS pain_point_evidence_by_evidence_idx ON pain_point_evidence (evidence_id);

/* -------------------------------------------------------------------------- */
/* Opportunity graph                                                           */
/* -------------------------------------------------------------------------- */

CREATE TABLE IF NOT EXISTS graph_nodes (
  id         TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  kind       TEXT NOT NULL CHECK (kind IN (
               'pain_point','user_segment','product_concept','competitor','desired_outcome',
               'failure_mode','workaround','price_point','supplier','ad_hypothesis')),
  label      TEXT NOT NULL,
  ref_id     TEXT,
  attributes JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, kind, label)
);

CREATE INDEX IF NOT EXISTS graph_nodes_ref_idx ON graph_nodes (ref_id) WHERE ref_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS graph_edges (
  id           TEXT PRIMARY KEY,
  company_id   TEXT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  kind         TEXT NOT NULL CHECK (kind IN (
                 'experiences','caused_by','currently_solved_by','worked_around_by',
                 'could_be_solved_by','sourceable_from','targeted_by','priced_at','desires')),
  from_node_id TEXT NOT NULL REFERENCES graph_nodes(id) ON DELETE CASCADE,
  to_node_id   TEXT NOT NULL REFERENCES graph_nodes(id) ON DELETE CASCADE,
  weight       DOUBLE PRECISION NOT NULL DEFAULT 1 CHECK (weight BETWEEN 0 AND 1),
  -- The evidence that justifies this edge, so the CEO can always ask "why do we
  -- believe this?" and get sources back.
  evidence_ids TEXT[] NOT NULL DEFAULT '{}',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT graph_edges_no_self_loop CHECK (from_node_id <> to_node_id),
  UNIQUE (company_id, kind, from_node_id, to_node_id)
);

CREATE INDEX IF NOT EXISTS graph_edges_from_idx ON graph_edges (from_node_id, kind);
CREATE INDEX IF NOT EXISTS graph_edges_to_idx ON graph_edges (to_node_id, kind);

/* -------------------------------------------------------------------------- */
/* Opportunities and scoring                                                   */
/* -------------------------------------------------------------------------- */

CREATE TABLE IF NOT EXISTS opportunities (
  id                          TEXT PRIMARY KEY,
  company_id                  TEXT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  title                       TEXT NOT NULL,
  concept                     TEXT NOT NULL,
  pain_point_ids              TEXT[] NOT NULL,
  target_segment              TEXT NOT NULL,
  category                    TEXT NOT NULL,
  value_hypothesis            TEXT NOT NULL,
  assumed_selling_price_cents BIGINT CHECK (assumed_selling_price_cents IS NULL OR assumed_selling_price_cents > 0),
  currency                    TEXT NOT NULL DEFAULT 'USD' CHECK (char_length(currency) = 3),
  stage                       TEXT NOT NULL CHECK (stage IN (
                                'discovered','evidence_gathering','scored','expert_review_requested',
                                'expert_reviewed','sourcing','quoted','economics_modelled','ceo_review',
                                'selected','building','launched','scaling','killed','parked')),
  latest_scorecard_id         TEXT,
  kill_reason                 TEXT,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT opportunities_has_pain_point CHECK (array_length(pain_point_ids, 1) >= 1),
  CONSTRAINT opportunities_killed_has_reason CHECK (stage <> 'killed' OR kill_reason IS NOT NULL)
);

DROP TRIGGER IF EXISTS opportunities_updated_at ON opportunities;
CREATE TRIGGER opportunities_updated_at BEFORE UPDATE ON opportunities
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX IF NOT EXISTS opportunities_stage_idx ON opportunities (company_id, stage, updated_at DESC);
CREATE INDEX IF NOT EXISTS opportunities_live_idx
  ON opportunities (company_id, updated_at DESC)
  WHERE stage NOT IN ('killed','parked');

CREATE TABLE IF NOT EXISTS opportunity_scorecards (
  id                    TEXT PRIMARY KEY,
  opportunity_id        TEXT NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  weight_profile        TEXT NOT NULL,
  dimensions            JSONB NOT NULL,
  overrides             JSONB NOT NULL DEFAULT '[]'::jsonb,
  composite             DOUBLE PRECISION NOT NULL CHECK (composite BETWEEN 0 AND 100),
  grounded_composite    DOUBLE PRECISION NOT NULL CHECK (grounded_composite BETWEEN 0 AND 100),
  -- How much of the score rests on real quotes and platform data rather than
  -- model estimates. The selection gate refuses a score that is mostly guess.
  grounded_weight_ratio DOUBLE PRECISION NOT NULL CHECK (grounded_weight_ratio BETWEEN 0 AND 1),
  computed_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS opportunity_scorecards_latest_idx
  ON opportunity_scorecards (opportunity_id, computed_at DESC);

ALTER TABLE opportunities
  DROP CONSTRAINT IF EXISTS opportunities_latest_scorecard_fk;
ALTER TABLE opportunities
  ADD CONSTRAINT opportunities_latest_scorecard_fk
  FOREIGN KEY (latest_scorecard_id) REFERENCES opportunity_scorecards(id) ON DELETE SET NULL;

/* -------------------------------------------------------------------------- */
/* Human expert review                                                         */
/* -------------------------------------------------------------------------- */

CREATE TABLE IF NOT EXISTS expert_reviews (
  id                          TEXT PRIMARY KEY,
  company_id                  TEXT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  subject                     TEXT NOT NULL CHECK (subject IN (
                                'opportunity_validity','evidence_quality','ad_creative','landing_page',
                                'brand_identity','packaging','pricing','category_compliance',
                                'supplier_quote','legal_escalation')),
  subject_ref_id              TEXT NOT NULL,
  provider                    TEXT NOT NULL,
  external_engagement_id      TEXT,
  external_request_id         TEXT,
  status                      TEXT NOT NULL CHECK (status IN (
                                'requested','pricing_pending','priced','launched','in_progress',
                                'submissions_received','completed','cancelled','failed')),
  question                    TEXT NOT NULL,
  rubric                      JSONB NOT NULL,
  participants_requested      INTEGER NOT NULL CHECK (participants_requested > 0),
  cost_per_participant_minor  BIGINT CHECK (cost_per_participant_minor IS NULL OR cost_per_participant_minor >= 0),
  currency                    TEXT,
  verdict                     TEXT NOT NULL DEFAULT 'pending'
                                CHECK (verdict IN ('pending','approved','approve_with_changes','rejected','inconclusive')),
  mean_scores                 JSONB NOT NULL DEFAULT '{}'::jsonb,
  requested_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at                TIMESTAMPTZ,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS expert_reviews_updated_at ON expert_reviews;
CREATE TRIGGER expert_reviews_updated_at BEFORE UPDATE ON expert_reviews
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX IF NOT EXISTS expert_reviews_subject_idx ON expert_reviews (company_id, subject, subject_ref_id);
CREATE INDEX IF NOT EXISTS expert_reviews_open_idx
  ON expert_reviews (company_id, requested_at)
  WHERE status NOT IN ('completed','cancelled','failed');
CREATE UNIQUE INDEX IF NOT EXISTS expert_reviews_external_idx
  ON expert_reviews (provider, external_engagement_id) WHERE external_engagement_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS expert_review_submissions (
  id                     TEXT PRIMARY KEY,
  expert_review_id       TEXT NOT NULL REFERENCES expert_reviews(id) ON DELETE CASCADE,
  external_submission_id TEXT NOT NULL,
  expert_ref             TEXT NOT NULL,
  attestations           TEXT[] NOT NULL DEFAULT '{}',
  scores                 JSONB NOT NULL,
  critique               TEXT NOT NULL,
  recommendation         TEXT NOT NULL CHECK (recommendation IN ('approve','approve_with_changes','reject')),
  suggested_changes      TEXT[] NOT NULL DEFAULT '{}',
  approved               BOOLEAN NOT NULL,
  submitted_at           TIMESTAMPTZ NOT NULL,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (expert_review_id, external_submission_id)
);

CREATE INDEX IF NOT EXISTS expert_review_submissions_review_idx ON expert_review_submissions (expert_review_id);
