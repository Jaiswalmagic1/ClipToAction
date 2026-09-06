// D37 — the app is the root page, and the plumbing points at it.
//
// This is a regression guard for a bug that was invisible for weeks: the manifest and the
// share target both said `index.html`, and both were right, but the app was living at
// `app.html` — so the installed phone app opened the retired page and nothing on staging
// showed it, because the staging build rewrote those two files on the way through.
//
// Everything here reads the repo's own files. Nothing that ships to a phone is mocked.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (name) => readFileSync(join(repo, name), "utf8");

describe("the root page is the app", () => {
  test("index.html is the notebook, not the retired capture page", () => {
    const page = read("index.html");
    assert.ok(page.includes('id="clipList"'), "the notebook list is missing");
    assert.ok(page.includes('id="settingsView"'), "the settings screen is missing");
    assert.ok(page.includes("/v1/sync?since="), "delta sync is missing");
    // The old page synced by committing data/ideas.json with a GitHub token pasted into
    // the UI (D3, superseded by D6). Its return would be a data-loss bug, not a style one.
    assert.ok(!page.includes("api.github.com"), "the retired GitHub-token sync is back");
    assert.ok(!page.includes("data/ideas.json"), "the retired file store is back");
  });

  test("it talks to staging, because that is where the notebook is (D36)", () => {
    const page = read("index.html");
    assert.ok(
      page.includes("https://cliptoaction-api-staging.cliptoaction.workers.dev"),
      "the app is not pointed at staging"
    );
  });

  test("the installed app starts at the app, and keeps the identity it already had", () => {
    const manifest = JSON.parse(read("manifest.json"));
    assert.equal(manifest.start_url, "./index.html");
    assert.equal(manifest.share_target.action, "./share-target.html");

    // No `id`, deliberately. A browser recognises an installed app by its manifest `id`,
    // which DEFAULTS to the fully-resolved start_url — and start_url has not changed, so
    // the identity is already exactly what his phone has been using.
    //
    // Writing one down looked safer and was the opposite: `id` is resolved against the
    // ORIGIN, not against the manifest's folder. On GitHub Pages this manifest lives at
    // /ClipToAction/manifest.json, so "./index.html" would have resolved to
    // https://jaiswalmagic1.github.io/index.html — a DIFFERENT app from the one he has
    // installed, which would then have stopped taking manifest updates and offered him a
    // second icon. The one line added to protect the install was the line breaking it.
    assert.ok(
      !("id" in manifest),
      "an `id` here resolves against the origin, not this folder — see the comment above"
    );
  });

  test("a shared link lands on the app", () => {
    const target = read("share-target.html");
    assert.ok(target.includes('replace("index.html")'), "the share target points elsewhere");
  });

  test("the old address still opens the notebook", () => {
    const stub = read("app.html");
    assert.ok(stub.includes('location.replace("./"'), "app.html no longer redirects");
    assert.ok(stub.includes("location.hash"), "app.html drops the part after the #");
    assert.ok(!stub.includes('id="clipList"'), "app.html is a second copy of the app");
  });

  test("the service worker cannot pin a phone to a replaced page", () => {
    const sw = read("service-worker.js");
    // Network first: the fetch handler must ASK the network before it looks in the cache.
    const handler = sw.slice(sw.indexOf('addEventListener("fetch"'));
    assert.ok(
      handler.indexOf("fetch(request)") < handler.indexOf("caches.match"),
      "the service worker is cache first again — an installed app would never update"
    );
    assert.ok(sw.includes("caches.delete"), "older caches are never cleaned up");
    assert.ok(sw.includes("self.skipWaiting"), "a new version would wait for every tab to close");
    // Nothing from another address may be written into a cache the app does not control,
    // with exactly one exception: the library the app cannot start without.
    assert.ok(sw.includes("self.location.origin"), "cross-origin requests are not left alone");
    assert.ok(
      sw.includes("LIBRARY_ORIGIN") && sw.includes("https://www.gstatic.com"),
      "the app imports Firebase at the top of its module — without that file cached, "
        + "offline is a white page and not the app"
    );
    // Giving up on WAITING is not giving up on the REQUEST. Hanging the save off the race
    // means a phone on a slow connection times out every time, never refreshes its copy,
    // and stays on an old build for ever — the exact bug this file exists to kill.
    assert.ok(
      handler.indexOf("const live = fetch(request)") < handler.indexOf("cache.put"),
      "the saved copy must be updated by the fetch, not by the race"
    );
    // Nor the API, even where the app and the API share an address (D26) — a cached sync
    // response is somebody's whole notebook, served back to whoever opens the app next.
    assert.ok(sw.includes('startsWith("/v1/")'), "API responses could be cached");
    // A dead connection does not reject. Without a wait, an app that used to open
    // instantly from its cache sits on a white screen instead.
    assert.ok(sw.includes("NETWORK_WAIT_MS"), "the network is waited on for ever");
    // Sharing a reel is the only way one gets in (D17), and it navigates to this page.
    assert.ok(sw.includes("./share-target.html"), "the share target is not kept for offline");
  });
});
