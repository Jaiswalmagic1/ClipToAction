// Whether the PC worker is running has to reach the app.
//
// This is Golden Rule 29 pointed at the worker itself. A dead worker is otherwise the most
// silent failure in the whole product: reels sit in 'pending' for ever, every clip shows
// "waiting", and nothing anywhere says the machine that does the work is switched off.
//
// The heartbeat is the queue call the worker already makes every 30 seconds. These tests
// pin that it is recorded even when there is no work, that a stale one reads as stopped,
// and that nothing about the machine itself leaks to the app.

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";

import worker from "../src/worker.js";
import { createTestEnv } from "./helpers/testenv.js";

const SERVICE_TOKEN = "service-token-for-tests";

describe("the app can tell whether the PC worker is running", () => {
  let harness;
  let ann;

  const workerRow = () => harness.database.prepare("SELECT * FROM workers").get();

  const syncWorker = async () => {
    const response = await harness.call(worker, "/v1/sync", { token: ann });
    assert.equal(response.status, 200);
    return response.body.worker;
  };

  const checkIn = async () => {
    const response = await harness.call(worker, "/v1/queue", { serviceToken: SERVICE_TOKEN });
    assert.equal(response.status, 200);
  };

  before(async () => {
    harness = await createTestEnv();
    ann = await harness.mintToken("ann");
  });

  after(() => harness.restore());

  test("before it has ever run, the app is told plainly rather than guessing", async () => {
    const state = await syncWorker();

    assert.equal(state.running, false);
    assert.equal(state.last_seen_at, null, "never run is not the same as run long ago");
  });

  test("asking for work counts as checking in, even when there is no work", async () => {
    assert.equal(workerRow(), undefined, "nothing recorded yet");

    await checkIn();

    const row = workerRow();
    assert.ok(row, "an empty queue call is still a heartbeat — that is the normal case");
    assert.ok(Date.now() - row.last_seen_at < 5000);
  });

  test("a fresh check-in reads as running", async () => {
    await checkIn();
    const state = await syncWorker();

    assert.equal(state.running, true);
    assert.ok(state.last_seen_at > 0);
  });

  test("one row however many times it checks in", async () => {
    await checkIn();
    await checkIn();
    await checkIn();

    const rows = harness.database.prepare("SELECT COUNT(*) AS n FROM workers").get();
    assert.equal(rows.n, 1, "a heartbeat every 30 seconds must not grow the database");
  });

  test("gone quiet reads as stopped, and still says when it was last seen", async () => {
    const longAgo = Date.now() - 6 * 60 * 1000;
    harness.database.prepare("UPDATE workers SET last_seen_at = ?").run(longAgo);

    const state = await syncWorker();

    assert.equal(state.running, false, "six minutes of silence is not running");
    assert.equal(state.last_seen_at, longAgo, "when it was last seen is what makes it useful");
  });

  test("a brief gap is not reported as an outage", async () => {
    harness.database.prepare("UPDATE workers SET last_seen_at = ?").run(Date.now() - 60 * 1000);

    assert.equal((await syncWorker()).running, true, "one slow minute is not a dead worker");
  });

  test("nothing about the machine itself reaches the app", async () => {
    await checkIn();
    const response = await harness.call(worker, "/v1/sync", { token: ann });
    const state = response.body.worker;

    assert.deepEqual(
      Object.keys(state).sort(),
      ["busy", "last_seen_at", "running"],
      "the worker is somebody's home PC — no hostname, no address, no token"
    );
    assert.doesNotMatch(JSON.stringify(response.body), /service-token-for-tests/);
  });

  test("every signed-in person is told, not just the one who owns the reels", async () => {
    await checkIn();
    const bob = await harness.mintToken("bob");
    const response = await harness.call(worker, "/v1/sync", { token: bob });

    assert.equal(response.body.worker.running, true, "when it is off, nobody's reels move");
  });

  test("signing in is still required to be told anything", async () => {
    const response = await harness.call(worker, "/v1/sync");
    assert.equal(response.status, 401);
  });

  test("the app cannot fake a heartbeat with a user's token", async () => {
    const before = workerRow().last_seen_at;
    const response = await harness.call(worker, "/v1/queue", { token: ann });

    assert.equal(response.status, 401, "the queue is the PC worker's, not the app's");
    assert.equal(workerRow().last_seen_at, before, "a refused call must not look like a check-in");
  });
});

describe("a machine in the middle of a long video is not reported as off", () => {
  // It asks for work, then transcribes the whole batch before asking again — and that
  // takes about six tenths of the video's length. So ANY video over about fourteen minutes
  // made the app announce the machine was off, mid-job, while a card six lines below said
  // "being watched now". His ordinary saves are eleven to eighteen minutes.
  //
  // The damage is what the sentence causes: he reads "off", restarts the machine, and
  // kills a transcription that was hours in.
  let harness;
  let token;

  before(async () => {
    harness = await createTestEnv();
    token = await harness.mintToken("vish");
  });
  after(() => harness.restore());

  test("a claim it still holds counts as being alive", async () => {
    const saved = await harness.call(worker, "/v1/clips", {
      method: "POST",
      token,
      body: { url: "https://www.instagram.com/reel/ALONGONE/" }
    });
    const sourceId = saved.body.clip.source_id;
    harness.database
      .prepare("UPDATE sources SET duration_sec = ? WHERE id = ?")
      .run(90 * 60, sourceId);

    // It takes the work on, and then says nothing for an hour because it is busy.
    await harness.call(worker, "/v1/queue?limit=3", {
      method: "GET",
      serviceToken: SERVICE_TOKEN
    });
    const anHourAgo = Date.now() - 60 * 60 * 1000;
    harness.database.prepare("UPDATE workers SET last_seen_at = ?").run(anHourAgo);

    const state = (await harness.call(worker, "/v1/sync", { token })).body.worker;
    assert.equal(state.running, true, "it was called off while it was working");
    assert.equal(state.busy, true, "and nothing says what it is doing instead");
  });

  test("but a machine holding nothing, and silent, is off", async () => {
    harness.database
      .prepare("UPDATE sources SET state = 'transcribed', claimed_at = NULL")
      .run();
    harness.database.prepare("UPDATE workers SET last_seen_at = ?").run(Date.now() - 60 * 60 * 1000);

    const state = (await harness.call(worker, "/v1/sync", { token })).body.worker;
    assert.equal(state.running, false, "a machine that is off is reported as running");
    assert.equal(state.busy, false);
  });

  test("and a claim whose lease has expired does not keep it alive for ever", async () => {
    const saved = await harness.call(worker, "/v1/clips", {
      method: "POST",
      token,
      body: { url: "https://www.instagram.com/reel/ADEADONE/" }
    });
    harness.database
      .prepare("UPDATE sources SET state = 'downloading', claimed_at = ? WHERE id = ?")
      .run(Date.now() - 10 * 24 * 60 * 60 * 1000, saved.body.clip.source_id);

    const state = (await harness.call(worker, "/v1/sync", { token })).body.worker;
    assert.equal(state.running, false, "a machine that died mid-job is reported as working");
  });
});
