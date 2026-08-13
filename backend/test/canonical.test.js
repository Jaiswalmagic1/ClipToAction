// The canonical URL is the dedupe key (D10). If it drifts, the same reel stops
// matching itself and every user's save triggers a fresh download, transcription
// and analysis — the cost model breaks silently, with nothing failing loudly.
// These tests exist to make that break noisy.

import { test } from "node:test";
import assert from "node:assert/strict";

import { canonicalUrl, platformFromUrl, extractUrl, isSupportedUrl } from "../src/canonical.js";

test("every YouTube link shape collapses to one canonical form", () => {
  const expected = "https://youtube.com/watch?v=dQw4w9WgXcQ";

  assert.equal(canonicalUrl("https://youtu.be/dQw4w9WgXcQ"), expected);
  assert.equal(canonicalUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ"), expected);
  assert.equal(canonicalUrl("https://youtube.com/shorts/dQw4w9WgXcQ"), expected);
  assert.equal(canonicalUrl("https://m.youtube.com/watch?v=dQw4w9WgXcQ&t=42s"), expected);
});

test("Instagram posts and reels collapse to one canonical form", () => {
  const expected = "https://instagram.com/reel/ABC123";

  assert.equal(canonicalUrl("https://www.instagram.com/reel/ABC123/"), expected);
  assert.equal(canonicalUrl("https://instagram.com/p/ABC123"), expected);
  assert.equal(canonicalUrl("https://instagram.com/reels/ABC123/"), expected);
});

test("share-sheet tracking parameters do not create a second source row", () => {
  assert.equal(
    canonicalUrl("https://www.instagram.com/reel/ABC123/?igshid=abcdef&utm_source=ig_web"),
    canonicalUrl("https://instagram.com/reel/ABC123")
  );
  assert.equal(
    canonicalUrl("https://www.facebook.com/reel/998877?fbclid=xyz"),
    canonicalUrl("https://facebook.com/reel/998877")
  );
});

test("Facebook watch links keep their video id", () => {
  // The bug this pins: the fallback dropped the whole query string, so every
  // facebook.com/watch?v=<id> — Facebook's main desktop video URL — collapsed onto one
  // key. The first saver's video was downloaded and everyone else silently attached to it.
  assert.notEqual(
    canonicalUrl("https://www.facebook.com/watch?v=1111111"),
    canonicalUrl("https://www.facebook.com/watch?v=2222222")
  );
  assert.equal(
    canonicalUrl("https://www.facebook.com/watch?v=1111111&fbclid=trackme"),
    canonicalUrl("https://facebook.com/watch?v=1111111")
  );
});

test("parameter order cannot fork the key", () => {
  assert.equal(
    canonicalUrl("https://vimeo.com/x?b=2&a=1"),
    canonicalUrl("https://vimeo.com/x?a=1&b=2")
  );
});

test("a lookalike host never borrows a real platform's canonical key", () => {
  // `endsWith("youtube.com")` also matched `myyoutube.com`. That let an attacker claim the
  // canonical key of a real video while the download pointed at a host they controlled.
  assert.notEqual(
    canonicalUrl("https://myyoutube.com/watch?v=dQw4w9WgXcQ"),
    canonicalUrl("https://youtube.com/watch?v=dQw4w9WgXcQ")
  );
  assert.notEqual(
    canonicalUrl("https://evil-instagram.com/reel/ABC123"),
    canonicalUrl("https://instagram.com/reel/ABC123")
  );
  assert.equal(platformFromUrl("https://myyoutube.com/watch?v=x"), "Unknown");
  assert.equal(platformFromUrl("https://evil-instagram.com/reel/x"), "Unknown");
  // A real subdomain still resolves to the platform.
  assert.equal(platformFromUrl("https://m.youtube.com/watch?v=x"), "YouTube");
});

test("only http and https are accepted", () => {
  assert.throws(() => canonicalUrl("javascript:alert(1)"));
  assert.throws(() => canonicalUrl("data:text/html,hi"));
  assert.throws(() => canonicalUrl("file:///etc/passwd"));
});

test("isSupportedUrl gates what the PC worker will ever fetch", () => {
  assert.equal(isSupportedUrl("https://instagram.com/reel/ABC"), true);
  assert.equal(isSupportedUrl("https://youtu.be/abc"), true);
  assert.equal(isSupportedUrl("http://169.254.169.254/latest/meta-data/"), false);
  assert.equal(isSupportedUrl("http://192.168.1.1/admin"), false);
  assert.equal(isSupportedUrl("https://evil.example.com/x"), false);
});

test("different reels stay different", () => {
  assert.notEqual(
    canonicalUrl("https://instagram.com/reel/AAA111"),
    canonicalUrl("https://instagram.com/reel/BBB222")
  );
});

test("canonicalUrl rejects input that is not a URL", () => {
  assert.throws(() => canonicalUrl("not a link"));
  assert.throws(() => canonicalUrl(""));
});

test("platform is derived from the host", () => {
  assert.equal(platformFromUrl("https://youtu.be/x"), "YouTube");
  assert.equal(platformFromUrl("https://www.instagram.com/reel/x"), "Instagram");
  assert.equal(platformFromUrl("https://fb.watch/x"), "Facebook");
  assert.equal(platformFromUrl("https://x.com/someone/status/1"), "X");
  assert.equal(platformFromUrl("https://www.linkedin.com/posts/x"), "LinkedIn");
  assert.equal(platformFromUrl("garbage"), "Unknown");
});

test("extractUrl pulls the link out of a shared message", () => {
  assert.equal(
    extractUrl("Check this out https://instagram.com/reel/ABC123 amazing"),
    "https://instagram.com/reel/ABC123"
  );
  // Share sheets often append punctuation to the URL.
  assert.equal(
    extractUrl("look at https://youtu.be/abc123."),
    "https://youtu.be/abc123"
  );
  assert.equal(extractUrl("no link here"), "");
  assert.equal(extractUrl(), "");
});
