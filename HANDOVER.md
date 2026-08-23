# ClipToAction — session handover, 2026-08-21

Paste this into a new session. It is written to be read cold.

## Before anything else

Read, in this order:

1. `D:\how-i-work\GOLDEN_RULES.md`
2. `D:\ClipToAction\CLAUDE.md` → `DECISION_LOG.md` → `DECISIONS.md`
3. `C:\Users\jaisw\.claude\projects\D--ClipToAction\memory\active.md` and `context.md`

`DECISION_LOG.md` is binding. Deviation is allowed; silent deviation is not — log a new
decision that supersedes the old entry, then build.

---

## Where the project stands

**Step 3 — the app — is finished, proven and pushed. It is not released.**

The product does what it was built to do. A real person shared reels from a phone through
the Android share sheet, and they came back fetched, transcribed, summarised, filed and
searchable, with no intervention. That happened on three separate accounts.

| Step | What it covers | State |
|---|---|---|
| 1 | D1 schema + Worker API | Built, deployed to staging |
| 2 | PC worker + Worker-side analysis | **Proven end to end**, repeatedly, on real reels |
| 3 | The app — sign-in, sync, notebook, settings, guide | **Done, proven on a phone, pushed** |
| 4 | The six value features | Not started. **Topics is next — see below** |
| 5 | Compliance and launch gates | Not started |

### What is live

| | |
|---|---|
| Staging API **and the app** | `https://cliptoaction-api-staging.cliptoaction.workers.dev` |
| The app | `/app.html`, and the bare address also serves it |
| Branch | `app-rewrite`, pushed, CI and PM Discipline both green |
| `main` | Untouched. Still serves the OLD app. Nothing is released (D16, D20) |
| Production | **Does not exist.** No database, no secrets, nothing deployed — deliberate |
| Tests | `cd backend && npm test` — **71 passing** |

### Accounts and real data on staging

| Account | What it has |
|---|---|
| `cliptoaction@gmail.com` | The real Gemini key. 3 clips, one deliberately failed |
| `rumeein@gmail.com` | Copy-and-paste tier, no key. 2 clips |
| `careernewssite@gmail.com` | Jaiswal's phone account, own Gemini key. **5 Facebook reels, all summarised** |

There is one piece of test rubbish: a bare `https://instagram.com` source that failed three
times. Harmless, and it usefully demonstrates the failure state.

---

## THE NEXT JOB — topics (D27)

**Decided, and recorded in `DECISION_LOG.md` as D27. Read it before planning.**

The AI works out a **topic and a sub-topic** while summarising — same pass, no second call.
**One topic and one sub-topic per clip.** The user can **override, and their choice is
final**. Clips summarised before this existed get **an option to categorise them**.

### The trap that must not be walked into

Analyses are **shared** — one per reel, reused by everyone who saved it. That reuse is the
entire cost model (D10). Topics are **per-user** (D10, D18).

So "check existing topics before making a new one" **cannot** mean showing the AI the user's
topic list — that would make every analysis per-user and multiply the cost by the number of
people who saved the reel. The AI names the topic **blind, from the reel alone**, and that
stays shared. The matching against a user's existing topics happens **afterwards, per user,
in the Worker**, normalised so "Amazon listing" and "Amazon Listings" meet.

### What has to be built

- A **migration** in `backend/migrations/` — `topics` is flat today, so it needs
  `parent_id`, plus a flag recording whether a clip's topic was set by a person or proposed
  by the AI. Do **not** edit `schema.sql`; it is all `CREATE TABLE IF NOT EXISTS`, so
  changes there apply to nothing. There is already real data.
- A **change to the analysis contract** so the AI returns topic and sub-topic. Under D16
  this ships with the test that proves it.
- **Filing logic** — match the proposed name against that user's topics, reuse or create.
- **Never overwrite a human-set topic.** Without the flag, any re-run silently undoes a
  deliberate decision (Golden Rule 29).
- **The app** — a topic view over the list (D22: grouping is a view over the list, never
  instead of it), and a way to change a clip's topic.
- Something for the clips already summarised with no topic.

Still to be planned, all mechanics rather than product choices: how the categorise option is
presented for old clips, and whether re-summarising may change a topic the user never
touched.

---

## Also outstanding

1. **Open the pull request** — `https://github.com/Jaiswalmagic1/ClipToAction/pull/new/app-rewrite`.
   **Do not merge.** Merging is the release (D16), and the swap below belongs in it.
2. **The swap (D21, D23), as one commit, once production exists:** promote `app.html` to
   `index.html`, delete the old GitHub-token sync with it, point `manifest.json`,
   `share-target.html` and `service-worker.js` at the new app, and change `API_BASE` to
   production.
3. **Branch protection on `main`** is still off, so the release gate is advisory. `gh` is
   authenticated. Ask before changing repo settings.
4. **Compliance (P5)** — blocks the first outside user: no privacy policy, no deletion path,
   no retention period in the schema, the Instagram/Facebook terms exposure unresearched,
   and now also that **Gemini's free tier may read and learn from everything sent to it**.
5. **Two older decisions still unmade:** `task="translate"` for Hinglish reels (proposed, not
   applied, `worker-pc/worker.py:137`), and Instagram reporting no duration — **Facebook does
   report it**, so this is Instagram-only.
6. A supported-site link that is not a video is accepted, fails three times, and leaves a
   dead entry.

---

## Things that cost time this session — do not repeat them

- **The PC worker uses an `X-Service-Token` header, not a bearer token.** A bearer token
  returns `401 Bad service token`, which looks exactly like a wrong secret.
- **Run the PC worker with `python -u`** or its output is buffered and a working worker
  looks hung.
- **The browser caches `app.html` hard.** After editing, always load it with a fresh `?v=`
  or the test silently runs against the old file.
- **A mutation test that does not assert the edit landed is worthless.** A `.replace()` that
  matched nothing printed "mutation applied", the tests passed, and it looked like the guard
  was useless. Assert `mutated != original` before running.
- **Building test JSON through nested strings turns `\n` into a literal backslash-n** and
  breaks fenced code blocks. Use `String.fromCharCode(10)`.
- **A scripted click is not a user gesture**, so clipboard writes are refused in automated
  tests. That is the fallback working, not a bug.
- **`git push` hangs in the foreground.** Run it in the background; it waits on a Windows
  GitHub sign-in box.
- **Google AI Studio blocks automated API-key creation.** Hand it to Jaiswal; it takes him
  twenty seconds.
- **Jaiswal signs in on a Chrome profile named "Rumee".** If a check says "signed out", it is
  the wrong browser, not a broken app.

---

## The rules that bite most often here

- Answer in 1–2 lines, plain English, one topic per response. **Jaiswal is not a coder —
  never use a technical word he has not used himself.** Findings go in a file; report the
  headline.
- Capture is link-only (D1). Never add a field to it.
- Only the Worker writes a row other people read (D18).
- The dedupe key must never merge two different videos (D19).
- Users' AI keys never leave the Worker (D11).
- External API shapes come from official docs, never memory (D13).
- `main` is a release (D16). Work on a branch; never commit to `main`.
- Nothing reaches production untested (D20): local → staging → production, and a change is
  not releasable until a real reel has gone through staging.
- Every per-user table carries `updated_at` (D6).
- No silent failures (Golden Rule 29).
- Check `git status` for pre-existing changes before staging anything (Golden Rule 30).
  **`project_dashboard.html` and `data/` are Jaiswal's, uncommitted, and not yours to
  commit.**

## The commit gate

Already enabled here. Committing any `.js`, `.mjs`, `.py`, `.html` or `.sql` file is blocked
unless `review_pass.json` exists and every field passes. Copy `review_pass.template.json`,
fill it honestly, commit — the hook appends `[PM-REVIEWED]` and deletes it. A GitHub Actions
job re-checks the pushed commit. Never fill it in as a formality.

Write commit messages to a file and use `git commit -F`. The Bash tool is POSIX sh, so
PowerShell here-string syntax mangles them.
