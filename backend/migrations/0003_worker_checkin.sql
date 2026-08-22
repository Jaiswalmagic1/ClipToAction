-- The PC worker has to be visible when it stops (2026-08-22).
--
-- A dead worker is a completely silent failure today: reels sit in 'pending' for ever and
-- nothing on screen says why. Golden Rule 29 applies to the worker itself, not only to the
-- reels it handles.
--
-- Run once per database that already has data:
--   wrangler d1 execute cliptoaction-staging --remote --env staging \
--     --file=./migrations/0003_worker_checkin.sql

-- This belongs to neither a user nor a reel, which is why it needed a table of its own
-- rather than a column bolted onto something unrelated.
--
-- Keyed by id, with '' meaning "the one worker", so a second machine can be added later
-- without a rewrite — D5 requires the worker stay host-agnostic. Same '' idiom that
-- analyses.user_id already uses.
CREATE TABLE IF NOT EXISTS workers (
  id           TEXT PRIMARY KEY,
  last_seen_at INTEGER NOT NULL
);
