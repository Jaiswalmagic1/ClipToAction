// Canonical URL + platform detection.
//
// The canonical URL is the dedupe key for the shared layer: if two users save the same
// reel through different share links, both must land on the same `sources` row so the
// video is downloaded, transcribed and analysed exactly once.

export function platformFromUrl(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "").toLowerCase();
    if (host.includes("youtube") || host.includes("youtu.be")) return "YouTube";
    if (host.includes("instagram")) return "Instagram";
    if (host.includes("facebook") || host.includes("fb.watch")) return "Facebook";
    if (host.includes("linkedin")) return "LinkedIn";
    if (host === "x.com" || host.includes("twitter")) return "X";
    return host.split(".")[0].replace(/^./, (char) => char.toUpperCase());
  } catch {
    return "Unknown";
  }
}

export function canonicalUrl(rawUrl) {
  const parsed = new URL(String(rawUrl).trim());
  const host = parsed.hostname.replace(/^www\./, "").toLowerCase();
  const path = parsed.pathname.replace(/\/+$/, "");

  if (host === "youtu.be") {
    return `https://youtube.com/watch?v=${path.slice(1)}`;
  }
  if (host.endsWith("youtube.com")) {
    const shorts = /^\/shorts\/([^/]+)/.exec(path);
    if (shorts) return `https://youtube.com/watch?v=${shorts[1]}`;
    const id = parsed.searchParams.get("v");
    if (id) return `https://youtube.com/watch?v=${id}`;
  }
  if (host.endsWith("instagram.com")) {
    // /p/<code> and /reel/<code> are the same post; normalise both to /reel/<code>.
    const post = /^\/(?:p|reel|reels)\/([^/]+)/.exec(path);
    if (post) return `https://instagram.com/reel/${post[1]}`;
  }

  // Everything else: origin + path, with tracking parameters dropped.
  return `https://${host}${path}`;
}

export function extractUrl(text = "") {
  const match = String(text).match(/https?:\/\/[^\s]+/i);
  return match ? match[0].replace(/[),.]+$/, "") : "";
}
