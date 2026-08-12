# ClipToAction — Decision Log

> ## These are the building rules. They are binding.
>
> Every decision in this file is a rule this project is built to. Any future change —
> a new feature, a fix, a refactor, by anyone in any session — must follow them.
>
> **Deviation is allowed, silent deviation is not.** If something here has to change, that
> is itself a decision: log a new entry stating what changed, why, and what it supersedes.
> Mark the old entry superseded. Never quietly build against a rule and never leave the
> log behind the code.
>
> No misses. Adopted for ClipToAction by Jaiswal, 2026-08-12.

Why each decision was made, not just what it was. Every entry records the options that
were on the table, the factors that decided it, and what it rules out.

`DECISIONS.md` is the one-line index. This file is the reasoning behind it.
Newest entries at the bottom of each section. Never delete an entry — if a decision is
reversed, add a new entry that supersedes it and mark the old one.

---

## Capture

### D1 — Capture is link-only
**Date:** 2026-06-28
**Options considered:** a form the user fills in at save time; link plus optional notes; link only.
**Decided:** link only. The user sends a URL and nothing else.
**Why:** the entire problem being solved is that saving a reel currently costs effort and
returns nothing. Any field the user has to fill in at capture time reintroduces that cost
at exactly the moment they are least willing to pay it — mid-scroll.
**Rules out:** adding any required field to the capture flow. Title, topic, category and
notes are all derived later, never asked for up front.

### D2 — The Telegram bot is the mobile inbox; the PWA share target is secondary
**Date:** 2026-06-28
**Why:** Telegram is already installed, already in the Android share sheet, and queues
undelivered messages for roughly 24 hours — so a link shared while the worker is offline
is not lost.
**Consequence:** the bot must stay dumb. It extracts a URL and stores it; it never
analyses, never enriches, never blocks on anything slow.

### D3 — `data/ideas.json` in the GitHub repo is the store of record
**Date:** 2026-06-20
**Superseded by:** D6. **No longer the rule.** Retained because the file and its
GitHub-token sync code still exist in `index.html` and must be removed as part of the D6
migration, not left running alongside the new backend.

---

## Extraction and analysis

### D4 — Content comes from downloading the video and transcribing the audio
**Date:** 2026-08-12
**Options considered:** (a) download + speech-to-text + LLM analysis; (b) captions and
post metadata only; (c) automatic for YouTube, manual for everything else.
**Decided:** (a).
**Why:** Jaiswal's main source is Instagram and Facebook reels, which expose no usable
transcript — captions there are typically a line of hashtags. Option (b) would have
discarded almost everything actually said in the video, which is the only thing worth
keeping.
**Stated before he chose, and chosen anyway:** downloading reels is against Instagram's
and Facebook's terms of service, and this path needs an always-on machine. Recorded so it
is not re-litigated in a later session.
**Rules out:** designing any feature that assumes a caption or description is available.

### D5 — The enrichment worker runs on Jaiswal's own PC, and must stay host-agnostic
**Date:** 2026-08-12
**Options considered:** Oracle Cloud Always Free; GitHub Actions; Google Cloud e2-micro;
his own PC.
**Decided:** his own PC. Oracle rejected — his box is "too crowded".
**Why:** beyond the crowding, a home IP is the option most likely to survive Instagram's
blocking of datacentre IPs, which is the failure that would break the whole pipeline. Not
being always-on is acceptable because Telegram queues updates for ~24 hours (D2).
**Binding consequence:** the worker takes its host from configuration only (`API_BASE`,
`SERVICE_TOKEN`). Moving it to a cloud VM must never require a rewrite.

### D9 — Three AI tiers, with copy-paste as the floor
**Date:** 2026-08-12
**Decided:** (1) a Gemini free API key — the recommended, fully automatic path;
(2) any other provider key; (3) **copy-paste mode** — the app produces a ready-made
prompt, the user runs it in any free chat AI and pastes the answer back.
**Why:** tier 3 is Jaiswal's own design and it is the load-bearing one. It means no user
ever needs an API key and Jaiswal never has to fund a free allowance — every user can be
free from their first clip.
**Rules out:** any flow that dead-ends a user who has no API key.
**Build rule:** the tier-3 prompt must demand a single fenced JSON block, and a bad paste
must fail visibly rather than save garbage (Golden Rule 29).

### D10 — Transcripts and analyses are shared across users, not per-user
**Date:** 2026-08-12
**Decided:** `sources`, `transcripts` and `analyses` are one row per unique reel, keyed on
a canonical URL, and reused by everyone who saves it. Only `clips`, `notes`, `questions`,
`topics` and `tasks` are per-user.
**Why:** the cost that actually scales is download and transcription, not storage. At
1,000 users saving ~3 reels a day, most saves are repeats — deduplicating means one
download and one analysis per reel regardless of how many people save it.
**Rules out:** bring-your-own-database designs. Dedupe only works on a single shared
backend, which is a second, independent reason D6 was chosen over per-user Firestore.

### D11 — Analysis runs inside the Cloudflare Worker, never on the PC
**Date:** 2026-08-12
**Options considered:** decrypt the user's key and hand it to the PC worker; keep the key
in the Worker and call the provider from there.
**Decided:** the Worker calls the provider.
**Why:** users' API keys then never leave the Worker — the PC worker holds a service token
and nothing else. The PC's job narrows to download and transcribe, which is also the only
part that genuinely needs a home IP (D5).
**Consequence:** the PC worker never sees a user key, and provider adapters live in
`backend/src/analyze.js`, not in `worker-pc/`.

### D13 — API request shapes come from official documentation, never from memory
**Date:** 2026-08-12
**Why:** Jaiswal's instruction, after being told that four provider adapters had been
written from their standard shapes rather than from their docs — *"you need to go ahead
and read their documentation and build according to that."* Reading the docs immediately
found three stale model IDs (`gpt-4o-mini`, `grok-2-latest`, a date-suffixed Anthropic ID).
**Binding rule:** before writing or changing any call to an external API, read that
provider's current documentation. Where a doc cannot be reached, say so in the code's
README rather than presenting the shape as verified — `backend/README.md` records exactly
which adapters are doc-confirmed and which are not.
**This is Golden Rule 1 applied to this project.** It is repeated here because this
project talks to five AI providers plus Cloudflare, Firebase and Telegram.

---

## Backend, accounts and identity

### D6 — Backend is Cloudflare D1 + Firebase Auth
**Date:** 2026-08-12
**Supersedes:** D3.
**Options considered, with limits confirmed from each provider's own pricing page on
2026-08-12:**

| | Free ceiling | Why not |
|---|---|---|
| Firestore (Spark) | 1 GiB, 50K reads/day | Billed per read; ~500 daily active users |
| Supabase | 500 MB, unlimited requests | 5 GB/month egress cap; 500 MB storage |
| **Cloudflare D1** | **5 GB, 5M row-reads/day, no egress charge** | **chosen** |

**Decided:** Cloudflare D1 for storage, Firebase Auth for identity.
**Why:** D1 has ten times Supabase's storage and no egress cap, which is the limit that
would otherwise bite first at 1,000 users. D1's only gap is that it has no built-in login,
which Firebase Auth fills at no cost up to 50,000 monthly users.
**Consequence:** the app must delta-sync (`?since=`), not re-read the whole notebook on
each open. Every per-user table therefore carries `updated_at`, and that is not optional —
retrofitting it later means rewriting the data layer.

### D7 — Onboarding is Google sign-in and nothing else
**Date:** 2026-08-12
**Partially superseded by:** D8 — still binding for storage and accounts, no longer
binding for the AI key.
**Decided:** a user signs in with Google and is never asked to create a project, paste a
config, or perform any setup.
**Why:** this is what killed bring-your-own-Firestore. Asking a normal user to create a
Google Cloud account and paste config keys ends the install.
**Rules out (still):** any storage or account design that requires per-user infrastructure.

### D8 — AI analysis runs on the user's own AI account (bring your own key)
**Date:** 2026-08-12
**Supersedes:** D7 for the AI key only.
**Decided:** users connect whatever provider they already have — Gemini, OpenAI, Groq,
Anthropic, xAI — and the app stores that key encrypted.
**Why:** Jaiswal was explicit that analysis must run on the user's quota, not his.
**Stated before he chose:** this is exactly the friction D7 ruled out; only Gemini and
Groq offer genuinely free API keys, and a ChatGPT Plus or Claude Pro subscription does
**not** include API access. He chose it anyway, then designed D9's copy-paste tier to
remove the friction a different way.
**Build rule:** stored keys are encrypted at rest, never logged, and never returned to a
client.

### D12 — The project runs under its own Google account, `cliptoaction@gmail.com`
**Date:** 2026-08-12
**Decided:** Cloudflare, Firebase and the Gemini key all live under that account, not
under `rumeein@gmail.com`.
**Why:** this is a product intended for publication, not a Rumee internal tool. Keeping it
out of his personal account keeps ownership, billing and any future transfer clean.

---

## How this project is built

### D14 — gstack workflow and PM Discipline are adopted and enforced in this repo
**Date:** 2026-08-12
**Why:** Jaiswal's instruction, in his words — this project needs *"a system which doesn't
break for anybody, a system which makes everybody follow the same rules,"* so results do
not vary by which session does the work. Modelled on Kartaan's decision log and the Rumee
Dashboard's PM Discipline hook plus CI check.
**Decided — three layers, all required:**

1. **This file** is the binding rule set. `DECISIONS.md` is its index.
2. **A local pre-commit gate.** Staging any code file requires a completed
   `review_pass.json`; `prepare-commit-msg` then appends `[PM-REVIEWED]` to the commit
   message and deletes the file.
3. **A server-side check.** `.github/workflows/pm_check.yml` re-checks the pushed commit
   message for the tag, so a bypassed or unconfigured local hook is still caught.

**Why both layers:** the local hook can be skipped (`--no-verify`), missing
(`core.hooksPath` unset on a fresh clone), or wrong. The Actions check is the one that
cannot be bypassed from a developer machine. On the Rumee Dashboard this exact split is
what caught three consecutive commits whose local hook claimed a tag it never added.
**Rules out:** a hook that reports doing something it cannot structurally do. A
pre-commit hook runs before the commit object exists and cannot rewrite a message passed
via `git commit -m` — that is why tag injection lives in `prepare-commit-msg` here, and
why the pre-commit hook only validates.

### D15 — GitHub auto-push stays in force for this project
**Date:** 2026-08-12
**Decided:** Golden Rule 6 applies unchanged — code, docs and config are pushed without
asking. Kartaan's D20 (never auto-push) does **not** carry over.
**Why:** nothing here is live for anyone but Jaiswal yet, and the repo is the deployment
target for GitHub Pages. This must be revisited before the first external user — at that
point pushing becomes publishing.
**Still excluded:** force pushes, branch deletion, and any destructive git operation.
