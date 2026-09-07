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

/**
 * Every host this product will fetch from, flattened.
 *
 * Exported so the PC worker's own copy of the same list can be compared against it. The
 * copy is deliberate — a second check that reads the first one is not a second check — but
 * a copy that has drifted is worse than none: a link the API accepts and his PC refuses
 * sits in the queue failing for a reason nobody can see.
 */
export const ALL_PLATFORM_DOMAINS = PLATFORMS.flatMap((platform) => platform.domains);

function normalisedHost(parsed) {
  return parsed.hostname.replace(/^www\./, "").toLowerCase();
}

/**
 * Characters that mean one thing to this parser and another to the next one along.
 *
 * The allowlist below is the outer wall (D19): only known platforms may be saved, because
 * the machine that fetches them is a PC on a home network. That wall was walked round with
 * a single backslash. `https://youtube.com\@attacker.example/x` is, to the WHATWG parser
 * this file uses, the host `youtube.com` with a path — approved, stored, and handed on.
 * Python's `urlparse`, which is what the PC worker's own second check uses, reads the same
 * string as the host `attacker.example`. So the wall approved one host and the machine
 * behind it evaluated a different one: a stranger's address, fetched from his home line,
 * with the private-network check aimed at the wrong name.
 *
 * Two guards, and they are not the same guard twice. This refuses the shapes where parsers
 * are known to disagree — a backslash anywhere, and credentials before the host — and
 * `canonicalUrl` then stores the parser's OWN idea of the address, so nothing downstream
 * can read a different host out of it than the one that was approved.
 */
export function parsesTheSameEverywhere(url) {
  const text = String(url);
  if (text.includes("\\")) return false;
  try {
    // Credentials before the host. This parser puts them in their own fields, and another
    // one further along may not — `https://youtube.com@somewhere.else/` is the same trick
    // as the backslash, wearing a different hat.
    const parsed = new URL(text);
    return !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}

/**
 * The address as this parser understands it, which is the only form anything else may see.
 *
 * Stored as `url_original` so that the PC worker, yt-dlp and every log read the host the
 * Worker approved rather than re-deriving one of their own from the raw text a stranger
 * typed. Everything the user wrote that matters survives — scheme, host, path and query —
 * it is only the ambiguity that does not.
 */
export function asItWasUnderstood(url) {
  return new URL(String(url)).href;
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
  return (
    parsesTheSameEverywhere(url)
    && isWebAddress(url)
    && platformFromUrl(url) !== "Unknown"
  );
}

/**
 * A web address, not something else wearing a platform's name.
 *
 * `file://youtube.com/x` and `javascript://youtube.com/x` both name an allowed host, so
 * both were saved — and then sat in the queue failing, because there is nothing at the
 * other end of either. No danger in it (both parsers agree on the host, and yt-dlp simply
 * fails), but a save that can never work should be refused where he can see it rather than
 * accepted and left to time out.
 */
function isWebAddress(url) {
  try {
    return ["http:", "https:"].includes(new URL(String(url)).protocol);
  } catch {
    return false;
  }
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
