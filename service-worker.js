// The service worker exists for one reason: Android will not offer to install the app,
// and so will not put it in the share sheet, without one — and the share sheet is the
// only way a reel gets in (D17).
//
// It is NETWORK FIRST, and that is the whole point of this version. The first one was
// cache first, which meant the page a phone installed was the page it kept: the app could
// be rebuilt a dozen times and the installed copy would never see any of it. Now the
// network answers when it can, the saved copy answers when it cannot, and the app is still
// there on a train with no signal.
const CACHE = "cliptoaction-v3";

// Enough to open the notebook with no signal. The notebook's own contents are already
// kept on the device by the app itself, so this is only the shell around them.
//
// `share-target.html` is in here because it is the only way a reel gets in (D17): sharing
// one on a train navigates to it, and a share target that is not cached falls through to
// the app with the link dropped and nothing said.
const SHELL = ["./", "./index.html", "./share-target.html", "./manifest.json", "./icon.svg"];

// The one address other than our own whose answers are kept.
//
// The app imports Firebase's sign-in library as a plain `import` at the top of its module,
// so if that file cannot be fetched the module never evaluates and NOT ONE LINE of the app
// runs — a header and a white page, permanently, with nothing on screen saying why. Every
// promise this file makes about working offline was untrue while these two files were
// excluded.
//
// It is safe to keep them for the same reason it is not safe to keep anything else: they
// are public library code, identical for everybody, and contain nothing of anyone's. The
// exclusion below still covers everything that carries somebody's data.
const LIBRARY_ORIGIN = "https://www.gstatic.com";

// How long to wait for the network before serving the saved copy instead.
//
// A rejection is not the failure that matters. A dead connection — patchy mobile signal, a
// captive portal, a hotel wifi that accepts the socket and never answers — does not reject
// for tens of seconds, and the app would sit on a white screen for all of them.
//
// Crucially, giving up on WAITING is not giving up on the REQUEST: the fetch keeps running
// and its answer is still saved. Attaching the save to the race instead would mean a phone
// on a slow connection timed out on every open, never refreshed its copy, and stayed on an
// old build for ever — which is the exact bug this whole file was rewritten to kill.
const NETWORK_WAIT_MS = 3000;

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

/** Whether this response is one worth keeping. */
function worthKeeping(response) {
  if (!response || !response.ok) return false;
  // "basic" is our own address. "cors" is the library origin above, which is the only
  // other one that reaches here at all. An opaque response has no status worth trusting
  // and would be served back later as though it were the page.
  return response.type === "basic" || response.type === "cors";
}

/** The network's answer, or a rejection once the wait is up, so the cache can answer. */
function orGiveUpWaiting(live) {
  return Promise.race([
    live,
    new Promise((_, giveUp) =>
      setTimeout(() => giveUp(new Error("the network took too long")), NETWORK_WAIT_MS)
    )
  ]);
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  const ours = url.origin === self.location.origin;

  // Anything not served from this address is left completely alone — the API, Firebase's
  // own sign-in traffic, anything else the page reaches for. Touching those would put a
  // saved copy of somebody's data in a cache the app does not control. The one exception
  // is the library origin above, and only because the app cannot start without it.
  if (!ours && url.origin !== LIBRARY_ORIGIN) return;

  // And nothing under /v1 either, even same-origin. On staging the app and the API share
  // an address (D26), so without this a sync response — the whole notebook, in clear text,
  // fetched with somebody's token — would be written into Cache Storage with no `Vary` on
  // Authorization, and handed back to whoever opens the app on that device next.
  if (ours && (url.pathname === "/v1" || url.pathname.startsWith("/v1/"))) return;

  // Started once, and the SAVE hangs off this rather than off the race below. A slow
  // answer still updates the copy, even when the cached one was served meanwhile.
  const live = fetch(request);
  event.waitUntil(
    live
      .then(async (response) => {
        if (!worthKeeping(response)) return;
        const cache = await caches.open(CACHE);
        await cache.put(request, response.clone());
      })
      .catch(() => {})
  );

  event.respondWith(
    orGiveUpWaiting(live).catch(async () => {
      const cached = await caches.match(request);
      if (cached) return cached;
      // A deep link opened with no signal still has to land on the app, which then reads
      // the notebook it already holds on the device.
      if (request.mode === "navigate") {
        const shell = await caches.match("./index.html");
        if (shell) return shell;
      }
      // Nothing saved and nothing arriving in time — but the request is still running, so
      // waiting for it is better than failing outright.
      return live;
    })
  );
});
