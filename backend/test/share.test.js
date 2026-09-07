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

    assert.match(
      app.$("saveUrl").value,
      /OLD/,
      "a reel shared before the release was not offered at all"
    );
    assert.equal(
      app.localStore.get("cliptoaction-pending-share"),
      undefined,
      "the old slot was left behind and will be carried over again every open"
    );
    app.restore();
  });

  test("but it is ASKED about, never saved by itself", async () => {
    // THE SECURITY HALF, and it is not a detail. The share target that is live today has no
    // referrer check at all — it writes that slot for anything, including
    // `.../share-target.html?url=<anything>` sent to him in a message. The whole ask route
    // exists to stop a stranger's link saving itself; carrying the old slot over as trusted
    // would launder exactly that. His PC would download and transcribe a stranger's video,
    // a day of an AI key would go on it, and its content would land in the notebook his AI
    // reads.
    const app = await loadApp(syncPayload({}), {
      seed: [[
        "cliptoaction-pending-share",
        JSON.stringify({ title: "", text: "", url: "https://evil.example/reel/SENT/" })
      ]]
    });
    for (let n = 0; n < 4; n += 1) await new Promise((done) => setTimeout(done, 0));

    const saved = app.bodiesTo("/v1/clips").map((one) => one.url);
    assert.equal(
      saved.length,
      0,
      `a link of unknown origin saved itself with no press: ${saved.join(", ")}`
    );
    assert.match(app.text("saveMsg"), /Press Save/i, app.text("saveMsg"));
    // AND IT IS STILL THERE. Dropping it "now that it is in the box in front of him" threw
    // the reel away: the box is not storage — the next save empties it and the tab dies
    // with it — so the queue was the only durable copy. Security needs "do not save it
    // without a press", not "delete it".
    const left = app.localStore.get(QUEUE) || "";
    assert.match(left, /SENT/, `the link was deleted rather than left waiting: ${left}`);
    assert.match(app.$("saveUrl").value, /SENT/, "and it is not in the box either");
    app.restore();
  });

  test("and a carried-over reel is not wiped by the next save succeeding", async () => {
    // The worst shape of it. The carried reel was dropped from storage, then the drain ran,
    // then `saveLink` emptied the box on success — so the screen said "Saved." while the
    // carried reel was gone from storage, gone from the box, and never posted.
    const app = await loadApp(syncPayload({}), {
      seed: [
        ["cliptoaction-pending-share",
          JSON.stringify({ title: "", text: "", url: "https://www.instagram.com/reel/OLD/" })],
        [QUEUE, JSON.stringify([shared("https://www.instagram.com/reel/HIS/", 9)])]
      ]
    });
    for (let n = 0; n < 10; n += 1) await new Promise((done) => setTimeout(done, 0));

    const saved = app.bodiesTo("/v1/clips").map((one) => one.url);
    assert.ok(saved.some((one) => one.includes("HIS")), `his own reel: ${saved.join(", ")}`);
    // The carried one is in exactly one of the two places it can be, and preferably both.
    const left = app.localStore.get(QUEUE) || "";
    assert.ok(
      left.includes("OLD") || app.$("saveUrl").value.includes("OLD"),
      `the carried reel is nowhere — queue ${left}, box "${app.$("saveUrl").value}"`
    );
    assert.match(left, /OLD/, `it is not in the only place that survives the tab: ${left}`);
    app.restore();
  });

  test("and pressing Save on it clears it, so it does not come back", async () => {
    const app = await loadApp(syncPayload({}), {
      seed: [["cliptoaction-pending-share",
        JSON.stringify({ title: "", text: "", url: "https://www.instagram.com/reel/PRESSED/" })]]
    });
    for (let n = 0; n < 6; n += 1) await new Promise((done) => setTimeout(done, 0));
    assert.match(app.$("saveUrl").value, /PRESSED/);

    app.$("saveForm").onsubmit({ preventDefault() {} });
    for (let n = 0; n < 8; n += 1) await new Promise((done) => setTimeout(done, 0));

    const saved = app.bodiesTo("/v1/clips").map((one) => one.url);
    assert.ok(saved.some((one) => one.includes("PRESSED")), `not saved: ${saved.join(", ")}`);
    assert.equal(
      app.localStore.get(QUEUE),
      undefined,
      "it will be offered again on every open after he already said yes"
    );
    app.restore();
  });

  test("and the drain does not save it one line later either", async () => {
    // The branch above refuses to save it; the drain that runs afterwards would have gone
    // straight through the queue and saved it anyway.
    const app = await loadApp(syncPayload({}), {
      seed: [
        ["cliptoaction-pending-share",
          JSON.stringify({ title: "", text: "", url: "https://evil.example/reel/SENT/" })],
        [QUEUE, JSON.stringify([shared("https://www.instagram.com/reel/HIS/", 9)])]
      ]
    });
    for (let n = 0; n < 6; n += 1) await new Promise((done) => setTimeout(done, 0));

    const saved = app.bodiesTo("/v1/clips").map((one) => one.url);
    assert.ok(
      !saved.some((one) => one.includes("SENT")),
      `the drain saved the unknown link: ${saved.join(", ")}`
    );
    // And his own share, which was behind it, still goes in.
    assert.ok(saved.some((one) => one.includes("HIS")), `his own reel was not saved: ${saved.join(", ")}`);
    // The unknown one is still waiting, not deleted.
    assert.match(app.localStore.get(QUEUE) || "", /SENT/, "the unknown link was thrown away");
    app.restore();
  });

  test("an old slot holding a LIST does not become a share with no address", async () => {
    // A JSON array is `typeof "object"` too. Spread into an object it becomes `{"0": …}`,
    // loses its url, and is dropped under "there was nothing to save".
    const app = await loadApp(syncPayload({}), {
      seed: [["cliptoaction-pending-share", JSON.stringify([{ url: "https://x.test/a" }])]]
    });
    for (let n = 0; n < 8; n += 1) await new Promise((done) => setTimeout(done, 0));

    // Carried over, it becomes `{"0": …}` with no url — which lands at the head of the
    // queue and is then read as "a share with no link in it", so the app announces a failed
    // share to somebody who never made one. It was never a share; nothing is said.
    assert.equal(
      app.text("saveMsg"),
      "",
      `the app announced a failed share that never happened: "${app.text("saveMsg")}"`
    );
    assert.equal(app.localStore.get(QUEUE), undefined, "rubbish reached the queue");
    assert.equal(
      app.localStore.get("cliptoaction-pending-share"),
      undefined,
      "and it will be read again on every open"
    );
    app.restore();
  });

  test("a link that arrived broken in the address still lets the queue drain", async () => {
    // The branch for an unreadable address never called the drain, so anything already
    // queued sat untouched for the whole session — the same shape as the photo finding, on
    // a different branch.
    const app = await loadApp(syncPayload({}), {
      hash: "#/share/%E0%A4",
      referrer: "https://app.test/share-target.html",
      seed: [[QUEUE, JSON.stringify([shared("https://www.instagram.com/reel/WAITING/", 6)])]]
    });
    for (let n = 0; n < 8; n += 1) await new Promise((done) => setTimeout(done, 0));

    const saved = app.bodiesTo("/v1/clips").map((one) => one.url);
    assert.ok(
      saved.some((one) => one.includes("WAITING")),
      `a queued reel was ignored for the session: ${saved.join(", ")}`
    );
    app.restore();
  });

  test("a corrupt queue does not strand the reel waiting to be carried over", async () => {
    // The queue read used to sit inside the write's `try`, so unreadable rubbish threw into
    // a catch whose whole reason is "the box is full" — and the carried reel was left in the
    // old slot for ever, with nothing on screen, healing only if he shared something else.
    const app = await loadApp(syncPayload({}), {
      seed: [
        ["cliptoaction-pending-share",
          JSON.stringify({ title: "", text: "", url: "https://www.instagram.com/reel/STUCK/" })],
        [QUEUE, "{ not json"]
      ]
    });
    for (let n = 0; n < 6; n += 1) await new Promise((done) => setTimeout(done, 0));

    assert.equal(
      app.localStore.get("cliptoaction-pending-share"),
      undefined,
      "the reel was stranded in the old slot by a corrupt queue"
    );
    assert.match(app.localStore.get(QUEUE) || "", /STUCK/, "and it did not reach the queue");
    app.restore();
  });

  test("the carry-over does not run away with itself", async () => {
    // `carryOverOldShare` read the queue through `queuedShares`, which calls
    // `carryOverOldShare` — and the old key is not removed until after the write, so every
    // nested call carried the same reel over again. The queue filled with copies of one
    // share and the real ones were buried behind them.
    const app = await loadApp(syncPayload({}), {
      seed: [
        ["cliptoaction-pending-share",
          JSON.stringify({ title: "", text: "", url: "https://evil.example/reel/ONCE/" })],
        [QUEUE, JSON.stringify([shared("https://www.instagram.com/reel/REAL/", 9)])]
      ]
    });
    for (let n = 0; n < 10; n += 1) await new Promise((done) => setTimeout(done, 0));

    const queued = JSON.parse(app.localStore.get(QUEUE) || "[]");
    const copies = queued.filter((one) => String(one.url).includes("ONCE")).length;
    assert.equal(copies, 1, `the carried share was written ${copies} times`);
    app.restore();
  });

  test("a full storage box does not delete the reel it cannot carry over", async () => {
    // The carry-over removed the old key and THEN wrote the queue. When the write threw —
    // a full box, which is the very condition a queue exists to survive — the reel was gone
    // from the only place it existed, and nothing was said. D71's own failure, inside the
    // function written to prevent it.
    const app = await loadApp(syncPayload({}), {
      quotaChars: 120,
      seed: [[
        "cliptoaction-pending-share",
        JSON.stringify({ title: "", text: "", url: "https://www.instagram.com/reel/FULL/" })
      ]]
    });
    await new Promise((done) => setTimeout(done, 0));

    const left = app.localStore.get("cliptoaction-pending-share");
    assert.ok(left, "the reel was deleted by a storage box it could not be moved into");
    assert.match(left, /FULL/, left);
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

  test("an unknown link BEHIND his own is not saved by the drain either", async () => {
    // The branch that handles the head of the queue refuses to save it. The drain, which
    // runs straight afterwards and walks the rest, would have saved it anyway — so an
    // unknown link one place further down went in with no press at all.
    const app = await loadApp(syncPayload({}), {
      seed: [[QUEUE, JSON.stringify([
        shared("https://www.instagram.com/reel/MINE/", 1),
        { title: "", text: "", url: "https://evil.example/reel/BEHIND/", at: 2, ask: true },
        shared("https://www.instagram.com/reel/ALSOMINE/", 3)
      ])]]
    });
    for (let n = 0; n < 8; n += 1) await new Promise((done) => setTimeout(done, 0));

    const saved = app.bodiesTo("/v1/clips").map((one) => one.url);
    assert.ok(
      !saved.some((one) => one.includes("BEHIND")),
      `the drain saved an unknown link: ${saved.join(", ")}`
    );
    assert.equal(saved.length, 2, `${saved.length} saved: ${saved.join(", ")}`);
    // Both of his are gone from the queue; the unknown one is still waiting for a press.
    const left = JSON.parse(app.localStore.get(QUEUE) || "[]");
    assert.equal(left.length, 1, `${left.length} left: ${JSON.stringify(left)}`);
    assert.match(left[0].url, /BEHIND/);
    app.restore();
  });

  test("a drain that fails partway keeps what it has not saved", async () => {
    // `if (!took) return;` — without it, a share that never reached the API is dropped
    // anyway, which is D70's whole failure repeated on the drain path.
    let requests = 0;
    const app = await loadApp(
      () => {
        requests += 1;
        // sign-in sync, POST one, sync, POST two -> the second POST is the one that fails.
        if (requests === 4) throw new TypeError("Failed to fetch");
        return syncPayload({});
      },
      {
        seed: [[QUEUE, JSON.stringify([
          shared("https://www.instagram.com/reel/GOESIN/", 1),
          shared("https://www.instagram.com/reel/STAYS/", 2)
        ])]]
      }
    );
    for (let n = 0; n < 8; n += 1) await new Promise((done) => setTimeout(done, 0));

    const left = app.localStore.get(QUEUE) || "";
    assert.match(left, /STAYS/, `the share that never reached the API was dropped: ${left}`);
    assert.ok(!left.includes("GOESIN"), `a saved reel is still queued: ${left}`);
    app.restore();
  });

  test("dropping one share does not drop a different one that shares its address", async () => {
    // `dropShare` matches on when it was shared, its address AND its text. Matching on the
    // address alone would drop a second, later share of the same reel that had not been
    // saved yet — and the same reel shared twice with different text is two entries.
    let requests = 0;
    const app = await loadApp(
      () => {
        requests += 1;
        // sign-in sync, POST one, sync, POST two -> the second POST is the one that fails,
        // so the second entry is still waiting and must not have been dropped with the first.
        if (requests === 4) throw new TypeError("Failed to fetch");
        return syncPayload({});
      },
      {
        seed: [[QUEUE, JSON.stringify([
          { title: "", text: "have a look", url: "https://www.instagram.com/reel/SAME/", at: 1 },
          { title: "", text: "this one too", url: "https://www.instagram.com/reel/SAME/", at: 2 }
        ])]]
      }
    );
    for (let n = 0; n < 8; n += 1) await new Promise((done) => setTimeout(done, 0));

    const left = app.localStore.get(QUEUE) || "";
    assert.match(
      left,
      /this one too/,
      `the second share of the same reel was dropped without being saved: ${left}`
    );
    app.restore();
  });

  test("an ask mark planted in the old slot cannot clear itself", async () => {
    // M3. `{ ...share, ask: true }` is only safe because `ask` is written AFTER the spread.
    // Written before it, an `ask: false` planted in the old slot — which anything that can
    // reach that origin's storage can do — would clear its own mark and save itself.
    const app = await loadApp(syncPayload({}), {
      seed: [["cliptoaction-pending-share", JSON.stringify({
        ask: false, title: "", text: "", url: "https://evil.example/reel/PLANTED/"
      })]]
    });
    for (let n = 0; n < 8; n += 1) await new Promise((done) => setTimeout(done, 0));

    const saved = app.bodiesTo("/v1/clips").map((one) => one.url);
    assert.equal(saved.length, 0, `a planted mark cleared itself: ${saved.join(", ")}`);
    assert.match(app.localStore.get(QUEUE) || "", /"ask":true/, "the mark was not applied");
    app.restore();
  });

  test("the reel carried over goes in FRONT of anything shared since", async () => {
    // M12. It was shared before everything else in the queue, and the queue is drained
    // oldest first — so appending it would show him his reels out of the order he saved
    // them, and put the one with no other copy last in line.
    // Offline, so nothing drains and the order it was written in is what is still there.
    // With a connection the later reel is saved and removed, which leaves the carried one
    // at the front whichever end it went in at — and the assertion proves nothing.
    const app = await loadApp(syncPayload({}), {
      failAfter: 0,
      seed: [
        ["cliptoaction-pending-share",
          JSON.stringify({ title: "", text: "", url: "https://www.instagram.com/reel/EARLIER/" })],
        [QUEUE, JSON.stringify([shared("https://www.instagram.com/reel/LATER/", 9)])]
      ]
    });
    for (let n = 0; n < 6; n += 1) await new Promise((done) => setTimeout(done, 0));

    const queued = JSON.parse(app.localStore.get(QUEUE) || "[]");
    assert.equal(queued.length, 2, `${queued.length} in the queue`);
    assert.match(
      String(queued[0]?.url),
      /EARLIER/,
      `out of order: ${queued.map((one) => one.url).join(", ")}`
    );
    app.restore();
  });

  test("storage that refuses says the box is the only copy", async () => {
    // M10. When the share page cannot use storage the link travels in the address, which
    // the app then wipes — so an offline save leaves the reel in an input box and nowhere
    // else. Without a sentence saying so he sees two identical "you appear to be offline"
    // messages and no reason to keep the page open.
    const app = await loadApp(syncPayload({}), {
      hash: "#/share/https%3A%2F%2Fwww.instagram.com%2Freel%2FONLYHERE%2F",
      referrer: "https://app.test/share-target.html",
      failAfter: 0
    });
    for (let n = 0; n < 8; n += 1) await new Promise((done) => setTimeout(done, 0));

    assert.match(app.$("saveUrl").value, /ONLYHERE/, "the link is not even in the box");
    assert.match(
      app.text("saveMsg"),
      /will be lost|keep this page open/i,
      `nothing said the reel is at risk: "${app.text("saveMsg")}"`
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

    // A GOOD reply first, so the test is decided by what the app does with a bad one rather
    // than by the harness's default having no address in it. Without this the whole
    // `answerWith` block could be deleted and the test still passed.
    let truncate = false;
    app.answerWith((url, options) => {
      if (!String(url).includes("/v1/connector") || options?.method !== "POST") return null;
      // The responder hands back the BODY, which the harness then wraps. Returning a
      // falsy body means "answer this the default way", so a truncated reply is `{ ok: true }`
      // with no `url` on it — which is exactly what the app sees in the real failure.
      return truncate
        ? { ok: true }
        : { ok: true, url: "https://api.test/mcp/realsecret" };
    });

    await app.$("makeConnector").onclick();
    assert.match(
      app.text("connectorMsg"),
      /only time it will be shown/,
      "a good reply did not draw the address at all — this test would prove nothing"
    );

    truncate = true;
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
