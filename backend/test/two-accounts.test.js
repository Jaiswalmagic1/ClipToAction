// Two people, one page, one second — round eight.
//
// Seven rounds asked whether the code was correct, and one asked what happens when the AI
// slips. This one asked what happens when two things are true at once: two accounts on one
// phone, two people saving the same reel in the same second. Both put somebody's data
// somewhere it does not belong.
//
// Nothing here is hypothetical. Each was reproduced before it was fixed.

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";

import worker from "../src/worker.js";
import { createTestEnv } from "./helpers/testenv.js";
import { loadApp, syncPayload } from "./helpers/appharness.js";

// ---------------------------------------------------------------- the account that changed

describe("a sync that answers after the account has changed", () => {
  // Signing straight from one Google account into another fires the app's auth handler
  // with the new user and NO null in between, and returning focus to the page — which
  // happens the moment the account picker closes — starts a background refresh. So the
  // first account's reply could land in the second account's notebook: on screen, and in
  // the second account's box on disk, where it stayed until they signed out.

  const clipOf = (uid) => ({
    id: `clip-${uid}`,
    user_id: uid,
    source_id: `src-${uid}`,
    status: "inbox",
    created_at: 1,
    updated_at: 1
  });
  const sourceOf = (uid, title) => ({
    id: `src-${uid}`,
    url_canonical: `https://www.instagram.com/reel/${uid}/`,
    url_original: `https://www.instagram.com/reel/${uid}/`,
    platform: "instagram",
    state: "analysed",
    title,
    created_at: 1,
    updated_at: 1
  });

  const notebookFor = (uid) =>
    syncPayload({
      clips: [clipOf(uid)],
      sources: [sourceOf(uid, uid === "alice" ? "ALICE PRIVATE REEL" : "bob's own reel")],
      // Different providers, because that is what the key list actually draws — the
      // key itself is never sent to a device, which is the point of D11.
      ai_keys: [
        {
          id: `key-${uid}`,
          label: uid,
          provider: uid === "alice" ? "groq" : "gemini",
          position: 0,
          created_at: 1,
          updated_at: 1
        }
      ]
    });

  test("it is refused, and lands nowhere", async () => {
    const app = await loadApp(notebookFor, { who: "alice" });
    app.tab("notebook");
    assert.ok(app.text("clipList").includes("ALICE PRIVATE REEL"), "alice never loaded");

    // Alice's refresh goes out and hangs on a slow network.
    const release = app.hold();
    app.fire("focus");
    await new Promise((done) => setTimeout(done, 0));

    // Bob signs in on the same page while it is still in the air.
    await app.signInAs("bob");

    // And now Alice's reply arrives.
    release();
    await new Promise((done) => setTimeout(done, 0));

    app.tab("notebook");
    const boxes = [...app.localStore.entries()];
    const holdingAlice = boxes.filter(([, value]) => String(value).includes("ALICE PRIVATE"));
    assert.deepEqual(
      holdingAlice.map(([key]) => key),
      ["cliptoaction-notebook-alice"],
      "alice's notebook was written into somebody else's box on disk"
    );
    assert.ok(
      !app.text("clipList").includes("ALICE PRIVATE"),
      "alice's reel was drawn on bob's screen"
    );
    assert.ok(app.text("clipList").includes("bob's own reel"), "bob lost his own notebook");
    app.restore();
  });

  test("it is still refused when the delay is in READING the reply", async () => {
    // The first version of this guard sat one `await` too early: before
    // `await response.json()`. Reading the body is itself a wait, and on a phone pulling
    // two hundred reels down it is the SLOW half of the request — so the guard passed and
    // the reply was handed back anyway, and every word of the leak came back with it.
    const app = await loadApp(notebookFor, { who: "alice", holdInBody: true });
    app.tab("notebook");
    const release = app.hold();
    app.fire("focus");
    await new Promise((done) => setTimeout(done, 0));

    await app.signInAs("bob");
    release();
    await new Promise((done) => setTimeout(done, 0));

    app.tab("notebook");
    const holdingAlice = [...app.localStore.entries()]
      .filter(([, value]) => String(value).includes("ALICE PRIVATE"))
      .map(([key]) => key);
    assert.deepEqual(holdingAlice, ["cliptoaction-notebook-alice"]);
    assert.ok(!app.text("clipList").includes("ALICE PRIVATE"));
    app.restore();
  });

  test("nothing about it is shown to the next person as a failure", async () => {
    // The reply was Alice's and her save DID work. Telling Bob "the account changed while
    // that was loading" in red, under a box still holding her link, is a failure message
    // for something that did not fail, addressed to the wrong person.
    const app = await loadApp(notebookFor, { who: "alice" });
    app.$("saveUrl").value = "https://www.instagram.com/reel/ALICEPRIVATE/";
    // Only the save itself. Bob has to be able to load his own notebook meanwhile.
    const release = app.hold(1);
    app.$("saveForm").onsubmit({ preventDefault() {} });
    await new Promise((done) => setTimeout(done, 0));

    await app.signInAs("bob");
    release();
    await new Promise((done) => setTimeout(done, 0));

    assert.equal(app.$("saveUrl").value, "", "her link was left in his capture box");
    assert.equal(app.text("saveMsg").trim(), "", `he was shown: ${app.text("saveMsg")}`);
    assert.equal(app.$("saveBtn").disabled, false, "the save button was left dead");
    app.restore();
  });

  test("the guard on the reply stands ON ITS OWN, not behind the one at the door", async () => {
    // Two guards were added and each hid the other: with either one reverted the suite
    // stayed green, so a later edit could put the leak back and CI would say nothing.
    // Sync has both. This route has only the one in `api` — `refreshKeys` writes the
    // reply straight into the store — so it pins that guard by itself.
    const app = await loadApp(notebookFor, {
      who: "alice",
      holdInBody: true,
      hash: "#/settings"
    });
    assert.ok(app.text("keyList").includes("groq"), "alice's list never drew");
    app.$("newKeyValue").value = "a-key-alice-is-adding";
    // Pressing Add sends the key and then re-reads the whole list. Let the send through
    // and hold the RE-READ, which is the reply that writes a list straight into the store.
    const release = app.hold(1, 1);
    app.$("addKey").onclick();
    await new Promise((done) => setTimeout(done, 0));

    await app.signInAs("bob");
    release();
    await new Promise((done) => setTimeout(done, 0));

    const drawn = app.text("keyList");
    assert.ok(
      !drawn.includes("groq"),
      "one account's list of AI keys was drawn under another account's name"
    );
    assert.ok(drawn.includes("gemini"), "bob lost his own list");
    app.restore();
  });

  test("and what was on screen is the new account's, not a mix", async () => {
    const app = await loadApp(notebookFor, { who: "alice" });
    await app.signInAs("bob");
    app.tab("notebook");
    const drawn = app.text("clipList");
    assert.ok(drawn.includes("bob's own reel"));
    assert.ok(!drawn.includes("ALICE PRIVATE"));
    app.restore();
  });

  test("a search still in the box does not follow him into the other account", async () => {
    const app = await loadApp(notebookFor, { who: "alice" });
    app.tab("notebook");
    app.$("search").value = "alice";
    app.$("search").oninput();
    await new Promise((done) => setTimeout(done, 200));

    await app.signInAs("bob");
    app.tab("notebook");
    assert.equal(app.$("search").value, "", "the box still held the other account's search");
    assert.ok(
      app.text("clipList").includes("bob's own reel"),
      "bob's notebook was filtered by somebody else's search"
    );
    app.restore();
  });
});

// ---------------------------------------------------------------- the field with no guard

describe("suggested_task, the one field nothing checked", () => {
  let harness;
  let amy;
  let clipId;
  let sourceId;

  before(async () => {
    harness = await createTestEnv();
    amy = await harness.mintToken("amy");
    const saved = await harness.call(worker, "/v1/clips", {
      method: "POST",
      token: amy,
      body: { url: "https://www.instagram.com/reel/TASKFIELD/" }
    });
    clipId = saved.body.clip.id;
    sourceId = saved.body.clip.source_id;
    harness.database.prepare("UPDATE sources SET state = 'downloading' WHERE id = ?").run(sourceId);
    await harness.call(worker, `/v1/sources/${sourceId}/transcript`, {
      method: "POST",
      serviceToken: "service-token-for-tests",
      body: { text: "[0:00:00] words", lang: "en", engine: "test", duration_sec: 40 }
    });
  });

  after(() => harness.restore());

  const pasteWith = (task) =>
    harness.call(worker, `/v1/clips/${clipId}/analysis`, {
      method: "POST",
      token: amy,
      body: {
        pasted: JSON.stringify({
          summary: "A good summary that must not be thrown away.",
          key_points: ["one"],
          learn_more: [],
          claims: [],
          suggested_task: task
        })
      }
    });

  test("a task of the wrong type does not destroy the whole analysis", async () => {
    // It is bound straight to the database, and D1 cannot store an object — so it threw
    // BEFORE the write. A pasted conversation came back as a bare 500 with nothing saying
    // which field was wrong, and on the Worker's own run the shared source row was marked
    // failed for every saver of that reel.
    for (const wrong of [{ do: "x" }, true, ["a"], 42]) {
      const response = await pasteWith(wrong);
      assert.equal(response.status, 200, `a task of ${JSON.stringify(wrong)} was refused`);
    }
    const row = harness.database
      .prepare("SELECT * FROM analyses WHERE source_id = ? AND user_id = 'amy'")
      .get(sourceId);
    assert.ok(row.summary.includes("must not be thrown away"), "the good nine tenths went too");
    assert.equal(row.suggested_task, null, "a task that is not text was stored anyway");
  });

  test("a real one still comes through", async () => {
    await pasteWith("  Switch on Sunday Pickup  ");
    const row = harness.database
      .prepare("SELECT suggested_task FROM analyses WHERE source_id = ? AND user_id = 'amy'")
      .get(sourceId);
    assert.equal(row.suggested_task, "Switch on Sunday Pickup");
  });

  test("and an absurd one is cut down rather than synced to every device", async () => {
    // No ceiling at all: 300,000 characters stored cleanly, went out on every sync and was
    // written into every device's box, with nothing on any screen rendering it.
    await pasteWith("x".repeat(300_000));
    const row = harness.database
      .prepare("SELECT suggested_task FROM analyses WHERE source_id = ? AND user_id = 'amy'")
      .get(sourceId);
    assert.ok(row.suggested_task.length <= 2000, `stored ${row.suggested_task.length} characters`);
  });

  test("a model name that is not a name loses nothing either", async () => {
    const response = await harness.call(worker, `/v1/clips/${clipId}/analysis`, {
      method: "POST",
      token: amy,
      body: {
        model: { name: "gemini" },
        pasted: JSON.stringify({
          summary: "Still stored.",
          key_points: [],
          learn_more: [],
          claims: []
        })
      }
    });
    assert.equal(response.status, 200);
    const row = harness.database
      .prepare("SELECT model, summary FROM analyses WHERE source_id = ? AND user_id = 'amy'")
      .get(sourceId);
    assert.equal(row.model, null);
    assert.equal(row.summary, "Still stored.");
  });
});

// ---------------------------------------------------------------- the same reel, at once

describe("two people saving the same new reel in the same second", () => {
  let harness;

  before(async () => {
    harness = await createTestEnv();
  });
  after(() => harness.restore());

  /**
   * Somebody else's save lands in the gap between the look and the insert.
   *
   * `Promise.all` on two requests is not enough to prove this: the two run to completion
   * one after the other more often than not, so the race never happens and the test passes
   * whether the fix is there or not. This puts the competing row in at the exact moment —
   * when the SELECT for that URL runs — which is the same thing happening, deterministically.
   */
  const withSomebodyElseSavingItFirst = () => {
    const real = harness.env.DB;
    let done = false;
    harness.env.DB = {
      ...real,
      prepare(sql) {
        if (!done && sql.includes("SELECT id FROM sources WHERE url_canonical")) {
          done = true;
          const statement = real.prepare(sql);
          return {
            ...statement,
            bind(...params) {
              const bound = statement.bind(...params);
              // Whatever the Worker made of his link — the canonical form is the whole
              // point of the unique column, and guessing it here would test nothing.
              const canonical = params[0];
              return {
                ...bound,
                async first() {
                  const mine = await bound.first();
                  // The other person's save completes right here.
                  harness.database
                    .prepare(
                      `INSERT INTO sources
                         (id, url_canonical, url_original, platform, state, attempts,
                          created_at, updated_at)
                       VALUES (?, ?, ?, 'instagram', 'pending', 0, 1, 1)`
                    )
                    .run("theirs", canonical, canonical);
                  return mine;
                }
              };
            }
          };
        }
        return real.prepare(sql);
      }
    };
    return () => { harness.env.DB = real; };
  };

  test("the one that lost the race is still saved, not a 500", async () => {
    const dee = await harness.mintToken("dee");
    const url = "https://www.instagram.com/reel/LOSTRACE/";
    const undo = withSomebodyElseSavingItFirst();
    try {
      const response = await harness.call(worker, "/v1/clips", {
        method: "POST",
        token: dee,
        body: { url }
      });
      assert.equal(response.status, 201, `the save was lost: ${JSON.stringify(response.body)}`);
      assert.equal(
        response.body.clip.source_id,
        "theirs",
        "it saved against a video nobody is downloading"
      );
    } finally {
      undo();
    }
    const rows = harness.database
      .prepare("SELECT COUNT(*) AS n FROM sources WHERE url_canonical LIKE ?")
      .get("%LOSTRACE%");
    assert.equal(rows.n, 1, "the same video ended up as two rows");
  });

  test("both saves work, and both point at the one shared video", async () => {
    // `url_canonical` is UNIQUE — one row per video is the whole cost model (D10). Both
    // requests missed the SELECT, the second INSERT hit the constraint, and it escaped as
    // a bare 500: the save simply lost, with no hint that pressing again would work. A
    // reel doing the rounds is exactly the one two people save at once.
    const amy = await harness.mintToken("amy");
    const ben = await harness.mintToken("ben");
    const url = "https://www.instagram.com/reel/SAMESECOND/";

    const [first, second] = await Promise.all([
      harness.call(worker, "/v1/clips", { method: "POST", token: amy, body: { url } }),
      harness.call(worker, "/v1/clips", { method: "POST", token: ben, body: { url } })
    ]);

    assert.equal(first.status, 201, `amy: ${JSON.stringify(first.body)}`);
    assert.equal(second.status, 201, `ben: ${JSON.stringify(second.body)}`);
    assert.equal(
      first.body.clip.source_id,
      second.body.clip.source_id,
      "the shared layer split in two — two downloads, two transcripts, two analyses"
    );

    const rows = harness.database
      .prepare("SELECT COUNT(*) AS n FROM sources WHERE url_canonical LIKE ?")
      .get("%SAMESECOND%");
    assert.equal(rows.n, 1);
  });

  test("a later save of a known reel still says it was already known", async () => {
    const cara = await harness.mintToken("cara");
    const again = await harness.call(worker, "/v1/clips", {
      method: "POST",
      token: cara,
      body: { url: "https://www.instagram.com/reel/SAMESECOND/" }
    });
    assert.equal(again.body.reused, true);
  });
});
