// What the independent review found, pinned so it cannot come back.
//
// Every test here exists because a reviewer who did not write this code proved a failure
// against the real Worker. They are gathered in one file on purpose: each one is a lesson
// about a different way this product can quietly do the wrong thing, and reading them
// together is more use than finding them scattered.

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";

import worker, { MAX_TRANSCRIPT_BODY_BYTES } from "../src/worker.js";
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

describe("a late worker's transcript", () => {
  let harness;
  let token;
  let clip;

  before(async () => {
    harness = await createTestEnv();
    token = await harness.mintToken("vish");
    clip = await saveAndClaim(harness, token, "ALREADYDONEBYSOMEONE");
  });
  after(() => harness.restore());

  test("cannot land after somebody else has finished the video", async () => {
    harness.database
      .prepare("UPDATE sources SET state = 'analyzed' WHERE id = ?")
      .run(clip.source_id);

    const posted = await harness.call(worker, `/v1/sources/${clip.source_id}/transcript`, {
      method: "POST",
      serviceToken: SERVICE_TOKEN,
      body: { text: "a stale machine's words", lang: "en", engine: "test" }
    });
    assert.equal(posted.status, 200);
    assert.equal(posted.body.applied, false);

    const rows = harness.database
      .prepare("SELECT COUNT(*) AS n FROM transcripts WHERE source_id = ?")
      .get(clip.source_id);
    assert.equal(rows.n, 0, "the transcript must not be written either");
  });

  test("and the two writes move together, so nothing is left half-done", async () => {
    // Splitting them left a hole: the state moved, the insert failed, and the reel was
    // stuck for ever — unclaimable, no transcript, no analysis and no error.
    harness.database
      .prepare("UPDATE sources SET state = 'downloading' WHERE id = ?")
      .run(clip.source_id);

    const posted = await harness.call(worker, `/v1/sources/${clip.source_id}/transcript`, {
      method: "POST",
      serviceToken: SERVICE_TOKEN,
      body: { text: "the real words", lang: "en", engine: "test" }
    });
    assert.equal(posted.status, 200);

    const state = harness.database
      .prepare("SELECT state FROM sources WHERE id = ?")
      .get(clip.source_id).state;
    const stored = harness.database
      .prepare("SELECT text FROM transcripts WHERE source_id = ?")
      .get(clip.source_id);
    assert.equal(state, "transcribed");
    assert.equal(stored.text, "the real words", "the state moved, so the words must be there");
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

  test("the Worker decides what is long, and puts a short one back in the queue", async () => {
    // The threshold otherwise lives only in a gitignored .env on one PC, and a stale value
    // there silently changes the rules the app is telling him about.
    //
    // Refusing outright would have STRANDED it: the source stays claimed, the lease
    // expires, it is claimed again, and after three goes it is retired as "gave up after 3
    // attempts" — a reel thrown away over a disagreement about a number.
    const other = await saveAndClaim(harness, token, "NOTEVENLONG");
    const asked = await harness.call(worker, `/v1/sources/${other.source_id}/too-long`, {
      method: "POST",
      serviceToken: SERVICE_TOKEN,
      body: { duration_sec: 5 * 60 }
    });
    assert.equal(asked.status, 200);
    assert.equal(asked.body.not_long, true);

    const row = harness.database
      .prepare("SELECT state, duration_sec FROM sources WHERE id = ?")
      .get(other.source_id);
    assert.equal(row.state, "pending", "it goes back to be downloaded normally");
    assert.equal(row.duration_sec, 5 * 60, "and what was measured is kept");
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

// -------------------------------------------------------------- the same cap, his language

describe("a long video in a language that is not English still fits", () => {
  // The cap is named in BYTES and the limit it protects is counted in CHARACTERS, and the
  // two are only the same thing for plain English. The PC worker posts with Python's
  // `requests`, which writes JSON with ensure_ascii=True — so every character outside
  // ASCII travels as a six-byte escape. At the old cap a three-hour video in his own
  // language was transcribed for hours, refused as too large, reported to him as "could
  // not reach ClipToAction", and re-downloaded and re-transcribed twice more before being
  // retired as failed. The old test could not see it: it used English.
  let harness;
  let token;
  let clip;

  before(async () => {
    harness = await createTestEnv();
    token = await harness.mintToken("vish");
    clip = await saveAndClaim(harness, token, "ALONGHINDIONE");
  });
  after(() => harness.restore());

  test("even when every single character is escaped on the wire", async () => {
    const words = "\u092e\u0942\u0932\u094d\u092f \u0924\u092f \u0939\u0948\u0964 ";
    const text = words
      .repeat(Math.ceil(MAX_TRANSCRIPT_CHARS / words.length))
      .slice(0, MAX_TRANSCRIPT_CHARS - 1);
    assert.ok(text.length > 300000, "this test is not testing what it thinks it is");

    // Exactly what `requests` puts on the wire, escapes and all — not what JSON.stringify
    // writes, which leaves these characters alone and hides the whole problem.
    const body = JSON.stringify({
      text,
      lang: "hi",
      engine: "test",
      duration_sec: MAX_VIDEO_SEC
    }).replace(/[^\x00-\x7F]/g, (ch) => "\\u" + ch.charCodeAt(0).toString(16).padStart(4, "0"));
    assert.ok(body.length > 1800000, `only ${body.length} bytes — not the worst case`);
    // And the arithmetic, which is the part that must stay true whatever this test sends:
    // every character its own six-byte escape, plus room for the rest of the body.
    assert.ok(
      MAX_TRANSCRIPT_CHARS * 6 + 4096 < MAX_TRANSCRIPT_BODY_BYTES,
      "the cap is in bytes and the limit is in characters — they have drifted apart again"
    );

    const response = await worker.fetch(
      new Request(`https://api.test/v1/sources/${clip.source_id}/transcript`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Service-Token": SERVICE_TOKEN,
          "Content-Length": String(body.length)
        },
        body
      }),
      harness.env
    );
    assert.equal(
      response.status,
      200,
      `hours of his PC spent, then refused at the door: ${await response.text()}`
    );
  });
});

// ------------------------------------------------------------------ round nine

describe("re-reading a reel never takes away what the first reading found", () => {
  // "Read those again" (D39) is the button this build puts on his home screen, and it
  // writes over an analysis that is already there. Every optional field — chapters, the
  // topic, the action, the tracker rows — is optional BECAUSE a first reading that skipped
  // one is still worth keeping. On a second reading that same leniency meant a reply which
  // simply did not mention chapters replaced three hours' worth of them with nothing, then
  // stamped the shapes version so the reel could never come round again. No error, no
  // message, and nothing anywhere that could derive them back.
  let harness;
  let token;
  let sourceId;

  const CHAPTERS = [
    { at: "0:00:00", heading: "How he started", detail: "The first year." },
    { at: "0:22:00", heading: "Pricing", detail: "How he works out a margin." }
  ];

  before(async () => {
    harness = await createTestEnv();
    token = await harness.mintToken("vish");
    await harness.call(worker, "/v1/settings", {
      method: "PUT",
      token,
      body: { provider: "gemini", api_key: "not-a-real-key-value-at-all" }
    });
    const clip = await saveAndClaim(harness, token, "AREREADONE");
    sourceId = clip.source_id;

    await harness.call(worker, `/v1/sources/${sourceId}/transcript`, {
      method: "POST",
      serviceToken: SERVICE_TOKEN,
      body: {
        text: "[0:00:00] a long talk about pricing",
        lang: "en",
        engine: "test",
        duration_sec: 90 * 60
      }
    });

    harness.database
      .prepare(
        `INSERT INTO analyses
           (source_id, user_id, provider, model, summary, key_points, learn_more, claims,
            suggested_task, topic, sub_topic, sections, kind, items, shapes_version,
            created_at)
         VALUES (?, '', 'gemini', 'old', 'The first reading.', '[]', '[]', '[]',
                 'Raise the price', 'Pricing', 'Margins', ?, 'tactic', NULL, 1, 1)
         ON CONFLICT (source_id, user_id) DO UPDATE SET
           sections = excluded.sections, suggested_task = excluded.suggested_task,
           topic = excluded.topic, shapes_version = 1, items = NULL`
      )
      .run(sourceId, JSON.stringify(CHAPTERS));
  });

  after(() => harness.restore());

  test("a re-read that fills in the rows keeps the chapters and the folder", async () => {
    harness.answerProviderWith(() => ({
      ok: true,
      status: 200,
      json: async () => ({
        candidates: [
          {
            content: {
              parts: [
                {
                  text: JSON.stringify({
                    summary: "The second reading.",
                    key_points: ["price up front"],
                    learn_more: [],
                    claims: [],
                    kind: "tactic",
                    items: [{ name: "price up front", does: "protects the margin" }]
                  })
                }
              ]
            }
          }
        ]
      })
    }));

    const done = await harness.call(worker, "/v1/kinds", { method: "POST", token });
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.equal(done.body.done, 1);

    const row = harness.database
      .prepare("SELECT * FROM analyses WHERE source_id = ? AND user_id = ''")
      .get(sourceId);

    assert.deepEqual(JSON.parse(row.sections), CHAPTERS, "the chapters were wiped");
    assert.equal(row.topic, "Pricing", "the folder was wiped");
    assert.equal(row.sub_topic, "Margins");

    // NOTHING that was already written changes. This row is SHARED: everyone who saved the
    // reel reads it, and the button sits on the home screen of every one of them from
    // their first day. A second person pressing it replaced the first person's summary
    // with their own, deleted the claim his home screen had flagged as doubted, renamed
    // his folder and moved his clip into it — up to two hundred and forty of his reels in
    // one press, on the stranger's own AI account. The button fills in the new tables.
    // That is all it may do.
    assert.equal(row.suggested_task, "Raise the price", "his action was overwritten");
    assert.equal(row.summary, "The first reading.", "his summary was overwritten");
    assert.equal(row.provider, "gemini");

    // And what the re-read was FOR is in.
    assert.ok(JSON.parse(row.items).length, "the rows it was re-read FOR were not stored");
    assert.equal(Math.abs(row.shapes_version), 2, "it would be offered for re-reading again");
    harness.answerProviderWith(null);
  });
});

describe("and never keeps something the new reading contradicts", () => {
  // The correction to the correction. Blanket "keep whatever was there" kept a sub-topic
  // stapled to a topic it never belonged to, and kept product rows on a video the new
  // reading calls an opinion — which the app then hides and the connector still reads out,
  // so the two disagree about what the video contains.
  let harness;
  let token;
  let sourceId;
  let clipId;

  before(async () => {
    harness = await createTestEnv();
    token = await harness.mintToken("vish");
    const clip = await saveAndClaim(harness, token, "ACHANGEDONE");
    sourceId = clip.source_id;
    clipId = clip.id;
    await harness.call(worker, `/v1/sources/${sourceId}/transcript`, {
      method: "POST",
      serviceToken: SERVICE_TOKEN,
      body: { text: "[0:00:00] stands and prices", lang: "en", engine: "test", duration_sec: 50 }
    });
  });
  after(() => harness.restore());

  const pasteOver = (payload) =>
    harness.call(worker, `/v1/clips/${clipId}/analysis`, {
      method: "POST",
      token,
      body: { pasted: JSON.stringify(payload) }
    });

  const mine = () =>
    harness.database
      .prepare("SELECT * FROM analyses WHERE source_id = ? AND user_id = 'vish'")
      .get(sourceId);

  test("a new folder brings its own sub-folder, and the two are never crossed", async () => {
    await pasteOver({
      summary: "The first reading.",
      key_points: [],
      learn_more: [],
      claims: [],
      topic: "Amazon listings",
      sub_topic: "Product photos"
    });
    assert.equal(mine().sub_topic, "Product photos");

    await pasteOver({
      summary: "The second reading.",
      key_points: [],
      learn_more: [],
      claims: [],
      topic: "Instagram growth"
    });
    const row = mine();
    assert.equal(row.topic, "Instagram growth");
    assert.equal(row.sub_topic, null, "a sub-folder was stapled to a topic it never came from");
  });

  test("a reading with no folder at all leaves the one he has alone", async () => {
    await pasteOver({ summary: "A third reading.", key_points: [], learn_more: [], claims: [] });
    assert.equal(mine().topic, "Instagram growth", "the folder was wiped by a quiet reading");
  });

  test("rows belonging to a kind the video is no longer said to be do not survive", async () => {
    await pasteOver({
      summary: "It sells stands.",
      key_points: [],
      learn_more: [],
      claims: [],
      kind: "product",
      items: [{ name: "Stand A", cost: "199" }]
    });
    assert.equal(JSON.parse(mine().items).length, 1);

    await pasteOver({
      summary: "Actually it just argues a point.",
      key_points: [],
      learn_more: [],
      claims: [],
      kind: "opinion"
    });
    const row = mine();
    assert.equal(row.kind, "opinion");
    assert.equal(row.items, null, "product rows outlived the kind they belonged to");
  });

  test("but a thin reading of the SAME kind does not lose the rows", async () => {
    await pasteOver({
      summary: "Stands again.",
      key_points: [],
      learn_more: [],
      claims: [],
      kind: "product",
      items: [{ name: "Stand A", cost: "199" }, { name: "Stand B", cost: "299" }]
    });
    await pasteOver({
      summary: "Stands, read thinly.",
      key_points: [],
      learn_more: [],
      claims: [],
      kind: "product"
    });
    assert.equal(JSON.parse(mine().items).length, 2, "one thin reading emptied the table");
  });
});
