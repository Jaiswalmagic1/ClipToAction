// The home screen (D43), run as the real app against a real-shaped sync response.
//
// He chose all four of these sections himself, and each answers a question two hundred
// cards newest-first cannot: what do I owe myself, what am I actually learning, what is
// stuck, and what has happened since Tuesday.
//
// What these pin is that each section reads the right rows and says the right thing about
// them — and, just as importantly, that opening the app costs nothing: no analysis, no
// call to a provider, no allowance. Everything here is computed from what the device holds.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

import { loadApp, syncPayload } from "./helpers/appharness.js";

const DAY = 24 * 60 * 60 * 1000;
const now = Date.now();

/** A saved reel, with everything the app needs to draw it. */
function reel({ id, at = now - 3 * DAY, title = "A reel", state = "analyzed", ...rest }) {
  return {
    clip: {
      id,
      user_id: "vish",
      source_id: `s-${id}`,
      status: "inbox",
      topic_id: rest.topic_id || null,
      topic_set_by: rest.topic_set_by || null,
      relooked_at: null,
      created_at: at,
      updated_at: at,
      deleted_at: null
    },
    source: {
      id: `s-${id}`,
      url_canonical: `https://www.facebook.com/share/r/${id}/`,
      url_original: `https://www.facebook.com/share/r/${id}/`,
      platform: "Facebook",
      title,
      creator: rest.creator || null,
      duration_sec: rest.duration_sec || 45,
      state,
      error: rest.error || null,
      error_detail: null,
      attempts: 0,
      created_at: at,
      updated_at: at
    },
    analysis: rest.analysis === null
      ? null
      : {
          source_id: `s-${id}`,
          user_id: "",
          provider: "gemini",
          model: "test",
          summary: rest.summary || "It said some things.",
          key_points: "[]",
          learn_more: "[]",
          claims: JSON.stringify(rest.claims || []),
          suggested_task: null,
          topic: null,
          sub_topic: null,
          sections: null,
          kind: rest.kind || "other",
          items: rest.items ? JSON.stringify(rest.items) : null,
          shapes_version: 2,
          created_at: rest.analysedAt || at
        }
  };
}

function payloadFrom(reels, extra = {}) {
  return syncPayload({
    clips: reels.map((r) => r.clip),
    sources: reels.map((r) => r.source),
    analyses: reels.map((r) => r.analysis).filter(Boolean),
    ...extra
  });
}

// ------------------------------------------------------------------ it opens on Home

describe("what opens", () => {
  let app;
  before(async () => {
    app = await loadApp(payloadFrom([reel({ id: "A" })]));
  });
  after(() => app.restore());

  test("the plain address opens Home, not the list", () => {
    assert.equal(app.$("homeView").hidden, false);
    assert.equal(app.$("listView").hidden, true);
  });

  test("the notebook is still there, one press away, and it is still the notebook", () => {
    const tabs = app.$("tabs");
    assert.deepEqual(tabs.children.map((child) => child.textContent), ["Home", "Notebook"]);
    app.tab("notebook");
    assert.equal(app.$("listView").hidden, false);
    assert.equal(app.$("homeView").hidden, true);
    // Nothing he uses today may be removed — that was the condition on the whole change.
    assert.ok(app.$("clipList").textContent.includes("A reel"));
    assert.equal(app.$("saveView").hidden, false, "the save box is on both landing screens");
  });

  test("one press draws one screen, not two", () => {
    // Setting the address fires the app's own hashchange handler, so calling render()
    // alongside it would rebuild everything twice — and on two hundred clips with a search
    // running, a rebuild means re-reading every transcript.
    const before = app.renders();
    app.tab("home");
    assert.equal(app.renders() - before, 1, "going to Home drew more than once");

    const again = app.renders();
    app.tab("notebook");
    assert.equal(app.renders() - again, 1, "going to the notebook drew more than once");
  });

  test("pressing the tab you are already on still redraws", () => {
    app.tab("notebook");
    const before = app.renders();
    app.tab("notebook");
    assert.equal(app.renders() - before, 1, "the address did not change, so nothing fired");
  });

  test("opening the app spends nothing", () => {
    // Every call the app made while starting up. Anything that reaches a provider, or any
    // POST that causes a re-read, would be spending an allowance he did not offer.
    for (const url of app.calls) {
      assert.match(url, /\/v1\/sync/, `opening the app must not call ${url}`);
    }
  });
});

// ------------------------------------------------------------------ 1. act on

describe("what I should act on", () => {
  let app;
  before(async () => {
    const reels = [
      reel({
        id: "P",
        title: "Three things under 25 rupees",
        kind: "product",
        items: [
          { name: "Hook set", cost: "Rs. 22", note: "holds 2kg" },
          { name: "Dishwash gloves", cost: "Rs. 13" }
        ]
      }),
      reel({
        id: "T",
        title: "A screen recorder",
        kind: "tool",
        items: [{ name: "Recordly", does: "records your screen" }]
      })
    ];
    app = await loadApp(
      payloadFrom(reels, {
        item_status: [
          {
            id: "i1",
            user_id: "vish",
            source_id: "s-P",
            item_key: "hook set",
            status: "doing",
            created_at: now,
            updated_at: now,
            deleted_at: null
          }
        ],
        relooks: [
          {
            id: "r1",
            user_id: "vish",
            themes: JSON.stringify([{ name: "Meesho", why: "Nine of these are Meesho." }]),
            act_now: JSON.stringify([
              { do: "Switch on Sunday Pickup", because: "It costs nothing", from: "Meesho settings" }
            ]),
            note: "Mostly Meesho this time.",
            clip_count: 9,
            covers_from: now - 40 * DAY,
            covers_to: now - 3 * DAY,
            created_at: now - DAY,
            updated_at: now - DAY,
            deleted_at: null
          }
        ]
      })
    );
  });
  after(() => app.restore());

  test("what the last look back said to do comes first", () => {
    const home = app.text("homeView");
    assert.ok(home.includes("From your last look back"));
    assert.ok(home.includes("Switch on Sunday Pickup"));
  });

  test("what he already said he would do is separated from what he has not decided", () => {
    const home = app.text("homeView");
    assert.ok(home.includes("You said you would"));
    assert.ok(home.includes("Hook set"), "the one he marked as ordered");
    assert.ok(home.includes("Waiting on a decision from you"));
    assert.ok(home.includes("Dishwash gloves"), "the one he has not answered about");
    assert.ok(home.includes("Recordly"), "rows come from every kind, not just products");
  });

  test("a decision he has made is not also listed as undecided", () => {
    const home = app.text("homeView");
    const waiting = home.slice(home.indexOf("Waiting on a decision from you"));
    assert.ok(!waiting.includes("Hook set"));
  });
});

// ------------------------------------------------------------------ 2. learning about

describe("what I'm learning about", () => {
  let app;
  before(async () => {
    const topics = [
      { id: "t-ecom", user_id: "vish", name: "e-commerce", parent_id: "", name_key: "ecommerce", summary: null, created_at: now - 200 * DAY, updated_at: now, deleted_at: null },
      { id: "t-meesho", user_id: "vish", name: "Meesho", parent_id: "t-ecom", name_key: "meesho", summary: null, created_at: now - 200 * DAY, updated_at: now, deleted_at: null },
      { id: "t-jewel", user_id: "vish", name: "jewellery", parent_id: "", name_key: "jewellery", summary: null, created_at: now - 300 * DAY, updated_at: now, deleted_at: null }
    ];
    const reels = [
      // Four e-commerce videos, three of them in the last month: growing.
      reel({ id: "E1", at: now - 2 * DAY, topic_id: "t-meesho" }),
      reel({ id: "E2", at: now - 5 * DAY, topic_id: "t-meesho" }),
      reel({ id: "E3", at: now - 20 * DAY, topic_id: "t-ecom" }),
      reel({ id: "E4", at: now - 45 * DAY, topic_id: "t-ecom" }),
      // Three jewellery videos, none for four months: drifted from.
      reel({ id: "J1", at: now - 120 * DAY, topic_id: "t-jewel" }),
      reel({ id: "J2", at: now - 130 * DAY, topic_id: "t-jewel" }),
      reel({ id: "J3", at: now - 140 * DAY, topic_id: "t-jewel" })
    ];
    app = await loadApp(payloadFrom(reels, { topics }));
  });
  after(() => app.restore());

  test("subjects are counted on the folder a person thinks in, not the sub-folder", () => {
    const home = app.text("homeView");
    // Two of the four e-commerce videos are filed under Meesho, which is inside
    // e-commerce. That is one interest, not two.
    assert.ok(home.includes("e-commerce — 4 videos"), home.slice(0, 400));
    assert.ok(!home.includes("Meesho — 2 videos"));
  });

  test("what is growing says so", () => {
    assert.match(app.text("homeView"), /e-commerce — 4 videos.*growing/s);
  });

  test("what he has drifted from says so, without calling it a problem", () => {
    const home = app.text("homeView");
    assert.ok(home.includes("jewellery — 3 videos"));
    assert.ok(home.includes("you have not added to this since"));
    assert.ok(home.includes("That is not a problem"));
  });

  test("the heaviest subject is first", () => {
    const home = app.text("homeView");
    assert.ok(home.indexOf("e-commerce — 4") < home.indexOf("jewellery — 3"));
  });

  // Pressing a subject has to ARRIVE at that subject. The first version searched for the
  // folder's name in text that does not contain it and showed "Nothing here matches"; the
  // second opened the folder view and stopped, which lands somewhere in the middle of two
  // hundred cards with the folder a few hundred rows away and nothing marking it.
  test("pressing a subject opens the folders and marks the one he pressed", () => {
    const row = app
      .$("homeView")
      .walk()
      .find((node) => node.classList.contains("tappable") && node.textContent.includes("jewellery"));
    assert.ok(row, "the subject is not pressable");
    row.onclick();

    assert.equal(app.$("listView").hidden, false, "it must open the notebook");
    const marked = app.$("clipList").byClass("landed");
    assert.equal(marked.length, 1, "exactly one folder is marked as the one he pressed");
    assert.equal(marked[0].textContent, "jewellery");
    assert.equal(app.$("search").value, "", "and it is not a search — the name is not in the text");
  });

  test("and the mark does not stay on every later draw", () => {
    app.tab("home");
    app.tab("notebook");
    assert.equal(app.$("clipList").byClass("landed").length, 0);
  });
});

// ------------------------------------------------------------------ 3. needs attention

describe("what needs attention", () => {
  let app;
  before(async () => {
    const reels = [
      reel({ id: "F", title: "A broken one", state: "failed", error: "Could not be downloaded.", analysis: null }),
      reel({ id: "W", title: "An hour with a seller", state: "needs_ok", duration_sec: 69 * 60, analysis: null }),
      reel({ id: "K", title: "One I put off", state: "parked", duration_sec: 113 * 60, analysis: null }),
      reel({ id: "N", title: "Written down only", state: "transcribed", analysis: null }),
      reel({
        id: "D",
        title: "A big claim",
        claims: [{ claim: "You will make a lakh a month", confidence: "low", why: "no evidence given" }]
      })
    ];
    app = await loadApp(payloadFrom(reels));
  });
  after(() => app.restore());

  test("a video waiting on his go-ahead is at the top, with its real length", () => {
    const home = app.text("homeView");
    assert.ok(home.includes("Waiting for your go-ahead"));
    assert.ok(home.includes("An hour with a seller"));
    assert.ok(home.includes("an hour and 9 minutes"), "the length is said in plain words");
    // "Downloaded" was not true: where a platform reports no length — Instagram routinely
    // does not — the audio IS fetched, measured, and deleted before the question is asked.
    // Nothing is KEPT, and nothing is read, which is what the answer decides.
    assert.ok(home.includes("nothing has been kept yet"), home.slice(0, 300));
  });

  test("and one of anything is never plural", async () => {
    // The single most important message this product shows read "6 hours and 1 minutes".
    // Small, and in the one place where being careless costs trust.
    const odd = await loadApp(
      payloadFrom([
        reel({
          id: "L",
          title: "A very long one",
          state: "needs_ok",
          duration_sec: 361 * 60,
          analysis: null
        })
      ])
    );
    const home = odd.text("homeView");
    assert.ok(home.includes("6 hours and 1 minute"), home.slice(0, 400));
    assert.ok(!home.includes("1 minutes"), "one minute was written as a plural");
    odd.restore();
  });

  test("a parked video is shown as parked, and never as failed", () => {
    const home = app.text("homeView");
    assert.ok(home.includes("Parked"));
    assert.ok(home.includes("One I put off"));
    const parked = home.slice(home.indexOf("Parked"), home.indexOf("Could not be read"));
    assert.ok(!parked.toLowerCase().includes("failed"));
    assert.ok(parked.includes("press go ahead whenever you want"));
  });

  test("a real failure says what went wrong", () => {
    const home = app.text("homeView");
    assert.ok(home.includes("Could not be read"));
    assert.ok(home.includes("Could not be downloaded."));
  });

  test("written down and never summarised says the likely reason", () => {
    const home = app.text("homeView");
    assert.ok(home.includes("Written down, never summarised"));
    assert.ok(home.includes("no AI account is connected"));
  });

  test("a claim the AI itself doubted, on a reel he never checked", () => {
    const home = app.text("homeView");
    assert.ok(home.includes("Doubted, and not checked"));
    assert.ok(home.includes("You will make a lakh a month"));
  });

  test("a doubted claim he HAS discussed is not nagged about", async () => {
    const reels = [
      reel({
        id: "D",
        title: "A big claim",
        claims: [{ claim: "You will make a lakh a month", confidence: "low", why: "none" }]
      })
    ];
    const checked = await loadApp(
      payloadFrom(reels, {
        learnings: [
          {
            id: "l1",
            user_id: "vish",
            clip_id: "D",
            learned: "[]",
            verdicts: JSON.stringify([{ claim: "a lakh a month", verdict: "false", why: "no" }]),
            actions: "[]",
            still_open: "[]",
            corrections: "[]",
            look_into: "[]",
            learned_with: "Claude",
            created_at: now,
            updated_at: now,
            deleted_at: null
          }
        ]
      })
    );
    assert.ok(!checked.text("homeView").includes("Doubted, and not checked"));
    checked.restore();
  });

  test("a quiet notebook says so rather than showing an empty heading", async () => {
    const quiet = await loadApp(payloadFrom([reel({ id: "A" })]));
    assert.ok(quiet.text("homeView").includes("Nothing is stuck and nothing is waiting on you."));
    quiet.restore();
  });
});

// ------------------------------------------------------------------ 4. what's new

describe("what's new since you last looked", () => {
  test("a first visit shows the last week, rather than nothing or everything", async () => {
    const app = await loadApp(
      payloadFrom([
        reel({ id: "NEW", title: "Saved on Tuesday", at: now - 2 * DAY }),
        reel({ id: "OLD", title: "Saved in June", at: now - 90 * DAY })
      ])
    );
    const home = app.text("homeView");
    assert.ok(home.includes("Saved on Tuesday"));
    const since = home.slice(home.indexOf("What's new since you last looked"));
    assert.ok(!since.includes("Saved in June"));
    app.restore();
  });

  test("an older reel that has just been summarised counts as new", async () => {
    const old = reel({
      id: "OLD",
      title: "Saved in June, read today",
      at: now - 90 * DAY,
      analysedAt: now - 60 * 1000,
      summary: "Finally summarised."
    });
    const app = await loadApp(payloadFrom([old]));
    const since = app.text("homeView").slice(
      app.text("homeView").indexOf("What's new since you last looked")
    );
    assert.ok(since.includes("been summarised"));
    assert.ok(since.includes("Saved in June, read today"));
    app.restore();
  });

  test("what is new holds still while he reads it", async () => {
    const app = await loadApp(payloadFrom([reel({ id: "NEW", at: now - 2 * DAY })]));
    const first = app.text("homeView");
    // Going to the notebook and back must not empty the section — which is exactly what
    // happens if the "last looked" mark is moved on every draw.
    app.tab("notebook");
    app.tab("home");
    assert.equal(app.text("homeView").includes("videos you saved"), first.includes("videos you saved"));
    app.restore();
  });
});

describe("two notices, two dismiss buttons", () => {
  // Both offers spend an AI account, so somebody on the copy-and-paste tier is shown a
  // notice instead of a button. They shared one "not now" key — first the re-look's, then
  // one of their own between the two of them — so dismissing either hid both for the day,
  // and the one he had not answered never came back.
  test("pressing 'not now' on one leaves the other where it is", async () => {
    const app = await loadApp(
      syncPayload({
        settings: { ai_provider: "manual", has_key: false },
        relook: { every_days: 14, last_at: null, due: 3, ready: true },
        clips: [behindClip()],
        sources: [behindSource()],
        analyses: [behindAnalysis()]
      })
    );

    const notices = app
      .$("homeView")
      .walk()
      .filter((node) => node.tag === "button" && node.textContent === "Not now");
    assert.equal(notices.length, 2, "both notices should be offering to be dismissed");

    notices[0].onclick();
    const left = app
      .$("homeView")
      .walk()
      .filter((node) => node.tag === "button" && node.textContent === "Not now");
    assert.equal(left.length, 1, "dismissing one notice took the other with it");
    app.restore();
  });
});

function behindClip() {
  return {
    id: "clip-behind",
    user_id: "vish",
    source_id: "src-behind",
    status: "inbox",
    created_at: 1,
    updated_at: 1
  };
}

function behindSource() {
  return {
    id: "src-behind",
    url_canonical: "https://instagram.com/reel/BEHIND",
    url_original: "https://instagram.com/reel/BEHIND",
    platform: "instagram",
    state: "analysed",
    title: "An older reel",
    created_at: 1,
    updated_at: 1
  };
}

function behindAnalysis() {
  return {
    source_id: "src-behind",
    user_id: "",
    provider: "gemini",
    summary: "Read before the tables existed.",
    key_points: "[]",
    learn_more: "[]",
    claims: "[]",
    kind: "tactic",
    items: null,
    shapes_version: 1,
    created_at: 1
  };
}

describe("the first five minutes, for somebody who is not him", () => {
  test("Home says what to do first, on the tab that opens", async () => {
    // Home is the tab that opens (D43). The nudge that explains a notebook only summarises
    // once one setup step is done lived on the notebook tab alone, so the one screen a new
    // person looks at was the one screen that never told them — until the machine had run
    // and left a reel "written down, never summarised", which can be a day if it is off.
    const app = await loadApp(
      syncPayload({ settings: { ai_provider: null, has_key: false } })
    );
    const home = app.text("homeView");
    // On an account with no reels yet the sentence says so — it used to tell a brand-new
    // person their reels were being saved when they had saved none.
    assert.match(home, /nothing will be summarised yet/);
    assert.match(home, /Set it up/);
    app.restore();
  });

  test("and stops saying so once it is set up", async () => {
    const app = await loadApp(
      syncPayload({ settings: { ai_provider: "manual", has_key: false } })
    );
    const drawn = app.text("homeView");
    assert.ok(!drawn.includes("nothing is being summarised yet"));
    assert.ok(!drawn.includes("nothing will be summarised yet"));
    app.restore();
  });

  test("a first visit does not invent a date it cannot know", async () => {
    // It printed a day before that person existed, which is the first sentence the product
    // says to them.
    const app = await loadApp(syncPayload({}));
    const home = app.text("homeView");
    assert.ok(!/^.*Since \d/m.test(home), `it made a date up: ${home.slice(0, 200)}`);
    assert.ok(!home.includes("Since "), "it made a date up");
    app.restore();
  });
});

describe("a reel he summarised by hand", () => {
  // The shared state stays at 'transcribed' for a paste on purpose (D18), and every screen
  // was reading that state as "does this clip have a summary". So a hand-summarised reel
  // said "no summary yet" directly above its own summary and stayed on the attention list
  // for ever — which, for anybody on the copy-and-paste tier (D9), is every reel they own.
  test("is not asked for a summary it already has", async () => {
    const clip = {
      id: "hand",
      user_id: "vish",
      source_id: "src-hand",
      status: "inbox",
      created_at: 1,
      updated_at: 1
    };
    const app = await loadApp(
      syncPayload({
        settings: { ai_provider: "manual", has_key: false },
        clips: [clip],
        sources: [
          {
            id: "src-hand",
            url_canonical: "https://instagram.com/reel/HAND",
            url_original: "https://instagram.com/reel/HAND",
            platform: "instagram",
            state: "transcribed",
            title: "Jhumka sourcing",
            created_at: 1,
            updated_at: 1
          }
        ],
        analyses: [
          {
            source_id: "src-hand",
            user_id: "vish",
            provider: "manual",
            summary: "Where to source jhumkas cheaply.",
            key_points: "[]",
            learn_more: "[]",
            claims: "[]",
            created_at: 1
          }
        ]
      })
    );

    const home = app.text("homeView");
    assert.ok(
      !home.includes("Written down, never summarised"),
      "it asked him to summarise the reel he had just summarised"
    );

    app.tab("notebook");
    const card = app.text("clipList");
    assert.ok(card.includes("Where to source jhumkas cheaply."), "the summary is not shown");
    assert.ok(!card.includes("no summary yet"), "the card denies the summary printed below it");
    app.restore();
  });
});

describe("a tidy that takes more than one press", () => {
  // A press does a few folders and says how many are left; the app presses again while
  // any are. Nothing tested the loop, so it could be reverted to a single request — a
  // half-finished tidy reporting success — with the whole suite still green.
  test("the app keeps pressing until nothing is left", async () => {
    // The button only appears where folders do.
    const app = await loadApp(
      syncPayload({
        topics: [
          { id: "t1", user_id: "vish", name: "Selling", parent_id: "", created_at: 1, updated_at: 1 }
        ],
        clips: [
          {
            id: "c1",
            user_id: "vish",
            source_id: "s1",
            status: "inbox",
            topic_id: "t1",
            topic_set_by: "ai",
            created_at: 1,
            updated_at: 1
          }
        ],
        sources: [
          {
            id: "s1",
            url_canonical: "https://instagram.com/reel/T1",
            url_original: "https://instagram.com/reel/T1",
            platform: "instagram",
            state: "analyzed",
            title: "A filed reel",
            created_at: 1,
            updated_at: 1
          }
        ]
      }),
      { hash: "" }
    );
    let presses = 0;
    app.answerWith((url) => {
      if (!String(url).includes("/v1/topics/tidy")) return null;
      presses += 1;
      return { ok: true, merged: 2, moved: 3, remaining: presses < 3 ? 5 : 0 };
    });

    app.tab("notebook");
    app.view("topics");
    await app.press("Tidy my folders");
    await new Promise((done) => setTimeout(done, 0));

    assert.equal(presses, 3, "it stopped before the tidy was finished");
    assert.match(app.text("syncMsg"), /6 folders together/);
    app.restore();
  });
});

describe("nothing on Home is cut off in silence", () => {
  // `andMore` exists and its own comment says it is there so a cut list is "said plainly
  // rather than by silently cutting". It was called for two lists out of six. The worst of
  // the four was the questions waiting on a go-ahead — hidden by the very section whose
  // reason for existing is that "a question sitting two hundred cards down is a question
  // nobody answers" (Golden Rule 29).
  const many = (state, count, extra = {}) =>
    Array.from({ length: count }, (unused, n) => ({
      id: `${state}${n}`,
      user_id: "vish",
      source_id: `s-${state}${n}`,
      status: "inbox",
      created_at: 1000 + n,
      updated_at: 1000 + n,
      ...extra
    }));

  const sourcesFor = (clips, state, duration) =>
    clips.map((clip) => ({
      id: clip.source_id,
      url_canonical: `https://instagram.com/reel/${clip.id}`,
      url_original: `https://instagram.com/reel/${clip.id}`,
      platform: "instagram",
      state,
      duration_sec: duration,
      title: `${state} ${clip.id}`,
      created_at: 1,
      updated_at: 1
    }));

  test("a long list says how many more there are, and where to find them", async () => {
    const asking = many("ask", 10);
    const parked = many("park", 9);
    const app = await loadApp(
      syncPayload({
        clips: [...asking, ...parked],
        sources: [
          ...sourcesFor(asking, "needs_ok", 69 * 60),
          ...sourcesFor(parked, "parked", 113 * 60)
        ]
      })
    );

    const home = app.text("homeView");
    assert.match(home, /and 4 more/, "ten questions were cut to six with nothing saying so");
    assert.match(home, /and 3 more/, "nine parked videos were cut to six in silence");
    // And a parked video says how long it is, like the row above it — a 113-minute one and
    // a 31-minute one read identically until you opened them.
    assert.match(home, /an hour and 53 minutes long — nothing has been started/);
    app.restore();
  });
});
