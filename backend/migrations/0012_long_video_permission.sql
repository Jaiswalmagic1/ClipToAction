-- Asking before a very long video is processed (2026-09-07, D42).
--
-- Run once per database that already has data:
--   wrangler d1 execute cliptoaction-staging --remote --env staging \
--     --file=./migrations/0012_long_video_permission.sql

-- When somebody said yes to this video's length, and who.
--
-- WHO matters and is not bookkeeping. A long video can spend most of a free daily
-- allowance, and D10 otherwise makes the FIRST saver with a key pay for a reel somebody
-- else saved. Nobody should have a day of their allowance spent because another person
-- approved an hour-long video. So the person who says yes is the person whose key pays for
-- that one, and `long_ok_by` is what carries it to the analysis.
ALTER TABLE sources ADD COLUMN long_ok_at INTEGER;
ALTER TABLE sources ADD COLUMN long_ok_by TEXT;

-- No new state column: `sources.state` gains two values, 'needs_ok' and 'parked'.
--
--   needs_ok — long enough to ask about, and nobody has been asked yet. Nothing has been
--              downloaded: the worker read the length from metadata and stopped.
--   parked   — somebody said not now. NOT a failure, and deliberately not 'failed': it
--              keeps no error, it is not retried, and it can be approved at any time.
--
-- Both are outside the claim query, so neither is picked up until somebody approves it.
