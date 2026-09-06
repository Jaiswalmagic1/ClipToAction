-- What kind of video this is, the rows that kind carries, and why an analysis failed
-- (2026-08-29, D34).
--
-- Run once per database that already has data:
--   wrangler d1 execute cliptoaction-staging --remote --env staging \
--     --file=./migrations/0007_kinds_items_and_error_detail.sql

-- Why the AI refused, in a form that cannot carry a key: the HTTP status and a name from
-- a fixed list in src/analyze.js, or "unrecognised". `sources.error` stays exactly what it
-- was -- a sentence safe to show everyone who saved the reel. This is the part that was
-- being thrown away, which left a real failure with no cause anyone could name.
--
-- NULL means "nothing went wrong", which is every row written before today.
ALTER TABLE sources ADD COLUMN error_detail TEXT;

-- One of: product | tool | tactic | opinion | other. NULL for every analysis written
-- before kinds existed and for any reply that named something else, so an old row and a
-- new untracked one are identical and nothing has to be backfilled.
ALTER TABLE analyses ADD COLUMN kind TEXT;

-- JSON array of rows, and only for kind 'product' or 'tool' -- the two that carry facts
-- worth sorting and ticking off. NULL, never '[]', for the same reason as `sections`.
--   product: [{name, cost, sell_price, where, min_order, note}]
--   tool:    [{name, does, popularity, price, link, install}]
-- Shared with the analysis it belongs to (D10): what a video said about a product is a
-- fact about the video, not about the person who saved it.
ALTER TABLE analyses ADD COLUMN items TEXT;

-- Where the user's own decision about one of those rows lives. Per-user, because "I
-- ordered this" is the opposite of shared -- it is the only part of a tracker that is
-- about the person rather than the video (D10, D18).
--
-- Keyed by item_key, the item's name flattened, and NOT by its position in the list. A
-- re-run analysis puts the rows back in a different order, and a position would then move
-- somebody's "ordered" onto a different product.
--
-- Carries updated_at so delta sync picks it up like every other per-user table (D6).
CREATE TABLE IF NOT EXISTS item_status (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  source_id  TEXT NOT NULL REFERENCES sources (id) ON DELETE CASCADE,
  item_key   TEXT NOT NULL,                 -- the row's name, flattened for matching
  status     TEXT NOT NULL,                 -- want | doing | done | no
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  UNIQUE (user_id, source_id, item_key)
);

CREATE INDEX IF NOT EXISTS idx_item_status_sync ON item_status (user_id, updated_at);
