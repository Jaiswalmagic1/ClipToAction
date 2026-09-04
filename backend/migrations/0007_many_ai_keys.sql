-- More than one AI key, spent in order (2026-08-29, D35).
--
-- A free allowance runs out and analysis stops. This holds several keys -- different
-- providers, or several accounts with the same one -- and moves to the next only when the
-- current one is genuinely out of allowance. Every other refusal stops and is shown,
-- because a key that has gone bad has to be noticed, not stepped over.
--
-- Run once per database that already has data:
--   wrangler d1 execute cliptoaction-staging --remote --env staging \
--     --file=./migrations/0007_many_ai_keys.sql

-- Per-user, so it carries updated_at like every other per-user table (D6). The key itself
-- is the same AES-GCM ciphertext users.ai_key_cipher held, encrypted with the same secret
-- and decrypted only inside the Worker (D11) -- this moves where it is stored, not how.
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

-- The automatic run joins clips to keys and orders by the saver's created_at, so the
-- lookup is per user and wants the position with it.
CREATE INDEX IF NOT EXISTS idx_ai_keys_user ON ai_keys (user_id, position);

-- Carry across the one key everybody already has, as first in their list. rowid keeps this
-- deterministic, and 'manual' is skipped because that is the copy-paste tier saying there
-- is no key at all -- storing it as one would put an empty entry in every list.
INSERT INTO ai_keys
  (id, user_id, label, provider, key_cipher, position, state, created_at, updated_at)
SELECT
  lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
  substr(lower(hex(randomblob(2))), 2) || '-a' ||
  substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))),
  u.id,
  'the key you already had',
  u.ai_provider,
  u.ai_key_cipher,
  0,
  'ready',
  u.created_at,
  u.created_at
FROM users u
WHERE u.ai_key_cipher IS NOT NULL
  AND u.ai_provider IS NOT NULL
  AND u.ai_provider != 'manual'
  AND NOT EXISTS (SELECT 1 FROM ai_keys k WHERE k.user_id = u.id);

-- users.ai_key_cipher is deliberately NOT cleared here.
--
-- Nothing reads it after this migration -- every path goes through ai_keys. It is left in
-- place so that rolling the Worker back to the previous version restores a working key
-- rather than a signed-in account with nothing connected. Clearing it is a separate
-- migration, once this has been live long enough that a rollback is not on the table.
