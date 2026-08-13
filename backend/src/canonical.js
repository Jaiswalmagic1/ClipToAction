// Canonical URL, platform detection, and the allowlist of hosts we will fetch.
//
// The canonical URL is the dedupe key for the shared layer (D10): if two users save the
// same reel through different share links, both must land on the same `sources` row so
// the video is downloaded, transcribed and analysed exactly once.
//
// Two things this file must never get wrong, because both fail silently:
//   * Collapsing DIFFERENT videos onto one key. Users then see each other's transcripts.
//     This is why the query string is filtered, not discarded — facebook.com/watch?v=<id>
//     carries its identity there.
//   * Matching a host too loosely. `endsWith("youtube.com")` also matches
//     `myyoutube.com`, which would let anyone register the canonical key of a real video
//     while pointing the download at a host they control.

/** host === domain, or a real subdomain of it. Never a suffix match on the string. */
function hostIs(host, domain) {
  return host === domain || host.endsWith(`.${domain}`);
}

const PLATFORMS = [
  { name: "YouTube", domains: ["youtube.com", "youtu.be"] },
  { name: "Instagram", domains: ["instagram.com"] },
  { name: "Facebook", domains: ["facebook.com", "fb.watch", "fb.com"] },
  { name: "LinkedIn", domains: ["linkedin.com"] },
  { name: "X", domains: ["x.com", "twitter.com"] }
];

// Parameters that identify *which* video. Everything else in the query is dropped.
const IDENTIFYING_PARAMS = {
  YouTube: ["v", "list"],
  Facebook: ["v", "story_fbid", "id"]
};

// Share sheets and ad platforms bolt these on. They never identify the video.
//
// `s` and `t` matter more than they look: X's share sheet appends `?s=20&t=<random>` to
// every share, and `t` is different every time. Leaving them in meant every share of the
// same tweet became a new source row — a fresh download, transcription and AI call each
// time. That is finding #2 in reverse: not a collision, a failure to dedupe.
const TRACKING_PARAMS = new Set([
  "igshid", "igsh", "fbclid", "gclid", "si", "s", "t", "ref", "ref_src", "ref_url",
  "feature", "app", "source", "mc_cid", "mc_eid", "_rdr", "mibextid", "rdid", "trk",
  "originalSubdomain", "share_id", "lipi"
]);

// Hosts that are the same site under different names.
const HOST_ALIASES = {
  "twitter.com": "x.com",
  "m.facebook.com": "facebook.com",
  "web.facebook.com": "facebook.com",
  "fb.com": "facebook.com"
};

function normalisedHost(parsed) {
  return parsed.hostname.replace(/^www\./, "").toLowerCase();
}

function platformOf(host) {
  const match = PLATFORMS.find((platform) =>
    platform.domains.some((domain) => hostIs(host, domain))
  );
  return match ? match.name : "Unknown";
}

export function platformFromUrl(url) {
  try {
    return platformOf(normalisedHost(new URL(url)));
  } catch {
    return "Unknown";
  }
}

/**
 * True when we recognise the host as a platform we support.
 * Anything else is refused rather than fetched — an arbitrary URL here would let a signed-in
 * user point the PC worker at their own server, or at an address inside the operator's LAN.
 */
export function isSupportedUrl(url) {
  return platformFromUrl(url) !== "Unknown";
}

/** Query string with tracking removed and the rest sorted, so parameter order cannot fork the key. */
function stableQuery(parsed, keepOnly) {
  const kept = [...parsed.searchParams.entries()]
    .filter(([key]) =>
      keepOnly ? keepOnly.includes(key) : !TRACKING_PARAMS.has(key) && !key.startsWith("utm_")
    )
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  if (!kept.length) return "";
  return `?${kept.map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join("&")}`;
}

export function canonicalUrl(rawUrl) {
  const parsed = new URL(String(rawUrl).trim());
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("Only http and https links are supported");
  }

  const host = normalisedHost(parsed);
  const path = parsed.pathname.replace(/\/+$/, "");
  const platform = platformOf(host);

  if (hostIs(host, "youtu.be")) {
    return `https://youtube.com/watch?v=${path.slice(1)}`;
  }
  if (hostIs(host, "youtube.com")) {
    const shorts = /^\/(?:shorts|live|embed)\/([^/]+)/.exec(path);
    if (shorts) return `https://youtube.com/watch?v=${shorts[1]}`;
    const id = parsed.searchParams.get("v");
    if (id) return `https://youtube.com/watch?v=${id}`;
  }
  if (hostIs(host, "instagram.com")) {
    // /p/<code>, /reel/<code> and /<user>/reel/<code> are all the same post.
    const post = /\/(?:p|reel|reels|tv)\/([^/]+)/.exec(path);
    if (post) return `https://instagram.com/reel/${post[1]}`;
  }

  // Everything else keeps its identifying parameters. Dropping the whole query here would
  // collapse every facebook.com/watch?v=<id> — Facebook's main desktop video URL — onto a
  // single key.
  const canonicalHost = hostIs(host, "facebook.com")
    ? "facebook.com"
    : HOST_ALIASES[host] || host;
  return `https://${canonicalHost}${path}${stableQuery(parsed, IDENTIFYING_PARAMS[platform])}`;
}

export function extractUrl(text = "") {
  const match = String(text).match(/https?:\/\/[^\s]+/i);
  return match ? match[0].replace(/[),.]+$/, "") : "";
}
