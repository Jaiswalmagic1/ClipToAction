// Assembles the folder the staging Worker serves the app from.
//
// Why this exists: staging needs an HTTPS address the app can be opened on from a phone,
// so the phone layout and — far more importantly — the Android share sheet can actually
// be run against it, and the share sheet is the only way anyone captures a reel (D17).
// Serving the app from the staging Worker gives it that address without signing up for
// anything new (D26).
//
// Nothing here is a second copy of the app. `index.html` at the repo root is the single
// source. Since the D21 swap it is also what GitHub Pages serves, so this script has far
// less to rewrite than it used to: the only differences left are the ones that must
// differ, which is the name on the installed icon.
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

// The app itself, the icon the manifest points at, and the share target — all exactly as
// the repo holds them. Nothing is rewritten any more.
await copyFile(join(repo, "index.html"), join(out, "index.html"));
await copyFile(join(repo, "icon.svg"), join(out, "icon.svg"));
await copyFile(join(repo, "share-target.html"), join(out, "share-target.html"));

// The address the app lived at while it was being built beside the old page. Kept so a
// bookmark of it still opens the notebook; the repo's copy is now a redirect to the root.
await copyFile(join(repo, "app.html"), join(out, "app.html"));

const manifest = JSON.parse(await readFile(join(repo, "manifest.json"), "utf8"));
manifest.name = "ClipToAction (staging)";
manifest.short_name = "CTA staging";
// A phone that already installed staging did so back when it started at ./app.html, and
// that address is what the browser has been using to recognise the app ever since. Saying
// it here keeps that install the same app rather than making a second icon appear beside
// it. What it OPENS is index.html, like everywhere else.
//
// Written as an absolute path, and that matters: `id` is resolved against the ORIGIN, not
// against the manifest's own folder. A relative "./app.html" happens to give the same
// answer here only because this manifest sits at the root — the repo's copy, which sits
// under /ClipToAction/ on GitHub Pages, has no `id` at all for exactly that reason.
manifest.id = "/app.html";
if (manifest.start_url !== "./index.html") {
  throw new Error("manifest.json no longer starts at ./index.html — check the D21 swap");
}
await writeFile(join(out, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

// Android will not offer to install the app without a service worker that handles fetch.
// This one deliberately does not cache: a cached page during testing means edits appear
// not to have happened, which already cost one debugging session. The repo's own service
// worker is network-first for the same reason, but it does keep an offline copy, and on
// staging even that is a copy too many.
await writeFile(
  join(out, "service-worker.js"),
  `// Staging only. Registers so the app is installable; caches nothing on purpose.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (event) => event.respondWith(fetch(event.request)));
`
);

console.log(`Staging assets assembled in ${out}`);
