# Independent security review — `release-gate`, 2026-08-13

Run before merging `release-gate` to `main`, per Golden Rule 24: code touching auth,
encryption and tokens gets a reviewer who did not write it. Scope: `backend/src/*`,
`backend/schema.sql`, `worker-pc/worker.py`, both CI workflows, both git hooks, and the
render path in `index.html`.

**Verdict when the review ran: merge blocked.** 3 critical/high findings each sufficient alone.

## Second review of the fixes — also blocked, also fixed, 2026-08-13

A second independent pass reviewed the fixes themselves (the first reviewer never saw that
code). It blocked too, and it was right. What it found:

| Issue | Fix |
|---|---|
| `jsString()` escaped neither `"` nor `&`, so finding #14 was still open — `x" onmouseover="alert(1)` broke out of the attribute | `onclick` removed entirely. Card buttons carry `data-id`/`data-act` and one delegated listener reads them, so no card value is ever parsed as JavaScript. |
| A GitHub-token sync UI had been **swept into the commit by accident** — pre-existing uncommitted work. It puts a repo-write PAT in localStorage on the live `*.github.io` origin, which is shared across every Pages site on the account | Preserved on branch `github-sync-wip`, removed from `release-gate`. If it ships at all, the write path belongs behind the Worker per D11. |
| X's share sheet appends `?s=&t=<random>`, and `t` differs every time — so every share of one tweet became a new source. Finding #2 in reverse, on a supported platform | `s`/`t`/`trk` added to the tracking denylist; `twitter.com`, `m.facebook.com` and `web.facebook.com` aliased to their canonical hosts; `instagram.com/<user>/reel/<code>` no longer forks from `/reel/<code>`. |
| A worker whose lease expired could POST a late failure and drag an already-analysed reel back into the queue, putting an error on it that every saver would see | `AND state = 'downloading'` on both `storeFailure` and `storeTranscript`. |
| A source claimed 3 times without a report stranded at `attempts=3, state='downloading', error=NULL` — invisible forever | A sweeper in `claimQueue` retires them to `failed` with a visible error. |
| `claimQueue` selected then updated without a guard, so two workers could claim the same rows | Each claim UPDATE is conditional on the row still being in the state it was selected in; rows that lose the race drop out of that batch. |
| `pm_check.yml`'s all-zero-SHA fallback checked only the tip commit — which is the **first push of every new branch**, re-creating the original bug | Falls back to `git merge-base origin/main`. |
| `schema.sql` is all `CREATE TABLE IF NOT EXISTS`, so re-running it on an existing database silently applies nothing | `backend/migrations/0001_*.sql` added, and the README now says so. |
| PC worker posted raw exception text into the shared `sources.error` | `classify_failure()` — full text to the local console, a classification to the shared row. |
| Delta sync pivoted on `c.updated_at`, so marking 20 clips read re-sent 20 transcripts | Pivots on `c.created_at`. |
| A non-base64 signature threw outside the try and returned 500 instead of 401; malformed JSON returned 413 instead of 400 | Decode moved inside the try; `RequestError` carries its own status. |
| **Three tests passed with their fix reverted** — the limit clamp, the lease, and the error-leak test, which never reached the code path it was named for | All three rewritten against isolated databases with exact counts. Every fix is now mutation-tested: reverting it fails a test. |

Tests: 44 → 52, and the suite now catches all 8 mutations checked, including the ones that
previously slipped through.

Still open, deliberately, before first deploy rather than before merge: the D1 test shim's
`batch()` is not transactional (real D1 rolls back), and there are no tests for
`worker-pc/` at all.

## Status — all 16 fixed, 2026-08-13

Every finding below has been fixed on `release-gate`. The fixes are recorded as D18 and
D19 in `DECISION_LOG.md`. Test count went from 15 to 44.

**The root cause the review named — "no test exercises `worker.js` routing, authz or
ownership" — is fixed too.** `test/api.test.js` runs the real Worker against an in-memory
SQLite database with real RS256 tokens signed by a key pair the harness generates, so
forged signatures, wrong-project tokens, expired tokens and cross-user access are all
proven to fail rather than assumed to.

That suite immediately found a bug the review had not: every handler in the router was
returned **un-awaited**, so any rejection escaped the router's own try/catch — the request
would have failed with a raw 500, no CORS headers, and the internal error text exposed.
Fixed by `return await` throughout, with a test pinning it.

| # | Fix |
|---|---|
| 1 | `analyses.user_id` — `''` is Worker-produced and shared, anything else is that user's paste. A paste never sets `sources.state`, and is refused before a transcript exists. |
| 2 | Identifying query parameters kept per host; tracking dropped; remaining params sorted. |
| 3 | Shared sync queries pivot on the joining clip: `t.created_at > since OR c.updated_at > since`. |
| 4 | `hostIs()` — exact match or a real subdomain. Never a bare suffix. |
| 5 | Platform allowlist in `saveClip`; `assert_public_host()` in the PC worker re-checks resolved addresses; 200 saves/user/day. |
| 6 | `AnalysisError` carries a fixed classification by status. Gemini's key moved to the `x-goog-api-key` header. |
| 7 | `sources.claimed_at` + a 15-minute lease; `except Exception` in the PC worker's per-source loop. |
| 8 | `pm_check.yml` runs on pull requests and walks every commit in the range. |
| 9 | Scan covers `sk-proj-`, `gsk_`, `xai-`, and this project's own two secrets. |
| 10 | `Math.min(Math.max(n, 1), 10)`. |
| 11 | `readJson` rejects over 256 KB before parsing; per-field caps in `validateAnalysis`. |
| 12 | `cleanup()` globs every file for the source id, not just the returned path. |
| 13 | Generic 500; `AuthError` maps to 401 explicitly rather than a substring test. |
| 14 | `safeHref()` scheme check plus `jsString()` for `onclick` interpolation. |
| 15 | 32-byte assertion on the encryption secret; the misleading comment corrected. |
| 16 | CORS origin from `APP_ORIGIN`; `X-Service-Token` dropped from the allowed headers. |

---

## The findings as reported

---

## Must fix before merge

### 1. CRITICAL — any signed-in user can poison the shared analysis for any reel, and permanently stop it downloading
`backend/src/worker.js:359-381` → `:299-327`

The ownership check is on the **clip**; the write lands in the **shared** `analyses` table.
A user saves a URL they expect to be popular, then immediately pastes a hand-written
analysis for it. `storeAnalysis` also sets `sources.state='analyzed'`, and `claimQueue`
only picks up `state='pending'` — so the reel is never downloaded or transcribed, ever.
`ON CONFLICT DO NOTHING` makes the fake permanent. Everyone who later saves that URL syncs
down the attacker's fabricated summary as authoritative.

**Fix:** manual analyses must be per-user (`analyses(source_id, user_id)`), promoted to
shared only when produced Worker-side. A user paste must never set `sources.state`.

### 2. CRITICAL — every Facebook `watch?v=` link collapses into one shared source
`backend/src/canonical.js:42`

The generic fallback drops the whole query string, so `facebook.com/watch?v=1111` and
`?v=2222` both canonicalise to `https://facebook.com/watch`. That is Facebook's main
desktop video URL form. **No attacker needed** — the first saver's video is downloaded and
every other user's Facebook link silently attaches to it, showing them a stranger's
transcript and analysis as their own clip.

`canonical.test.js:34` only tests the path-keyed `facebook.com/reel/...` form, so the suite
never touches this.

**Fix:** whitelist identifying params per host (`v`, `story_fbid`, `list`); in the
fallback, keep the query minus a tracking denylist rather than discarding it. Add a test
asserting two different `watch?v=` links do not collide.

### 3. HIGH — delta sync never delivers shared rows created before the user saved the clip
`backend/src/worker.js:127-142`

Shared rows are filtered on their own `created_at`/`updated_at`, and `saveClip` does not
touch an existing `sources` row when it reuses one. So: reel transcribed on day 1, user
saves it on day 5 — they get their `clips` row and **no source, no transcript, no
analysis**. A permanently blank clip, nothing errors. This is the majority path once
dedupe works, so it gets worse as the product succeeds.

**Fix:** pivot the shared queries on the joining clip — `c.updated_at > ?since OR
t.created_at > ?since`. Add a test for save-after-transcribe.

---

## Also found (fix before launch, not necessarily before merge)

| # | Sev | Where | What |
|---|---|---|---|
| 4 | HIGH | `canonical.js:29,35` | `endsWith("youtube.com")` matches `myyoutube.com`. An attacker registers the canonical key of a real video while `url_original` points at their own host — the PC worker then downloads *their* content and serves it to everyone who saves the genuine link. Use exact host matching. |
| 5 | HIGH | `worker.js:61-88`, `worker.py:82-88` | SSRF: any authenticated user can make the PC worker fetch `192.168.x.x` / `169.254.169.254` from inside the home LAN. No host allowlist, no private-range block, no per-user save cap. |
| 6 | HIGH | `worker.js:283`, `analyze.js:57,77,100` | Provider error bodies are written to the **shared** `sources.error`. OpenAI 401s contain a partial key; 429s carry org and billing details. One user's key fragment syncs to every other saver. Gemini's key is in the query string, so a URI-echoing error exposes it in full. |
| 7 | HIGH | `worker.js:221-243`, `worker.py:121-134` | Claimed sources strand in `downloading` forever — no lease, no timeout, `attempts` never reset, and a whisper `RuntimeError` kills the worker mid-batch. Clips sit on "pending" with no error, which the project rules forbid. |
| 8 | MED | `pm_check.yml:8,22` | The PM gate never runs on pull requests, and only inspects the tip commit — commit code untagged, then a README commit, and it passes green. |
| 9 | MED | `ci.yml:46` | Secret scan misses `sk-proj-…`, `gsk_…` (Groq), `xai-…`, Cloudflare tokens, and both of this project's own secrets. `sk-[A-Za-z0-9]{32,}` cannot match `sk-proj-` — the `-` ends the class. |
| 10 | MED | `worker.js:222` | `?limit=-1` becomes SQLite `LIMIT -1` = no limit; claims the entire queue in an unbounded write loop. |
| 11 | MED | `worker.js:62,179,210,365` | No size limit on any request body — multi-megabyte paste is parsed and stringified before failing. |
| 12 | MED | `worker.py:90-94` | Media leaks to disk when ffmpeg extraction fails: `audio_path` is unset, so the `finally` deletes nothing. Contradicts "nothing is kept on disk". |
| 13 | MED | `worker.js:452` | Raw internal errors returned to clients, including D1 messages quoting SQL. 401-vs-500 is decided by a substring test for "token". |
| 14 | LOW | `index.html:572,586` | `idea.url` and `idea.id` interpolated unescaped while every other field is escaped. Self-XSS today; becomes stored XSS against all savers once #1/#4/#5 meet the D3→D6 sync migration. |
| 15 | LOW | `auth.js:84-90,129` | No length assertion on the encryption secret — a 32-char base64 secret silently gives AES-192. The constant-time comment is wrong; it returns early on length. |
| 16 | LOW | `worker.js:15` | `Allow-Origin: *` with `X-Service-Token` in `Allow-Headers`. Restrict to the Pages origin; the PC worker never preflights. |

---

## Checked and genuinely clean

| Area | Verdict |
|---|---|
| SQL injection | Clean — every value bound; the only interpolations are hardcoded table names |
| JWT verification | Sound — `alg` pinned before use, key from Google's JWKS by `kid`, `aud`/`iss` pinned to the project, `exp`/`iat`/`sub` all checked |
| Router ordering | Safe — no user route reachable without a Firebase token, no service route without the service token |
| Key exfiltration via responses | No endpoint selects from `users`; the only leak is the error-text path (#6) |
| AES-GCM usage | Correct — fresh 12-byte IV per encryption, prepended and sliced back properly |
| Command injection in the PC worker | None — yt-dlp used as a library, fixed ffmpeg arg list, no shell |
| ReDoS | Both regexes linear |
| `pre-commit` hook logic | Correct as written; its known weaknesses are what `pm_check.yml` is meant to backstop — hence #8 |

**The gap that let all this through:** no test touches `worker.js` routing, authz or
ownership. The suite covers `canonicalUrl`, `parseAnalysis` and `validateAnalysis` only, so
a green CI currently says nothing about the entire auth surface — which is exactly where
findings #1 and #3 live.
