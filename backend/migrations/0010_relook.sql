-- The fortnightly re-look (2026-09-07, D41).
--
-- Run once per database that already has data:
--   wrangler d1 execute cliptoaction-staging --remote --env staging \
--     --file=./migrations/0010_relook.sql

-- How often a re-look is OFFERED, in days. NULL means the default of 14, so nobody has to
-- be given a value by this migration. 0 means "stop asking me", which is a real answer and
-- not the same as never having chosen.
ALTER TABLE users ADD COLUMN relook_days INTEGER;

-- When this person last did one. NULL means never, which is everybody today.
ALTER TABLE users ADD COLUMN relooked_at INTEGER;

-- When this clip was last included in a re-look. NULL means never, so every clip in the
-- notebook is due exactly once and none of them can come round twice.
--
-- On `clips` rather than a table of its own because clips already carries user_id and
-- updated_at, so delta sync carries this for free (D6) — the same reasoning D27 used for
-- topic_id.
ALTER TABLE clips ADD COLUMN relooked_at INTEGER;

-- One round-up. Per-user, because it is about what THIS person saved and not about any
-- one reel, so D10's sharing does not apply and must not.
CREATE TABLE IF NOT EXISTS relooks (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  themes      TEXT NOT NULL,             -- JSON [{name, why}]
  act_now     TEXT NOT NULL,             -- JSON [{do, because, from}]
  note        TEXT,                      -- a few sentences, or NULL
  clip_count  INTEGER NOT NULL,          -- how many reels this looked across
  covers_from INTEGER,                   -- the oldest of them, as saved
  covers_to   INTEGER,                   -- the newest of them
  provider    TEXT,                      -- which AI produced it
  model       TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  deleted_at  INTEGER
);

CREATE INDEX IF NOT EXISTS idx_relooks_sync ON relooks (user_id, updated_at);
