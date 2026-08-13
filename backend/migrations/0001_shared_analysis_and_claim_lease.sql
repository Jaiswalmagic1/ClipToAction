-- Migration for a database created before 2026-08-13.
--
-- schema.sql is all CREATE TABLE IF NOT EXISTS, so re-running it against an existing
-- database silently does nothing — the new columns would never appear and the Worker
-- would fail on every queue claim and every analysis write. Run this instead.
--
--   wrangler d1 execute cliptoaction --remote --file=./migrations/0001_shared_analysis_and_claim_lease.sql
--
-- Skip it entirely on a fresh database: schema.sql already includes everything here.

-- Lease column, so a worker that dies mid-download does not strand the source.
ALTER TABLE sources ADD COLUMN claimed_at INTEGER;

-- analyses gains user_id and a composite primary key: '' means the Worker produced it and
-- it is shared, anything else is one user's copy-paste result. SQLite cannot change a
-- primary key in place, so the table is rebuilt.
ALTER TABLE analyses RENAME TO analyses_old;

CREATE TABLE analyses (
  source_id     TEXT NOT NULL REFERENCES sources (id) ON DELETE CASCADE,
  user_id       TEXT NOT NULL DEFAULT '',
  provider      TEXT NOT NULL,
  model         TEXT,
  summary       TEXT NOT NULL,
  key_points    TEXT NOT NULL,
  learn_more    TEXT NOT NULL,
  claims        TEXT NOT NULL,
  suggested_task TEXT,
  created_at    INTEGER NOT NULL,
  PRIMARY KEY (source_id, user_id)
);

-- Existing rows produced by a connected key stay shared. Existing 'manual' rows cannot be
-- attributed to a user retrospectively — the old table had no user_id — and a paste of
-- unknown origin is exactly what must not be shared, so they are dropped rather than
-- promoted.
INSERT INTO analyses
  (source_id, user_id, provider, model, summary, key_points, learn_more, claims,
   suggested_task, created_at)
SELECT source_id, '', provider, model, summary, key_points, learn_more, claims,
       suggested_task, created_at
FROM analyses_old
WHERE provider != 'manual';

DROP TABLE analyses_old;
