-- ClipToAction — Cloudflare D1 schema
--
-- Two layers:
--   Shared layer  (sources, transcripts, analyses) — one row per unique reel, reused by
--                 every user who saves it. This is the dedupe that keeps download,
--                 transcription and AI cost flat as user count grows.
--   Per-user layer (clips, notes, questions, topics, tasks) — one row per user's own save.
--
-- Every per-user table carries updated_at so the app can delta-sync (?since=) instead of
-- re-reading the whole notebook on each open.

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,          -- Firebase uid
  email         TEXT,
  display_name  TEXT,
  ai_provider   TEXT,                      -- gemini | groq | openai | anthropic | xai | manual
  ai_key_cipher TEXT,                      -- AES-GCM ciphertext, never returned to client
  created_at    INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL
);

-- ---------------------------------------------------------------- shared layer

CREATE TABLE IF NOT EXISTS sources (
  id            TEXT PRIMARY KEY,
  url_canonical TEXT NOT NULL UNIQUE,      -- dedupe key
  url_original  TEXT NOT NULL,
  platform      TEXT NOT NULL,
  title         TEXT,
  duration_sec  INTEGER,
  state         TEXT NOT NULL,             -- pending | downloading | transcribed | analyzed | failed
  error         TEXT,                      -- surfaced in the UI, never swallowed
  attempts      INTEGER NOT NULL DEFAULT 0,
  claimed_at    INTEGER,                   -- lease: a claim older than the timeout is retryable
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sources_state ON sources (state, updated_at);

CREATE TABLE IF NOT EXISTS transcripts (
  source_id  TEXT PRIMARY KEY REFERENCES sources (id) ON DELETE CASCADE,
  text       TEXT NOT NULL,
  lang       TEXT,
  engine     TEXT NOT NULL,                -- e.g. faster-whisper:base
  created_at INTEGER NOT NULL
);

-- An analysis is shared (user_id = '') only when the Worker produced it with a connected
-- key. A copy-paste analysis is text the user typed, so it is stored against that user and
-- nobody else ever sees it. Without that split, one user's paste would overwrite the
-- authoritative analysis for every other person who saved the same reel.
CREATE TABLE IF NOT EXISTS analyses (
  source_id     TEXT NOT NULL REFERENCES sources (id) ON DELETE CASCADE,
  user_id       TEXT NOT NULL DEFAULT '',  -- '' = shared; otherwise the pasting user
  provider      TEXT NOT NULL,             -- which tier produced it, incl. 'manual'
  model         TEXT,
  summary       TEXT NOT NULL,
  key_points    TEXT NOT NULL,             -- JSON array
  learn_more    TEXT NOT NULL,             -- JSON array — tools/terms/people to dig into
  claims        TEXT NOT NULL,             -- JSON array [{claim, confidence, why}]
  suggested_task TEXT,
  created_at    INTEGER NOT NULL,
  PRIMARY KEY (source_id, user_id)
);

-- ---------------------------------------------------------------- per-user layer

CREATE TABLE IF NOT EXISTS clips (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  source_id  TEXT NOT NULL REFERENCES sources (id) ON DELETE CASCADE,
  status     TEXT NOT NULL DEFAULT 'inbox', -- inbox | keep | done | archived
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,                       -- soft delete, so delta sync can propagate it
  UNIQUE (user_id, source_id)               -- saving the same reel twice is a no-op
);

CREATE INDEX IF NOT EXISTS idx_clips_sync ON clips (user_id, updated_at);

CREATE TABLE IF NOT EXISTS notes (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  clip_id    TEXT NOT NULL REFERENCES clips (id) ON DELETE CASCADE,
  body       TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_notes_sync ON notes (user_id, updated_at);

CREATE TABLE IF NOT EXISTS questions (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  clip_id    TEXT NOT NULL REFERENCES clips (id) ON DELETE CASCADE,
  question   TEXT NOT NULL,
  answer     TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_questions_sync ON questions (user_id, updated_at);

-- Topics are the "8 reels become one chapter" feature.
CREATE TABLE IF NOT EXISTS topics (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  summary    TEXT,                          -- merged across every clip in the topic
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_topics_sync ON topics (user_id, updated_at);

CREATE TABLE IF NOT EXISTS clip_topics (
  clip_id    TEXT NOT NULL REFERENCES clips (id) ON DELETE CASCADE,
  topic_id   TEXT NOT NULL REFERENCES topics (id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (clip_id, topic_id)
);

CREATE TABLE IF NOT EXISTS tasks (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  clip_id    TEXT REFERENCES clips (id) ON DELETE SET NULL,
  title      TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'open',  -- open | doing | done | dropped
  effort     TEXT,
  impact     TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_tasks_sync ON tasks (user_id, updated_at);
