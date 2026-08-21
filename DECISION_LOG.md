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
**Superseded by:** D17. **No longer the rule.**
**Was:** Telegram as the primary capture path, because it is already installed and already
in the Android share sheet.

### D17 — The PWA share target is the only capture path. The Telegram bot is removed.
**Date:** 2026-08-13
**Supersedes:** D2.
**Decided:** `telegram-bot/` is deleted. The installed PWA registers in the Android share
sheet and does the same job.
**Why:** the bot was built before the app existed. It is now a second capture path with a
different identity model — it writes to the old `data/ideas.json` (D3, itself superseded)
and has no Firebase user, so a link it captures cannot belong to anyone. Keeping it would
mean maintaining two capture paths and two auth models to save one tap.
**What is not lost:** Telegram's ~24h message queue was D2's real advantage. The backend
replaces it — a saved link sits in `sources` as `pending` until the PC worker runs, so
nothing is lost while the PC is off either.
**Reversible:** the code stays in git history. If a Telegram entry point is ever wanted —
for users without the app installed, say — it comes back as a client of the D6 API with a
real user identity, not as a writer to a JSON file.

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

## The app

### D21 — The new app is built beside the live page, never on top of it
**Date:** 2026-08-21
**Options considered:** rewrite `index.html` in place; build the new app at a new path and
swap when it works.
**Decided:** build it as a separate page on a branch. `index.html` keeps serving the old
app, untouched, until the new one is proven — then one commit swaps it.
**Why:** GitHub Pages serves `index.html` straight from `main` (D16), so a half-finished
rewrite of that file is a half-finished public website. There is no safe intermediate state
when the file being edited *is* the release.
**Rules out:** any commit to `main` that leaves `index.html` in a partly-migrated state.
The swap is a single change that either works or is not made.
**Consequence:** for the length of the app work there are two apps in the repo. That is the
intended cost, and the old one is deleted by the same commit that promotes the new one.

### D22 — The notebook is a list of clips; each clip opens its own page that grows
**Date:** 2026-08-21
**Options considered:** one long page that everything is appended to; a list of clips, each
opening its own entry; clips grouped under topics.
**Decided:** a list, newest first, with search. Tapping a clip opens that clip's own page,
and that page is what grows as the user asks questions and writes notes.
**Why:** the product's core claim is that the reel is a seed, not the destination — the
entry has to be a place that grows. One long page cannot be that past a few dozen clips,
and topic grouping is a real feature (one of the six) that does not exist yet, so it cannot
be the only way in. Grouping is added later as a view over the list, not instead of it.
**Rules out:** a design where a clip has no page of its own.
**Consequence:** the list must be cheap to render from local storage and only ask the
server for what changed (D6). Search runs over what is already on the device.

### D23 — The GitHub-token sync is removed in the same change that adds Google sign-in
**Date:** 2026-08-21
**Completes:** D3, which was superseded by D6 and whose sync was left running.
**Options considered:** leave the old sync in place as a fallback until the new one settles;
remove it in the same change.
**Decided:** remove it in the same change.
**Why:** it stores a GitHub token with write access to the repository in browser storage on
a public `*.github.io` origin. That is not a fallback, it is a live exposure, and the only
reason to keep it would be distrust of the new path — which is what staging is for. It has
already been preserved once on the `github-sync-wip` branch, so nothing is lost.
**Rules out:** any build where both sync paths are live at once.

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

### D18 — Only the Worker writes to a shared row. Anything a user typed is stored against that user.
**Date:** 2026-08-13
**Why:** the independent review before the first merge found that a copy-paste analysis
(D9 tier 3) was written into the **shared** `analyses` table with only a clip-level
ownership check, and that it also set `sources.state='analyzed'`. Any signed-in user could
therefore publish a fabricated analysis to everyone who saved a reel, and stop that reel
ever being downloaded, permanently.
**Decided:** `analyses.user_id` — `''` means Worker-produced and shared; anything else is
one user's paste and only that user sees it. A paste never sets `sources.state`.
**The general rule this states:** a row that other people read may only be written by the
Worker from a source the Worker itself obtained. User-supplied content goes in a row keyed
to that user. Apply this to every shared table added later — topics, merged summaries,
anything the dedupe model introduces.

### D19 — The dedupe key must never merge two different videos, and never trust a host suffix
**Date:** 2026-08-13
**Why:** the same review found the canonicaliser dropped the entire query string, so every
`facebook.com/watch?v=<id>` — Facebook's main desktop video URL — collapsed onto one
`sources` row. No attacker needed: the first saver's video was downloaded and every other
user silently attached to it, seeing a stranger's transcript as their own clip. Separately,
`endsWith("youtube.com")` also matched `myyoutube.com`, letting anyone claim a real video's
canonical key while pointing the download at a host they controlled.
**Decided:** identifying query parameters are kept per host and tracking parameters are
dropped; host matching is `host === domain || host.endsWith("." + domain)`, never a bare
suffix; and only hosts on the platform allowlist can be saved at all.
**Build rule:** any change to `canonical.js` ships with a test asserting two different
videos do not collide, and that a lookalike host does not borrow a real one's key.
**Second job this allowlist does:** it is the outer wall against pointing the PC worker at
`192.168.x.x` or a cloud metadata address. `worker-pc/worker.py` re-checks resolved
addresses independently, because that worker runs on a home LAN.

### D20 — Nothing reaches production untested. Local, then staging, then production.
**Date:** 2026-08-13
**Why:** Jaiswal's instruction — *"testing is needed before we release."* D16 already made
`main` a release, but a green CI only proves the logic under test. Two independent reviews
had already found defects that no test would have caught, and at that point the code had
still never run against real infrastructure at all.
**Decided — three levels, each proving something the one before cannot:**

| Level | Command | Proves |
|---|---|---|
| Local | `npm run dev` (`wrangler dev --local`) | The Worker runs and its queries work. No account, nothing deployed. |
| Staging | `npm run deploy:staging` | Real Cloudflare, real D1, real Firebase tokens — own database, no real users. |
| Production | `npm run deploy:production` | — |

**Binding rules:**
- `wrangler deploy` with no `--env` has **no database binding**, so it cannot quietly ship
  to production. Production is always named explicitly.
- **Staging and production use different secret values.** A staging `WORKER_SERVICE_TOKEN`
  that also works in production means a test run can reach real users' data.
- A change is not releasable until it has been run through staging with a real reel — not
  merely proven by tests. Green CI is necessary, not sufficient.
**Cost:** none. Cloudflare's free tier covers a second Worker and a second D1.

### D15 — GitHub auto-push stays in force for this project
**Date:** 2026-08-12
**Superseded by:** D16, the following day. **No longer the rule.**
**Was:** Golden Rule 6 applies unchanged — code, docs and config pushed without asking.
**Why it was wrong:** it treated the repo as storage. It is the deployment.

### D16 — `main` is a release. Branches are where work is built and proven. Supersedes D15.
**Date:** 2026-08-13
**Supersedes:** D15 (auto-push to `main`). Golden Rule 6 does **not** apply to `main` in
this project — the same carve-out Kartaan made in its D20, for the same reason.
**Decided, in Jaiswal's framing:**

| | What it is |
|---|---|
| A branch | Where things are built and tested. Push freely — nothing on a branch is served to anyone. |
| `main` | Released and live. Moving `main` **is** the release. |
| The crossing | Nothing reaches `main` without passing every gate. |

**Why:** GitHub Pages serves `index.html` straight from `main`, so a push to `main` is not
saving work — it publishes. Jaiswal's own words: *"if at all that is something needs to be
pushed, the system has to be built in a way that it has to be verified and validated,
tested against everything possible. Only then it should go ahead and be pushed."*

**Why branches still push freely:** a rule of "never push" would leave the only copy of
the work on one PC. Separating backup from release keeps both properties — the work is
safe, and nothing ships unproven.

**The gate — all of it must pass, and it is machine-checked, not claimed:**

1. `.github/workflows/ci.yml` — unit tests, syntax checks on all three runtimes, a
   secret scan, and a check that no `.env` is tracked.
2. `.github/workflows/pm_check.yml` — the D14 `[PM-REVIEWED]` tag.
3. Branch protection on `main` requiring both, so the gate cannot be walked around.

**Why the tests exist at all:** without them "verified and validated" is a checkbox a
session ticks — exactly the failure D14 was built to stop. The first suite covers what can
break silently: URL canonicalisation (the D10 dedupe key — if it drifts, every reel is
re-downloaded and nothing errors), parsing a pasted AI reply (D9 tier 3), and the analysis
validator.

**Build rule that follows:** a change to canonicalisation, to the analysis contract, or to
auth ships **with** the test that proves it. A pull request that changes behaviour and adds
no test has not passed this gate, whatever CI says.

**Recorded because it was found while building this:** the secret scan's first version
matched credential *prefixes* and failed on the clean repo — `index.html`'s token field
literally reads `ghp_... or github_pat_...`. A gate that cries wolf gets switched off, so
it now matches credential shapes, and was verified both ways: silent on the clean repo,
still catches a planted key.

### D24 — A layer is not built until the layer beneath it has been proven end to end
**Date:** 2026-08-21
**Options considered:** build the app first and discover the backend's gaps through it;
prove the backend by hand first, then build the app on something known to work.
**Decided:** prove first. Before the app was written, one sign-in token was obtained by
hand, one clip was saved with it, and the whole chain was watched through on staging —
save, claim, download, transcribe, post back, analyse, read back.
**Why:** the app was the only thing that could produce a sign-in token, which made it look
like the app had to come first. It did not: a twenty-line throwaway page produced the same
token. Building the app first would have stacked new untested code on an untested chain,
and every failure would have had two possible homes.
**What it actually caught, before a line of app code existed:** the service token goes in an
`X-Service-Token` header and not a bearer token; analysis silently does nothing until some
user has a key connected; Instagram reports no duration but Facebook does.
**Rules out:** "we will find out when the app runs." If a layer cannot be exercised without
the thing being built on top of it, exercise it with a throwaway.
**Extends:** D20 — that rule says nothing ships untested; this one says nothing is *built
on* untested.

### D25 — The secret scan allows exactly one literal: the Firebase web key
**Date:** 2026-08-21
**Amends:** the secret scan established in D16. The scan itself, and the reason it matches
shapes rather than prefixes, is unchanged.
**The problem:** a Firebase web key and a Gemini key are the same shape — `AIzaSy` plus 33
characters. No pattern can tell them apart. But the Firebase one *has* to be inside the
app to work at all, so `app.html` (D21) makes the scan go red on a repo that is clean.
**Options considered:**

| | Why not |
|---|---|
| Exclude `app.html` from the scan | Blinds the gate on the file most likely to leak a real key |
| Break the key into pieces so the pattern misses it | Defeating the gate rather than deciding about it — exactly what D14 exists to stop |
| Serve the Firebase config from the Worker instead | The key still reaches the browser, so it protects nothing; it costs a request on every open and a new endpoint |
| **Allow one exact literal value** | **chosen** |

**Decided:** the scan deletes exactly one known value from each matching line and re-tests
the line. Anything still matching fails.
**Why this is safe to publish:** confirmed from `https://firebase.google.com/docs/projects/api-keys`
— Firebase web keys identify a project, they do not authorise; Google documents them as
fine to commit. That holds **only while the key is restricted**, because an unrestricted
key can reach any API enabled on the project, and Google says explicitly never to allow the
Gemini API on a public key. Checked in Google Cloud Console on 2026-08-21: the browser key
is restricted to 25 Firebase services and the Gemini API is **not** among them. The Gemini
key is a separate credential, scoped to the Gemini API alone.
**Also done at the same time:** `Firebase AI Logic API` was removed from the browser key's
list. It is a client-side route to the same Gemini models through a Firebase proxy, its
App Check guard is not set up, and this project does not use it — analysis runs in the
Worker (D11). It was access given away for no benefit.
**Rules out:** widening this to a file exclusion, a pattern, or a second value without a
new decision. One value, written in the workflow, with the reason next to it.
**Build rule:** if the Firebase key is ever rotated, the value in `ci.yml` changes with it.
**Proven both ways before it was committed** (Golden Rule 24): passes on the real repo;
still fails on a different Google key planted in its own file; still fails on a real key
planted on the *same line* as the allowed one.

**Noted, not decided:** Firebase AI Logic would remove the bring-your-own-key step
entirely — Firebase would hold Jaiswal's key and every user would run on his allowance.
That is D8 reversed, and it moves the cost to him. Raised with him on 2026-08-21 and left
switched off deliberately. If it is ever wanted, it is a decision to make on purpose.

### D26 — The staging Worker also serves the app. Production still does not.
**Date:** 2026-08-21
**Narrows:** D16 and D21, which both assume GitHub Pages serves the app. Unchanged for
production; this applies to staging alone.
**The problem:** Firebase only permits Google sign-in from `localhost` and from domains on
its authorised list. While the app existed only on a laptop's `localhost`, **it could not
be opened on a phone at all** — so the small-screen layout and, far more seriously, the
Android share sheet had never been run once. The share sheet is the only way anyone is
meant to capture a reel (D17), which meant the product's entire everyday use was untested.
**Options considered:**

| | Why not |
|---|---|
| Put `app.html` on `main` so GitHub Pages serves it | Merging to `main` is a release (D16). Testing is not a reason to release. |
| A new Cloudflare Pages project | Another service to create and keep in step, for a test |
| Expose the laptop over the local network | Not HTTPS, so Firebase sign-in still refuses, and it proves nothing about the real thing |
| **Serve it from the staging Worker** | **chosen** |

**Decided:** the staging Worker serves the app from a static assets folder alongside its
API. `wrangler.toml` gains `[env.staging.assets]` only — production is untouched.
**Why it is safe:** assets are matched by filename and every API route begins with `/v1/`,
so the two cannot collide; anything that matches no file falls through to the Worker
exactly as before. Verified after deploying: `/app.html`, `/manifest.json`,
`/share-target.html`, `/icon.svg` and `/` all serve, and `/v1/sync` with no sign-in still
returns `401 {"error":"Sign in first."}`.
**`html_handling = "none"`** so `/app.html` is served literally. Cloudflare otherwise
redirects it to `/app`, and the address a phone is tested against should be the same one
GitHub Pages will serve when the swap happens (D21).
**No second copy of the app.** `app.html` at the repo root stays the single source.
`backend/scripts/build-staging-assets.mjs` assembles the deploy folder and rewrites, on the
way through, the two files that still point at the old app — `manifest.json`'s `start_url`
and the share target's redirect. They are rewritten rather than edited, because D21 says
the live page and its plumbing stay untouched until the swap. The folder is gitignored.
**Also added to `app.html`:** a manifest link and a service worker registration. Android
will not offer to install the app without them, and an app that cannot be installed never
appears in the share sheet. The staging service worker caches nothing on purpose — a
cached `app.html` during testing makes edits look like they did not happen, which had
already cost time once.
**Rules out:** serving the app from the production Worker. Production keeps the app on
GitHub Pages and the API on Cloudflare, as D16 has it.
**Consequence:** the staging address must be added to Firebase's authorised domains, and it
is the one address where the app and the API share an origin — so a cross-site problem that
only appears in production would not show up in a staging test. Worth remembering when the
swap is made.

### D27 — The AI proposes topics, two levels deep. The topics themselves stay per-user.
**Date:** 2026-08-21
**Status:** direction settled by Jaiswal; the questions listed at the end are **not** settled
and must be answered before this is built.
**Builds on:** D22, which said grouping arrives later as a view *over* the list rather than
instead of it. That still holds — the list stays the way in.
**Options considered:** the user files clips into topics by hand; the AI proposes them; both.
**Decided:** the AI proposes. Jaiswal's words — *"ai decides topics with subcategory"*.
**And two levels, not one:** a topic with sub-topics under it, not a flat list of tags.
**Why the AI:** filing by hand is the effort the whole product exists to remove. D1 already
rules out asking for a category at capture time, and asking for one afterwards is the same
tax moved later. The analysis already returns `learn_more` — the tools, terms and concepts
each reel names — which is the raw material.

**The consequence that has to be got right first:** analyses are **shared** across everyone
who saved a reel (D10), but topics are **per-user** (D10 again, and D18 — anything a user
owns is stored against that user). So a proposed topic name may live in the shared analysis,
and every user who saved that reel may be *offered* the same name — but the `topics` row and
the `clip_topics` link are created per user, in their own notebook. One person renaming or
deleting a topic must never touch anyone else's. Anything that puts a user's own topic into
a shared row breaks D18.

**Schema consequence:** `topics` is flat today — no `parent_id`. Two levels needs a
migration, and `schema.sql` is all `CREATE TABLE IF NOT EXISTS`, so it goes in
`backend/migrations/` and not by editing the schema file. There is already real data from
three accounts.

**Contract consequence:** having the AI name topics means changing the analysis contract,
which under D16 ships with the test that proves it. Every analysis produced before that
change has no topic, so there must be an answer for the ones already stored.

**Still open — do not build until these are answered:**
1. Does the AI name topics inside the existing analysis, or in a separate pass?
2. One topic per clip, or several?
3. What happens to clips analysed before this existed?
4. Can the user rename, merge or override what the AI chose — and if they rename a topic
   the AI keeps proposing, does it stop fighting them?
5. How are two near-identical topic names kept from splitting one subject in two?
