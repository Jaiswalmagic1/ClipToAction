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
  -- D35: no longer read. The keys live in ai_keys below; this is kept only so a rollback
  -- to the pre-D35 Worker finds a working key rather than an empty account.
  ai_key_cipher TEXT,                      -- AES-GCM ciphertext, never returned to client
  -- D41. How often a re-look is OFFERED, in days. NULL is the default of 14; 0 is "stop
  -- asking me", which is a real answer and not the same as never having chosen.
  relook_days   INTEGER,
  relooked_at   INTEGER,                   -- when they last did one. NULL means never
  created_at    INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL
);

-- D35. One key became a list, because a free allowance runs out. Spent in `position`
-- order, and the next one is reached ONLY when the current is out of allowance -- every
-- other refusal stops and is shown, so a key that has gone bad is noticed rather than
-- silently stepped over. Per-user, so it carries updated_at like the rest (D6). The
-- ciphertext is decrypted only inside the Worker and never returned to a client (D11).
CREATE TABLE IF NOT EXISTS ai_keys (
  id                TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  label             TEXT,                   -- what the person calls it, e.g. "work gmail"
  provider          TEXT NOT NULL,          -- gemini | groq | openai | anthropic | xai
  key_cipher        TEXT NOT NULL,          -- never returned to any client
  position          INTEGER NOT NULL,       -- the order this person's keys are spent in
  state             TEXT NOT NULL DEFAULT 'ready',  -- ready | exhausted | rejected
  last_error        TEXT,                   -- the sentence shown to its owner
  last_error_detail TEXT,                   -- status + allowlisted name, never free text
  last_error_at     INTEGER,
  exhausted_at      INTEGER,                -- when the allowance ran out; drives the retry
  last_used_at      INTEGER,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ai_keys_user ON ai_keys (user_id, position);

-- ---------------------------------------------------------------- shared layer

CREATE TABLE IF NOT EXISTS sources (
  id            TEXT PRIMARY KEY,
  url_canonical TEXT NOT NULL UNIQUE,      -- dedupe key
  url_original  TEXT NOT NULL,
  platform      TEXT NOT NULL,
  title         TEXT,
  -- D40. The channel, page or handle the video came from, as the platform reports it.
  -- A fact about the video, so it is shared like the rest of this row (D10) and only the
  -- Worker writes it (D18). NULL where the platform did not say.
  creator       TEXT,
  -- When it was last looked for, set whether one was found or not. That is what makes the
  -- backfill finite: a video the platform will not name is asked once and then left alone.
  creator_checked_at INTEGER,
  duration_sec  INTEGER,
  -- pending | downloading | transcribed | analyzed | failed
  -- plus, since D42: needs_ok (long enough that somebody has to say yes first, and nothing
  -- has been downloaded) and parked (somebody said not now -- not a failure, keeps no
  -- error, is never retried, and can be approved at any time).
  state         TEXT NOT NULL,
  error         TEXT,                      -- surfaced in the UI, never swallowed
  -- Why, in a form that cannot carry a key: the HTTP status and a name from a fixed list
  -- in src/analyze.js, or "unrecognised". `error` stays the sentence people read; this is
  -- what makes a failure diagnosable instead of guessable (D34).
  error_detail  TEXT,
  attempts      INTEGER NOT NULL DEFAULT 0,
  claimed_at    INTEGER,                   -- lease: a claim older than the timeout is retryable
  -- D42. When somebody said yes to this video's length, and who. WHO is not bookkeeping:
  -- a long video can spend most of a free daily allowance, and D10 would otherwise make
  -- the first saver with a key pay for a video somebody else approved. The approver pays.
  long_ok_at    INTEGER,
  long_ok_by    TEXT,
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
  topic         TEXT,                      -- D27: proposed by the AI from the reel alone,
  sub_topic     TEXT,                      -- so one analysis still serves everyone (D10)
  sections      TEXT,                      -- D33: JSON [{at, heading, detail}] for a long
                                           -- video. NULL for a reel, which is never asked
                                           -- for chapters, and for a long one that came
                                           -- back without them
  kind          TEXT,                      -- D34/D38: product | tool | prompt | tactic |
                                           -- opinion | other. NULL where none was named
  items         TEXT,                      -- D34/D38: JSON rows, for the kinds that have
                                           -- a row shape -- product, tool, prompt and
                                           -- tactic. NULL, never '[]', so a row written
                                           -- before kinds existed is indistinguishable
                                           -- from one that tracks nothing
  -- D38/D39. Which version of those row shapes this was written against. NULL means the
  -- first one, where only product and tool had rows -- so a reel read before a new table
  -- existed is countable, and the app can OFFER to re-read it instead of quietly
  -- spending somebody's AI allowance on a backfill nobody asked for.
  shapes_version INTEGER,
  created_at    INTEGER NOT NULL,
  PRIMARY KEY (source_id, user_id)
);

-- The PC worker's own heartbeat. Belongs to neither a user nor a reel, so it gets its own
-- table. '' is "the one worker"; keyed by id so a second machine needs no rewrite (D5).
-- Without this a dead worker is invisible and reels just sit in 'pending' (Golden Rule 29).
CREATE TABLE IF NOT EXISTS workers (
  id           TEXT PRIMARY KEY,
  last_seen_at INTEGER NOT NULL
);

-- ---------------------------------------------------------------- per-user layer

CREATE TABLE IF NOT EXISTS clips (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  source_id  TEXT NOT NULL REFERENCES sources (id) ON DELETE CASCADE,
  status     TEXT NOT NULL DEFAULT 'inbox', -- inbox | keep | done | archived
  -- D27. Points at the SUB-topic where there is one; the parent is reached through
  -- topics.parent_id, so a clip is filed in exactly one place. It lives here rather than
  -- in clip_topics because clips already carries user_id and updated_at, so delta sync
  -- (D6) carries it for free.
  topic_id     TEXT REFERENCES topics (id) ON DELETE SET NULL,
  topic_set_by TEXT,                        -- 'ai' | 'user'. 'user' is final (D27)
  -- D41. When this clip was last included in a re-look. NULL means never, so every clip
  -- is due exactly once and none can come round twice. Here rather than in a table of its
  -- own for the same reason topic_id is: clips already carries user_id and updated_at, so
  -- delta sync (D6) carries it for free.
  relooked_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,                       -- soft delete, so delta sync can propagate it
  UNIQUE (user_id, source_id)               -- saving the same reel twice is a no-op
);

CREATE INDEX IF NOT EXISTS idx_clips_sync ON clips (user_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_clips_topic ON clips (user_id, topic_id);

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
  -- '' means top-level. NULL would defeat the unique index below: SQLite treats NULLs as
  -- distinct, so the same top-level name could be created twice over.
  parent_id  TEXT NOT NULL DEFAULT '',
  -- `name` with case, punctuation and plurals flattened, so "Amazon listing" and
  -- "Amazon Listings" meet on one row. Written by normaliseTopicName in src/topics.js —
  -- the rules are past what SQL can express, so SQLite must never compute it separately.
  name_key   TEXT NOT NULL DEFAULT '',
  summary    TEXT,                          -- merged across every clip in the topic
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_topics_sync ON topics (user_id, updated_at);

-- The database itself refuses a duplicate, not just the code: two requests arriving at
-- once would otherwise both look up, both miss, and both insert.
CREATE UNIQUE INDEX IF NOT EXISTS idx_topics_unique_name
  ON topics (user_id, parent_id, name_key);

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

-- What the user LEARNED from a reel, brought back from the AI app they discussed it in
-- (D29). The reel is the seed; this is the part that makes the notebook worth keeping.
--
-- Its own table rather than a row in `notes`: `notes` is prose the user typed, this is a
-- fixed seven-field shape. Keyed to the clip, so it is one person's and delta sync (D6)
-- carries it with everything else.
CREATE TABLE IF NOT EXISTS learnings (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  clip_id        TEXT NOT NULL REFERENCES clips (id) ON DELETE CASCADE,
  learned        TEXT NOT NULL,             -- JSON array — what I now understand
  verdicts       TEXT NOT NULL,             -- JSON array [{claim, verdict, why}],
                                            -- verdict is 'true' | 'false' | 'unsure'
  actions        TEXT NOT NULL,             -- JSON array — what I will do about it
  still_open     TEXT NOT NULL,             -- JSON array — what did not get resolved
  corrections    TEXT NOT NULL,             -- JSON array — where the reel was wrong
  look_into      TEXT NOT NULL,             -- JSON array — worth reading or trying next
  learned_with   TEXT,                      -- which AI app, and the model if it said
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  deleted_at     INTEGER
);

CREATE INDEX IF NOT EXISTS idx_learnings_sync ON learnings (user_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_learnings_clip ON learnings (clip_id);

-- The user's own decision about one row of a product or tool tracker (D34). Per-user,
-- because "I ordered this" is the one part of a tracker that is about the person rather
-- than the video (D10, D18).
--
-- Keyed by item_key -- the row's name flattened -- and never by its position in the list.
-- A re-run analysis returns the rows in a different order, and a position would then move
-- somebody's "ordered" onto a different product.
CREATE TABLE IF NOT EXISTS item_status (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  source_id  TEXT NOT NULL REFERENCES sources (id) ON DELETE CASCADE,
  item_key   TEXT NOT NULL,                 -- the row's name, flattened for matching
  status     TEXT NOT NULL,                 -- want | doing | done | no
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  UNIQUE (user_id, source_id, item_key)
);

CREATE INDEX IF NOT EXISTS idx_item_status_sync ON item_status (user_id, updated_at);

-- One fortnightly round-up over the reels that had not been looked at again (D41).
--
-- Per-user, because it is about what THIS person saved rather than about any one reel, so
-- D10's sharing does not apply and must not: two people who saved the same forty reels
-- have not saved the same notebook.
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

-- The address a user gives their AI app so it can read their notebook itself (D29).
--
-- Only the HASH is stored. The secret is shown once, when it is made, and never again by
-- any endpoint — this row recognises a secret that is presented, it cannot recover one.
-- The secret is the whole of the authentication and it travels inside a URL pasted into
-- someone else's app, so a database storing it in the clear would hand over every
-- notebook at once.
CREATE TABLE IF NOT EXISTS connector_tokens (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash   TEXT NOT NULL,               -- SHA-256 of the secret, hex
  label        TEXT,                        -- which app it was made for, in their words
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER,                     -- so a forgotten connector is visible as one
  revoked_at   INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_connector_tokens_hash ON connector_tokens (token_hash);
CREATE INDEX IF NOT EXISTS idx_connector_tokens_user ON connector_tokens (user_id);
