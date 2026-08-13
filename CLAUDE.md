# ClipToAction — Project Instructions

Read this before doing anything in this repo. It applies to every session, every person,
every agent. It sits under the global rules in `C:\Users\jaisw\.claude\CLAUDE.md` and
`D:\how-i-work\GOLDEN_RULES.md`, and adds what is specific to this project.

## What this product is

A user shares a reel link. The system downloads it, transcribes it, analyses it, and files
the result in a growing notebook they can search, question, annotate and learn from later.
Multi-user, publishable, and free to run. The reel is a seed, not the destination.

## Start here, in this order

1. `DECISION_LOG.md` — **the binding building rules.** Every entry is a rule this project
   is built to. Read it before proposing anything.
2. `DECISIONS.md` — the one-line index, plus what is still open and what is built.
3. `C:\Users\jaisw\.claude\projects\D--ClipToAction\memory\` — `active.md` for open work
   and the next entry point, `context.md` for architecture, accounts and capacity figures.

If a change you are about to make conflicts with `DECISION_LOG.md`, **stop.** Deviation is
allowed; silent deviation is not. Log a new decision that states what changed, why, and
what it supersedes, and mark the old entry superseded — then build.

## The workflow — five steps, in order

| Step | What it means here |
|---|---|
| **1. Understand** | State what you understood and ask what is unclear, together, before building. Non-trivial features get interviewed to completion first (Golden Rule 25). |
| **2. Plan** | Name the exact files and changes. Wait for an explicit go-ahead on anything non-trivial. |
| **3. Build** | Only what was agreed. Nothing extra (Golden Rule 21). |
| **4. Review** | Does it match the plan? Does it break anything? Is it security-clean? Is `DECISION_LOG.md` current? **Before pushing.** |
| **5. Ship** | Open a PR from your branch. Merging to `main` is the release (D16). |

Step 4 is recorded in `review_pass.json` and enforced — see below.

## Branches and `main` (D16)

**`main` is live.** GitHub Pages serves `index.html` from it, so merging to `main` *is* the
release — never a way to save work.

- **Work on a branch and push it freely.** Nothing on a branch is served, so pushing a
  branch is backup, not release.
- **Never commit or push directly to `main`.** Golden Rule 6's auto-push does not apply to
  `main` here.
- **Crossing to `main` means passing everything:** CI green (tests, syntax on all three
  runtimes, secret scan, no tracked `.env`), the `[PM-REVIEWED]` tag, and branch protection.

```bash
cd backend && npm test
```

**A change to canonicalisation, the analysis contract, or auth ships with the test that
proves it.** A PR that changes behaviour and adds no test has not passed this gate,
whatever CI reports.

### One-time setup on GitHub (not yet done)

Settings → Branches → Add branch ruleset for `main`: require a pull request, and require
the status checks **CI / Tests and checks** and **PM Discipline Check** to pass. Without
this the gate is advisory — CI will still run and go red, but nothing stops a merge.

## The enforcement — enable it once per clone

```bash
git config core.hooksPath .githooks
```

Committing any `.js`, `.mjs`, `.py`, `.html` or `.sql` file is **blocked** unless
`review_pass.json` exists and every field passes. Copy `review_pass.template.json` to
`review_pass.json`, fill it in honestly, then commit — `prepare-commit-msg` appends
`[PM-REVIEWED]` and deletes the file. A GitHub Actions job re-checks the pushed commit for
that tag, so a skipped or unconfigured local hook is still caught.

Never fill the checklist in as a formality. It is a claim that Review actually happened.

## Project-specific rules that bite most often

- **Capture stays link-only.** Never add a field to the capture flow (D1).
- **External API shapes come from the provider's current docs, never from memory** (D13).
  If a doc cannot be reached, say so in the README rather than presenting it as verified.
- **Users' AI keys never leave the Worker.** The PC worker holds a service token and
  nothing else (D11).
- **Transcripts and analyses are shared, per reel — not per user** (D10). Anything that
  breaks dedupe breaks the cost model.
- **Every per-user table carries `updated_at`** so the app can delta-sync (D6). This is
  not optional; retrofitting it means rewriting the data layer.
- **No silent failures.** Every error gets a visible home — a failed download or analysis
  is stored on the source and returned by sync so the app can show it (Golden Rule 29).
- **Secrets never enter the repo.** `.env` is gitignored; scan before every commit
  (Golden Rule 8).

## Layout

| Path | What it is |
|---|---|
| `backend/` | Cloudflare Worker + D1 schema. The API for both the app and the PC worker. |
| `worker-pc/` | Python worker: downloads audio, transcribes it, posts the transcript back. |
| `index.html` | The PWA — the only capture path (D17). Still on the old GitHub-token sync, being replaced (D3 → D6). |
| `.githooks/` | PM Discipline gate. Not active until `core.hooksPath` is set. |
