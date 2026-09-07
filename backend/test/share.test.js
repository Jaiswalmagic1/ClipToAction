// The only way a reel gets in (D17), tested for the first time.
//
// Nineteen review rounds went past this path without a single test on it. Round nineteen
// sat where he sits — on a phone, on a patchy connection — and found that a reel shared
// with no signal was thrown away without a word: the queue was emptied on the way past,
// before the save was even attempted, and the save sits behind a sync that can fail. The
// reel then existed only as text in an input box, which dies with the tab the moment the
// phone reclaims it. Nothing on screen ever mentioned it again.
//
// Three reels shared one after another left one, for the same reason in a different shape:
// one fixed storage slot, overwritten each time.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { loadApp, syncPayload } from "./helpers/appharness.js";

const QUEUE = "cliptoaction-pending-shares";

/** What the share target writes when he shares a reel. */
const shared = (url, at) => ({ title: "", text: "", url, at });

/** Types into a box, the way a finger does. */
const $set = (app, id, value) => { app.$(id).value = value; };

describe("a reel shared from the share sheet", () => {
  test("is saved, and only then dropped from the queue", async () => {
    const app = await loadApp(syncPayload({}), {
      seed: [[QUEUE, JSON.stringify([shared("https://www.instagram.com/reel/AAA/", 1)])]]
    });
    await new Promise((done) => setTimeout(done, 0));

    assert.ok(
      app.calls.some((one) => one.includes("/v1/clips")),
      `the share never reached the API: ${app.calls.join(", ")}`
    );
    assert.equal(
      app.localStore.get(QUEUE),
      undefined,
      "a saved reel is still queued and will be saved again next time"
    );
    app.restore();
  });

  test("survives a save that failed because there was no signal", async () => {
    // THE ONE THAT WAS LOSING REELS. The queue was emptied before the save was attempted,
    // so an offline share was gone for good.
    const queued = JSON.stringify([shared("https://www.instagram.com/reel/TUBE/", 2)]);
    const app = await loadApp(syncPayload({}), { failAfter: 0, seed: [[QUEUE, queued]] });
    await new Promise((done) => setTimeout(done, 0));

    const left = app.localStore.get(QUEUE);
    assert.ok(left, "the reel he shared on the Underground was thrown away");
    assert.match(left, /TUBE/, left);
    app.restore();
  });

  test("and he is told it is still waiting, rather than nothing at all", async () => {
    const queued = JSON.stringify([shared("https://www.instagram.com/reel/TUBE/", 2)]);
    const app = await loadApp(syncPayload({}), { failAfter: 0, seed: [[QUEUE, queued]] });
    await new Promise((done) => setTimeout(done, 0));
    const said = `${app.text("saveMsg")} ${app.text("syncMsg")}`.trim();
    assert.ok(said, "a share that could not be saved said nothing at all");
    app.restore();
  });

  test("and it goes in on the next open, once there is a connection", async () => {
    const queued = JSON.stringify([shared("https://www.instagram.com/reel/TUBE/", 2)]);
    const offline = await loadApp(syncPayload({}), { failAfter: 0, seed: [[QUEUE, queued]] });
    await new Promise((done) => setTimeout(done, 0));
    const carried = [...offline.localStore.entries()];
    offline.restore();

    const online = await loadApp(syncPayload({}), { seed: carried });
    await new Promise((done) => setTimeout(done, 0));
    assert.ok(
      online.calls.some((one) => one.includes("/v1/clips")),
      "the reel that was waiting was never offered again"
    );
    assert.equal(online.localStore.get(QUEUE), undefined);
    online.restore();
  });

  test("three shared one after another all get in, not just the last", async () => {
    // One fixed storage slot meant the second share overwrote the first, and the second's
    // navigation destroyed the first's page before it had finished saving.
    const three = JSON.stringify([
      shared("https://www.instagram.com/reel/ONE/", 1),
      shared("https://www.instagram.com/reel/TWO/", 2),
      shared("https://www.instagram.com/reel/THREE/", 3)
    ]);
    const app = await loadApp(syncPayload({}), { seed: [[QUEUE, three]] });
    await new Promise((done) => setTimeout(done, 0));
    await new Promise((done) => setTimeout(done, 0));

    const saved = app.bodiesTo("/v1/clips").map((one) => one.url);
    assert.equal(saved.length, 3, `${saved.length} of the three shares reached the API`);
    assert.match(saved[0], /ONE/, `saved out of order: ${saved.join(", ")}`);
    assert.match(saved[2], /THREE/, `saved out of order: ${saved.join(", ")}`);
    assert.equal(app.localStore.get(QUEUE), undefined, "shares were left behind");
    app.restore();
  });

  test("a share with no link in it says so, instead of nothing", async () => {
    // A photo, or plain text. It reached the end of the startup path and drew no message
    // at all — Golden Rule 29's exact failure, on the one path a reel gets in by.
    const app = await loadApp(syncPayload({}), {
      seed: [[QUEUE, JSON.stringify([{ title: "A photo", text: "look at this", url: "", at: 1 }])]]
    });
    await new Promise((done) => setTimeout(done, 0));
    assert.match(
      app.text("saveMsg"),
      /no video link/i,
      `nothing was said about a share that could not be saved: "${app.text("saveMsg")}"`
    );
    assert.equal(app.localStore.get(QUEUE), undefined, "an unsaveable share stayed queued");
    app.restore();
  });

  test("one shared just before the release lands is not lost by the upgrade", async () => {
    // The app that is live today writes ONE share to `cliptoaction-pending-share`. This one
    // reads a queue under a different name. Without carrying it across, a reel shared in
    // the minutes before the merge sits in his storage and is read by nothing, ever again —
    // a lost reel caused entirely by the upgrade, which is the one thing D36 forbids.
    const app = await loadApp(syncPayload({}), {
      seed: [[
        "cliptoaction-pending-share",
        JSON.stringify({ title: "", text: "", url: "https://www.instagram.com/reel/OLD/" })
      ]]
    });
    await new Promise((done) => setTimeout(done, 0));

    assert.ok(
      app.calls.some((one) => one.includes("/v1/clips")),
      "a reel shared before the release was never saved"
    );
    assert.equal(
      app.localStore.get("cliptoaction-pending-share"),
      undefined,
      "the old slot was left behind and will be carried over again every open"
    );
    app.restore();
  });

  test("and it goes in FIRST, ahead of anything shared since", async () => {
    const app = await loadApp(syncPayload({}), {
      seed: [
        ["cliptoaction-pending-share",
          JSON.stringify({ title: "", text: "", url: "https://www.instagram.com/reel/OLD/" })],
        [QUEUE, JSON.stringify([shared("https://www.instagram.com/reel/NEW/", 9)])]
      ]
    });
    await new Promise((done) => setTimeout(done, 0));
    await new Promise((done) => setTimeout(done, 0));

    const saved = app.bodiesTo("/v1/clips").map((one) => one.url);
    assert.ok(saved.length >= 2, `only ${saved.length} were saved: ${saved.join(", ")}`);
    assert.match(saved[0], /OLD/, `saved out of order: ${saved.join(", ")}`);
    app.restore();
  });

  test("a null in the queue does not block everything behind it", async () => {
    // `${share.url}` on a null reads as the word "undefined", which matches no link — so
    // the entry can never be saved and can never be dropped, and it sits at the head of the
    // queue for ever with every real reel stuck behind it.
    const app = await loadApp(syncPayload({}), {
      seed: [[QUEUE, JSON.stringify([null, shared("https://www.instagram.com/reel/REAL/", 3)])]]
    });
    await new Promise((done) => setTimeout(done, 0));
    assert.ok(
      app.calls.some((one) => one.includes("/v1/clips")),
      "a real reel was stuck behind a broken entry"
    );
    app.restore();
  });

  test("a photo at the head of the queue does not stop the reel behind it", async () => {
    // He shares a photo, then a reel, then opens the app. The photo was dropped, the words
    // "there was nothing to save" were drawn, and the drain was never called — so the reel
    // sat untouched for the rest of the session and the sentence on screen was untrue at
    // the moment it was shown, on the one path a reel gets in by.
    const app = await loadApp(syncPayload({}), {
      seed: [[QUEUE, JSON.stringify([
        { title: "A photo", text: "look at this", url: "", at: 1 },
        shared("https://www.instagram.com/reel/BEHIND/", 2)
      ])]]
    });
    await new Promise((done) => setTimeout(done, 0));
    await new Promise((done) => setTimeout(done, 0));

    const saved = app.bodiesTo("/v1/clips").map((one) => one.url);
    assert.equal(saved.length, 1, `${saved.length} reels were saved: ${saved.join(", ")}`);
    assert.match(saved[0], /BEHIND/);
    assert.equal(app.localStore.get(QUEUE), undefined, "the reel was left queued");
    assert.doesNotMatch(
      app.text("saveMsg"),
      /nothing to save/i,
      `he was told nothing was saved while a reel was going in: "${app.text("saveMsg")}"`
    );
    app.restore();
  });

  test("a reel the API took is not called unsaved because the refresh failed", async () => {
    // `saveLink` said "Saved.", then refreshed, and both were in one `try` — so a failed
    // refresh came back as a failed save. On the share path that means he is told "Saved."
    // and then, in the same breath, "could not save that yet — it is still here", about a
    // reel that is safely in his notebook — and the share stays queued to be sent again on
    // every future open.
    // The harness calls this for EVERY request, not only for a sync. In order: the sync
    // that loads his notebook at sign-in, the POST that saves the reel, and then the sync
    // inside `saveLink` — which is the one that fails.
    let requests = 0;
    const app = await loadApp(
      () => {
        requests += 1;
        if (requests > 2) throw new TypeError("Failed to fetch");
        return syncPayload({});
      },
      { seed: [[QUEUE, JSON.stringify([shared("https://www.instagram.com/reel/TOOK/", 4)])]] }
    );
    for (let n = 0; n < 6; n += 1) await new Promise((done) => setTimeout(done, 0));

    const saved = app.bodiesTo("/v1/clips").map((one) => one.url);
    assert.equal(saved.length, 1, `the reel was posted ${saved.length} times`);
    assert.equal(
      app.localStore.get(QUEUE),
      undefined,
      "a reel the API took is still queued, and will be sent again on every open"
    );
    assert.doesNotMatch(
      app.text("saveMsg"),
      /Could not save/i,
      `a reel the API took was called unsaved: "${app.text("saveMsg")}"`
    );
    app.restore();
  });

  test("a queue that is not a list does not take the app down with it", async () => {
    const app = await loadApp(syncPayload({}), { seed: [[QUEUE, "{ not json"]] });
    await new Promise((done) => setTimeout(done, 0));
    assert.ok(app.text("homeView").length > 0, "the app did not draw");
    app.restore();
  });
});

describe("a patchy connection, on the screens where it costs something", () => {
  test("a connector whose address did not arrive is not shown as `undefined`", async () => {
    // `api` swallows a body it cannot read and hands back `{}` with the response still
    // counted as fine — a truncated reply on a dying mobile connection, or a hotel portal
    // answering 200 with its own HTML. The connector row exists server-side by then and
    // only its hash is kept (D29), so the address is gone for good. He was shown the
    // literal word `undefined`, under a sentence saying this was the only time it would
    // ever be shown, and would have pasted that into his AI app.
    const app = await loadApp(syncPayload({}));
    await new Promise((done) => setTimeout(done, 0));
    app.answerWith((url, options) => {
      if (String(url).includes("/v1/connector") && options?.method === "POST") {
        return { ok: true, status: 200, json: async () => ({}) };
      }
      return null;
    });

    await app.$("makeConnector").onclick();
    const said = app.text("connectorMsg");
    assert.ok(
      !said.includes("only time it will be shown"),
      `he was told to keep an address that never arrived: ${said}`
    );
    assert.match(said, /did not arrive/i, said);
    app.restore();
  });

  test("coming back to the app fetches the delta once, not twice", async () => {
    // Returning to a backgrounded phone fires `visibilitychange` AND `focus`, and both call
    // the quiet refresh. Nothing was ever wrong — the merge is by key — but every single
    // resume, the most frequent event in a phone's life, cost double the row reads.
    const app = await loadApp(syncPayload({}));
    await new Promise((done) => setTimeout(done, 0));
    const before = app.calls.filter((one) => one.includes("/v1/sync")).length;

    app.fire("visibilitychange");
    app.fire("focus");
    await new Promise((done) => setTimeout(done, 0));

    const after = app.calls.filter((one) => one.includes("/v1/sync")).length;
    assert.equal(
      after - before,
      1,
      `one resume cost ${after - before} syncs`
    );
    app.restore();
  });
});
