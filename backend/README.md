# ClipToAction API (Cloudflare Worker + D1)

The backend for the app and the PC enrichment worker.

## Why it is shaped this way

`sources`, `transcripts` and `analyses` are **shared across all users** — one row per unique
reel. If fifty people save the same viral clip, it is downloaded, transcribed and analysed
once. `clips`, `notes`, `questions`, `topics` and `tasks` are per-user and carry
`updated_at`, so the app syncs only what changed instead of re-reading the whole notebook.

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

### PC worker (send `X-Service-Token: <WORKER_SERVICE_TOKEN>`)

| Method | Path | Purpose |
|---|---|---|
| GET | `/v1/queue?limit=3` | Claim pending sources to download and transcribe. |
| POST | `/v1/sources/:id/transcript` | Store the transcript. |
| POST | `/v1/sources/:id/analysis` | Store the analysis. |
| POST | `/v1/sources/:id/error` | Record a failure — retried up to 3 times, then marked `failed`. |

Failures are stored on the source and returned by sync, so the app can show what went
wrong rather than leaving a clip stuck on "pending".

## Setup

```bash
npm install -g wrangler
wrangler login
wrangler d1 create cliptoaction
```

Put the returned `database_id` into `wrangler.toml`, set `FIREBASE_PROJECT_ID`, then:

```bash
wrangler d1 execute cliptoaction --remote --file=./schema.sql
```

Generate and store the two secrets:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

```bash
wrangler secret put KEY_ENCRYPTION_SECRET
```

```bash
wrangler secret put WORKER_SERVICE_TOKEN
```

Deploy:

```bash
wrangler deploy
```

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
