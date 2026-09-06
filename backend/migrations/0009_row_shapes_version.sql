-- Which version of the row shapes an analysis was written against (2026-09-07, D38, D39).
--
-- Run once per database that already has data:
--   wrangler d1 execute cliptoaction-staging --remote --env staging \
--     --file=./migrations/0009_row_shapes_version.sql

-- A new kind of table is worth nothing over a notebook that was read before it existed:
-- the rows were never asked for, so the columns are empty and the table looks broken.
-- This column is what lets the app COUNT those reels and offer to re-read them, and then
-- wait to be told yes. Without it there is no way to tell a reel that has nothing to
-- track from one that was never asked (D39).
--
-- NULL means version 1 -- product and tool carried rows and nothing else did -- which is
-- every analysis written before today. Nothing is rewritten by this migration on purpose:
-- re-reading a reel costs somebody's AI allowance, and that is his to spend, not ours.
ALTER TABLE analyses ADD COLUMN shapes_version INTEGER;
