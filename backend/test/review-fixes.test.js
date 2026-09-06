// What the independent review found, pinned so it cannot come back.
//
// Every test here exists because a reviewer who did not write this code proved a failure
// against the real Worker. They are gathered in one file on purpose: each one is a lesson
// about a different way this product can quietly do the wrong thing, and reading them
// together is more use than finding them scattered.

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";

import worker from "../src/worker.js";
import { MAX_TRANSCRIPT_CHARS, MAX_VIDEO_SEC, CHARS_PER_SEC } from "../src/longvideo.js";
import { retryPause } from "../src/analyze.js";
import { createTestEnv } from "./helpers/testenv.js";

const SERVICE_TOKEN = "service-token-for-tests";
retryPause.ms = 0;

const ANALYSIS = {
  summary: "A long talk about selling online.",
  key_points: [],
  learn_more: [],
  claims: [],
  suggested_task: null,
  topic: "e-commerce",
  sub_topic: null,
  kind: "other",
  items: []
};

async function saveAndClaim(harness, token, name) {
  const saved = await harness.call(worker, "/v1/clips", {
    method: "POST",
    token,
    body: { url: `https://www.facebook.com/share/r/${name}/` }
  });
  harness.database
    .prepare("UPDATE sources SET state = 'downloading' WHERE id = ?")
    .run(saved.body.clip.source_id);
  return saved.body.clip;
}

// ------------------------------------------------------------------ the body cap

describe("a six-hour transcript can actually be posted", () => {
  let harness;
  let token;
  let clip;

  before(async () => {
    harness = await createTestEnv();
    token = await harness.mintToken("vish");
    clip = await saveAndClaim(harness, token, "AVERYLONGONE");
  });
  after(() => harness.restore());

  test("the longest allowed video fits inside the body the Worker will accept", async () => {
    // D42 raised the ceiling to six hours and the transcript limit to 400,000 characters —
    // and left the general body cap at 256KB, which is about 4.8 hours. So a five-hour
    // video would have been REFUSED AS TOO LARGE after his PC had already spent three
    // hours making the transcript, and reported to him as "could not reach ClipToAction".
    // Exactly the failure D42 says it fixed, one step further along.
    const words = "the price is fixed and the margin is thin. ";
    const text = words.repeat(Math.ceil((MAX_VIDEO_SEC * CHARS_PER_SEC) / words.length));
    assert.ok(text.length > 300000, "this test is not testing what it thinks it is");
    assert.ok(text.length < MAX_TRANSCRIPT_CHARS, "and it is inside the stated limit");

    const posted = await harness.call(worker, `/v1/sources/${clip.source_id}/transcript`, {
      method: "POST",
      serviceToken: SERVICE_TOKEN,
      body: { text, lang: "en", engine: "test", duration_sec: MAX_VIDEO_SEC }
    });
    assert.equal(posted.status, 200, "a transcript inside the stated limit was refused");

    const row = harness.database
      .prepare("SELECT state FROM sources WHERE id = ?")
      .get(clip.source_id);
    assert.equal(row.state, "transcribed");
  });

  test("a transcript past the stated limit is still refused, and says so", async () => {
    const other = await saveAndClaim(harness, token, "PASTTHELIMIT");
    const posted = await harness.call(worker, `/v1/sources/${other.source_id}/transcript`, {
      method: "POST",
      serviceToken: SERVICE_TOKEN,
      body: { text: "x".repeat(MAX_TRANSCRIPT_CHARS + 1), lang: "en", engine: "test" }
    });
    assert.equal(posted.status, 400);
    assert.match(posted.body.error, /too long/);
  });

  test("an ordinary request is still capped at the smaller size", async () => {
    const posted = await harness.call(worker, "/v1/notes", {
      method: "POST",
      token,
      body: { clip_id: clip.id, body: "x".repeat(300000) }
    });
    assert.equal(posted.status, 413, "the raised cap must apply to transcripts and nothing else");
  });
});

// ------------------------------------------------------------------ approver pays

describe("approving a long video you cannot pay for", () => {
  let harness;
  let alice;
  let bob;
  let bobsClip;
  let sourceId;

  before(async () => {
    harness = await createTestEnv();
    alice = await harness.mintToken("alice");
    bob = await harness.mintToken("bob");
    await harness.call(worker, "/v1/settings", {
      method: "PUT",
      token: alice,
      body: { provider: "gemini", api_key: "alices-key-value-not-real" }
    });

    await saveAndClaim(harness, alice, "SHAREDLONG");
    const source = harness.database
      .prepare("SELECT * FROM sources WHERE url_canonical LIKE ?")
      .get("%SHAREDLONG%");
    sourceId = source.id;

    const bobSaved = await harness.call(worker, "/v1/clips", {
      method: "POST",
      token: bob,
      body: { url: "https://www.facebook.com/share/r/SHAREDLONG/" }
    });
    bobsClip = bobSaved.body.clip;

    await harness.call(worker, `/v1/sources/${sourceId}/too-long`, {
      method: "POST",
      serviceToken: SERVICE_TOKEN,
      body: { duration_sec: 69 * 60 }
    });
  });

  after(() => {
    harness.answerProviderWith(null);
    harness.restore();
  });

  test("Bob has no key, and approves it anyway", async () => {
    const approved = await harness.call(worker, `/v1/clips/${bobsClip.id}/long-ok`, {
      method: "POST",
      token: bob
    });
    assert.equal(approved.status, 200);
    assert.equal(
      harness.database.prepare("SELECT long_ok_by FROM sources WHERE id = ?").get(sourceId).long_ok_by,
      "bob"
    );
  });

  test("an hour of his PC is not thrown away — it falls back to whoever can pay", async () => {
    // "Whoever says yes pays" is a rule about who SHOULD pay, not a reason to strand a
    // video. Without the fallback the source sat at 'transcribed' with no error for ever
    // while Alice's working key went unused, and nothing on screen said why.
    harness.answerProviderWith(() => harness.geminiReplyWith(ANALYSIS));
    harness.database.prepare("UPDATE sources SET state = 'downloading' WHERE id = ?").run(sourceId);

    await harness.call(worker, `/v1/sources/${sourceId}/transcript`, {
      method: "POST",
      serviceToken: SERVICE_TOKEN,
      body: { text: "an hour of talk", lang: "en", engine: "test", duration_sec: 69 * 60 }
    });

    const row = harness.database
      .prepare("SELECT state FROM sources WHERE id = ?")
      .get(sourceId);
    assert.equal(row.state, "analyzed", "the video must not be stranded at 'transcribed'");

    const used = harness.providerCalls.at(-1);
    assert.match(
      used.options.headers["x-goog-api-key"],
      /alices-key-value-not-real/,
      "the only key that could pay is the one that should have been used"
    );
  });
});

// ------------------------------------------------------------------ nobody's uid travels

describe("what the shared row is allowed to tell you about other people", () => {
  let harness;
  let alice;
  let bob;

  before(async () => {
    harness = await createTestEnv();
    alice = await harness.mintToken("alice");
    bob = await harness.mintToken("bob");

    await saveAndClaim(harness, alice, "WHOAPPROVED");
    const source = harness.database
      .prepare("SELECT * FROM sources WHERE url_canonical LIKE ?")
      .get("%WHOAPPROVED%");

    const bobSaved = await harness.call(worker, "/v1/clips", {
      method: "POST",
      token: bob,
      body: { url: "https://www.facebook.com/share/r/WHOAPPROVED/" }
    });

    await harness.call(worker, `/v1/sources/${source.id}/too-long`, {
      method: "POST",
      serviceToken: SERVICE_TOKEN,
      body: { duration_sec: 69 * 60 }
    });
    await harness.call(worker, `/v1/clips/${bobSaved.body.clip.id}/long-ok`, {
      method: "POST",
      token: bob
    });
  });
  after(() => harness.restore());

  test("Alice is never handed Bob's account id", async () => {
    const delta = await harness.call(worker, "/v1/sync?since=0", { token: alice });
    const source = delta.body.sources.find((row) => row.url_canonical.includes("WHOAPPROVED"));
    assert.ok(source, "she still sees the reel she saved");
    assert.equal(
      "long_ok_by" in source,
      false,
      "`sources` is shared; anybody who saves the same link would be handed the approver's id"
    );
  });

  test("what she can know is whether it was her", async () => {
    const hers = await harness.call(worker, "/v1/sync?since=0", { token: alice });
    const his = await harness.call(worker, "/v1/sync?since=0", { token: bob });
    const find = (delta) =>
      delta.body.sources.find((row) => row.url_canonical.includes("WHOAPPROVED"));
    assert.equal(find(hers).long_ok_mine, false);
    assert.equal(find(his).long_ok_mine, true);
  });

  test("a reel nobody had to approve says nothing either way", async () => {
    await saveAndClaim(harness, alice, "ANORDINARYREEL");
    const delta = await harness.call(worker, "/v1/sync?since=0", { token: alice });
    const source = delta.body.sources.find((row) => row.url_canonical.includes("ANORDINARYREEL"));
    assert.equal(source.long_ok_mine, null);
  });
});

// ------------------------------------------------------------------ "never" means never

describe("turning the look back off", () => {
  let harness;
  let token;

  before(async () => {
    harness = await createTestEnv();
    token = await harness.mintToken("vish");
    await harness.call(worker, "/v1/settings", {
      method: "PUT",
      token,
      body: { provider: "gemini", api_key: "a-key-value-not-real" }
    });

    const clip = await saveAndClaim(harness, token, "SOMETHINGOLD");
    harness.answerProviderWith(() => harness.geminiReplyWith(ANALYSIS));
    await harness.call(worker, `/v1/sources/${clip.source_id}/transcript`, {
      method: "POST",
      serviceToken: SERVICE_TOKEN,
      body: { text: "words", lang: "en", engine: "test", duration_sec: 40 }
    });
    harness.database
      .prepare("UPDATE clips SET created_at = ? WHERE user_id = 'vish'")
      .run(Date.now() - 60 * 24 * 60 * 60 * 1000);
  });

  after(() => {
    harness.answerProviderWith(null);
    harness.restore();
  });

  test("the server refuses, not just the app", async () => {
    // The app not drawing the banner is a courtesy. "Stop asking me" is a rule, and a rule
    // this product states has to be stated where it is enforced.
    await harness.call(worker, "/v1/relook/every", { method: "PUT", token, body: { days: 0 } });

    const before = harness.providerCalls.length;
    const run = await harness.call(worker, "/v1/relook", { method: "POST", token });
    assert.equal(run.status, 400);
    assert.match(run.body.error, /turned looking back off/);
    assert.equal(harness.providerCalls.length, before, "nothing may be spent");
    assert.equal(
      harness.database.prepare("SELECT COUNT(*) n FROM relooks").get().n,
      0
    );
  });

  test("turning it back on lets it run again", async () => {
    harness.answerProviderWith(() =>
      harness.geminiReplyWith({
        themes: [{ name: "e-commerce", why: "Most of this batch." }],
        act_now: [{ do: "Try one thing", because: "It is cheap", from: "A reel" }],
        note: null
      })
    );
    await harness.call(worker, "/v1/relook/every", { method: "PUT", token, body: { days: 14 } });
    const run = await harness.call(worker, "/v1/relook", { method: "POST", token });
    assert.equal(run.status, 201);
  });
});

// ------------------------------------------------------------------ a late worker

describe("a worker whose lease expired cannot bury finished work", () => {
  let harness;
  let token;
  let clip;

  before(async () => {
    harness = await createTestEnv();
    token = await harness.mintToken("vish");
    clip = await saveAndClaim(harness, token, "ALREADYFINISHED");
    harness.database
      .prepare("UPDATE sources SET state = 'analyzed', duration_sec = 90 WHERE id = ?")
      .run(clip.source_id);
  });
  after(() => harness.restore());

  test("a stale 'this is past the ceiling' report changes nothing", async () => {
    // Its sibling branch has carried this guard from the start, with a comment saying why.
    // This one wrote 'failed' with no guard at all — so a late report from a worker that
    // had lost its claim could show a perfectly analysed reel as broken, to everyone who
    // saved it.
    const asked = await harness.call(worker, `/v1/sources/${clip.source_id}/too-long`, {
      method: "POST",
      serviceToken: SERVICE_TOKEN,
      body: { duration_sec: 7 * 3600 }
    });
    assert.equal(asked.status, 200);

    const row = harness.database
      .prepare("SELECT state, error, duration_sec FROM sources WHERE id = ?")
      .get(clip.source_id);
    assert.equal(row.state, "analyzed");
    assert.equal(row.error, null);
    assert.equal(row.duration_sec, 90, "and its length was not rewritten either");
  });

  test("the Worker decides what is long, not the machine that reported it", async () => {
    // The threshold and the ceiling otherwise live only in a gitignored .env on one PC,
    // and a stale value there silently changes the rules the app is telling him about.
    const other = await saveAndClaim(harness, token, "NOTEVENLONG");
    const asked = await harness.call(worker, `/v1/sources/${other.source_id}/too-long`, {
      method: "POST",
      serviceToken: SERVICE_TOKEN,
      body: { duration_sec: 5 * 60 }
    });
    assert.equal(asked.status, 400);
    assert.equal(
      harness.database.prepare("SELECT state FROM sources WHERE id = ?").get(other.source_id).state,
      "downloading",
      "a five-minute reel must not be parked waiting for permission"
    );
  });
});

// ------------------------------------------------------------------ the long lease

describe("a six-hour job outlives a fifteen-minute claim", () => {
  let harness;
  let token;

  before(async () => {
    harness = await createTestEnv();
    token = await harness.mintToken("vish");
  });
  after(() => harness.restore());

  test("a long video's claim is not stolen while the machine is still working on it", async () => {
    const clip = await saveAndClaim(harness, token, "THREEHOURS");
    // Claimed an hour ago, and it is a three-hour video: the machine is still on it.
    harness.database
      .prepare("UPDATE sources SET duration_sec = ?, claimed_at = ?, attempts = 1 WHERE id = ?")
      .run(3 * 3600, Date.now() - 60 * 60 * 1000, clip.source_id);

    const claimed = await harness.call(worker, "/v1/queue?limit=5", { serviceToken: SERVICE_TOKEN });
    assert.equal(
      claimed.body.sources.length,
      0,
      "a second worker would have started the same three-hour job over"
    );
  });

  test("a reel's claim still expires in minutes, as it always did", async () => {
    const clip = await saveAndClaim(harness, token, "AREEL");
    harness.database
      .prepare("UPDATE sources SET duration_sec = 45, claimed_at = ?, attempts = 1 WHERE id = ?")
      .run(Date.now() - 30 * 60 * 1000, clip.source_id);

    const claimed = await harness.call(worker, "/v1/queue?limit=5", { serviceToken: SERVICE_TOKEN });
    assert.equal(claimed.body.sources.length, 1, "a dead worker must not strand a reel for hours");
  });

  test("a long video is not retired as failed while it is still being worked on", async () => {
    const clip = await saveAndClaim(harness, token, "LASTTRY");
    harness.database
      .prepare("UPDATE sources SET duration_sec = ?, claimed_at = ?, attempts = 3 WHERE id = ?")
      .run(4 * 3600, Date.now() - 2 * 60 * 60 * 1000, clip.source_id);

    await harness.call(worker, "/v1/queue?limit=5", { serviceToken: SERVICE_TOKEN });

    const row = harness.database
      .prepare("SELECT state FROM sources WHERE id = ?")
      .get(clip.source_id);
    assert.equal(row.state, "downloading", "four hours of work would have been thrown away");
  });
});

// ------------------------------------------------------------------ a throttled backfill

describe("a rate-limited creator backfill must not burn the queue", () => {
  let harness;
  let token;
  const ids = [];

  before(async () => {
    harness = await createTestEnv();
    token = await harness.mintToken("vish");
    for (let n = 0; n < 3; n += 1) {
      const clip = await saveAndClaim(harness, token, `NOCREATOR${n}`);
      ids.push(clip.source_id);
    }
  });
  after(() => harness.restore());

  test("a lookup that FAILED settles nothing — the video comes round again", async () => {
    // The first version marked a video "asked" whether the platform had answered or not.
    // One throttle would then have walked the whole queue in a couple of hours, marking
    // two hundred videos "asked, nobody named" without anything ever being asked — and the
    // creator column would have stayed empty for ever with nothing saying why.
    const reported = await harness.call(worker, `/v1/sources/${ids[0]}/creator`, {
      method: "POST",
      serviceToken: SERVICE_TOKEN,
      body: { creator: null, asked: false }
    });
    assert.equal(reported.body.settled, false);

    const row = harness.database
      .prepare("SELECT creator_checked_at, creator_tries FROM sources WHERE id = ?")
      .get(ids[0]);
    assert.equal(row.creator_checked_at, null, "a failure is not an answer");
    assert.equal(row.creator_tries, 1);

    const queue = await harness.call(worker, "/v1/creators?limit=10", { serviceToken: SERVICE_TOKEN });
    assert.ok(queue.body.sources.some((one) => one.id === ids[0]));
  });

  test("but a video that keeps failing is eventually left alone", async () => {
    // The other way to get this wrong is a queue that never ends.
    for (let n = 0; n < 3; n += 1) {
      await harness.call(worker, `/v1/sources/${ids[1]}/creator`, {
        method: "POST",
        serviceToken: SERVICE_TOKEN,
        body: { creator: null, asked: false }
      });
    }
    const row = harness.database
      .prepare("SELECT creator_checked_at, creator_tries FROM sources WHERE id = ?")
      .get(ids[1]);
    assert.equal(row.creator_tries, 3);
    assert.ok(row.creator_checked_at, "three failures and it stops being asked about");

    const queue = await harness.call(worker, "/v1/creators?limit=10", { serviceToken: SERVICE_TOKEN });
    assert.ok(!queue.body.sources.some((one) => one.id === ids[1]));
  });

  test("a lookup that ANSWERED 'nobody' settles it at once", async () => {
    const reported = await harness.call(worker, `/v1/sources/${ids[2]}/creator`, {
      method: "POST",
      serviceToken: SERVICE_TOKEN,
      body: { creator: null, asked: true }
    });
    assert.equal(reported.body.settled, true);

    const row = harness.database
      .prepare("SELECT creator, creator_checked_at, creator_tries FROM sources WHERE id = ?")
      .get(ids[2]);
    assert.equal(row.creator, null);
    assert.equal(row.creator_tries, 0);
    assert.ok(row.creator_checked_at);
  });

  test("the ones that have failed least are asked first", async () => {
    const queue = await harness.call(worker, "/v1/creators?limit=10", { serviceToken: SERVICE_TOKEN });
    const tries = queue.body.sources.map(
      (one) =>
        harness.database.prepare("SELECT creator_tries t FROM sources WHERE id = ?").get(one.id).t
    );
    assert.deepEqual(tries, [...tries].sort((a, b) => a - b));
  });
});
