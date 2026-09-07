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
