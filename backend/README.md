# ClipToAction API (Cloudflare Worker + D1)

The backend for the app and the PC enrichment worker.

## Why it is shaped this way

`sources` and `transcripts` are **shared across all users** — one row per unique reel. If
fifty people save the same viral clip, it is downloaded and transcribed once. `clips`,
`notes`, `questions`, `topics` and `tasks` are per-user and carry `updated_at`, so the app
syncs only what changed instead of re-reading the whole notebook.

`analyses` is split by `user_id`: `''` means the Worker produced it with a connected key
and it is shared, anything else is one user's copy-paste result and only that user ever
sees it. **A user's paste never writes into a shared row and never sets `sources.state`** —
otherwise anyone could publish a fabricated analysis to everyone who saved a reel, and mark
it analysed so it was never actually downloaded.

Only hosts on the platform allowlist in `src/canonical.js` can be saved at all. An
arbitrary URL would let a signed-in user aim the PC worker at their own server, or at an
address inside the operator's own network.

## Endpoints

### App (send `Authorization: Bearer <Firebase ID token>`)

| Method | Path | Purpose |
|---|---|---|
| POST | `/v1/clips` | Save a link. Reuses an existing source when the URL is already known. |
| GET | `/v1/sync?since=<ms>` | Delta sync — everything changed since that timestamp. |
| PATCH | `/v1/clips/:id` | Set status (`inbox`, `keep`, `done`, `archived`). |
| POST | `/v1/notes` | Add a note to a clip. |
| PUT | `/v1/settings` | Choose AI provider and store its key (encrypted, never returned). |
| GET | `/v1/clips/:id/prompt` | Copy-paste tier: the ready-made prompt to paste into any chat AI. |
| POST | `/v1/clips/:id/analysis` | Copy-paste tier: paste the AI's reply back in. |
| GET | `/v1/clips/:id/learn-prompt` | D29: the text to take to an AI app — teach me, then hand the learning back. |
| POST | `/v1/clips/:id/learning` | D29: store what was learned. Takes `{pasted}` (the AI's whole reply) or `{learning}` (the object). |
| POST | `/v1/connector` | Mint a connector address. **The secret is in this response and nowhere else** — only its hash is stored. |
| DELETE | `/v1/connector/:id` | Turn one off. The row is kept, marked revoked. |

### The user's AI app (MCP — authenticated by the secret in the address)

| Method | Path | Purpose |
|---|---|---|
| POST | `/mcp/:secret` | The MCP endpoint (D29). Tools: `search`, `fetch`, `save_learning`. |

**There are two incompatible eras of MCP and this server answers both.** Revision
`2026-07-28` dropped the `initialize` handshake and sessions entirely — every request
carries its version in `_meta` — while everything up to `2025-11-25` opens with
`initialize`. Neither Claude nor ChatGPT documents which it speaks, so `initialize`,
`server/discover`, `tools/list`, `tools/call` and `ping` are all implemented, and nothing
is stored between requests either way. Wire shapes read from the specification 2026-08-23:
[versioning](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning),
[streamable HTTP](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http),
[discover](https://modelcontextprotocol.io/specification/2026-07-28/server/discover),
[tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools),
[2025-11-25 lifecycle](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle),
and OpenAI's [`search`/`fetch` shapes](https://developers.openai.com/api/docs/mcp).

**One deliberate deviation, documented rather than hidden:** the 2026-07-28 revision says
an unknown method MUST return `404`. This returns `200` with the JSON-RPC `-32601` instead,
because a handshake-era client reads a `404` as "there is no MCP endpoint here" and falls
back to a transport deprecated two revisions ago — the connector then looks broken rather
than merely missing one method. The JSON-RPC error is the part either era reads.

**Where each app takes the address:** Claude — Customize → Connectors, on any plan
including Free. ChatGPT — Settings → Security and login → Developer mode, Plus or Pro only.
The Gemini app cannot: Google requires the user be in the US.

### PC worker (send `X-Service-Token: <WORKER_SERVICE_TOKEN>`)

| Method | Path | Purpose |
|---|---|---|
| GET | `/v1/queue?limit=3` | Claim pending sources. A claim is a 15-minute lease, so a worker that dies mid-download does not strand them. |
| POST | `/v1/sources/:id/transcript` | Store the transcript. The Worker then analyses it if any saver has a key connected. |
| POST | `/v1/sources/:id/error` | Record a failure — retried up to 3 times, then marked `failed`. |

Failures are stored on the source and returned by sync, so the app can show what went
wrong rather than leaving a clip stuck on "pending". `sources.error` is read by everyone
who saved the reel, so an analysis failure is recorded as a fixed classification — never a
provider's response body, which can quote a fragment of the key that failed.

## Tests

```bash
npm test
```

The API tests run the real Worker against an in-memory SQLite database and real RS256
tokens signed by a key pair generated in the harness, so authentication, authorisation and
cross-user isolation are genuinely exercised — including the cases that must fail.

## Three environments (D20)

Nothing reaches production untested. Each level proves something the one before it cannot.

| Level | Command | What it proves | Costs |
|---|---|---|---|
| Local | `npm run dev` | The Worker runs, routes and queries work. No account, nothing deployed. | nothing |
| Staging | `npm run deploy:staging` | Real Cloudflare, real D1, real Firebase tokens — with its own database and no real users. | nothing |
| Production | `npm run deploy:production` | — | nothing |

`wrangler deploy` with no `--env` has no database binding on purpose, so it cannot quietly
ship to production. **Staging and production must use different secret values** — a staging
service token that also works in production means a test run can reach real users' data.

## Setup

```bash
npm install -g wrangler
```

```bash
wrangler login
```

Create both databases and put each returned `database_id` into the matching block in
`wrangler.toml`, along with your `FIREBASE_PROJECT_ID`:

```bash
wrangler d1 create cliptoaction-staging
```

```bash
wrangler d1 create cliptoaction
```

Apply the schema to each:

```bash
wrangler d1 execute cliptoaction-staging --remote --file=./schema.sql
```

**On a database that already exists, that command does nothing** — every statement in
`schema.sql` is `CREATE TABLE IF NOT EXISTS`, so schema changes never land. Apply the files
in `migrations/` instead, in order. A fresh database needs only `schema.sql`.

Generate a secret value (run it once per environment — do not reuse):

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

```bash
wrangler secret put KEY_ENCRYPTION_SECRET --env staging
```

```bash
wrangler secret put WORKER_SERVICE_TOKEN --env staging
```

Then deploy staging, point the PC worker's `API_BASE` at it, and put a real reel through
before touching production.

```bash
npm run deploy:staging
```

### The migrations come FIRST, and nothing enforces that

`npm run deploy:staging` builds the app's assets and ships the Worker. **It does not touch
the database.** Deploying code that expects a column the database has not got does not fail
politely in one place — it breaks every route that reads that table at once, and the app
shows an empty notebook, which reads exactly like data loss.

So: apply any new files in `migrations/` **before** deploying the code that needs them, in
order, one at a time.

```bash
wrangler d1 execute cliptoaction-staging --remote --env staging --file=./migrations/0009_row_shapes_version.sql
# ... and so on, in order, up to 0016_sync_indexes.sql
```

Each is additive — `ALTER TABLE ADD COLUMN`, `CREATE TABLE IF NOT EXISTS` and six indexes — so they
are safe on a database holding real reels, and none of them rewrites a single existing row.
They are **not** safe to run twice: SQLite has no `ADD COLUMN IF NOT EXISTS`, so a repeat
fails with "duplicate column name". (`0014` is the exception — it only creates an index,
and opens with a `DROP INDEX IF EXISTS` so that re-running it actually corrects an earlier
draft's version of the same index rather than silently doing nothing.)

**"Duplicate column name" does NOT mean "already applied."** Several of these files hold
more than one statement — `0010` holds five. If one stops part of the way through, a re-run
fails on its FIRST statement and everything after the interruption never runs. The error
looks identical to a file that finished, and the half of `0010` that creates the `relooks`
table is exactly the half whose absence takes `/v1/sync` down for everybody — which on
screen is indistinguishable from a lost notebook.

So on a repeated error, **check before believing it**, and if a file is half applied, run
its remaining statements by hand rather than the file again.

To see which have landed — every table and column these files touch, not just `sources`:

```bash
wrangler d1 execute cliptoaction-staging --remote --env staging --command "SELECT 'analyses' AS t, name FROM pragma_table_info('analyses') UNION ALL SELECT 'sources', name FROM pragma_table_info('sources') UNION ALL SELECT 'clips', name FROM pragma_table_info('clips') UNION ALL SELECT 'users', name FROM pragma_table_info('users') UNION ALL SELECT 'table', name FROM sqlite_master WHERE type='table' UNION ALL SELECT 'index', name FROM sqlite_master WHERE type='index'"
```

What to look for, file by file:

| File | What it must have left behind |
|---|---|
| `0009` | `analyses.shapes_version` |
| `0010` | `users.relook_days`, `users.relooked_at`, `clips.relooked_at`, **and the `relooks` table** plus `idx_relooks_sync` |
| `0011` | `sources.creator`, `sources.creator_checked_at` |
| `0012` | `sources.long_ok_at`, `sources.long_ok_by` |
| `0013` | `sources.creator_tries` |
| `0014` | the index `idx_sources_creator_todo` |
| `0015` | `sources.releases` |
| `0016` | the indexes `idx_clips_new`, `idx_sources_updated`, `idx_transcripts_new`, `idx_analyses_new` |

### The release order, in full

Getting these the wrong way round is the only way this release can look like lost data, so
they are written out rather than left to be inferred. **Do them in this order.** Steps 1-3
are all reversible; from step 5 the app is live.

**0. The PC worker's `.env` first.** It is gitignored, so nothing in the repo updates it and
no test can catch it being stale. It must carry the new ceilings before the worker restarts,
or a five-hour video is still refused at three:

```
MAX_DURATION_SEC=21600
WARN_ABOVE_SEC=1800
MAX_TRANSCRIPT_CHARS=400000
```

**1. Push the branch and wait for CI to go green.** `git push -u origin big-build`. Pushing a
branch releases nothing (D16) — only `main` is served. Both checks run on the branch push, so
a failure is found here rather than at the merge, and **Tests and checks** must be green
before anything below is worth starting.

**2. Every unapplied migration, on staging, in order** — `0009` to `0016`. Safe while the old
Worker is still running: they are all additive and nothing reads the new columns yet. Verify
with the command above before moving on; if a file half-applied, read the paragraph about
"duplicate column name" again before re-running anything.

**3. `npm run deploy:staging`.** Never before step 2 — the new code reads columns that would
not exist, and `/v1/sync` then fails for everybody, which on screen is indistinguishable from
an empty notebook.

> **The way back.** If staging misbehaves, `wrangler rollback --env staging` returns the
> Worker to the previous deployment in seconds. It rolls back **code only** — the migrations
> stay applied, which is exactly why they are additive: the old code never reads the new
> columns, so a rolled-back Worker runs correctly against the new database.

**4. Restart the PC worker's scheduled task**, so it runs the code that matches its new
`.env`. `Stop-ScheduledTask ClipToActionWorker` then `Start-ScheduledTask ClipToActionWorker`.
This step is order-independent by design: `claim_batch` falls back to its pre-D42 behaviour
when the API sends no limits, so an old Worker and a new worker get along.

**5. Put a real reel through staging, by hand.** This is the point of the whole rehearsal.
Nothing below happens until one reel has gone from share to analysed on staging.

**6. Open the PR and merge it to `main`**, which is what publishes the app (D16). Do it
promptly after step 3 and not days later: between the two, GitHub Pages is still serving the
OLD app against the NEW Worker, and a video waiting on a length approval draws there as the
bare word `needs_ok` with no button to answer it. Nothing is lost and it corrects itself the
moment this step lands.

> **Merge commit, not squash.** The PM Discipline check reads `[PM-REVIEWED]` out of every
> commit message in the range, and a squash throws all of them away in favour of the PR
> title. The check then runs on `main`'s push and goes red on code that is already live.
> Choose "Create a merge commit".

**7. Open the app once, directly, before sharing anything to it.** The service worker already
on his phone is cache-first, so the very first open after step 6 may still be served the old
page while the new one installs; the old page consumes a pending share into a list the new
app does not read. One direct open settles it for good.

**8. Then** requeue anything that was stuck — the three long videos that were retired before
D42 existed. Find them first rather than guessing at ids:

```bash
wrangler d1 execute cliptoaction-staging --remote --env staging --command "SELECT id, title, error, error_detail, attempts, releases FROM sources WHERE state='failed'"
```

Then requeue only those, by id:

```bash
wrangler d1 execute cliptoaction-staging --remote --env staging --command "UPDATE sources SET state='pending', attempts=0, releases=0, claimed_at=NULL, error=NULL, error_detail=NULL WHERE id IN ('...','...','...')"
```

`releases=0` and `claimed_at=NULL` are not tidiness. A row at the release cap is sent
straight back to `failed` by the first claim that lets go of it, and a row with a stale
`claimed_at` is invisible to the queue until the lease expires — either way the requeue looks
like it did nothing.

**9. Last of all, turn on the branch ruleset** described in `CLAUDE.md`. Doing it before step
6 blocks the very PR that carries the checks it names.

## AI providers


Analysis runs inside the Worker (`src/analyze.js`) so a user's API key never leaves it.
Endpoints and model IDs were checked against each provider's own documentation on
2026-08-12:

| Provider | Endpoint | Model | Docs confirmed |
|---|---|---|---|
| Gemini (default) | `generativelanguage.googleapis.com/v1beta/…:generateContent` | `gemini-3.5-flash-lite` | endpoint, request/response shape |
| Groq | `api.groq.com/openai/v1/chat/completions` | `llama-3.3-70b-versatile` | endpoint, auth header, body, model |
| xAI | `api.x.ai/v1/chat/completions` | `grok-4.6` | endpoint, auth header, body, model |
| Anthropic | `api.anthropic.com/v1/messages` | `claude-haiku-4-5` | endpoint, headers, body, model |
| OpenAI | `api.openai.com/v1/chat/completions` | `gpt-5.6-luna` | model only — the API reference returns 403 to automated fetches, so the endpoint is the widely-used one rather than a doc-confirmed one |

Raw HTTP is used for every provider, including Anthropic: one adapter shape across five
providers is simpler here than mixing an SDK into a Cloudflare Worker for one of them.

## Not built yet

Topic merging, "you already know this", weekly digest and shared notebooks have tables in
the schema but no endpoints — they come after the enrichment worker and the app are wired
end to end.
