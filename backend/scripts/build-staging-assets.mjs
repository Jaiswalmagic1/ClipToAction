// Assembles the folder the staging Worker serves the app from.
//
// Why this exists: until the app has a real web address it cannot be opened on a phone at
// all, and Firebase only allows sign-in from `localhost` otherwise. That leaves the phone
// layout and — far more importantly — the Android share sheet completely unrun, and the
// share sheet is the only way anyone is meant to capture a reel (D17). Serving the app
// from the staging Worker gives it an HTTPS address without touching the live page (D21)
// and without signing up for anything new.
//
// Nothing here is a second copy of the app. `app.html` at the repo root stays the single
// source; this only assembles a deploy folder, which is gitignored. The two files that
// point at the OLD app are rewritten on the way through rather than edited in the repo,
// because D21 says the live page and its plumbing stay untouched until the swap.
//
// This is staging only. Production serves the app from GitHub Pages (D16).

import { mkdir, rm, copyFile, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..");
const out = join(here, "..", ".staging-assets");

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

// The app itself, and the icon the manifest points at.
await copyFile(join(repo, "app.html"), join(out, "app.html"));
await copyFile(join(repo, "icon.svg"), join(out, "icon.svg"));

// Opening the bare address should land on the app, not on a 404 from the API.
await copyFile(join(repo, "app.html"), join(out, "index.html"));

// The manifest decides what the phone installs and what the share sheet hands the link
// to. The repo's copy still points at the old app, so it is redirected here.
const manifest = JSON.parse(await readFile(join(repo, "manifest.json"), "utf8"));
manifest.name = "ClipToAction (staging)";
manifest.short_name = "CTA staging";
manifest.start_url = "./app.html";
manifest.share_target.action = "./share-target.html";
await writeFile(join(out, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

// Same reason: the repo's share target hands off to index.html, which is the old app.
const shareTarget = (await readFile(join(repo, "share-target.html"), "utf8")).replace(
  'window.location.replace("index.html")',
  'window.location.replace("app.html")'
);
if (!shareTarget.includes('replace("app.html")')) {
  throw new Error("share-target.html no longer contains the redirect this script rewrites");
}
await writeFile(join(out, "share-target.html"), shareTarget);

// Android will not offer to install the app without a service worker that handles fetch.
// This one deliberately does not cache: a cached app.html during testing means edits
// appear not to have happened, which already cost one debugging session.
await writeFile(
  join(out, "service-worker.js"),
  `// Staging only. Registers so the app is installable; caches nothing on purpose.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (event) => event.respondWith(fetch(event.request)));
`
);

console.log(`Staging assets assembled in ${out}`);
