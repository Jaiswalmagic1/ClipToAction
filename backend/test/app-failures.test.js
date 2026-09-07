// What he sees when something goes wrong.
//
// A reviewer pointed out that the app's tests had never executed a single failure path:
// the harness answered every request with `ok: true` and never let browser storage throw.
// So every message Golden Rule 29 exists to guarantee — "you appear to be offline",
// "could not save that", "back in the queue" — was unproven, and two of them were being
// written into a hidden element where nobody could have seen them anyway.
//
// These tests break things on purpose.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { loadApp, syncPayload } from "./helpers/appharness.js";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const now = Date.now();

function payload(overrides = {}) {
  return syncPayload({
    clips: [
      {
        id: "c1", user_id: "vish", source_id: "s1", status: "inbox",
        topic_id: null, topic_set_by: null, relooked_at: null,
        created_at: now - 86400000, updated_at: now, deleted_at: null
      }
    ],
    sources: [
      {
        id: "s1", url_canonical: "https://x/1", url_original: "https://x/1",
        platform: "Facebook", title: "A reel", creator: null,
        duration_sec: 45, state: "analyzed", error: null, error_detail: null,
        attempts: 0, created_at: now - 86400000, updated_at: now
      }
    ],
    analyses: [
      {
        source_id: "s1", user_id: "", provider: "gemini", model: "t",
        summary: "It said some things.", key_points: "[]", learn_more: "[]",
        claims: "[]", suggested_task: null, topic: null, sub_topic: null,
        sections: null, kind: "other", items: null, shapes_version: 2,
        created_at: now - 86400000
      }
    ],
    ...overrides
  });
}

describe("when the first sync fails", () => {
  test("he is told, on the screen he is actually looking at", async () => {
    // `syncMsg` used to live inside the notebook. Home became the screen that opens, so
    // this message went into a hidden box and he saw a normal-looking Home built from
    // stale data with nothing saying anything had failed.
    const app = await loadApp(payload(), { failAfter: 0 });
    assert.equal(app.$("homeView").hidden, false, "Home must still draw");
    assert.match(app.text("syncMsg"), /offline/i);
    assert.equal(app.$("syncMsg").hidden, false);
    app.restore();
  });

  test("the message is not buried inside a view that can be hidden", async () => {
    const app = await loadApp(payload(), { failAfter: 0 });
    // Walk up from the message to the top: it must not sit inside any of the four views,
    // because three of them are hidden at any moment.
    const views = new Set(["homeView", "listView", "clipView", "settingsView"]);
    let node = app.$("syncMsg").parentNode;
    while (node) {
      assert.ok(!views.has(node.id), `the message sits inside ${node.id}`);
      node = node.parentNode;
    }
    app.restore();
  });
});

describe("when browser storage is blocked", () => {
  test("the notebook still loads and still syncs", async () => {
    // Safari's private window, and any browser set to block site data, THROWS on
    // localStorage rather than returning null. One unguarded read sat between the first
    // render and the first sync: it threw, the sign-in handler stopped there, and he was
    // left signed in looking at an empty notebook with nothing explaining it.
    const app = await loadApp(payload(), { storageBlocked: true });
    assert.ok(app.calls.some((url) => url.includes("/v1/sync")), "the sync never ran");
    assert.ok(app.text("homeView").includes("What needs attention"));
    app.restore();
  });

  test("and the look back is still offered rather than crashing on the snooze", async () => {
    const app = await loadApp(
      payload({ relook: { every_days: 14, last_at: null, due: 5, ready: true } }),
      { storageBlocked: true }
    );
    assert.ok(app.text("homeView").includes("Look back over them"));
    app.restore();
  });
});

describe("when a request fails after he has walked away from the page", () => {
  test("nothing throws, and the reason still reaches him", async () => {
    // A clip's page builds its own message box, and leaving the page destroys it. Three
    // handlers wrote to that box by name — so a request that answered after he had gone
    // back hit `null.innerHTML`, threw where nobody catches it, and the note was lost with
    // nothing on screen.
    const app = await loadApp(payload(), { hash: "#/clip/c1" });
    assert.equal(app.$("clipView").hidden, false);

    app.tab("notebook");
    app.goOffline();

    // The status chips on the notebook write to `clipMsg` if it is still there.
    const filters = app.$("filters");
    const done = filters.children.find((one) => one.dataset.status === "done");
    assert.ok(done);
    filters.onclick({ target: done });

    // Whatever happens, it must not be a crash, and Home/the notebook must still be drawn.
    assert.equal(app.$("listView").hidden, false);
    app.restore();
  });
});

describe("a video that could not be read is not a dead end", () => {
  test("its page offers to put it back in the queue", async () => {
    const broken = payload();
    broken.sources[0].state = "failed";
    broken.sources[0].error = "Could not be downloaded.";

    const app = await loadApp(broken, { hash: "#/clip/c1" });
    const page = app.text("clipView");
    assert.ok(page.includes("It is not gone"), "nothing offers a way back");
    assert.ok(page.includes("Try it again"));
    app.restore();
  });

  test("pressing it asks the Worker, and says so", async () => {
    const broken = payload();
    broken.sources[0].state = "failed";
    broken.sources[0].error = "Could not be downloaded.";

    const app = await loadApp(broken, { hash: "#/clip/c1" });
    const button = app
      .$("clipView")
      .walk()
      .find((node) => node.tag === "button" && node.textContent === "Try it again");
    assert.ok(button, "the button is not there");

    await button.onclick();
    assert.ok(
      app.calls.some((url) => url.includes("/v1/clips/c1/retry")),
      "pressing it asked the Worker for nothing"
    );
    app.restore();
  });

  test("a failure to put it back is shown, not swallowed", async () => {
    const broken = payload();
    broken.sources[0].state = "failed";
    broken.sources[0].error = "Could not be downloaded.";

    const app = await loadApp(broken, { hash: "#/clip/c1" });
    app.goOffline();
    const button = app
      .$("clipView")
      .walk()
      .find((node) => node.tag === "button" && node.textContent === "Try it again");

    await button.onclick();
    const shown = `${app.text("clipMsg")} ${app.text("syncMsg")}`;
    assert.match(shown, /offline/i, "the failure went nowhere he could see it");
    assert.equal(button.disabled, false, "and the button is usable again");
    app.restore();
  });
});

describe("when the device will not hold the whole notebook", () => {
  test("the words are dropped and the clock is wound back, so nothing is lost", async () => {
    // The words of a video are only ever sent by a DELTA sync. There is no route anywhere
    // that fetches one on its own — so a saved copy that drops the transcripts while
    // KEEPING the clock does not shrink the notebook, it deletes what was said in every
    // reel, permanently, with nothing on screen. Winding the clock back is the whole of
    // why the smaller copy is safe.
    const big = payload();
    big.transcripts = [
      { source_id: "s1", text: "a".repeat(5000), lang: "en", engine: "test", created_at: now }
    ];
    // Real rows, so "his notes are never dropped" is decided by the code rather than by
    // both sides happening to be empty.
    big.notes = [{
      id: "n1", user_id: "vish", clip_id: "c1", body: "a note that exists nowhere else",
      created_at: now, updated_at: now, deleted_at: null
    }];
    big.learnings = [{
      id: "l1", user_id: "vish", clip_id: "c1", source_id: "s1",
      worked: "[]", did_not: "[]", learned: '["what I worked out"]', questions: "[]",
      verdicts: "[]", next_steps: "[]", note: null,
      created_at: now, updated_at: now, deleted_at: null
    }];

    // Big enough for the notebook without its words, too small for it with them.
    const app = await loadApp(big, { quotaChars: 3000 });

    const cached = JSON.parse(app.localStore.get("cliptoaction-notebook-vish"));
    assert.ok(cached, "nothing was saved at all — the smaller copy must still be written");
    assert.deepEqual(cached.transcripts, [], "the words are the thing that is dropped");
    assert.equal(cached.since, 0, "and the clock MUST be wound back, or they are gone");
    // What he typed exists nowhere else on the device and is never dropped. Asserted on
    // the CONTENTS, not on the keys: `notes: []` satisfies `"notes" in cached`, so the
    // claim could be broken with the whole suite green.
    assert.deepEqual(
      cached.notes,
      big.notes,
      "his notes were dropped from the smaller copy — they exist nowhere else here"
    );
    assert.deepEqual(cached.learnings, big.learnings, "and neither may his learnings be");
    assert.ok(cached.analyses.length > 0, "and the readings went with them");
    app.restore();
  });

  test("and he is told his phone is short of space, rather than just being slow", async () => {
    // Once the box is full it STAYS full, so every cold start from then on re-reads the
    // whole notebook from the server — for ever, silently, and it is the most expensive
    // thing the app does. Nothing is lost; it is simply slow for a reason he can fix.
    const big = payload();
    big.transcripts = [
      { source_id: "s1", text: "a".repeat(5000), lang: "en", engine: "test", created_at: now }
    ];
    big.notes = [{
      id: "n1", user_id: "vish", clip_id: "c1", body: "a note of his own",
      created_at: now, updated_at: now, deleted_at: null
    }];
    const app = await loadApp(big, { quotaChars: 3000 });

    assert.match(
      app.text("homeView"),
      /short of space/i,
      "a phone reloading everything on every open says nothing about why"
    );
    app.restore();
  });

  test("and when nothing will fit, the last complete copy is left alone", async () => {
    // Written so it can actually fail. An earlier version of this test put the complete
    // copy into the store BY HAND and then read it back, which proves nothing about
    // saveCache — the same shape of vacuous test the harness's fake `batch` was.
    const first = await loadApp(payload(), { quotaChars: 100000 });
    const key = "cliptoaction-notebook-vish";
    const complete = first.localStore.get(key);
    assert.ok(complete, "the first run must have cached something");
    assert.ok(JSON.parse(complete).since > 0, "and it must be a complete copy");
    first.restore();

    // Same device, same account, and now the box will not take anything at all. The app
    // runs its whole save path against it — and must leave what is there alone. Stale and
    // whole beats current with pieces missing.
    const later = payload();
    later.clips[0].status = "keep";
    const second = await loadApp(later, { quotaChars: 1, seed: [[key, complete]] });

    assert.equal(
      second.localStore.get(key),
      complete,
      "a save that cannot fit must not damage the copy already there"
    );
    // And the app itself is working from the new data regardless.
    assert.ok(second.text("homeView").length > 100);
    second.restore();
  });
});

describe("a link somebody sent him", () => {
  test("is filled in and waits, rather than saving itself", async () => {
    // A link that arrives in the ADDRESS can be sent by anybody — an email, a message. If
    // it saved itself it would queue his PC and spend a day of an AI key on somebody
    // else's choosing, with no decision from him. The share sheet's own path, which only
    // this app can write, still saves itself.
    const app = await loadApp(payload(), {
      hash: "#/share/https%3A%2F%2Fwww.instagram.com%2Freel%2FSENTTOHIM%2F"
    });

    assert.equal(app.$("saveUrl").value, "https://www.instagram.com/reel/SENTTOHIM/");
    assert.ok(
      !app.calls.some((url) => url.includes("/v1/clips")),
      "a link he did not choose must not save itself"
    );
    assert.match(app.text("saveMsg"), /Press Save/);
    app.restore();
  });

  test("and it lands on Home, not on a dead route", async () => {
    const app = await loadApp(payload(), {
      hash: "#/share/https%3A%2F%2Fwww.instagram.com%2Freel%2FSENTTOHIM%2F"
    });
    assert.equal(app.$("homeView").hidden, false);
    assert.equal(globalThis.location.hash, "", "the address must be cleared, or a reload offers it twice");
    app.restore();
  });

  // His OWN share sheet also comes through the address when storage will not take the
  // link — and it must not then accuse him of being sent it, or cost him a second press
  // on the one path that has to be effortless (D17). What tells them apart is the page it
  // came from, which only this app can be.
  test("but his own share sheet still saves itself, even with the box full", async () => {
    const app = await loadApp(payload(), {
      hash: "#/share/https%3A%2F%2Fwww.instagram.com%2Freel%2FHISOWN%2F",
      referrer: "https://app.test/share-target.html?url=x",
      // The condition that puts the link in the address in the first place.
      quotaChars: 1
    });

    assert.ok(
      app.calls.some((url) => url.includes("/v1/clips")),
      "a reel he shared himself must not need a second press"
    );
    assert.ok(!app.text("saveMsg").includes("Somebody shared"));
    app.restore();
  });

  test("and a page pretending to be it does not count", async () => {
    const app = await loadApp(payload(), {
      hash: "#/share/https%3A%2F%2Fwww.instagram.com%2Freel%2FPRETEND%2F",
      referrer: "https://example.invalid/share-target.html"
    });
    assert.ok(!app.calls.some((url) => url.includes("/v1/clips")));
    assert.match(app.text("saveMsg"), /Press Save/);
    app.restore();
  });
});

describe("somebody linking straight to the share target", () => {
  // That address is public and guessable. Tapping such a link used to save the reel with
  // no press at all: his PC downloads and transcribes it, a day of an AI key goes on it,
  // and content of the sender's choosing lands in the notebook his AI reads.
  test("is asked about, not saved", async () => {
    const app = await loadApp(payload(), {
      hash: "#/share-ask/https%3A%2F%2Fwww.instagram.com%2Freel%2FLINKED%2F",
      // Even with the referrer of the real share target — the route is what decides,
      // because a link to that page produces that referrer too.
      referrer: "https://app.test/share-target.html?url=x"
    });

    assert.equal(app.$("saveUrl").value, "https://www.instagram.com/reel/LINKED/");
    assert.ok(
      !app.calls.some((url) => url.includes("/v1/clips")),
      "a link he did not share must not save itself"
    );
    assert.match(app.text("saveMsg"), /Press Save/);
    app.restore();
  });

  test("and the share target itself decides which route to use", () => {
    // The two halves have to agree, and they live in different files.
    const page = readFileSync(join(repo, "share-target.html"), "utf8");
    assert.ok(page.includes('"#/share-ask/"'), "the share target cannot ask");
    assert.ok(page.includes('"#/share/"'), "the share target cannot save");
    assert.ok(
      page.indexOf("external =") < page.indexOf("#/share-ask/"),
      "it must work out where it was opened from BEFORE choosing"
    );
    // A cross-origin referrer means somebody linked here rather than sharing through it.
    assert.ok(page.includes("!== window.location.origin"));
  });
});

describe("somebody with no AI account", () => {
  // The copy-and-paste tier is a tier this product supports on purpose (D9). Both of these
  // offers spend an AI account, and both used to be shown to somebody who has none — so
  // pressing got them "Connect an AI account in Settings first." A button whose only
  // outcome is a refusal says a feature exists and then blames you for it.
  const noKey = () => {
    const p = payload({ relook: { every_days: 14, last_at: null, due: 5, ready: true } });
    p.settings = { ai_provider: "manual", has_key: false };
    p.analyses[0].shapes_version = null;
    return p;
  };

  test("is told what a look back needs, not given a button that refuses", async () => {
    const app = await loadApp(noKey());
    const home = app.text("homeView");
    assert.ok(home.includes("needs an AI account"));
    assert.ok(home.includes("Connect one in Settings"));
    assert.ok(home.includes("copy and paste, which needs no account"));
    assert.ok(!home.includes("Look back over them"), "no button that can only refuse");
    app.restore();
  });

  test("and the same for filling in the tables", async () => {
    const app = await loadApp(noKey());
    const home = app.text("homeView");
    assert.ok(home.includes("Filling them in needs an AI account"));
    assert.ok(!home.includes("Read those"), "no button that can only refuse");
    app.restore();
  });

  test("while somebody who has one is still offered both", async () => {
    const withKey = noKey();
    withKey.settings = { ai_provider: "gemini", has_key: true };
    const app = await loadApp(withKey);
    const home = app.text("homeView");
    assert.ok(home.includes("Look back over them"));
    assert.ok(home.includes("Read those") || home.includes("Read that one again"));
    app.restore();
  });
});

describe("a parked video never claims he parked it", () => {
  test("because on a shared pipeline somebody else may have", async () => {
    const parked = payload();
    parked.sources[0].state = "parked";
    parked.sources[0].duration_sec = 69 * 60;

    const app = await loadApp(parked, { hash: "#/clip/c1" });
    const page = app.text("clipView");
    assert.ok(page.includes("This one is parked"));
    assert.ok(!page.includes("You parked"), "it must not assert a decision he may not have made");
    assert.ok(page.includes("Go ahead now"));
    app.restore();
  });
});
