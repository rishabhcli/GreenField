-- Audience segments: who a campaign is aimed at, and the evidence that says so.
--
-- Before this table, `experiments.audience_spec` was an untyped JSONB bag that
-- nothing ever populated, while the Meta launch path correctly refused to build
-- an ad set without `audience_spec.targeting`. Every experiment the agents could
-- create was therefore unlaunchable. A segment is the row that closes that gap.
--
-- The `audience_segments_has_evidence` constraint is the point of the table: a
-- segment must cite the evidence it was derived from. Targeting spend at a
-- demographic a model guessed is the same class of error as reporting a sale
-- that did not happen, and it costs real money.
--
-- Conventions follow 0001_foundation.sql: TEXT + CHECK instead of ENUM, TEXT
-- ULID identifiers, TIMESTAMPTZ, and set_updated_at() to keep updated_at honest.

CREATE TABLE IF NOT EXISTS audience_segments (
  id                    TEXT PRIMARY KEY,
  company_id            TEXT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  -- Null until an opportunity is selected; a segment can be researched before
  -- the company commits to what it is selling.
  opportunity_id        TEXT REFERENCES opportunities(id) ON DELETE SET NULL,
  name                  TEXT NOT NULL,
  description           TEXT NOT NULL,

  -- Geo, age and gender are stored as columns rather than inside a blob because
  -- they are queried when picking a segment and validated on write.
  geo                   JSONB NOT NULL,
  age_min               INTEGER NOT NULL CHECK (age_min BETWEEN 13 AND 65),
  age_max               INTEGER NOT NULL CHECK (age_max BETWEEN 13 AND 65),
  gender                TEXT NOT NULL CHECK (gender IN ('all','male','female')),

  interests             JSONB NOT NULL DEFAULT '[]'::jsonb,
  languages             JSONB NOT NULL DEFAULT '[]'::jsonb,

  -- The grounding record. evidence_ids are ids from evidence_items.
  evidence_ids          JSONB NOT NULL,
  grounded              BOOLEAN NOT NULL DEFAULT false,

  -- Only ever written from a platform reach estimate. Never computed by us.
  estimated_reach_lower BIGINT CHECK (estimated_reach_lower >= 0),
  estimated_reach_upper BIGINT CHECK (estimated_reach_upper >= 0),

  status                TEXT NOT NULL CHECK (status IN ('draft','active','retired')),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT audience_segments_age_order CHECK (age_max >= age_min),
  -- An audience nobody observed is an invention. At least one evidence row.
  CONSTRAINT audience_segments_has_evidence CHECK (jsonb_array_length(evidence_ids) >= 1),
  -- At least one country, or the segment cannot be projected to a platform.
  CONSTRAINT audience_segments_has_country CHECK (jsonb_array_length(geo -> 'countries') >= 1),
  CONSTRAINT audience_segments_reach_order CHECK (
    estimated_reach_lower IS NULL
    OR estimated_reach_upper IS NULL
    OR estimated_reach_upper >= estimated_reach_lower
  )
);

DROP TRIGGER IF EXISTS audience_segments_updated_at ON audience_segments;
CREATE TRIGGER audience_segments_updated_at BEFORE UPDATE ON audience_segments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX IF NOT EXISTS audience_segments_company_status_idx
  ON audience_segments (company_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS audience_segments_opportunity_idx
  ON audience_segments (opportunity_id) WHERE opportunity_id IS NOT NULL;

-- Experiments point at the segment they target. Nullable because rows created
-- before this migration have no segment, and because organic/email/sms
-- experiments may carry an audience definition without an ads platform.
ALTER TABLE experiments
  ADD COLUMN IF NOT EXISTS audience_segment_id TEXT
  REFERENCES audience_segments(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS experiments_audience_segment_idx
  ON experiments (audience_segment_id) WHERE audience_segment_id IS NOT NULL;
