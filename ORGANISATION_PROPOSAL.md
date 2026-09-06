# How the notebook should organise what you save

Written 2026-08-29. A proposal, not a decision. Nothing here is built.
Based on reading your real staging notebook: **86 analysed videos.**

---

## What is actually in your notebook

| What you save | How many | What it holds |
|---|---|---|
| A tool or a code project someone found | 28 | name, what it does, how popular, free or paid, the link |
| Something with money in it — a product, a price, a margin | 26 | product, price, where to buy, the sum that makes it worth it |
| A tactic for selling — Flipkart, Meesho, Amazon | ~20 | the platform, the steps, what it fixes |
| Someone's opinion, myths, warnings | ~10 | only the claims, nothing to track |
| Long talks with chapters | 2 | already handled (D33) |

**Every one of them gets the exact same seven boxes today**: a summary, main points,
worth studying, claims, one suggested action, a topic and a sub-topic.

That is the whole problem. Three products with three prices and three shops get squashed
into a paragraph and four bullets.

### Your own example

You saved a video listing three items to sell for under Rs. 25. What the notebook holds:

> - 6-piece hook set priced at Rs. 22, capable of holding 1-2 kg
> - Dishwash gloves with heavy dual-layer quality priced at Rs. 13
> - Water coloring book including watercolors, a brush, and 7 drawing sheets priced at Rs. 25
> - Products can be purchased at store B-35 Madhubhya RIP Extension

Right words, wrong shape. You cannot sort that by price. You cannot ask "show me
everything under Rs. 30". You cannot tick one off as ordered. It is a paragraph pretending
to be a list.

**What it should be — three rows in a products tracker you can sort and tick:**

| Item | Cost | Where | Note | From | Status |
|---|---|---|---|---|---|
| 6-piece hook set | Rs. 22 | B-35 Madhubhya RIP Extn | holds 1-2 kg | that reel | — |
| Dishwash gloves | Rs. 13 | same | dual layer | that reel | — |
| Water colouring book | Rs. 25 | same | 7 sheets + brush | that reel | — |

Same for the 28 tool videos — a tools tracker with name, what it does, popularity, free or
paid, and the link, instead of 28 separate paragraphs saying "this project has 29,000 stars".

---

## The change: ask the AI what kind of video it is, then ask the right questions

One new label per video — **what kind it is** — and one extra block of answers that
depends on the kind. Everything that exists today stays exactly as it is.

This is the same move that worked for long videos (D33): the new shape is the old shape
plus one thing, so the app, the connector and the topic filing all carry on unchanged.

| Kind | The extra questions it gets asked |
|---|---|
| **Product / deal** | item, cost, selling price if said, where to buy, minimum order, one-line spec |
| **Tool / project** | name, what it does, popularity, free or paid, the link, how to install |
| **Tactic / how-to** | which platform, the steps in order, what problem it fixes |
| **Opinion / warning** | nothing extra — the claims box already does this job |
| **Long talk** | chapters, as now |

If the AI cannot tell, it says so and the video behaves exactly as it does today. Nothing
breaks and nothing needs re-running.

### What you get out of it

Two new screens beside the notebook list:

1. **Products** — every item from every deal video, one row each, sortable by cost, with a
   status you set yourself: *want to source / ordered / rejected / listed*.
2. **Tools** — every tool from every tool video, one row each, with *want to try / tried /
   using / not for me*.

Both searchable, both exportable, both fed automatically as you keep saving.

---

## The second thing that is broken: the filing is a mess

86 videos are filed under **45 different topics.** Including these, which are the same
subject written five ways:

`Artificial Intelligence` / `artificial intelligence` / `AI tools` / `AI development` /
`AI development tools` / `AI Development` / `AI coding assistants` / `AI coding tools`

**Why:** the AI is told, in writing, *"Name them from this video alone. You have not been
shown anyone's existing topics."* (D27). So it invents a fresh name every single time.
Nearly every video ends up in its own folder, which is the same as having no folders.

**The fix is one line of the instruction:** show the AI the topics you already use, and
tell it to reuse one if it fits and only invent a name when nothing does. Plus a one-time
tidy-up that merges the names that are already duplicated.

This changes D27 and needs a new decision written before it is built.

---

## The third thing: the error you have been seeing

**"Analysis failed: the AI provider refused the request"** — on 3 of your 86 videos.
27 Aug, 28 Aug, 29 Aug. One a day, three different days.

| Video | Length | Transcript |
|---|---|---|
| How To Boost Your sale organica... | 62s | 1,108 characters |
| Master AI Coding with these 6 G... | 26s | 436 characters |
| Level up your video demos with Op... | 28s | 399 characters |

Short, ordinary, nothing unusual about any of them. Videos far longer went through fine on
the same days.

**Why nobody can currently say what went wrong.** The Worker deliberately throws away
whatever the AI provider said and replaces it with that one sentence. That is there for a
good reason — a rejection message can carry a piece of your key or your billing details,
and this text is shown to everyone who saved the same video. But it also means the actual
reason is gone, and guessing at it would be exactly the mistake Golden Rule 1 exists to
prevent.

**So the fix is in two parts, in order:**

1. **Keep the provider's short reason code** — the one-word reason only, never the message
   body, never anything that could carry a key. Stored where only you can see it, not in
   the shared text everyone reads. Then the next time it happens, the cause is known
   instead of guessed at.
2. **Retry once before giving up.** Right now it tries once and stops. A one-a-day pattern
   with no content in common looks far more like a passing blip than something wrong with
   those three videos — and a blip should be retried, not surfaced as a failure.

**Right now, today:** those three still have their transcripts. Pressing *"Summarise this
one"* on each will most likely just work.

### Two other failures worth knowing about

| Video | What it says | Status |
|---|---|---|
| A 113-minute video | "over the 30 minute limit" | **Already fixed but not live.** D33 raised the ceiling to 3 hours on the `long-videos` branch. Not merged, and its database change has not been run. |
| One video | "could not be downloaded or transcribed" | Gave up after 3 tries. Facebook probably refused the download. Nothing to fix in the code. |

---

## What this would cost to build

| Piece | Size | Depends on |
|---|---|---|
| Kind label + per-kind questions | The prompt, one new stored column, the parser | nothing |
| Products tracker screen | New screen + a status you set | the above |
| Tools tracker screen | Same screen, different columns | the above |
| Reuse existing topics | A few lines of the prompt + a one-time tidy | needs D27 amended |
| Keep the provider's reason code | Small, and self-contained | nothing |
| Retry analysis once | Small | the above |

Each ships with the test that proves it, per the repo's own rule.

---

## Order I would build them in

1. **Keep the reason code + retry once** — smallest, and it stops the thing that is
   annoying you now.
2. **Reuse existing topics** — biggest gain for the least work. It fixes 86 videos at once.
3. **Kind label + per-kind questions** — the real change.
4. **Products and Tools trackers** — the screens that make it visible.

Nothing above is started. Each needs a decision written first.
