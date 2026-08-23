-- What the user LEARNED from a reel, brought back from wherever they discussed it (D29).
--
-- The product stored what a reel said and stopped there. Jaiswal's words: "if it sits
-- there as a text only, it doesn't help as much. It has to enable me to learn." This is
-- the row that closes the loop — the reel goes out to an AI app, the conversation happens
-- there, and the finished learning comes back here.
--
-- Run once per database that already has data:
--   wrangler d1 execute cliptoaction-staging --remote --env staging \
--     --file=./migrations/0004_learnings.sql

-- Its own table, not a row in `notes`. `notes` is prose the user typed; this is a fixed
-- seven-field shape, and JSON stuffed into `notes.body` would be searched and drawn as raw
-- text next to their own sentences.
--
-- Keyed to the CLIP and not the source, which was Jaiswal's call: "attached to the reel so
-- that everything can be synced". A learning is one person's, so it never belongs on the
-- shared layer (D18) — and clip_id already carries the user through every existing query.
CREATE TABLE IF NOT EXISTS learnings (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  clip_id        TEXT NOT NULL REFERENCES clips (id) ON DELETE CASCADE,

  -- The seven fields, all JSON arrays except the last two. Empty arrays are allowed and
  -- normal: a session that raised no correction is not a broken session.
  learned        TEXT NOT NULL,             -- what I now understand
  verdicts       TEXT NOT NULL,             -- [{claim, verdict, why}] — verdict is
                                            -- 'true' | 'false' | 'unsure'
  actions        TEXT NOT NULL,             -- what I will do about it
  still_open     TEXT NOT NULL,             -- what did not get resolved
  corrections    TEXT NOT NULL,             -- where the reel was wrong or misleading
  look_into      TEXT NOT NULL,             -- worth reading or trying next
  learned_with   TEXT,                      -- which AI app, and the model if it said

  -- `created_at` is the "when" of the seventh field. It is also the only date this
  -- product shows anywhere so far.
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,          -- D6 — not optional, delta sync reads it
  deleted_at     INTEGER
);

CREATE INDEX IF NOT EXISTS idx_learnings_sync ON learnings (user_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_learnings_clip ON learnings (clip_id);
