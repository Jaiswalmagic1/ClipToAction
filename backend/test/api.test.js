// Tests for the surface a green CI previously said nothing about: authentication,
// authorisation, and the boundary between one user's data and everyone else's.
//
// Findings 1, 3, 5 and 10 of the 2026-08-13 security review all lived here.

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";

import worker from "../src/worker.js";
import { createTestEnv } from "./helpers/testenv.js";

const SERVICE_TOKEN = "service-token-for-tests";

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

describe("saving settings does not silently throw the key away", () => {
  // Found by the 2026-08-21 UAT pass. The screen offers a provider AND a key box, and the
  // key is never shown back — so saving the screen to change only the provider used to
  // wipe the key with nothing on screen to say so, and every later clip quietly went
  // unsummarised. Deliberately not shaped like a real key: the CI secret scan reads this
  // file too.
  const KEY = "carols-first-key-value-not-a-real-one";
  const REPLACEMENT = "carols-second-key-value-not-a-real-one";

  const cipherFor = (user) =>
    harness.database.prepare("SELECT ai_key_cipher FROM users WHERE id = ?").get(user)
      ?.ai_key_cipher ?? null;

  const providerFor = (user) =>
    harness.database.prepare("SELECT ai_provider FROM users WHERE id = ?").get(user)
      ?.ai_provider ?? null;

  const save = async (token, body) =>
    harness.call(worker, "/v1/settings", { method: "PUT", token, body });

  let carol;

  before(async () => {
    carol = await harness.mintToken("carol");
    const stored = await save(carol, { provider: "gemini", api_key: KEY });
    assert.equal(stored.body.key_stored, true);
  });

  test("saving with no key at all keeps the key already stored", async () => {
    const before = cipherFor("carol");
    assert.ok(before, "the key should have been stored by the setup step");

    const response = await save(carol, { provider: "groq" });

    assert.equal(response.status, 200);
    assert.equal(cipherFor("carol"), before, "the stored key must be untouched");
    assert.equal(response.body.key_stored, true, "and the app must be told it is still there");
  });

  test("saving with no key still changes which AI is used", async () => {
    await save(carol, { provider: "anthropic" });
    assert.equal(providerFor("carol"), "anthropic");
  });

  test("an empty or whitespace key is treated as no key, not as a key", async () => {
    const before = cipherFor("carol");

    const blank = await save(carol, { provider: "gemini", api_key: "" });
    assert.equal(cipherFor("carol"), before);
    assert.equal(blank.body.key_stored, true);

    const spaces = await save(carol, { provider: "gemini", api_key: "   " });
    assert.equal(cipherFor("carol"), before, "whitespace must not be encrypted and stored");
    assert.equal(spaces.body.key_stored, true);
  });

  test("sending a new key replaces the old one", async () => {
    const before = cipherFor("carol");

    const response = await save(carol, { provider: "gemini", api_key: REPLACEMENT });

    assert.equal(response.body.key_stored, true);
    const after = cipherFor("carol");
    assert.notEqual(after, before, "the stored value must actually change");
    assert.ok(after && !after.includes(REPLACEMENT), "and it must not be stored in the clear");
  });

  test("choosing copy-and-paste clears the key, because none is in use", async () => {
    assert.ok(cipherFor("carol"), "there should be a key to clear");

    const response = await save(carol, { provider: "manual" });

    assert.equal(response.body.key_stored, false);
    assert.equal(cipherFor("carol"), null);
    assert.equal(providerFor("carol"), "manual");
  });

  test("one person's settings never touch another's key", async () => {
    const dave = await harness.mintToken("dave");
    await save(dave, { provider: "gemini", api_key: "daves-key-value-not-a-real-one" });
    const davesKey = cipherFor("dave");

    await save(carol, { provider: "groq", api_key: "carols-third-key-value-not-a-real-one" });

    assert.equal(cipherFor("dave"), davesKey, "Dave's key must be exactly as he left it");
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

    // The transcript endpoint now only completes a source that is actually in flight,
    // so claim it first the way the PC worker would.
    await harness.call(worker, "/v1/queue?limit=10", { serviceToken: "service-token-for-tests" });
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

    await harness.call(worker, "/v1/queue?limit=10", { serviceToken: "service-token-for-tests" });
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

describe("the download queue", () => {
  const SERVICE = "service-token-for-tests";

  // Each test here gets its own database, so counts are exact rather than "whatever
  // earlier tests happened to leave behind" — the flaw that made the first version of
  // these tests pass with the fix removed.
  async function queueHarness(sourceCount) {
    const local = await createTestEnv();
    const token = await local.mintToken("queueuser");
    for (let i = 0; i < sourceCount; i += 1) {
      await local.call(worker, "/v1/clips", {
        method: "POST",
        token,
        body: { url: `https://instagram.com/reel/Q${i}/` }
      });
    }
    return local;
  }

  test("a negative limit claims one source, not the whole queue", async () => {
    const local = await queueHarness(12);
    try {
      const response = await local.call(worker, "/v1/queue?limit=-1", { serviceToken: SERVICE });
      assert.equal(response.status, 200);
      // Unbounded would return all 12; the maximum would return 10. Only a real clamp
      // to the minimum returns 1.
      assert.equal(response.body.sources.length, 1);
    } finally {
      local.restore();
    }
  });

  test("a limit above the maximum is capped", async () => {
    const local = await queueHarness(12);
    try {
      const response = await local.call(worker, "/v1/queue?limit=999", { serviceToken: SERVICE });
      assert.equal(response.body.sources.length, 10);
    } finally {
      local.restore();
    }
  });

  test("an in-flight claim is not re-issued until its lease expires", async () => {
    const local = await queueHarness(1);
    try {
      const first = await local.call(worker, "/v1/queue?limit=10", { serviceToken: SERVICE });
      assert.equal(first.body.sources.length, 1);

      const second = await local.call(worker, "/v1/queue?limit=10", { serviceToken: SERVICE });
      assert.equal(second.body.sources.length, 0, "still leased");

      // Age the claim past the 15-minute lease.
      local.database
        .prepare("UPDATE sources SET claimed_at = ?")
        .run(Date.now() - 20 * 60 * 1000);

      const third = await local.call(worker, "/v1/queue?limit=10", { serviceToken: SERVICE });
      assert.equal(third.body.sources.length, 1, "an expired lease must be reclaimable");
      assert.equal(third.body.sources[0].attempts, 1, "attempts reflects the earlier claim");
    } finally {
      local.restore();
    }
  });

  test("a source that used up its attempts is retired with a visible error", async () => {
    const local = await queueHarness(1);
    try {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await local.call(worker, "/v1/queue?limit=10", { serviceToken: SERVICE });
        local.database
          .prepare("UPDATE sources SET claimed_at = ?")
          .run(Date.now() - 20 * 60 * 1000);
      }
      // One more poll runs the sweeper.
      await local.call(worker, "/v1/queue?limit=10", { serviceToken: SERVICE });

      const source = local.database.prepare("SELECT state, error FROM sources").get();
      assert.equal(source.state, "failed", "must not sit in 'downloading' forever");
      assert.ok(source.error, "and must carry an error the app can show");
    } finally {
      local.restore();
    }
  });

  test("a late failure cannot drag a finished reel back into the queue", async () => {
    const local = await queueHarness(1);
    try {
      await local.call(worker, "/v1/queue?limit=10", { serviceToken: SERVICE });
      const sourceId = local.database.prepare("SELECT id FROM sources").get().id;

      await local.call(worker, `/v1/sources/${sourceId}/transcript`, {
        method: "POST",
        serviceToken: SERVICE,
        body: { text: "finished by a second worker", engine: "test" }
      });

      // A stalled worker's timeout arriving after its lease expired.
      const late = await local.call(worker, `/v1/sources/${sourceId}/error`, {
        method: "POST",
        serviceToken: SERVICE,
        body: { error: "ReadTimeout" }
      });
      assert.equal(late.body.applied, false, "a stale failure must be ignored");

      const source = local.database.prepare("SELECT state, error FROM sources").get();
      assert.equal(source.state, "transcribed");
      assert.equal(source.error, null, "and must not put an error on a completed reel");
    } finally {
      local.restore();
    }
  });
});

describe("abuse limits", () => {
  test("an oversized body is refused before it is parsed", async () => {
    const response = await harness.call(worker, "/v1/notes", {
      method: "POST",
      token: alice,
      body: { clip_id: "x", body: "z".repeat(300_000) }
    });
    assert.equal(response.status, 413);
  });

  test("a malformed body is a 400, not a 413 or a 500", async () => {
    const response = await worker.fetch(
      new Request("https://api.test/v1/notes", {
        method: "POST",
        headers: { Authorization: `Bearer ${alice}`, "Content-Type": "application/json" },
        body: "{not json"
      }),
      harness.env
    );
    assert.equal(response.status, 400);
  });

  test("the daily save cap holds", async () => {
    const local = await createTestEnv();
    const token = await local.mintToken("prolific");
    try {
      let lastStatus = 0;
      for (let i = 0; i < 201; i += 1) {
        const response = await local.call(worker, "/v1/clips", {
          method: "POST",
          token,
          body: { url: `https://instagram.com/reel/CAP${i}/` }
        });
        lastStatus = response.status;
      }
      assert.equal(lastStatus, 429, "the 201st save in a day must be refused");
    } finally {
      local.restore();
    }
  });

  test("an internal fault returns a generic message, never SQL", async () => {
    const local = await createTestEnv();
    const token = await local.mintToken("alice");
    try {
      const saved = await local.call(worker, "/v1/clips", {
        method: "POST",
        token,
        body: { url: "https://instagram.com/reel/BOOM/" }
      });

      // Force a real database fault on the next write so the catch-all is genuinely
      // exercised — the previous version of this test never reached it.
      local.database.exec("DROP TABLE notes");

      const response = await local.call(worker, "/v1/notes", {
        method: "POST",
        token,
        body: { clip_id: saved.body.clip.id, body: "this write will fault" }
      });

      assert.equal(response.status, 500);
      assert.equal(response.body.error, "Something went wrong.");
      assert.ok(!/SELECT|INSERT|sqlite|notes/i.test(JSON.stringify(response.body)));
    } finally {
      local.restore();
    }
  });
});
