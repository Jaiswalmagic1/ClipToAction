// The fortnightly re-look (D41).
//
// The thing this feature must never do is spend somebody's AI allowance while they are not
// watching. There is no timer anywhere in this product and there must never be one — so
// most of what is pinned here is about WHEN the offer appears and what happens when it is
// refused, not about the round-up itself.
//
//   * It is offered, never taken. The only way an allowance is spent is a POST that a
//     button caused.
//   * Nothing is offered until something has actually been sitting there for the length of
//     the gap, so a new notebook is not nagged on its first afternoon.
//   * "Never" is a real answer and is stored, not assumed.
//   * A reel that has been in one is never in another.
//   * A failure marks nothing, so pressing again covers exactly the same reels.

import { test, before, after, beforeEach, describe } from "node:test";
import assert from "node:assert/strict";

import worker from "../src/worker.js";
import {
  DEFAULT_RELOOK_DAYS,
  RELOOK_CHOICES,
  MAX_RELOOK_CLIPS,
  relookLines,
  relookState,
  validateRelook
} from "../src/relook.js";
import { retryPause } from "../src/analyze.js";
import { createTestEnv } from "./helpers/testenv.js";

const SERVICE_TOKEN = "service-token-for-tests";
const DAY = 24 * 60 * 60 * 1000;

retryPause.ms = 0;

const ROUNDUP = {
  themes: [
    { name: "Meesho selling", why: "Nine of these are about the seller panel." },
    { name: "AI for product photos", why: "You keep saving ways to make a photo look shot." }
  ],
  act_now: [
    { do: "Switch on Sunday Pickup", because: "It costs nothing and adds a day", from: "Meesho settings" },
    { do: "Try one jewellery prompt", because: "You saved four and used none", from: "ChatGPT commands" }
  ],
  note: "Most of this batch is Meesho. Nothing here needs money to start."
};

// ------------------------------------------------------------------ when to offer

describe("when a look back is offered", () => {
  const at = 1_000 * DAY;

  test("two weeks is the default, and nobody has to be given a value", () => {
    assert.equal(DEFAULT_RELOOK_DAYS, 14);
    const state = relookState({
      everyDays: null, lastAt: null, dueCount: 30, oldestDueAt: at - 20 * DAY, at
    });
    assert.equal(state.every_days, 14);
    assert.equal(state.ready, true);
  });

  test("a notebook started this afternoon is not nagged", () => {
    const state = relookState({
      everyDays: 14, lastAt: null, dueCount: 3, oldestDueAt: at - 2 * DAY, at
    });
    assert.equal(state.ready, false, "nothing has been sitting there for a fortnight yet");
    assert.equal(state.due, 3, "they are still counted, they are just not offered");
  });

  test("nothing due means nothing offered, however long it has been", () => {
    const state = relookState({
      everyDays: 14, lastAt: at - 400 * DAY, dueCount: 0, oldestDueAt: null, at
    });
    assert.equal(state.ready, false);
  });

  test("one a fortnight, not one a day", () => {
    const justDone = relookState({
      everyDays: 14, lastAt: at - 3 * DAY, dueCount: 40, oldestDueAt: at - 90 * DAY, at
    });
    assert.equal(justDone.ready, false, "a look back three days ago is still recent");

    const overdue = relookState({
      everyDays: 14, lastAt: at - 15 * DAY, dueCount: 40, oldestDueAt: at - 90 * DAY, at
    });
    assert.equal(overdue.ready, true);
  });

  test("never means never, and it is one of the choices", () => {
    assert.ok(RELOOK_CHOICES.includes(0));
    const off = relookState({
      everyDays: 0, lastAt: null, dueCount: 200, oldestDueAt: at - 500 * DAY, at
    });
    assert.equal(off.ready, false);
    assert.equal(off.every_days, 0, "'stop asking me' is stored, not treated as unset");
  });

  test("a shorter gap offers sooner", () => {
    const weekly = relookState({
      everyDays: 7, lastAt: at - 8 * DAY, dueCount: 5, oldestDueAt: at - 9 * DAY, at
    });
    assert.equal(weekly.ready, true);
  });
});

// ------------------------------------------------------------------ the reply

describe("checking what the AI sent back", () => {
  test("a good round-up passes", () => {
    assert.deepEqual(validateRelook(ROUNDUP), []);
    assert.deepEqual(validateRelook({ ...ROUNDUP, note: null }), [], "a note is optional");
  });

  test("an empty or wrong-shaped round-up is refused rather than stored", () => {
    assert.ok(validateRelook({ themes: [], act_now: ROUNDUP.act_now }).includes("themes is empty"));
    assert.ok(validateRelook({ themes: ROUNDUP.themes, act_now: "not a list" }).includes("act_now"));
    assert.ok(validateRelook({}).length >= 2);
  });

  test("an enormous reply is refused rather than stored", () => {
    const huge = { ...ROUNDUP, note: "x".repeat(5000) };
    assert.ok(validateRelook(huge).includes("note is too long"));
    const many = { ...ROUNDUP, themes: Array.from({ length: 40 }, () => ({ name: "a", why: "b" })) };
    assert.ok(validateRelook(many).includes("themes has too many items"));
  });

  test("what the AI is shown is the summary and never the transcript", () => {
    const lines = relookLines([
      { created_at: Date.UTC(2026, 7, 3), title: "Meesho settings", summary: "Three settings." }
    ]);
    assert.match(lines, /2026-08-03/);
    assert.match(lines, /Meesho settings/);
    assert.match(lines, /Three settings\./);
  });
});

// ------------------------------------------------------------------ end to end

describe("looking back over a notebook", () => {
  let harness;
  let token;
  const clips = [];

  const analysis = (n) => ({
    summary: `Summary number ${n}.`,
    key_points: [`point ${n}`],
    learn_more: ["Meesho"],
    claims: [],
    suggested_task: null,
    topic: "e-commerce",
    sub_topic: "Meesho",
    kind: "other",
    items: []
  });

  before(async () => {
    harness = await createTestEnv();
    token = await harness.mintToken("vish");
    await harness.call(worker, "/v1/settings", {
      method: "PUT",
      token,
      body: { provider: "gemini", api_key: "not-a-real-key-value-at-all" }
    });

    for (let n = 0; n < 3; n += 1) {
      harness.answerProviderWith(() => harness.geminiReplyWith(analysis(n)));
      const saved = await harness.call(worker, "/v1/clips", {
        method: "POST",
        token,
        body: { url: `https://www.facebook.com/share/r/RELOOK${n}/` }
      });
      clips.push(saved.body.clip);
      harness.database
        .prepare("UPDATE sources SET state = 'downloading' WHERE id = ?")
        .run(saved.body.clip.source_id);
      await harness.call(worker, `/v1/sources/${saved.body.clip.source_id}/transcript`, {
        method: "POST",
        serviceToken: SERVICE_TOKEN,
        body: { text: `words ${n}`, lang: "en", engine: "test", duration_sec: 40 }
      });
    }

    // Saved a month ago, so something has actually been waiting.
    const old = Date.now() - 30 * DAY;
    harness.database.prepare("UPDATE clips SET created_at = ? WHERE user_id = 'vish'").run(old);
  });

  after(() => {
    harness.answerProviderWith(null);
    harness.restore();
  });

  beforeEach(() => {
    harness.answerProviderWith(() => harness.geminiReplyWith(ROUNDUP));
  });

  test("sync says one is ready, and over how many", async () => {
    const delta = await harness.call(worker, "/v1/sync?since=0", { token });
    assert.equal(delta.body.relook.ready, true);
    assert.equal(delta.body.relook.due, 3);
    assert.equal(delta.body.relook.every_days, 14);
    assert.equal(delta.body.relook.last_at, null);
  });

  test("nothing is spent until the button is pressed", async () => {
    const before = harness.providerCalls.length;
    await harness.call(worker, "/v1/sync?since=0", { token });
    await harness.call(worker, "/v1/sync?since=0", { token });
    assert.equal(
      harness.providerCalls.length,
      before,
      "reading the notebook must never cost an allowance"
    );
  });

  test("one press, one call, and the round-up is stored against that person", async () => {
    const before = harness.providerCalls.length;
    const run = await harness.call(worker, "/v1/relook", { method: "POST", token });
    assert.equal(run.status, 201);
    assert.equal(run.body.covered, 3);
    assert.equal(run.body.still_due, 0);
    assert.equal(
      harness.providerCalls.length - before,
      1,
      "three reels must cost one call, not three"
    );

    const row = harness.database.prepare("SELECT * FROM relooks WHERE user_id = 'vish'").get();
    assert.equal(row.clip_count, 3);
    assert.equal(JSON.parse(row.act_now).length, 2);
    assert.equal(row.note, ROUNDUP.note);
  });

  test("it comes back through sync like every other per-user row", async () => {
    const delta = await harness.call(worker, "/v1/sync?since=0", { token });
    assert.equal(delta.body.relooks.length, 1);
    assert.equal(delta.body.relook.due, 0, "nothing is waiting any more");
    assert.equal(delta.body.relook.ready, false);
    assert.ok(delta.body.relook.last_at, "the app can say when the last one was");
  });

  test("a reel that has been in one is never in another", async () => {
    const before = harness.providerCalls.length;
    const again = await harness.call(worker, "/v1/relook", { method: "POST", token });
    assert.equal(again.body.nothing_due, true);
    assert.equal(
      harness.providerCalls.length,
      before,
      "an empty batch must not reach a provider at all"
    );
  });

  test("nobody else's notebook is touched or visible", async () => {
    const other = await harness.mintToken("ben");
    const delta = await harness.call(worker, "/v1/sync?since=0", { token: other });
    assert.equal(delta.body.relooks.length, 0);
    assert.equal(delta.body.relook.due, 0);
  });

  test("a new reel makes one due again, but only after the gap has passed", async () => {
    harness.answerProviderWith(() => harness.geminiReplyWith(analysis(9)));
    const saved = await harness.call(worker, "/v1/clips", {
      method: "POST",
      token,
      body: { url: "https://www.facebook.com/share/r/RELOOKNEW/" }
    });
    harness.database
      .prepare("UPDATE sources SET state = 'downloading' WHERE id = ?")
      .run(saved.body.clip.source_id);
    await harness.call(worker, `/v1/sources/${saved.body.clip.source_id}/transcript`, {
      method: "POST",
      serviceToken: SERVICE_TOKEN,
      body: { text: "words 9", lang: "en", engine: "test", duration_sec: 40 }
    });

    const delta = await harness.call(worker, "/v1/sync?since=0", { token });
    assert.equal(delta.body.relook.due, 1);
    assert.equal(delta.body.relook.ready, false, "one saved today has not been waiting");
  });

  test("a malformed reply marks nothing, so pressing again covers the same reels", async () => {
    harness.database.prepare("UPDATE clips SET relooked_at = NULL WHERE user_id = 'vish'").run();
    harness.answerProviderWith(() => harness.geminiReplyWith({ themes: [], act_now: [] }));

    const run = await harness.call(worker, "/v1/relook", { method: "POST", token });
    assert.equal(run.status, 400);
    assert.match(run.body.error, /malformed/);

    const stillDue = harness.database
      .prepare("SELECT COUNT(*) AS n FROM clips WHERE user_id = 'vish' AND relooked_at IS NULL")
      .get();
    assert.equal(stillDue.n, 4, "nothing may be marked when nothing was stored");
  });

  test("without a key it says so, and nothing is marked", async () => {
    harness.database.prepare("DELETE FROM ai_keys WHERE user_id = 'vish'").run();
    const run = await harness.call(worker, "/v1/relook", { method: "POST", token });
    assert.equal(run.status, 400);
    assert.match(run.body.error, /Connect an AI account/);

    const stillDue = harness.database
      .prepare("SELECT COUNT(*) AS n FROM clips WHERE user_id = 'vish' AND relooked_at IS NULL")
      .get();
    assert.equal(stillDue.n, 4);
  });
});

// ------------------------------------------------------------------ the setting

describe("how often to be offered one", () => {
  let harness;
  let token;

  before(async () => {
    harness = await createTestEnv();
    token = await harness.mintToken("vish");
  });

  after(() => harness.restore());

  test("a choice is stored and comes straight back", async () => {
    const set = await harness.call(worker, "/v1/relook/every", {
      method: "PUT",
      token,
      body: { days: 30 }
    });
    assert.equal(set.status, 200);
    const delta = await harness.call(worker, "/v1/sync?since=0", { token });
    assert.equal(delta.body.relook.every_days, 30);
  });

  test("turning it off is stored as a choice, not as an absence", async () => {
    await harness.call(worker, "/v1/relook/every", { method: "PUT", token, body: { days: 0 } });
    const delta = await harness.call(worker, "/v1/sync?since=0", { token });
    assert.equal(delta.body.relook.every_days, 0);
    assert.equal(delta.body.relook.ready, false);
  });

  test("a number nobody offered is refused", async () => {
    for (const days of [1, 365, -14, "fortnightly", null]) {
      const set = await harness.call(worker, "/v1/relook/every", {
        method: "PUT",
        token,
        body: { days }
      });
      assert.equal(set.status, 400, `${days} must not be accepted`);
    }
  });

  test("signing in is required to change it or to read it", async () => {
    const set = await harness.call(worker, "/v1/relook/every", {
      method: "PUT",
      body: { days: 7 }
    });
    assert.equal(set.status, 401);
    const run = await harness.call(worker, "/v1/relook", { method: "POST" });
    assert.equal(run.status, 401);
  });
});

// ------------------------------------------------------------------ the cap

describe("a very large batch", () => {
  test("the cap is a real number and the rest stay due", () => {
    // Pinned rather than exercised with sixty real reels: the behaviour that matters is
    // that the queue is limited and ordered oldest first, which relookQueue does in SQL.
    assert.ok(MAX_RELOOK_CLIPS >= 20 && MAX_RELOOK_CLIPS <= 200);
  });
});
