-- What a background refresh actually reads (2026-09-07, D59).
--
-- Every forty-five seconds the app asks what has changed. Three of those queries joined
-- clips to a shared table with an OR across the two, which no index can serve -- so each
-- one walked the whole clip list to return, almost always, nothing. At 210 clips that is
-- about 2,100 rows read to hand back four, a quarter of a million rows a day for one
-- person, and it is what limited how many people this could carry at all (D5).
--
-- The queries are now two halves joined by UNION. These are the indexes each half stands
-- on. Index-only, additive, and safe on a database holding real reels.
CREATE INDEX IF NOT EXISTS idx_clips_new ON clips (user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_sources_updated ON sources (updated_at);
CREATE INDEX IF NOT EXISTS idx_transcripts_new ON transcripts (created_at);
CREATE INDEX IF NOT EXISTS idx_analyses_new ON analyses (created_at);
