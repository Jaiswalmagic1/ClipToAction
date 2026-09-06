-- Who made the video (2026-09-07, D40).
--
-- Run once per database that already has data:
--   wrangler d1 execute cliptoaction-staging --remote --env staging \
--     --file=./migrations/0011_creator.sql

-- The channel, page or handle the video came from, as the platform reports it. A fact
-- about the video and not about anybody who saved it, so it lives on the shared row and
-- only the Worker writes it (D10, D18).
--
-- NULL for every video saved before today. They are filled in slowly, in the background,
-- from metadata alone -- never by downloading anything again.
ALTER TABLE sources ADD COLUMN creator TEXT;

-- When the creator was last looked for. Set whether one was found or not, which is what
-- makes the backfill queue shrink to zero: a video whose platform will not say who made it
-- is asked once and then left alone, instead of being asked again on every poll for ever.
ALTER TABLE sources ADD COLUMN creator_checked_at INTEGER;
