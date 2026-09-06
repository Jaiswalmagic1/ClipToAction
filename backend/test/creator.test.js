// Who made the video, and searching by them (D40).
//
// Two halves. New videos carry the creator in with the transcript. The 212 already saved
// are filled in slowly afterwards from metadata alone — and the risk in that half is not
// correctness, it is being rate-limited by Facebook or Instagram, which would cost
// transcription and not just this. So what the API has to guarantee is that the backfill
// queue is small, ordered, and finite.
//
//   * A creator is a fact about the video, so it is on the shared row and only the Worker
//     writes it (D10, D18).
//   * A video the platform will not name leaves the queue anyway, or the worker asks
//     about it on every poll for ever.
//   * Reporting a creator can never move a video's state, its error or its transcript —
//     it runs over reels that are already finished.
//   * Nothing about this is reachable without the service token.

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";

import worker, { cleanCreator } from "../src/worker.js";
import { createTestEnv } from "./helpers/testenv.js";

const SERVICE_TOKEN = "service-token-for-tests";

describe("a creator name, as it is stored", () => {
  test("whitespace is flattened and an empty name is nobody", () => {
    assert.equal(cleanCreator("  Rumee   Jewellery \n"), "Rumee Jewellery");
    assert.equal(cleanCreator(""), null);
    assert.equal(cleanCreator("   "), null);
    assert.equal(cleanCreator(null), null);
    assert.equal(cleanCreator(undefined), null);
  });

  test("an absurd value is cut rather than stored whole", () => {
    assert.equal(cleanCreator("x".repeat(9000)).length, 200);
  });
});

describe("who made it", () => {
  let harness;
  let token;
  let clip;

  before(async () => {
    harness = await createTestEnv();
    token = await harness.mintToken("vish");
    const saved = await harness.call(worker, "/v1/clips", {
      method: "POST",
      token,
      body: { url: "https://www.facebook.com/share/r/WHOMADEIT/" }
    });
    clip = saved.body.clip;
  });

  after(() => harness.restore());

  test("it arrives with the transcript and is shared like the rest of the row", async () => {
    harness.database.prepare("UPDATE sources SET state = 'downloading' WHERE id = ?").run(clip.source_id);
    const posted = await harness.call(worker, `/v1/sources/${clip.source_id}/transcript`, {
      method: "POST",
      serviceToken: SERVICE_TOKEN,
      body: {
        text: "three settings",
        lang: "en",
        engine: "test",
        title: "Meesho settings",
        duration_sec: 45,
        creator: "  Ecom Guruji  "
      }
    });
    assert.equal(posted.status, 200);

    const row = harness.database
      .prepare("SELECT creator, creator_checked_at, title FROM sources WHERE id = ?")
      .get(clip.source_id);
    assert.equal(row.creator, "Ecom Guruji");
    assert.ok(row.creator_checked_at, "arriving with the transcript counts as having looked");
  });

  test("the app is told, through the same sync as everything else", async () => {
    const delta = await harness.call(worker, "/v1/sync?since=0", { token });
    const source = delta.body.sources.find((row) => row.id === clip.source_id);
    assert.equal(source.creator, "Ecom Guruji");
  });

  test("nobody else's notebook gains the row, only the shared fact", async () => {
    const ben = await harness.mintToken("ben");
    const delta = await harness.call(worker, "/v1/sync?since=0", { token: ben });
    assert.equal(delta.body.sources.length, 0, "a shared fact is not a shared clip");
  });
});

describe("filling in the ones already saved", () => {
  let harness;
  let token;
  const ids = [];

  before(async () => {
    harness = await createTestEnv();
    token = await harness.mintToken("vish");
    for (let n = 0; n < 3; n += 1) {
      const saved = await harness.call(worker, "/v1/clips", {
        method: "POST",
        token,
        body: { url: `https://www.facebook.com/share/r/OLD${n}/` }
      });
      ids.push(saved.body.clip.source_id);
    }
  });

  after(() => harness.restore());

  test("the worker is told which ones still need one, and how many are left", async () => {
    const queue = await harness.call(worker, "/v1/creators?limit=2", { serviceToken: SERVICE_TOKEN });
    assert.equal(queue.status, 200);
    assert.equal(queue.body.sources.length, 2, "a few at a time, never the whole notebook");
    assert.equal(queue.body.remaining, 3);
    assert.ok(queue.body.sources[0].url_original, "the worker needs the address to look it up");
    assert.equal(queue.body.sources[0].creator, undefined, "only what it needs is sent");
  });

  test("a name is stored, and that video leaves the queue", async () => {
    const stored = await harness.call(worker, `/v1/sources/${ids[0]}/creator`, {
      method: "POST",
      serviceToken: SERVICE_TOKEN,
      body: { creator: "Rumee Jewellery" }
    });
    assert.equal(stored.status, 200);

    const queue = await harness.call(worker, "/v1/creators?limit=10", { serviceToken: SERVICE_TOKEN });
    assert.equal(queue.body.remaining, 2);
    assert.ok(!queue.body.sources.some((row) => row.id === ids[0]));
  });

  test("a video the platform will not name also leaves the queue", async () => {
    // This is the case that makes the difference between a backfill that ends and one
    // that asks a rate-limiting platform the same question every thirty seconds for ever.
    const stored = await harness.call(worker, `/v1/sources/${ids[1]}/creator`, {
      method: "POST",
      serviceToken: SERVICE_TOKEN,
      body: { creator: null }
    });
    assert.equal(stored.status, 200);
    assert.equal(stored.body.creator, null);

    const queue = await harness.call(worker, "/v1/creators?limit=10", { serviceToken: SERVICE_TOKEN });
    assert.equal(queue.body.remaining, 1);
    assert.ok(!queue.body.sources.some((row) => row.id === ids[1]));

    const row = harness.database.prepare("SELECT creator FROM sources WHERE id = ?").get(ids[1]);
    assert.equal(row.creator, null, "nobody named is stored as nobody, never as a guess");
  });

  test("it cannot move a video's state, its error or its transcript", async () => {
    harness.database
      .prepare("UPDATE sources SET state = 'analyzed', error = 'an old failure' WHERE id = ?")
      .run(ids[2]);

    await harness.call(worker, `/v1/sources/${ids[2]}/creator`, {
      method: "POST",
      serviceToken: SERVICE_TOKEN,
      body: { creator: "Someone" }
    });

    const row = harness.database
      .prepare("SELECT state, error, attempts, claimed_at FROM sources WHERE id = ?")
      .get(ids[2]);
    assert.equal(row.state, "analyzed", "a finished video must stay finished");
    assert.equal(row.error, "an old failure", "an error it already carried is not cleared");
  });

  test("a video that does not exist is a plain 404", async () => {
    const stored = await harness.call(worker, "/v1/sources/no-such-id/creator", {
      method: "POST",
      serviceToken: SERVICE_TOKEN,
      body: { creator: "Someone" }
    });
    assert.equal(stored.status, 404);
  });

  test("none of it is reachable without the service token", async () => {
    const queue = await harness.call(worker, "/v1/creators", {});
    assert.equal(queue.status, 401);

    // A signed-in person's own token is not a service token: the shared row is written by
    // the Worker on the PC worker's behalf and by nobody else (D18).
    const asUser = await harness.call(worker, "/v1/creators", { token });
    assert.equal(asUser.status, 401);

    const stored = await harness.call(worker, `/v1/sources/${ids[0]}/creator`, {
      method: "POST",
      token,
      body: { creator: "Somebody Else" }
    });
    assert.equal(stored.status, 401);
    const row = harness.database.prepare("SELECT creator FROM sources WHERE id = ?").get(ids[0]);
    assert.equal(row.creator, "Rumee Jewellery", "a signed-in user cannot rewrite a shared fact");
  });
});
