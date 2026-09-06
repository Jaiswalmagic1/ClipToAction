-- How many times we have tried to find out who made a video (2026-09-07, D40, amended).
--
-- Run once per database that already has data:
--   wrangler d1 execute cliptoaction-staging --remote --env staging \
--     --file=./migrations/0013_creator_tries.sql

-- The first version marked a video as "asked" whether the lookup had SUCCEEDED or merely
-- failed. That is fine for a video the platform will not name, and wrong for a machine
-- that is being rate-limited: one throttle would have walked the whole backfill queue,
-- marking two hundred videos "asked, nobody named" while nothing was ever actually asked.
-- The creator column would then have stayed empty for ever, with nothing on screen saying
-- why -- exactly the outcome the pacing exists to prevent.
--
-- So a failed lookup now counts instead of concluding. Three tries and the video is left
-- alone; anything less and it comes round again on a later idle poll.
ALTER TABLE sources ADD COLUMN creator_tries INTEGER NOT NULL DEFAULT 0;
