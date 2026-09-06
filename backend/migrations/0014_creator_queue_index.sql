-- Make the creator backfill's queue cheap to ask about (2026-09-07, D40, amended).
--
-- Run once per database that already has data:
--   wrangler d1 execute cliptoaction-staging --remote --env staging \
--     --file=./migrations/0014_creator_queue_index.sql

-- The PC worker asks "which videos still need a creator?" on every idle poll -- every
-- thirty seconds, for ever. The only index on `sources` is (state, updated_at), which that
-- question cannot use, so each ask was a full table scan and so was the count beside it.
--
-- At ~430 rows that is about 1.2 million rows read a day, roughly a quarter of D1's free
-- daily allowance, spent for ever on a question whose answer is usually zero. D5 says this
-- has to stay free to run; at a few hundred more videos it would not be.
--
-- Partial, so it holds only the rows still waiting and shrinks to nothing as the backfill
-- finishes -- the opposite of the scan it replaces. The columns are in the order the query
-- reads them, so the sort comes out of the index too rather than a temporary b-tree.
CREATE INDEX IF NOT EXISTS idx_sources_creator_todo
  ON sources (creator_tries, created_at DESC)
  WHERE creator IS NULL AND creator_checked_at IS NULL;
