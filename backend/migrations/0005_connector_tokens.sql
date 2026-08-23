-- The address a user gives their AI app, so it can read their notebook itself (D29).
--
-- Run once per database that already has data:
--   wrangler d1 execute cliptoaction-staging --remote --env staging \
--     --file=./migrations/0005_connector_tokens.sql

-- ONLY THE HASH IS STORED. The secret itself is shown to the user once, at the moment it
-- is made, and never again — not by sync, not by any endpoint. This row is a way to
-- recognise a secret that is presented, never a way to recover one.
--
-- Why that matters here more than usual: this secret is the whole of the authentication.
-- Anyone holding it reads that person's entire notebook, and it travels inside a URL the
-- user pastes into someone else's app. A database that stored it in the clear would hand
-- over every notebook at once.
--
-- Revoked rather than deleted, so "I turned that off on the 3rd" stays answerable.
CREATE TABLE IF NOT EXISTS connector_tokens (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash   TEXT NOT NULL,               -- SHA-256 of the secret, hex
  label        TEXT,                        -- which app it was made for, in their words
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER,                     -- so a forgotten connector is visible as one
  revoked_at   INTEGER
);

-- The lookup every single MCP request makes. Unique because a collision here would mean
-- one secret opening two notebooks.
CREATE UNIQUE INDEX IF NOT EXISTS idx_connector_tokens_hash ON connector_tokens (token_hash);
CREATE INDEX IF NOT EXISTS idx_connector_tokens_user ON connector_tokens (user_id);
