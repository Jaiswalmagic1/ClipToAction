// The service worker exists for one reason: Android will not offer to install the app,
// and so will not put it in the share sheet, without one — and the share sheet is the
// only way a reel gets in (D17).
//
// It is NETWORK FIRST, and that is the whole point of this version. The first one was
// cache first, which meant the page a phone installed was the page it kept for ever: the
// app could be rebuilt a dozen times and the installed copy would never see any of it.
// Now the network answers when it can, the saved copy answers when it cannot, and the
// app is still there on a train with no signal.
const CACHE = "cliptoaction-v2";

// Enough to open the notebook with no signal. The notebook's own contents are already
// kept on the device by the app itself, so this is only the shell around them.
const SHELL = ["./", "./index.html", "./manifest.json", "./icon.svg"];

self.addEventListener("install", (event) => {
  self.skipWaiting();
  // One missing file must not fail the whole install and leave the app uninstallable, so
  // each is added on its own and a failure is allowed.
  event.waitUntil(
    caches.open(CACHE).then((cache) =>
      Promise.all(SHELL.map((path) => cache.add(path).catch(() => {})))
    )
  );
});

self.addEventListener("activate", (event) => {
  // Every older cache goes. Without this the previous version's copy of index.html sits
  // there for ever and `caches.match` can still find it — which is exactly how an
  // installed app ends up opening a page that was replaced months ago.
  event.waitUntil(
    caches
      .keys()
      .then((names) => Promise.all(names.filter((name) => name !== CACHE).map((name) => caches.delete(name))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  // Anything not served from this address is left completely alone — the API, Firebase
  // sign-in, and the module files the app imports. Touching those would put a saved copy
  // of somebody's notebook data in a cache the app does not control.
  if (new URL(request.url).origin !== self.location.origin) return;

  event.respondWith(
    fetch(request)
      .then((response) => {
        // Only a real, complete answer is worth keeping. An opaque or partial one saved
        // here would be served back later as though it were the page.
        if (response && response.ok && response.type === "basic") {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy)).catch(() => {});
        }
        return response;
      })
      .catch(async () => {
        const cached = await caches.match(request);
        if (cached) return cached;
        // A deep link opened with no signal still has to land on the app, which then
        // reads the notebook it already holds on the device.
        if (request.mode === "navigate") {
          const shell = await caches.match("./index.html");
          if (shell) return shell;
        }
        return Response.error();
      })
  );
});
