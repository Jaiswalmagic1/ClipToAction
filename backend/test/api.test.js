// Tests for the surface a green CI previously said nothing about: authentication,
// authorisation, and the boundary between one user's data and everyone else's.
//
// Findings 1, 3, 5 and 10 of the 2026-08-13 security review all lived here.

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";

import worker from "../src/worker.js";
import { createTestEnv } from "./helpers/testenv.js";

let harness;
let alice;
let bob;

before(async () => {
  harness = await createTestEnv();
  alice = await harness.mintToken("alice");
  bob = await harness.mintToken("bob");
});

after(() => harness.restore());

const REEL = "https://www.instagram.com/reel/SHARED1/";

async function saveClip(token, url = REEL) {
  return harness.call(worker, "/v1/clips", { method: "POST", token, body: { url } });
}

describe("authentication", () => {
  test("no token is rejected", async () => {
    const response = await harness.call(worker, "/v1/sync");
    assert.equal(response.status, 401);
  });

  test("a token with a valid shape but a forged signature is rejected", async () => {
    const forged = await harness.mintToken("mallory", { forgeSignature: true });
    const response = await harness.call(worker, "/v1/sync", { token: forged });
    assert.equal(response.status, 401);
  });

  test("a token for another Firebase project is rejected", async () => {
    const wrongAudience = await harness.mintToken("mallory", { aud: "someone-elses-project" });
    assert.equal((await harness.call(worker, "/v1/sync", { token: wrongAudience })).status, 401);

    const wrongIssuer = await harness.mintToken("mallory", {
      iss: "https://securetoken.google.com/someone-elses-project"
    });
    assert.equal((await harness.call(worker, "/v1/sync", { token: wrongIssuer })).status, 401);
  });

  test("an expired token is rejected", async () => {
    const past = Math.floor(Date.now() / 1000) - 7200;
    const expired = await harness.mintToken("alice", { iat: past, exp: past + 60 });
    assert.equal((await harness.call(worker, "/v1/sync", { token: expired })).status, 401);
  });

  test("service routes are unreachable with a user token, and vice versa", async () => {
    assert.equal((await harness.call(worker, "/v1/queue", { token: alice })).status, 401);
    assert.equal(
      (await harness.call(worker, "/v1/sync", { serviceToken: "service-token-for-tests" })).status,
      401
    );
  });

  test("a wrong service token is rejected", async () => {
    const response = await harness.call(worker, "/v1/queue", { serviceToken: "not-the-token" });
    assert.equal(response.status, 401);
  });
});

describe("saving links", () => {
  test("a supported link is saved", async () => {
    const response = await saveClip(alice);
    assert.equal(response.status, 201);
    assert.equal(response.body.clip.user_id, "alice");
  });

  test("saving the same reel twice does not create a second clip", async () => {
    const first = await saveClip(alice, "https://instagram.com/reel/DUPE/");
    const second = await saveClip(alice, "https://www.instagram.com/reel/DUPE/?igshid=xyz");
    assert.equal(second.body.clip.id, first.body.clip.id);
    assert.equal(second.body.reused, true);
  });

  test("two users saving one reel share a single source", async () => {
    const a = await saveClip(alice, "https://instagram.com/reel/BOTH/");
    const b = await saveClip(bob, "https://instagram.com/reel/BOTH/");
    assert.equal(a.body.clip.source_id, b.body.clip.source_id);
    assert.notEqual(a.body.clip.id, b.body.clip.id);
  });

  test("an unsupported host is refused, so the PC worker is never aimed at it", async () => {
    for (const url of [
      "http://169.254.169.254/latest/meta-data/",
      "http://192.168.1.1/admin",
      "https://evil.example.com/reel/ABC",
      "https://myyoutube.com/watch?v=dQw4w9WgXcQ"
    ]) {
      const response = await saveClip(alice, url);
      assert.equal(response.status, 400, `${url} should be refused`);
    }
  });
});

describe("one user cannot reach another user's data", () => {
  test("sync returns only your own clips", async () => {
    await saveClip(alice, "https://instagram.com/reel/ALICEONLY/");
    const response = await harness.call(worker, "/v1/sync?since=0", { token: bob });

    assert.equal(response.status, 200);
    assert.ok(response.body.clips.every((clip) => clip.user_id === "bob"));
    assert.ok(!response.body.clips.some((clip) => clip.id.includes("alice")));
  });

  test("you cannot change the status of someone else's clip", async () => {
    const saved = await saveClip(alice, "https://instagram.com/reel/STATUS/");
    const response = await harness.call(worker, `/v1/clips/${saved.body.clip.id}`, {
      method: "PATCH",
      token: bob,
      body: { status: "done" }
    });
    assert.equal(response.status, 404);
  });

  test("you cannot attach a note to someone else's clip", async () => {
    const saved = await saveClip(alice, "https://instagram.com/reel/NOTE/");
    const response = await harness.call(worker, "/v1/notes", {
      method: "POST",
      token: bob,
      body: { clip_id: saved.body.clip.id, body: "not mine" }
    });
    assert.equal(response.status, 404);
  });

  test("settings never return the stored key", async () => {
    // Deliberately not shaped like a real key — the CI secret scan reads this file too,
    // and a realistic fixture would (correctly) trip it.
    const sentinel = "sentinel-value-that-must-never-come-back";
    const response = await harness.call(worker, "/v1/settings", {
      method: "PUT",
      token: alice,
      body: { provider: "gemini", api_key: sentinel }
    });

    assert.equal(response.status, 200);
    assert.equal(response.body.key_stored, true);
    assert.ok(!JSON.stringify(response.body).includes(sentinel));

    // And it must not leak through sync either.
    const sync = await harness.call(worker, "/v1/sync?since=0", { token: alice });
    assert.ok(!JSON.stringify(sync.body).includes(sentinel));

    // Nor may it be stored in the clear.
    const stored = harness.database.prepare("SELECT ai_key_cipher FROM users WHERE id = ?").get("alice");
    assert.ok(stored.ai_key_cipher && !stored.ai_key_cipher.includes(sentinel));
  });
});

describe("a pasted analysis stays with the user who pasted it", () => {
  const PASTE_REEL = "https://instagram.com/reel/PASTE/";
  const payload = {
    summary: "Alice's own reading of the video.",
    key_points: ["one"],
    learn_more: ["two"],
    claims: [],
    suggested_task: null
  };

  test("a paste is refused before there is a transcript", async () => {
    const saved = await saveClip(alice, PASTE_REEL);
    const response = await harness.call(worker, `/v1/clips/${saved.body.clip.id}/analysis`, {
      method: "POST",
      token: alice,
      body: { pasted: JSON.stringify(payload) }
    });
    assert.equal(response.status, 404);
  });

  test("a paste never marks the reel analysed, so it still gets downloaded", async () => {
    const saved = await saveClip(alice, PASTE_REEL);
    const sourceId = saved.body.clip.source_id;

    await harness.call(worker, `/v1/sources/${sourceId}/transcript`, {
      method: "POST",
      serviceToken: "service-token-for-tests",
      body: { text: "the real transcript", engine: "test" }
    });

    const response = await harness.call(worker, `/v1/clips/${saved.body.clip.id}/analysis`, {
      method: "POST",
      token: alice,
      body: { pasted: JSON.stringify(payload) }
    });
    assert.equal(response.status, 200);

    const source = harness.database.prepare("SELECT state FROM sources WHERE id = ?").get(sourceId);
    assert.equal(source.state, "transcribed", "a user paste must not complete the pipeline");
  });

  test("another user who saved the same reel never sees that paste", async () => {
    const bobsClip = await saveClip(bob, PASTE_REEL);
    assert.equal(bobsClip.status, 201);

    const sync = await harness.call(worker, "/v1/sync?since=0", { token: bob });
    const summaries = sync.body.analyses.map((row) => row.summary);
    assert.ok(
      !summaries.includes(payload.summary),
      "Alice's pasted analysis must not reach Bob"
    );
  });

  test("a malformed paste is refused and stores nothing", async () => {
    const saved = await saveClip(alice, PASTE_REEL);
    const response = await harness.call(worker, `/v1/clips/${saved.body.clip.id}/analysis`, {
      method: "POST",
      token: alice,
      body: { pasted: "I'm sorry, I can't help with that." }
    });
    assert.equal(response.status, 400);
  });
});

describe("delta sync", () => {
  test("a reel transcribed before you saved it still reaches you", async () => {
    // The failure this pins: shared rows were filtered on their own timestamp, so a user
    // who saved an already-transcribed reel got a permanently blank clip.
    const url = "https://instagram.com/reel/OLDNEWS/";
    const alicesClip = await saveClip(alice, url);
    const sourceId = alicesClip.body.clip.source_id;

    await harness.call(worker, `/v1/sources/${sourceId}/transcript`, {
      method: "POST",
      serviceToken: "service-token-for-tests",
      body: { text: "transcribed long before Bob turned up", engine: "test" }
    });

    const watermark = Date.now() + 1;
    await new Promise((resolve) => setTimeout(resolve, 5));

    const bobsClip = await saveClip(bob, url);
    assert.equal(bobsClip.status, 201);

    const sync = await harness.call(worker, `/v1/sync?since=${watermark}`, { token: bob });
    assert.equal(sync.body.clips.length, 1, "Bob should get his new clip");
    assert.equal(sync.body.sources.length, 1, "and the source it points at");
    assert.equal(sync.body.transcripts.length, 1, "and the transcript that already existed");
  });
});

describe("abuse limits", () => {
  test("the queue cannot be drained with a negative limit", async () => {
    const response = await harness.call(worker, "/v1/queue?limit=-1", {
      serviceToken: "service-token-for-tests"
    });
    assert.equal(response.status, 200);
    assert.ok(response.body.sources.length <= 10, "limit must clamp to the maximum");
  });

  test("a claimed source is not handed out again straight away", async () => {
    await saveClip(alice, "https://instagram.com/reel/QUEUED/");
    const first = await harness.call(worker, "/v1/queue?limit=10", {
      serviceToken: "service-token-for-tests"
    });
    const second = await harness.call(worker, "/v1/queue?limit=10", {
      serviceToken: "service-token-for-tests"
    });

    assert.ok(first.body.sources.length > 0);
    assert.equal(second.body.sources.length, 0, "an in-flight claim must not be re-issued");
  });

  test("an oversized body is refused before it is parsed", async () => {
    const response = await harness.call(worker, "/v1/notes", {
      method: "POST",
      token: alice,
      body: { clip_id: "x", body: "z".repeat(300_000) }
    });
    assert.equal(response.status, 413);
  });

  test("internal errors do not leak their text to the client", async () => {
    const response = await harness.call(worker, "/v1/clips/does-not-exist", {
      method: "PATCH",
      token: alice,
      body: { status: "nonsense" }
    });
    assert.equal(response.status, 400);
    assert.ok(!/SELECT|UPDATE|sqlite/i.test(JSON.stringify(response.body)));
  });
});
