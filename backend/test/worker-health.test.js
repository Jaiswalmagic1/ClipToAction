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
      ["last_seen_at", "running"],
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
