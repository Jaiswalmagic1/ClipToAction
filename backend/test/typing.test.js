// What he TYPED, and where it exists.
//
// Twenty-two rounds all asked the same question: "was it saved?" This one asks the other:
// if this fails, or if he presses something else first, what is still holding a copy?
//
// A clip's page is rebuilt from nothing on every draw — `clipView.innerHTML = ""` — and
// seven of the buttons ON that page redraw it when they succeed. So pasting an hour of
// conversation with his AI into "Paste the AI's last reply", then remembering to add a note
// first and pressing Add note, saved the note and ERASED THE HOUR, with nothing on screen
// mentioning it. Ticking one tracker row wiped two boxes at once.
//
// There was no test in this repo that typed anything and then pressed anything else.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { loadApp, syncPayload } from "./helpers/appharness.js";

const now = Date.now();

function payload(overrides = {}) {
  return syncPayload({
    clips: [{
      id: "c1", user_id: "vish", source_id: "s1", status: "inbox",
      topic_id: null, topic_set_by: null, relooked_at: null,
      created_at: now - 86400000, updated_at: now, deleted_at: null
    }],
    sources: [{
      id: "s1", url_canonical: "https://x/1", url_original: "https://x/1",
      platform: "Facebook", title: "A reel", creator: null,
      duration_sec: 45, state: "analyzed", error: null, error_detail: null,
      attempts: 0, created_at: now - 86400000, updated_at: now
    }],
    analyses: [{
      source_id: "s1", user_id: "", provider: "gemini", model: "t",
      summary: "It said some things.", key_points: "[]", learn_more: "[]",
      claims: "[]", suggested_task: null, topic: null, sub_topic: null,
      sections: null, kind: "other", items: null, shapes_version: 2,
      created_at: now - 86400000
    }],
    ...overrides
  });
}

/** Every box on a clip's page, by the words in it. */
const boxes = (app) =>
  app.$("clipView").walk().filter((one) => one.tag === "textarea" || one.tag === "input");

const boxSaying = (app, placeholder) =>
  boxes(app).find((one) => String(one.placeholder || "").includes(placeholder));

const settle = async (turns = 8) => {
  for (let n = 0; n < turns; n += 1) await new Promise((done) => setTimeout(done, 0));
};

describe("something half-typed on a clip's page", () => {
  test("survives pressing a different button on the same page", async () => {
    // THE ONE THAT WAS DESTROYING WORK. He pastes an hour of conversation, then presses
    // Add note. The note saves, the page is rebuilt from nothing, and the hour is gone.
    const app = await loadApp(payload(), { hash: "#/clip/c1" });

    const filing = boxSaying(app, "Topic — the broad subject");
    assert.ok(filing, "the filing box is not on the page");
    filing.type("Buying from wholesalers in Jaipur");

    const note = boxSaying(app, "what you want to remember");
    assert.ok(note, "the note box is not on the page");
    note.type("remember to check the price");

    await app.press("Add note");
    await settle();

    const after = boxSaying(app, "Topic — the broad subject");
    assert.ok(after, "the filing box is gone from the page");
    assert.match(
      after.value,
      /Buying from wholesalers/,
      `what he had typed was erased by saving a note: "${after.value}"`
    );
    app.restore();
  });

  test("and the box it WAS saved from is emptied, so it is not saved twice", async () => {
    const app = await loadApp(payload(), { hash: "#/clip/c1" });
    const note = boxSaying(app, "what you want to remember");
    note.type("remember to check the price");
    await app.press("Add note");
    await settle();

    const after = boxSaying(app, "what you want to remember");
    assert.equal(
      after.value,
      "",
      `the saved note came back into the box and will be saved again: "${after.value}"`
    );
    app.restore();
  });

  test("and survives leaving the page and coming back", async () => {
    const app = await loadApp(payload(), { hash: "#/clip/c1" });
    boxSaying(app, "what you want to remember").type("half a thought, typed in");

    app.tab("notebook");
    await settle(2);
    app.$("clipView").hidden = false;
    globalThis.location.hash = "#/clip/c1";
    app.fire("hashchange");
    await settle(2);

    const back = boxSaying(app, "what you want to remember");
    assert.match(back.value, /half a thought/, `lost on the way back: "${back.value}"`);
    app.restore();
  });

  test("and survives closing the app entirely", async () => {
    const first = await loadApp(payload(), { hash: "#/clip/c1" });
    boxSaying(first, "what you want to remember").type("a thought I had not finished");
    const carried = [...first.localStore.entries()];
    first.restore();

    const second = await loadApp(payload(), { hash: "#/clip/c1", seed: carried });
    await settle(2);
    const box = boxSaying(second, "what you want to remember");
    assert.match(box.value, /a thought I had not finished/, `lost with the tab: "${box.value}"`);
    second.restore();
  });

  test("and is his own, not the next person's to sign in", async () => {
    const app = await loadApp(payload(), { hash: "#/clip/c1" });
    boxSaying(app, "what you want to remember").type("something private");

    await app.signInAs("someoneelse");
    await settle(4);
    globalThis.location.hash = "#/clip/c1";
    app.fire("hashchange");
    await settle(2);

    const box = boxSaying(app, "what you want to remember");
    if (box) {
      assert.doesNotMatch(
        box.value,
        /something private/,
        "one person's half-written note appeared in another person's box"
      );
    }
    app.restore();
  });
});

describe("a note the server took but the refresh after it did not", () => {
  test("is not reported as a failure he should try again", async () => {
    // The save and the refresh were in one `try`, so a failed refresh came back as a failed
    // save: the note was in his notebook and the screen said it was not, so he pressed again
    // and got two. D72 fixed this in `saveLink` and nowhere else.
    let requests = 0;
    const app = await loadApp(
      () => {
        requests += 1;
        // sign-in sync, then the POST, then the refresh — which is the one that fails.
        if (requests > 2) throw new TypeError("Failed to fetch");
        return payload();
      },
      { hash: "#/clip/c1" }
    );
    boxSaying(app, "what you want to remember").type("a note that really did save");
    await app.press("Add note");
    await settle();

    assert.doesNotMatch(
      app.text("clipMsg"),
      /offline|went wrong|could not/i,
      `a note the server took was reported as failed: "${app.text("clipMsg")}"`
    );
    app.restore();
  });
});

describe("the guard that keeps a background refresh off a page he is typing on", () => {
  test("a quiet refresh does not redraw a clip's page", async () => {
    // `refreshQuietly` runs every 45 seconds and on every return to the app, and a redraw
    // rebuilds the page from nothing. The one line stopping it doing that on a clip's page
    // could be deleted with the whole suite green — and with it gone he loses a note every
    // forty-five seconds.
    const app = await loadApp(payload(), { hash: "#/clip/c1" });
    const box = boxSaying(app, "what you want to remember");
    box.value = "typed, and not written down anywhere yet";

    const before = app.calls.filter((one) => one.includes("/v1/sync")).length;
    app.fire("focus");
    await settle();
    const after = app.calls.filter((one) => one.includes("/v1/sync")).length;

    assert.equal(
      after,
      before,
      "a background refresh ran while he was on a page with something typed on it"
    );
    assert.equal(
      boxSaying(app, "what you want to remember").value,
      "typed, and not written down anywhere yet",
      "the page was rebuilt under him"
    );
    app.restore();
  });
});

describe("the paste boxes, which only exist for somebody with no AI account", () => {
  // D9's copy-and-paste tier. These hold the longest thing anybody types into this app —
  // a whole conversation with their AI — and they are on the same page as everything else.
  const pasteTier = () => payload({
    settings: { ai_provider: "manual", has_key: false },
    analyses: [],
    transcripts: [{ source_id: "s1", text: "the words that were spoken", created_at: now }]
  });

  test("what is pasted into one is not erased by saving a note", async () => {
    const app = await loadApp(pasteTier(), { hash: "#/clip/c1" });
    const paste = boxSaying(app, "Paste the AI's whole reply");
    assert.ok(paste, `no paste box: ${boxes(app).map((one) => one.placeholder).join(" | ")}`);
    paste.type("An hour of conversation with my AI, pasted in and not yet saved.");

    boxSaying(app, "what you want to remember").type("a note");
    await app.press("Add note");
    await settle();

    const after = boxSaying(app, "Paste the AI's whole reply");
    assert.match(
      after.value,
      /An hour of conversation/,
      `an hour of pasted conversation was erased: "${after.value}"`
    );
    app.restore();
  });
});

describe("a draft against something that is already filed", () => {
  // The new way to lose his own work, made by the fix for the old one. `topicBox.value` is
  // filled in from his real filing and then overwritten by whatever draft is held — so a
  // topic he started retyping and walked away from became what the page SAID the clip was
  // filed under, on every open and on every device, for ever, while the notebook's own
  // folder headers said something else. Pressing Save then sent the abandoned topic
  // together with a sub-topic he had never touched, and D27 marks that as set by him so
  // nothing ever moves it back.
  const filedPayload = () => {
    const one = payload();
    one.clips[0].topic_id = "t2";
    one.clips[0].topic_set_by = "user";
    one.topics = [
      { id: "t1", user_id: "vish", name: "Business", parent_id: "", summary: null,
        created_at: now, updated_at: now, deleted_at: null },
      { id: "t2", user_id: "vish", name: "Suppliers", parent_id: "t1", summary: null,
        created_at: now, updated_at: now, deleted_at: null }
    ];
    return one;
  };

  test("an abandoned draft never speaks for the filing he actually chose", async () => {
    const first = await loadApp(filedPayload(), { hash: "#/clip/c1" });
    const topic = boxSaying(first, "Topic — the broad subject");
    assert.equal(topic.value, "Business", `it is not showing his filing: "${topic.value}"`);
    topic.type("Jaipur wholesal");
    const carried = [...first.localStore.entries()];
    first.restore();

    // Same clip, still filed the same way, opened again.
    const again = await loadApp(filedPayload(), { hash: "#/clip/c1", seed: carried });
    await settle(2);
    const back = boxSaying(again, "Topic — the broad subject");
    assert.match(
      again.text("clipView"),
      /not saved it/i,
      "the page shows something other than his filing and does not say so"
    );
    assert.match(back.value, /Jaipur wholesal/, "what he was typing was thrown away instead");
    again.restore();
  });

  test("and a draft is dropped once the filing has changed underneath it", async () => {
    const first = await loadApp(filedPayload(), { hash: "#/clip/c1" });
    boxSaying(first, "Topic — the broad subject").type("Jaipur wholesal");
    const carried = [...first.localStore.entries()];
    first.restore();

    // He filed it differently on another device, and that answer arrives here.
    const moved = filedPayload();
    moved.topics[0].name = "Buying";
    const later = await loadApp(moved, { hash: "#/clip/c1", seed: carried });
    await settle(2);

    const box = boxSaying(later, "Topic — the broad subject");
    assert.equal(
      box.value,
      "Buying",
      `a stale draft overrode a filing decision made somewhere else: "${box.value}"`
    );
    later.restore();
  });
});

describe("signing out on a borrowed machine", () => {
  test("takes what he half-wrote with it", async () => {
    // The one thing in browser storage that exists NOWHERE else — the notebook can be
    // fetched again, an unfinished note cannot — and it was the one thing left behind.
    const app = await loadApp(payload(), { hash: "#/clip/c1" });
    boxSaying(app, "what you want to remember").type("something I had not finished");
    assert.ok(
      [...app.localStore.keys()].some((key) => key.startsWith("cliptoaction-draft-")),
      "nothing was written down to begin with"
    );

    await app.$("signOut").onclick();
    await settle(2);

    assert.deepEqual(
      [...app.localStore.keys()].filter((key) => key.startsWith("cliptoaction-draft-")),
      [],
      "what he half-wrote was left on the machine"
    );
    app.restore();
  });

  test("and stops the device claiming to belong to him", async () => {
    // Left set, the share page went on stamping shares for the account that had just gone,
    // so the next person's own reels were marked as somebody else's and never saved.
    const app = await loadApp(payload(), { hash: "#/clip/c1" });
    assert.equal(app.localStore.get("cliptoaction-last-account"), "vish");

    await app.$("signOut").onclick();
    await settle(2);

    // Set to nobody, not removed. Removing it is worse: an unstamped share is treated as
    // belonging to whoever signs in next, so a reel shared during the signed-out window
    // would be drained into a stranger's notebook — the very thing the stamp exists to
    // stop, on the one window where nobody can say whose it is.
    const holder = app.localStore.get("cliptoaction-last-account");
    assert.notEqual(holder, "vish", "the device still says it belongs to the account that left");
    assert.ok(holder, "and an unstamped share is saved by whoever signs in next");
    app.restore();
  });
});

describe("the pile of half-written things", () => {
  test("does not grow without end", async () => {
    // Nothing removes a draft except the save it was written towards, so one he started and
    // walked away from lived for ever — in the same storage box the notebook copy needs.
    const many = [];
    for (let n = 0; n < 60; n += 1) {
      many.push([`cliptoaction-draft-vish-c${n}-note`,
        JSON.stringify({ text: `draft ${n}`, was: null, at: now - n })]);
    }
    const app = await loadApp(payload(), { hash: "#/clip/c1", seed: many });
    boxSaying(app, "what you want to remember").type("one more");
    await settle(2);

    const left = [...app.localStore.keys()].filter((key) => key.startsWith("cliptoaction-draft-"));
    assert.ok(left.length <= 41, `${left.length} half-written things are being kept`);
    app.restore();
  });

  test("and one from months ago is let go of", async () => {
    const ancient = [["cliptoaction-draft-vish-cOLD-note",
      JSON.stringify({ text: "from last year", was: null, at: now - 400 * 24 * 60 * 60 * 1000 })]];
    const app = await loadApp(payload(), { hash: "#/clip/c1", seed: ancient });
    boxSaying(app, "what you want to remember").type("something now");
    await settle(2);

    assert.equal(
      app.localStore.get("cliptoaction-draft-vish-cOLD-note"),
      undefined,
      "a draft from a year ago is still taking up room"
    );
    app.restore();
  });
});

describe("every box on a clip's page, one at a time", () => {
  // Round twenty-four deleted `keepDraft` from the sub-topic box and from "Paste the AI's
  // last reply" — the box in the previous entry's own headline sentence — and the whole
  // suite stayed green. And the draft key could lose the clip id entirely with nothing
  // going red, which would put one clip's half-written note into every other clip's box.
  // The note box is not in this list: it is the box being SAVED by the press below, so its
  // own draft is correctly cleared. It has its own test above.
  const each = [
    ["Topic — the broad subject", "topic"],
    ["Sub-topic — optional", "subtopic"]
  ];

  for (const [placeholder, what] of each) {
    test(`${what}: what is typed comes back after the page is rebuilt`, async () => {
      const app = await loadApp(payload(), { hash: "#/clip/c1" });
      boxSaying(app, placeholder).type(`half a ${what}`);

      // Any successful press on this page rebuilds it from nothing.
      boxSaying(app, "what you want to remember").type("and a note, which is what saves");
      await app.press("Add note");
      await settle();

      const back = boxSaying(app, placeholder);
      assert.match(back.value, new RegExp(`half a ${what}`), `${what} was erased: "${back.value}"`);
      app.restore();
    });
  }

  test("and the paste box for somebody with no AI account", async () => {
    const app = await loadApp(
      payload({
        settings: { ai_provider: "manual", has_key: false },
        analyses: [],
        transcripts: [{ source_id: "s1", text: "the words spoken", created_at: now }]
      }),
      { hash: "#/clip/c1" }
    );
    const paste = boxSaying(app, "Paste the AI's whole reply");
    assert.ok(paste, "no paste box on the page");
    paste.type("an hour of conversation");
    boxSaying(app, "what you want to remember").type("a note");
    await app.press("Add note");
    await settle();
    assert.match(boxSaying(app, "Paste the AI's whole reply").value, /an hour of conversation/);
    app.restore();
  });

  test("one clip's half-written note does not appear in another clip's box", async () => {
    // The draft key could lose the clip id with the whole suite green.
    const two = payload();
    two.clips.push({
      id: "c2", user_id: "vish", source_id: "s2", status: "inbox",
      topic_id: null, topic_set_by: null, relooked_at: null,
      created_at: now - 86400000, updated_at: now, deleted_at: null
    });
    two.sources.push({
      id: "s2", url_canonical: "https://x/2", url_original: "https://x/2",
      platform: "Facebook", title: "Another reel", creator: null,
      duration_sec: 45, state: "analyzed", error: null, error_detail: null,
      attempts: 0, created_at: now - 86400000, updated_at: now
    });

    const app = await loadApp(two, { hash: "#/clip/c1" });
    boxSaying(app, "what you want to remember").type("about the first one");

    globalThis.location.hash = "#/clip/c2";
    app.fire("hashchange");
    await settle(2);

    const other = boxSaying(app, "what you want to remember");
    assert.equal(
      other.value,
      "",
      `one clip's half-written note appeared on another clip: "${other.value}"`
    );
    app.restore();
  });

  test("and the filing's draft is let go of once the filing is saved", async () => {
    const app = await loadApp(payload(), { hash: "#/clip/c1" });
    boxSaying(app, "Topic — the broad subject").type("Selling");
    boxSaying(app, "Sub-topic — optional").type("Pricing");
    await app.press("Save");
    await settle();

    const left = [...app.localStore.keys()].filter((key) => key.includes("-c1-"));
    assert.deepEqual(left, [], `the filing's drafts came back: ${left.join(", ")}`);
    app.restore();
  });
});

describe("everything else that saves something, when the refresh after it fails", () => {
  // D75 said six places were split from their refresh. Four were. The tracker status was
  // the worst of the four left: a failed refresh reported the save as failed AND snapped
  // the dropdown back to the old answer, on a row the server was already holding.
  const refreshFails = (after) => {
    let requests = 0;
    return () => {
      requests += 1;
      if (requests > after) throw new TypeError("Failed to fetch");
      return payload();
    };
  };

  test("a tracker row the server took does not snap back on screen", async () => {
    const withItems = payload();
    withItems.analyses[0].kind = "product";
    withItems.analyses[0].items = JSON.stringify([{ name: "a stand", does: "holds it" }]);

    let requests = 0;
    const app = await loadApp(
      () => {
        requests += 1;
        if (requests > 2) throw new TypeError("Failed to fetch");
        return withItems;
      },
      { hash: "#/clip/c1" }
    );

    const select = app.$("clipView").walk().find((one) => one.tag === "select");
    assert.ok(select, "no tracker row on the page");
    const before = select.value;
    select.value = "doing";
    await select.onchange();
    await settle();

    assert.doesNotMatch(
      app.text("clipMsg"),
      /Could not save/i,
      `a decision the server took was reported as failed: "${app.text("clipMsg")}"`
    );
    assert.notEqual(select.value, before, "and the dropdown snapped back to the old answer");
    app.restore();
  });
});

describe("the box the headline was about", () => {
  // "Paste the AI's last reply" — the box D75's own first sentence names — had no test at
  // all: `keepDraft` could be deleted from it with the whole suite green. It is only on the
  // page once a reel has been written down, which the default fixture does not do.
  const withWords = (over = {}) => payload({
    transcripts: [{ source_id: "s1", text: "the words spoken", created_at: now }],
    ...over
  });

  test("what is pasted into it survives saving a note", async () => {
    const app = await loadApp(withWords(), { hash: "#/clip/c1" });
    const paste = boxSaying(app, "Paste the AI's last reply");
    assert.ok(paste, `no learn box: ${boxes(app).map((one) => one.placeholder).join(" | ")}`);
    paste.type("An hour of conversation with my AI, not saved yet.");

    boxSaying(app, "what you want to remember").type("a note");
    await app.press("Add note");
    await settle();

    assert.match(
      boxSaying(app, "Paste the AI's last reply").value,
      /An hour of conversation/,
      "the box the whole fix was named after still loses what is in it"
    );
    app.restore();
  });

  test("and a learning the server took is not reported as failed", async () => {
    let requests = 0;
    const app = await loadApp(
      () => {
        requests += 1;
        if (requests > 2) throw new TypeError("Failed to fetch");
        return withWords();
      },
      { hash: "#/clip/c1" }
    );
    boxSaying(app, "Paste the AI's last reply").type("{\"learned\":[\"a thing\"]}");
    await app.press("Save what you learned");
    await settle();

    assert.doesNotMatch(
      app.text("learnMsg"),
      /offline|went wrong|could not/i,
      `a learning the server took was reported as failed: "${app.text("learnMsg")}"`
    );
    app.restore();
  });

  test("and a reading the server took is not reported as failed either", async () => {
    let requests = 0;
    const app = await loadApp(
      () => {
        requests += 1;
        if (requests > 2) throw new TypeError("Failed to fetch");
        return withWords({ settings: { ai_provider: "manual", has_key: false }, analyses: [] });
      },
      { hash: "#/clip/c1" }
    );
    boxSaying(app, "Paste the AI's whole reply").type("{\"summary\":\"it said things\"}");
    await app.press("Save the answer");
    await settle();

    assert.doesNotMatch(
      app.text("byHandMsg"),
      /offline|went wrong|could not/i,
      `a reading the server took was reported as failed: "${app.text("byHandMsg")}"`
    );
    app.restore();
  });

  test("and a filing the server took is not reported as failed either", async () => {
    let requests = 0;
    const app = await loadApp(
      () => {
        requests += 1;
        if (requests > 2) throw new TypeError("Failed to fetch");
        return payload();
      },
      { hash: "#/clip/c1" }
    );
    boxSaying(app, "Topic — the broad subject").type("Selling");
    await app.press("Save");
    await settle();

    assert.doesNotMatch(
      app.text("clipMsg"),
      /offline|went wrong|could not/i,
      `a filing the server took was reported as failed: "${app.text("clipMsg")}"`
    );
    app.restore();
  });
});

describe("what round twenty-five found, one at a time", () => {
  test("signing out does not delete the other person's unfinished note", async () => {
    // Every other key sign-out removes carries the uid. Drafts did not, so signing in and
    // out on a shared phone deleted somebody else's half-written note — the one thing on
    // the device that exists nowhere else, destroyed by the code written to protect it.
    const app = await loadApp(payload(), {
      hash: "#/clip/c1",
      seed: [["cliptoaction-draft-bob-c9-note",
        JSON.stringify({ text: "bob's unfinished thought", was: null, at: now })]]
    });
    boxSaying(app, "what you want to remember").type("mine");

    await app.$("signOut").onclick();
    await settle(2);

    assert.ok(
      app.localStore.get("cliptoaction-draft-bob-c9-note"),
      "somebody else's unfinished note was deleted by his sign-out"
    );
    assert.deepEqual(
      [...app.localStore.keys()].filter((key) => key.startsWith("cliptoaction-draft-vish-")),
      [],
      "and his own was left behind"
    );
    app.restore();
  });

  test("a note saved just as somebody else signs in says nothing to them", async () => {
    // The four new catches were bare `catch {}`, so `accountChanged` — which is wordless on
    // purpose — was never consulted. The next person to sign in was shown a green
    // "Note added" about somebody else's notebook: the mirror image of the failure this
    // was fixing, reintroduced by the fix for it.
    const app = await loadApp(payload(), { hash: "#/clip/c1" });
    boxSaying(app, "what you want to remember").type("a note of his");

    // The refresh AFTER the note is held open, and the account changes underneath it —
    // which is exactly the window `accountChanged` exists for. The POST is let through.
    const release = app.hold(1, 1);
    const pressed = app.press("Add note");
    await settle(2);
    await app.signInAs("someoneelse");
    release();
    await pressed;
    await settle();

    assert.doesNotMatch(
      app.text("clipMsg"),
      /Note added|Saved|Filed/i,
      `the next person was told about somebody else's note: "${app.text("clipMsg")}"`
    );
    app.restore();
  });

  test("the unsaved sentence appears while he is typing, not at the next redraw", async () => {
    // It was worked out once when the page was built, so it never showed at the only moment
    // it is any use — and the test that claimed otherwise could not fail, because the
    // stand-in read hidden text as though it were on screen.
    const app = await loadApp(payload(), { hash: "#/clip/c1" });
    assert.doesNotMatch(app.text("clipView"), /not saved it/i, "it is showing already");

    boxSaying(app, "Topic — the broad subject").type("Selling");
    assert.match(
      app.text("clipView"),
      /not saved it/i,
      "nothing on screen says the filing shown is not the filing saved"
    );
    app.restore();
  });

  test("and there is a button that really does leave the filing alone", async () => {
    // The sentence used to say "clear the boxes to leave the filing as it is". Clearing them
    // and pressing Save sends two empty strings, which UNFILES the clip and marks it as set
    // by hand — so nothing automatic ever files it again. Following the advice destroyed the
    // decision the advice was protecting.
    const app = await loadApp(payload(), { hash: "#/clip/c1" });
    boxSaying(app, "Topic — the broad subject").type("Selling");
    assert.doesNotMatch(
      app.text("clipView"),
      /clear the boxes/i,
      "the page still tells him to do the destructive thing"
    );

    await app.press("Leave it as it is");
    await settle(2);
    assert.equal(boxSaying(app, "Topic — the broad subject").value, "");
    assert.deepEqual(
      [...app.localStore.keys()].filter((key) => key.includes("-c1-topic")),
      [],
      "the half-written change is still held"
    );
    assert.deepEqual(app.bodiesTo("/topic"), [], "and it sent something to the server");
    app.restore();
  });

  test("a note that saved but could not be redrawn does not fail silently", async () => {
    // Every one of the new inner catches covered `render()` as well as `sync()`, so a reply
    // of the wrong shape had no visible home at all — Golden Rule 29's exact failure, in
    // eight places at once, added by the fix for a different one.
    const app = await loadApp(payload(), { hash: "#/clip/c1" });
    boxSaying(app, "what you want to remember").type("a note");

    // The next draw cannot finish. In a browser this is a data shape the app cannot draw.
    const view = app.$("clipView");
    const realAppend = view.append.bind(view);
    view.append = () => { throw new Error("could not draw the page"); };

    await app.press("Add note");
    await settle();
    view.append = realAppend;

    const said = `${app.text("clipMsg")} ${app.text("syncMsg")}`;
    // Two things at once, and both matter. The fault must be VISIBLE — swallowed, a
    // drawing bug has no home at all. And it must not read as the note having failed: the
    // server took it, and telling him otherwise is how he ends up with two.
    assert.match(said, /could not be redrawn/i, `a drawing fault was swallowed: "${said}"`);
    assert.match(said, /Saved/i, `a note the server took was reported as failed: "${said}"`);
    app.restore();
  });

  test("a storage box that is already full is still tidied", async () => {
    // The tidy sat after `setItem` and inside its try, so when the box was full the write
    // threw and the tidy that would have freed the room never ran — inoperative in the one
    // condition it was built for.
    const many = [];
    for (let n = 0; n < 60; n += 1) {
      many.push([`cliptoaction-draft-vish-c${n}-note`,
        JSON.stringify({ text: `draft ${n}`, was: null, at: now - n })]);
    }
    const app = await loadApp(payload(), { hash: "#/clip/c1", quotaChars: 4000, seed: many });
    await settle(2);

    const left = [...app.localStore.keys()].filter((key) => key.startsWith("cliptoaction-draft-"));
    assert.ok(left.length <= 41, `${left.length} half-written things on a full device`);
    app.restore();
  });

  test("signing out takes his own queued shares with him", async () => {
    // A queued reel is his, by the same argument as a half-written note: it is on the
    // device and nowhere else, and it must not be sitting in a borrowed machine's storage
    // for the next person. Anything stamped for somebody else is left exactly where it is.
    const app = await loadApp(payload(), {
      hash: "#/clip/c1",
      failAfter: 1,
      seed: [["cliptoaction-pending-shares", JSON.stringify([
        { title: "", text: "", url: "https://www.instagram.com/reel/MINE/", at: 1, by: "vish" },
        { title: "", text: "", url: "https://www.instagram.com/reel/THEIRS/", at: 2, by: "bob" }
      ])]]
    });
    await settle(6);

    await app.$("signOut").onclick();
    await settle(2);

    const left = app.localStore.get("cliptoaction-pending-shares") || "";
    assert.ok(!left.includes("MINE"), `his own share was left on the machine: ${left}`);
    assert.match(left, /THEIRS/, "and somebody else's was taken away with it");
    app.restore();
  });

  test("a reel shared while nobody was signed in is asked about, not taken", async () => {
    // Sign-out used to REMOVE the marker saying whose device it is, and an unstamped share
    // belongs to whoever signs in next — so a reel shared during the signed-out window was
    // silently drained into a stranger's notebook.
    const app = await loadApp(payload(), { hash: "#/clip/c1" });
    await app.$("signOut").onclick();
    await settle(2);
    const holder = app.localStore.get("cliptoaction-last-account");

    // The share page stamps whatever it finds; the next person signs in.
    const next = await loadApp(payload(), {
      who: "someoneelse",
      seed: [["cliptoaction-pending-shares", JSON.stringify([
        { title: "", text: "", url: "https://www.instagram.com/reel/BETWEEN/", at: 1, by: holder }
      ])]]
    });
    await settle(6);

    const saved = next.bodiesTo("/v1/clips").map((one) => one.url);
    assert.equal(saved.length, 0, `it was taken by the next person: ${saved.join(", ")}`);
    next.restore();
    app.restore();
  });
});
