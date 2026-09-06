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
    // Changing start_url on an installed app makes it a different app unless `id` pins
    // the old one. `id` must therefore stay exactly what start_url has always been.
    assert.equal(manifest.id, "./index.html");
    assert.equal(manifest.share_target.action, "./share-target.html");
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
    // Nothing from another address may be written into a cache the app does not control.
    assert.ok(sw.includes("!== self.location.origin"), "cross-origin requests are not left alone");
  });
});
