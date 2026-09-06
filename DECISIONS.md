# ClipToAction — Decision Tracker

Running list of what is settled and what is still open. Updated every session.
**Why each decision was made — options considered, factors weighed — is in
[DECISION_LOG.md](DECISION_LOG.md).** That file is binding; this one is its index.

Last updated: 2026-09-07

---

## What this product is

A user shares a reel link. The system downloads it, transcribes it, analyses it, and files
the result in a growing notebook they can search, question, annotate and learn from later.
The reel is a seed, not the destination.

---

## Settled

| # | Topic | Decision |
|---|---|---|
| D1 | Capture | Link only. The user sends a URL and nothing else, ever. |
| D2 | ~~Mobile inbox~~ | ~~Telegram bot is primary~~ — **superseded by D17.** |
| D3 | ~~Storage~~ | ~~`data/ideas.json` in the repo~~ — **superseded by D6.** Its GitHub-token sync in `index.html` must be removed, not left running. |
| D4 | Extraction | Download the video, transcribe the audio. Not captions. Breaches Instagram/Facebook ToS — accepted knowingly. |
| D5 | Worker host | Jaiswal's PC for now. Must stay host-agnostic — moving to a VM is config, never a rewrite. |
| D6 | Backend | Cloudflare D1 + Firebase Auth. Firestore and Supabase both costed and rejected. |
| D7 | Onboarding | Google sign-in and nothing else. Binding for storage and accounts; superseded by D8 for the AI key. |
| D8 | AI account | Bring your own key — analysis runs on the user's quota, not Jaiswal's. |
| D9 | AI tiers | Gemini key / any other key / **copy-paste mode**. Tier 3 means no user ever needs a key. |
| D10 | Dedupe | Transcripts and analyses are shared across users, one per unique reel. Only clips/notes/topics/tasks are per-user. |
| D11 | Key safety | Analysis runs in the Cloudflare Worker. Users' keys never leave it; the PC worker never sees one. |
| D12 | Accounts | Everything under `cliptoaction@gmail.com`, not `rumeein@gmail.com`. |
| D13 | External APIs | Request shapes come from official docs, never from memory. Unverified adapters are labelled as such. |
| D14 | Discipline | gstack + PM Discipline enforced in this repo: decision log, pre-commit gate, server-side check. |
| D15 | ~~Pushing~~ | ~~Golden Rule 6 stands — auto-push~~ — **superseded by D16.** |
| D20 | Environments | Local → staging → production, all free. Production is never the default deploy target and never shares a secret with staging. A change is not releasable until a real reel has gone through staging. |
| D19 | Dedupe key | Identifying query params kept per host, tracking dropped; host matching is exact or a real subdomain, never a bare suffix; only allowlisted platforms can be saved. Changes ship with a collision test. |
| D18 | Shared rows | Only the Worker writes a row other people read. Anything a user typed is stored against that user. |
| D17 | Capture path | The PWA share target is the only way in. The Telegram bot is removed — one capture path, one identity model. Recoverable from git history if ever wanted. |
| D16 | Releases | `main` is live and a push to it is a release. Branches are where work is built and proven, and push freely. Nothing crosses to `main` without passing CI + the PM tag + branch protection. |
| D21 | App rewrite | Built as a new page beside the live one. `index.html` is never left half-migrated; one commit swaps it. |
| D22 | Notebook view | A list of clips, newest first, with search. Each clip opens its own page, and that page is what grows. |
| D23 | Old sync | The GitHub-token sync goes in the same change that adds Google sign-in. Both paths are never live at once. |
| D24 | Build order | A layer is not built until the layer beneath it has been proven end to end, with a throwaway if needed. |
| D25 | Secret scan | Allows exactly one literal — the Firebase web key, which must ship in the app and is restricted to Firebase services. Nothing else. |
| D26 | Staging hosting | The staging Worker also serves the app, so it can be opened on a phone at all. Production keeps the app on GitHub Pages. |
| D27 | Topics | The AI proposes topics, two levels deep. The topic rows stay per-user even though the analysis that suggested them is shared. All questions answered; backend built 2026-08-22. |
| D28 | Transcripts | Whisper always translates -- the transcript is English whatever was spoken -- and the model floor moves from `base` to `small`. Measured, not argued: transcribe mode is wrong at every size. |
| D29 | Learning loop | The notebook connects to the user's own AI app (MCP), and what they learn is written back to the reel in a fixed seven-field shape. Claude Free is the target; Gemini is closed to India, so copy-out / paste-back stays. **Built 2026-08-23** — both protocol eras answered, only the secret's hash stored, one logged deviation from the spec. |
| D30 | Connector handshake | The connector refuses `server/discover` with a plain 400, so a dual-era client falls back to `initialize` — the only path a real client is known to complete. Measured against Claude, not argued. Amends D29. |
| D31 | Time zone | Every date and time the app or the connector shows is India time (`Asia/Kolkata`), not the device's zone and not UTC. Stored moments are unchanged — only what is displayed. A per-user zone is deliberately deferred. |
| D32 | Dark mode | Follows the phone or laptop until the person uses the switch in the header; after that their choice wins and is remembered on that device. Every colour is a variable, so the dark palette is written once. |
| D33 | Long videos | The ceiling is 3 hours, and over 10 minutes the video gets a different question, not just a bigger allowance: times written into the transcript and chapters asked for. The long shape is the short shape plus one field, so nothing downstream had to change. |
| D34 | Kinds and trackers | Each video is labelled with what KIND it is, and a product or tool video also comes back as rows you can sort and tick off. Top-level folders now merge instead of multiplying. A failed analysis stores a reason code, and a one-off is retried once. |
| D35 | Several AI keys | A list, not one key, spent in order. Only a spent allowance moves to the next; every other refusal stops and is shown against the key that gave it. Whose keys pay is D10 unchanged — the first saver's whole list, then the next saver's. |
| D36 | When production may be touched | Never offered or started until Jaiswal says the app is open to the public - "release", "deploy" and "go ahead" are not the trigger. And his staging data is carried over in every scenario, no exception. |
| D37 | The root page | `index.html` IS the app. The old capture page is retired to git history, `app.html` stays as a redirect so old links work, and the service worker is network-first so an installed phone app can never be pinned to a page that was replaced. |
| D38 | New tables | Two, from reading all 202 analysed videos: `prompt` (wording you paste into an AI, which was arriving as a tool) and rows for `tactic` (one thing worth trying, never one step). `setting`, `place`, `fee`, `channel` and `course` were considered and rejected for thin evidence. |
| D39 | Backfilling | A new table counts the reels read before it existed, says the number, and waits to be pressed. `analyses.shapes_version` is what makes that queue shrink to zero instead of asking for ever. |
| D40 | Creators | Who made each video is stored on the shared row, arrives free with the download's metadata pass, and is searchable. The ones already saved are filled in two at a time when the PC has no real work, metadata only — being rate-limited would cost transcription, not just this. |
| D41 | The look back | Every fortnight by default, changeable to weekly, monthly or never. It is an offer with a number on it and a button — one call over the reels that have been sitting unlooked-at, and no timer anywhere. Nothing is marked until the round-up is stored. |
| D42 | Very long videos | Past 30 minutes nothing downloads until he has been told the length, the time his PC is tied up, that everything queues behind it and that it can spend a day of a key - then said yes. A refusal parks it, and parked is never failed. The ceiling goes from 3 hours to 6, and the transcript limit moves with it so the refusal cannot come after the work. Whoever approves pays. |
| D43 | Home screen | The app opens on four sections he chose - what to act on, what he is learning about, what needs attention, what is new since he last looked. All of it computed from what the device already holds, so opening the app spends nothing. The notebook is one tab away and nothing in it was moved or removed. |
| D44 | The leftovers | Chapters, creators and the new tracker rows now reach the connector - they were stored, drawn in the app and reachable from it by nothing. The stale project dashboard is deleted, HANDOVER.md says it is a snapshot, and the merged branches are gone. |
| D45 | What the review found | Four independent reviewers found 14 blocking problems in D37-D44, including two in code written specifically to prevent the failure it caused. All fixed and pinned by tests. The bar stands: the author cannot be the reviewer. |
| D46 | Round two | Verified all 14 of D45 and found 19 more, three of them CREATED by D45 own fixes. The worst: the creator backfill was reading a quarter of the free daily database allowance for ever, a failed video was a dead end with no way back, and the fence round a stranger content could be closed by that content. |

---

## Open — needs a decision

| Topic | Question |
|---|---|
| Privacy policy | Required before any external user. Jaiswal wants provider-side visibility into what users search — that makes him a data fiduciary under the DPDP Act. |
| Data retention | No deletion date is set for anything a user stores. Golden Rule 11 requires one at the time of storage. |
| Instagram ToS | D4 knowingly breaches it. What the exposure actually is for a published product has not been researched. |
| Play Store | PWA works and is free. A real listing is a one-time $25 — not decided, not needed yet. |
| Transcription at scale | 1,000 users ≈ 3,000 downloads and ~50 hours of audio a day. Dedupe (D10) helps; the remainder has no plan. |
| Weekly digest delivery | Agreed as a feature. Email, Telegram, or push is undecided. |
| Notebook sharing | Agreed as a feature. Whether a shared notebook is public-link or account-to-account is undecided. |
| First external user | Who, and what gates it. |

---

## Build state

| Step | Covers | State |
|---|---|---|
| 1 | D1 schema + Worker API (auth, dedupe, delta sync, copy-paste tier) | Built and **deployed to staging** 2026-08-21 |
| 2 | PC worker (yt-dlp → faster-whisper → transcript) + Worker-side analysis | **Proven end to end on staging** 2026-08-21 — save → claim → download → transcribe → post back → Gemini analysis → read back |
| 3 | App rewrite — Google sign-in, delta sync, notebook view | **Done and live.** `index.html` IS the app since the D21 swap (D37); the old capture page and its GitHub-token sync are in git history |
| 4 | The six value features (below) | **Four of six built.** Topics (D27), the learning loop (D29), kinds and trackers (D34, D38), and the fortnightly look back (D41) — the last of which is the weekly nudge, in the app rather than by email |
| 5 | Compliance + launch gates | Not started. Production is parked and is not raised until he says the app is open to the public (D36) |

The six agreed value features: merge clips into one topic (built, D27) · "you already
know this" (built as the learning loop, D29) · turn advice into a task (still only a
`suggested_task` field) · weekly nudge (built as the fortnightly look back, D41) ·
credibility flag (built — claims carry a confidence, and D43 surfaces the doubted ones) ·
share a notebook (not started).

---

## Housekeeping

| Item | State |
|---|---|
| `D:\ClipToAction` as a git repo | Yes |
| Decision log + index | This file and `DECISION_LOG.md` |
| PM Discipline hook + CI check | Set up 2026-08-12 — run `git config core.hooksPath .githooks` once per clone |
| Test suite | **425 tests**, `cd backend && npm test`, plus **33** in `worker-pc`, `python -m unittest discover -p "test_*.py"`. They cover canonicalisation and dedupe, paste parsing, analysis validation, the auth surface end to end, topics (one analysis serves every saver, topic rows never cross notebooks, a hand-set topic is never moved), whether the app can tell the PC worker is running, the connector (both handshake versions, saved keys never in plain text, one notebook never visible from another, learnings written back, and since D38–D40 the chapters, creators and tracker rows that used to be reachable from nowhere), India time (D31), long videos (D33), several AI keys (D35), the new tables and the ask-before-backfill rule (D38, D39), the fortnightly look back (D41), the warning before a very long video (D42), and — new — **the app itself**, run out of `index.html` in Node against a real-shaped sync response (D43). The `worker-pc` tests guard the transcription settings (D28), the creator backfill's pacing (D40) and that a long video is asked about before it is downloaded (D42) |
| CI | `.github/workflows/ci.yml` — tests, syntax on all 3 runtimes, secret scan, tracked-`.env` check |
| Branch protection on `main` | **Not enabled** — needs to be switched on in GitHub settings, see `CLAUDE.md` |
| `COMPLIANCE.md` | Exists, mostly unfilled — see Open |
| Cloudflare / Firebase accounts | **Created** 2026-08-21 under `cliptoaction@gmail.com`. Cloudflare account `06b97f8f…`, subdomain `cliptoaction.workers.dev`, Firebase project `cliptoaction-ff144` (Google sign-in on, Analytics off), web app `ClipToAction Web` registered. **Gemini API key created** and connected to staging. |
| Staging | **Live** — `https://cliptoaction-api-staging.cliptoaction.workers.dev`, database `cliptoaction-staging`, both secrets set |
| Production | Nothing created. No database, no secrets, not deployed (D20) |
| Anything running end to end | **Yes** — two real reels went the whole way through staging on 2026-08-21, analysis included, and a third on 2026-08-22 came back with a topic and sub-topic and was filed under them |
