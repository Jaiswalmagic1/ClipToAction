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
    assert.ok(home.includes("nothing has been downloaded yet"));
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
