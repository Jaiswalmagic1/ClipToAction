-- D27 — the AI proposes a topic and a sub-topic, and the topic rows stay per-user.
--
-- schema.sql is all CREATE TABLE IF NOT EXISTS, so re-running it against an existing
-- database silently does nothing. Run this instead, once per database that already has
-- data. Skip it on a fresh database: schema.sql already includes everything here.
--
--   wrangler d1 execute cliptoaction-staging --remote --env staging \
--     --file=./migrations/0002_topics_two_levels.sql

-- ---------------------------------------------------------------- topics: two levels
--
-- '' rather than NULL for "this is a top-level topic". SQLite treats NULLs as distinct in
-- a unique index, so a nullable parent would let the same top-level name be created twice
-- over — which is the exact duplicate this migration exists to prevent. '' is the same
-- idiom analyses.user_id already uses for "shared".
ALTER TABLE topics ADD COLUMN parent_id TEXT NOT NULL DEFAULT '';

-- The name with case, punctuation and plurals flattened, so "Amazon listing" and
-- "Amazon Listings" meet on one row. Written by the Worker (normaliseTopicName in
-- src/topics.js) — the rules are past what SQL can express, so SQLite must never compute
-- this itself or the two would drift apart.
ALTER TABLE topics ADD COLUMN name_key TEXT NOT NULL DEFAULT '';

-- Best effort for rows that predate the column. Nothing has ever inserted a topic — there
-- is no endpoint that does — so in practice this touches nothing; it is here so the
-- migration is still correct if that assumption is ever wrong.
UPDATE topics SET name_key = lower(trim(name)) WHERE name_key = '';

-- The database itself refuses a duplicate, not just the code. Two requests arriving at
-- once would otherwise both look up, both miss, and both insert.
CREATE UNIQUE INDEX IF NOT EXISTS idx_topics_unique_name
  ON topics (user_id, parent_id, name_key);

-- ---------------------------------------------------------------- clips: where it is filed
--
-- One topic per clip (D27), so the link lives on the clip rather than in clip_topics.
-- clips already carries user_id and updated_at, so delta sync (D6) carries this for free;
-- clip_topics carries neither and could not be synced without being rebuilt.
--
-- topic_id points at the SUB-topic when there is one. The parent is reached through
-- topics.parent_id, so a clip is filed in exactly one place and can never disagree with
-- itself about which topic it belongs to.
ALTER TABLE clips ADD COLUMN topic_id TEXT REFERENCES topics (id) ON DELETE SET NULL;

-- 'ai' or 'user'. The user's choice is final (D27): once this says 'user', nothing
-- automatic may change the topic again. Without it a later run silently undoes a
-- deliberate decision — the failure Golden Rule 29 forbids.
ALTER TABLE clips ADD COLUMN topic_set_by TEXT;

CREATE INDEX IF NOT EXISTS idx_clips_topic ON clips (user_id, topic_id);

-- ---------------------------------------------------------------- analyses: what was proposed
--
-- Shared, like the rest of the analysis. The AI names these from the reel alone and never
-- sees anyone's topic list, so one analysis still serves everyone who saved the reel (D10).
-- Matching them against a particular person's topics happens afterwards, per user.
ALTER TABLE analyses ADD COLUMN topic TEXT;
ALTER TABLE analyses ADD COLUMN sub_topic TEXT;
