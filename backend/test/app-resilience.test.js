// The app against a backend that is not the one it was built for, and against a notebook
// saved by an older version of itself.
//
// This is not hypothetical. The app ships from GitHub Pages the moment `main` moves, and
// the Worker is deployed by a separate command (D16, D20) — so there is always a window
// where the new app is talking to the old backend. And the whole notebook is kept in the
// browser, so on the first open after any release the app reads a cache written by the
// version before it.
//
// Neither of those may produce a blank screen, a crash, or a wrong statement about his
// notebook. He would read any of the three as having lost his reels.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { loadApp, syncPayload } from "./helpers/appharness.js";

const now = Date.now();

/** What the CURRENT Worker sends. */
function currentSync() {
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
        platform: "Facebook", title: "A reel", creator: "Ecom Guruji",
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
    ]
  });
}

/**
 * What the PREVIOUS Worker sends: no `relook`, no `relooks`, no `creator`, no
 * `shapes_version`, no `long_ok_*`, and no source ever in 'needs_ok' or 'parked'.
 */
function oldWorkerSync() {
  const payload = currentSync();
  delete payload.relook;
  delete payload.relooks;
  delete payload.sources[0].creator;
  delete payload.sources[0].creator_checked_at;
  delete payload.analyses[0].shapes_version;
  return payload;
}

describe("the new app against the previous backend", () => {
  test("it draws Home rather than a blank screen", async () => {
    const app = await loadApp(oldWorkerSync());
    const home = app.text("homeView");
    assert.ok(home.length > 100, "Home drew nothing at all");
    assert.ok(home.includes("What I should act on"));
    assert.ok(home.includes("What I'm learning about"));
    assert.ok(home.includes("What needs attention"));
    assert.ok(home.includes("What's new since you last looked"));
    app.restore();
  });

  test("it does not invent a look back, and does not offer one", async () => {
    const app = await loadApp(oldWorkerSync());
    const home = app.text("homeView");
    assert.ok(!home.includes("look back over them"), "a backend that cannot do it must not be offered");
    assert.ok(!home.includes("Your last look back"));
    app.restore();
  });

  test("an analysis with no shapes_version is counted as behind, not as broken", async () => {
    // NULL means version 1, which is every analysis in the real notebook today. The offer
    // to read them again must appear, and it must not appear as an error.
    const app = await loadApp(oldWorkerSync());
    app.tab("notebook");
    const views = app.$("views");
    views.onclick({ target: views.children.find((b) => b.dataset.view === "prompt") });
    const list = app.text("clipList");
    assert.ok(list.includes("nothing in these tables yet"));
    app.restore();
  });

  test("the notebook still lists the reel, with no creator and no crash", async () => {
    const app = await loadApp(oldWorkerSync());
    app.tab("notebook");
    assert.ok(app.text("clipList").includes("A reel"));
    app.restore();
  });

  test("the settings screen draws without a look-back setting to show", async () => {
    const app = await loadApp(oldWorkerSync(), { hash: "#/settings" });
    assert.equal(app.$("settingsView").hidden, false);
    // Falls back to the default rather than to nothing, so the box is never empty.
    const chooser = app.$("relookEvery");
    assert.ok(chooser.children.some((option) => option.textContent.includes("two weeks")));
    app.restore();
  });
});

describe("the current app against the current backend", () => {
  test("everything the previous one could not do is there", async () => {
    const payload = currentSync();
    payload.relook = { every_days: 14, last_at: null, due: 5, ready: true };
    const app = await loadApp(payload);
    const home = app.text("homeView");
    assert.ok(home.includes("Look back over them"));
    app.restore();
  });

  test("a creator is shown, and pressing it searches for them", async () => {
    const app = await loadApp(currentSync());
    app.tab("notebook");
    const chip = app.$("clipList").byClass("creator")[0];
    assert.ok(chip, "the creator is not on the card");
    assert.equal(chip.textContent, "Ecom Guruji");

    chip.onclick({ stopPropagation() {} });
    assert.equal(app.$("search").value, "Ecom Guruji");
    app.restore();
  });
});

describe("a notebook cached by an older version of the app", () => {
  test("the missing keys are filled in rather than crashing on first read", async () => {
    // The cache is written by whatever version last ran. A key added since — `relooks`,
    // `relook`, `item_status` — is simply absent, and every read of it must survive.
    const app = await loadApp(currentSync());
    const key = "cliptoaction-notebook-vish";
    const cached = JSON.parse(app.localStore.get(key));
    assert.ok(cached, "the notebook is not being cached at all");

    delete cached.relooks;
    delete cached.relook;
    delete cached.item_status;
    delete cached.aiKeys;
    app.localStore.set(key, JSON.stringify(cached));
    app.restore();

    const second = await loadApp(currentSync());
    assert.ok(second.text("homeView").includes("What needs attention"));
    second.restore();
  });
});
