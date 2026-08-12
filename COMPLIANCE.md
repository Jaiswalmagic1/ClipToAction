# ClipToAction — Compliance Register

Required by Golden Rule 11. Every obligation that applies to this project, in one
scannable table. Reviewed and dated every session in which anything here changes.

Last reviewed: 2026-08-12

**Status today: nothing below is satisfied, and nothing needs to be until there is a user
other than Jaiswal.** That is the gate — see "Blocking the first external user".

---

## Registry

| Rule / Obligation | Layer | Source | What it requires | Last checked | Status |
|---|---|---|---|---|---|
| DPDP Act 2023 — data fiduciary duties | Statutory | Indian data protection law | Once real users store clips and searches, Jaiswal is a data fiduciary over third-party personal data. Needs a published privacy policy, a stated purpose, and a deletion path. | 2026-08-12 | **Open** |
| DPDP — retention limits | Statutory | Same | A deletion date set at the time data is stored. Golden Rule 11's data-expiry rule. Nothing in `backend/schema.sql` has one. | 2026-08-12 | **Open** |
| Provider-side visibility into user activity | Statutory | Same | Jaiswal has asked to see what users search and save. That is processing of personal data and must be disclosed in the privacy policy, not done quietly. | 2026-08-12 | **Open** |
| Instagram / Facebook Terms of Service | Platform | Meta platform terms | D4 downloads reels, which those terms prohibit. Accepted knowingly for personal use; the exposure for a *published* product has not been researched. | 2026-08-12 | **Open — researched before launch** |
| YouTube Terms of Service | Platform | YouTube ToS | Same question for YouTube downloads. Not researched. | 2026-08-12 | **Open** |
| Telegram Bot API terms | Technical | Telegram | Bot platform usage. Not reviewed. | — | Not started |
| Cloudflare Workers / D1 terms | Technical | Cloudflare | Free-tier acceptable use for a multi-user product. Not reviewed. | — | Not started |
| Firebase / Google Cloud terms | Technical | Google | Firebase Auth for external users. Not reviewed. | — | Not started |
| AI provider terms (Gemini, OpenAI, Groq, Anthropic, xAI) | Technical | Each provider | Users supply their own keys (D8), so each user's own agreement governs their usage — but the app transmits their key and content, which must be disclosed. | 2026-08-12 | **Open** |
| Google Play developer policy | Platform | Google Play | Only if the PWA is ever published as a Play listing. Not currently planned. | — | Not applicable yet |

---

## Blocking the first external user

None of the following is optional once someone other than Jaiswal signs in:

1. A published privacy policy covering what is stored, why, for how long, and that
   provider-side visibility exists.
2. A deletion path — a user can remove their data, and it actually goes.
3. A retention period set per table, enforced in code.
4. A researched answer on the Instagram/Facebook ToS exposure (D4), with the decision
   logged either way.

---

## Review cadence

| Compliance type | Frequency |
|---|---|
| Platform policies (Meta, YouTube, Telegram) | On integration change, and every 6 months |
| API / technical ToS (Cloudflare, Firebase, AI providers) | On new integration, and every 6 months |
| Statutory / legal (DPDP) | Every 6 months, and on any change to what is stored |
| Full audit | Annually, and before the first external user |

---

## Proof

Golden Rule 11's proof-first rule applies: complying is not enough, the compliance must be
logged. When any row above moves to satisfied, record what was done, when, and where the
evidence lives — not just the status change.
