// The page that actually receives the share, run rather than read.
//
// Round twenty found that nothing executes this file. It is checked as TEXT in two places —
// a regex over the source — so the central claim of the round before it, "the share target
// writes a queue now, not one slot", could be reverted to a single overwritten key with all
// 605 tests green. Every share test seeds browser storage directly and therefore only ever
// exercises the reader.
//
// This is the one page a reel gets in through (D17) and nothing in it may throw.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

import { loadApp, syncPayload } from "./helpers/appharness.js";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const page = readFileSync(join(repo, "share-target.html"), "utf8");
const script = /<script>([\s\S]*?)<\/script>/.exec(page)[1];

const QUEUE = "cliptoaction-pending-shares";

/**
 * Runs the real page against a browser stand-in and hands back what it did.
 *
 * `store` carries over between runs on purpose — three shares in a row are three runs of
 * this page against one phone's storage, which is the case that was losing reels.
 */
function share(query, { referrer = "", store = new Map(), storageBroken = false } = {}) {
  let went = null;
  const localStorage = {
    getItem: (key) => {
      if (storageBroken) throw new Error("site data is blocked");
      return store.has(key) ? store.get(key) : null;
    },
    setItem: (key, value) => {
      if (storageBroken) throw new Error("site data is blocked");
      store.set(key, String(value));
    },
    removeItem: (key) => { store.delete(key); }
  };
  const context = {
    localStorage,
    document: { referrer },
    URLSearchParams,
    URL,
    Date,
    JSON,
    window: {
      location: {
        search: query,
        origin: "https://app.test",
        href: "https://app.test/share-target.html",
        replace: (where) => { went = where; }
      }
    }
  };
  context.window.self = context.window;
  vm.createContext(context);
  vm.runInContext(script, context);
  return { store, went, queued: JSON.parse(store.get(QUEUE) || "[]") };
}

describe("the page the share sheet opens", () => {
  test("puts one shared reel in the queue and opens the app", () => {
    const done = share("?url=https%3A%2F%2Fwww.instagram.com%2Freel%2FAAA%2F");
    assert.equal(done.queued.length, 1);
    assert.match(done.queued[0].url, /AAA/);
    assert.equal(done.went, "index.html");
  });

  test("three shared one after another are all still there", () => {
    // THE ONE THAT WAS LOSING REELS, on the side no test executed. One fixed key meant each
    // share overwrote the last, and clearing a saved-posts list is exactly how somebody
    // shares three things in ten seconds.
    const store = new Map();
    share("?url=https%3A%2F%2Fwww.instagram.com%2Freel%2FONE%2F", { store });
    share("?url=https%3A%2F%2Fwww.instagram.com%2Freel%2FTWO%2F", { store });
    const done = share("?url=https%3A%2F%2Fwww.instagram.com%2Freel%2FTHREE%2F", { store });

    assert.equal(done.queued.length, 3, `${done.queued.length} of three survived`);
    assert.match(done.queued[0].url, /ONE/, "the oldest is not first");
    assert.match(done.queued[2].url, /THREE/, "the newest is not last");
  });

  test("and the queue is capped, dropping the oldest rather than the newest", () => {
    // A bug that never drains this must not be able to fill his storage and take the whole
    // app down with it. The newest is the one he is watching happen, so the oldest goes.
    const store = new Map();
    for (let n = 0; n < 30; n += 1) {
      share(`?url=https%3A%2F%2Fwww.instagram.com%2Freel%2FR${n}%2F`, { store });
    }
    const queued = JSON.parse(store.get(QUEUE));
    assert.equal(queued.length, 25, `the queue grew to ${queued.length}`);
    assert.match(queued[24].url, /R29/, "the newest share was the one thrown away");
    assert.match(queued[0].url, /R5/, "the wrong end was trimmed");
  });

  test("a link somebody SENT him is not queued — it goes to the address to be asked about", () => {
    // This address is public and guessable. A cross-origin referrer means somebody sent him
    // a link rather than sharing through the sheet, and saving it with no press would let a
    // message queue his PC and spend a day of an AI key on a stranger's choosing.
    const done = share("?url=https%3A%2F%2Fwww.instagram.com%2Freel%2FSENT%2F", {
      referrer: "https://somewhere.example/messages"
    });
    assert.equal(done.queued.length, 0, "a link somebody sent was saved without being asked");
    assert.match(done.went, /#\/share-ask\//, done.went);
  });

  test("storage that refuses still gets the reel to the app, in the address", () => {
    const done = share("?url=https%3A%2F%2Fwww.instagram.com%2Freel%2FBLOCKED%2F", {
      storageBroken: true
    });
    assert.match(done.went, /#\/share\//, done.went);
    assert.match(decodeURIComponent(done.went), /BLOCKED/);
  });

  test("a share with no link in it still opens the app rather than hanging", () => {
    // Nothing in this page may throw: it used to write to storage unguarded, and he was
    // left looking at "Opening ClipToAction..." for ever.
    const done = share("?title=A+photo&text=look+at+this");
    assert.equal(done.went, "index.html");
    assert.equal(done.queued.length, 1, "the share was not recorded at all");
  });

  test("a queue that was left holding rubbish is replaced, not thrown at", () => {
    const store = new Map([[QUEUE, "{ not json"]]);
    const done = share("?url=https%3A%2F%2Fwww.instagram.com%2Freel%2FAFTER%2F", { store });
    assert.equal(done.went, "index.html");
    assert.equal(done.queued.length, 1);
    assert.match(done.queued[0].url, /AFTER/);
  });
});

describe("the writer and the reader, joined", () => {
  // NOTHING crossed this join. `share-target.html` writes a key and `index.html` reads one,
  // and the two agree only because two separate test files happen to spell the same string.
  // Renaming the key in the writer AND its own tests, leaving the reader alone, kept all 620
  // green — every shared reel going into a box nothing reads, which is precisely the bug the
  // queue exists to fix, reintroducible in silence.
  //
  // So: run the real page, take the storage it actually produced, and start the real app on
  // it. Neither half is told what the other calls anything.

  test("a reel shared through the page is saved by the app", async () => {
    const done = share("?url=https%3A%2F%2Fwww.instagram.com%2Freel%2FJOIN%2F");
    const app = await loadApp(syncPayload({}), { seed: [...done.store.entries()] });
    for (let n = 0; n < 4; n += 1) await new Promise((wait) => setTimeout(wait, 0));

    const saved = app.bodiesTo("/v1/clips").map((one) => one.url);
    assert.equal(saved.length, 1, `the app saved ${saved.length} reels: ${saved.join(", ")}`);
    assert.match(saved[0], /JOIN/);
    app.restore();
  });

  test("and three shared in a row are all saved, in the order he shared them", async () => {
    const store = new Map();
    share("?url=https%3A%2F%2Fwww.instagram.com%2Freel%2FFIRST%2F", { store });
    share("?url=https%3A%2F%2Fwww.instagram.com%2Freel%2FSECOND%2F", { store });
    share("?url=https%3A%2F%2Fwww.instagram.com%2Freel%2FTHIRD%2F", { store });

    const app = await loadApp(syncPayload({}), { seed: [...store.entries()] });
    for (let n = 0; n < 8; n += 1) await new Promise((wait) => setTimeout(wait, 0));

    const saved = app.bodiesTo("/v1/clips").map((one) => one.url);
    assert.equal(saved.length, 3, `${saved.length} of three were saved: ${saved.join(", ")}`);
    assert.match(saved[0], /FIRST/, `out of order: ${saved.join(", ")}`);
    assert.match(saved[2], /THIRD/, `out of order: ${saved.join(", ")}`);
    app.restore();
  });

  test("and a link somebody SENT him is not saved by the app either", async () => {
    // The page routes it to the address rather than storage; the app has to honour that.
    const done = share("?url=https%3A%2F%2Fevil.example%2Freel%2FSENT%2F", {
      referrer: "https://somewhere.example/messages"
    });
    const hash = done.went.includes("#") ? `#${done.went.split("#")[1]}` : "";
    const app = await loadApp(syncPayload({}), {
      seed: [...done.store.entries()],
      hash,
      referrer: "https://app.test/share-target.html"
    });
    for (let n = 0; n < 4; n += 1) await new Promise((wait) => setTimeout(wait, 0));

    const saved = app.bodiesTo("/v1/clips").map((one) => one.url);
    assert.equal(saved.length, 0, `a link somebody sent saved itself: ${saved.join(", ")}`);
    assert.match(app.text("saveMsg"), /Press Save/i, app.text("saveMsg"));
    app.restore();
  });
});
