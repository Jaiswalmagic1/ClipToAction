# ClipToAction — Decision Tracker

Running list of what is settled and what is still open. Updated every session.
**Why each decision was made — options considered, factors weighed — is in
[DECISION_LOG.md](DECISION_LOG.md).** That file is binding; this one is its index.

Last updated: 2026-08-22

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
| 3 | App rewrite — Google sign-in, delta sync, notebook view | **In progress** — decided in D21–D23, being built on a branch |
| 4 | The six value features (below) | **Topics built and proven end to end** 2026-08-22 (D27) — migration, contract, filing, the sort button and the app's topic view. A real reel came back named and filed on staging |
| 5 | Compliance + launch gates | Not started |

The six agreed value features: merge clips into one topic · "you already know this" ·
turn advice into a task · weekly nudge · credibility flag · share a notebook.
Their tables exist in `backend/schema.sql`; none have endpoints yet.

---

## Housekeeping

| Item | State |
|---|---|
| `D:\ClipToAction` as a git repo | Yes |
| Decision log + index | This file and `DECISION_LOG.md` |
| PM Discipline hook + CI check | Set up 2026-08-12 — run `git config core.hooksPath .githooks` once per clone |
| Test suite | 97 tests, `cd backend && npm test`. Covers canonicalisation, paste parsing, analysis validation, the auth surface end to end, and topics — that one analysis serves every saver, that topic rows never cross between notebooks, and that a hand-set topic is never moved |
| CI | `.github/workflows/ci.yml` — tests, syntax on all 3 runtimes, secret scan, tracked-`.env` check |
| Branch protection on `main` | **Not enabled** — needs to be switched on in GitHub settings, see `CLAUDE.md` |
| `COMPLIANCE.md` | Exists, mostly unfilled — see Open |
| Cloudflare / Firebase accounts | **Created** 2026-08-21 under `cliptoaction@gmail.com`. Cloudflare account `06b97f8f…`, subdomain `cliptoaction.workers.dev`, Firebase project `cliptoaction-ff144` (Google sign-in on, Analytics off), web app `ClipToAction Web` registered. **Gemini API key created** and connected to staging. |
| Staging | **Live** — `https://cliptoaction-api-staging.cliptoaction.workers.dev`, database `cliptoaction-staging`, both secrets set |
| Production | Nothing created. No database, no secrets, not deployed (D20) |
| Anything running end to end | **Yes** — two real reels went the whole way through staging on 2026-08-21, analysis included, and a third on 2026-08-22 came back with a topic and sub-topic and was filed under them |
