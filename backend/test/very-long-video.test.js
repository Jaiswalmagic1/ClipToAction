// Asking before a very long video is processed (D42).
//
// The thing this must never do is start a two-hour download behind his back. So the whole
// flow is built around one fact: the length is not known until the metadata is read, and
// the metadata read is free — so the worker reads it, stops, and asks.
//
// What is pinned here:
//
//   * The 11-to-18 minute videos he saves all the time are NEVER asked about. A warning
//     that always appears is a warning nobody reads, and that would be worse than none.
//   * A video waiting for an answer is not claimable, carries no error, and is not failed.
//   * "No" parks it. Parked is not failed: no error, never retried, approvable for ever.
//   * Whoever says yes is whoever pays for reading it — a day of somebody's free allowance
//     must not go on an hour-long video another person approved.
//   * Past the ceiling it is refused outright, because no answer he could give would help.

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import worker from "../src/worker.js";
import {
  WARN_ABOVE_SEC,
  MAX_VIDEO_SEC,
  MAX_TRANSCRIPT_CHARS,
  CHARS_PER_SEC,
  NEAR_CEILING_FRACTION,
  needsPermission,
  tooLongForAnyone,
  whatItCosts
} from "../src/longvideo.js";
import { isLong, LONG_VIDEO_SEC } from "../src/analyze.js";
import { createTestEnv } from "./helpers/testenv.js";

const SERVICE_TOKEN = "service-token-for-tests";
const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// ------------------------------------------------------------------ the threshold

describe("what counts as long enough to ask about", () => {
  test("the videos he saves all the time are never asked about", () => {
    // 11 to 18 minutes, which is what the nine long videos in the real notebook are.
    for (const minutes of [11, 14, 18, 25, 29]) {
      assert.equal(
        needsPermission(minutes * 60),
        false,
        `${minutes} minutes must not be asked about — the warning would become furniture`
      );
    }
  });

  test("the genuinely big ones are", () => {
    for (const minutes of [31, 69, 72, 113, 180]) {
      assert.equal(needsPermission(minutes * 60), true, `${minutes} minutes must be asked about`);
    }
  });

  test("asking is a different question from the long prompt, and sits well above it", () => {
    // D33's threshold decides which PROMPT a video gets — chapters and times. It is ten
    // minutes and must not move: an 18-minute video still gets chapters without being
    // asked about. These two numbers do different jobs and must not be merged.
    assert.equal(isLong(15 * 60), true, "a 15-minute video still gets the long prompt");
    assert.equal(needsPermission(15 * 60), false, "and is still not asked about");
    assert.ok(WARN_ABOVE_SEC > 20 * 60, "the warning must sit clear of his routine saves");
  });

  test("the ceiling is six hours, and it is still a ceiling", () => {
    assert.equal(MAX_VIDEO_SEC, 6 * 60 * 60);
    assert.equal(tooLongForAnyone(5.5 * 3600), false);
    assert.equal(tooLongForAnyone(6.5 * 3600), true);
  });

  test("the ceiling fits inside what a transcript may be, which is what D33 could not do", () => {
    // The old limits were three hours and 200,000 characters. Six hours of speech is about
    // 330,000, so raising the length without raising this would have refused a video after
    // three hours of work rather than before it.
    assert.ok(
      MAX_VIDEO_SEC * CHARS_PER_SEC < MAX_TRANSCRIPT_CHARS,
      "the longest allowed video must be able to fit in the column that holds it"
    );
  });
});

describe("the figures the warning is written from", () => {
  test("a 90-minute video reads as a big cost, in plain numbers", () => {
    const cost = whatItCosts(90 * 60);
    assert.equal(cost.minutes, 90);
    assert.ok(cost.pc_minutes >= 45 && cost.pc_minutes <= 90, "the PC estimate is honest");
    assert.ok(cost.times_a_reel > 50, "he was told it is roughly 75 times a reel");
    assert.equal(cost.near_ceiling, false);
  });

  test("something near six hours says so before the work, not after", () => {
    assert.equal(whatItCosts(5.9 * 3600).near_ceiling, true, "a six-hour video is warned about");
    assert.equal(whatItCosts(4 * 3600).near_ceiling, false, "a four-hour one is not");
    // The line has to be reachable at a length that is actually allowed, or it is dead
    // wording that never appears.
    assert.equal(whatItCosts(MAX_VIDEO_SEC).near_ceiling, true);
  });

  test("a zero length does not produce nonsense", () => {
    const cost = whatItCosts(0);
    assert.equal(cost.minutes, 0);
    assert.ok(cost.pc_minutes >= 1);
    assert.ok(cost.times_a_reel >= 1);
  });

  test("the app's copy of these numbers matches this file's", () => {
    const app = readFileSync(join(repo, "index.html"), "utf8");
    const read = (name) => {
      const found = new RegExp(`const ${name} = ([\\d.]+);`).exec(app);
      assert.ok(found, `the app does not define ${name}`);
      return Number(found[1]);
    };
    assert.equal(read("WARN_ABOVE_SEC"), WARN_ABOVE_SEC);
    assert.equal(read("MAX_VIDEO_SEC"), MAX_VIDEO_SEC);
    assert.equal(read("CHARS_PER_SEC"), CHARS_PER_SEC);
    assert.equal(read("MAX_TRANSCRIPT_CHARS"), MAX_TRANSCRIPT_CHARS);
    assert.equal(read("NEAR_CEILING_FRACTION"), NEAR_CEILING_FRACTION);
  });

  // The fourth number that has to agree across three files, and the one that was left
  // behind on the PC when the other three moved to the API. It decides whether times are
  // written INTO the transcript there and whether the prompt ASKS for them here — so a
  // stale value in a gitignored .env means an hour-long talk is told to copy time markers
  // out of a transcript that has none, and comes back with no chapters and nothing saying
  // why. Which is the one thing D33 exists to produce.
  test("what counts as long enough for chapters travels with the work too", async () => {
    const harness = await createTestEnv();
    try {
      const claimed = await harness.call(worker, "/v1/queue?limit=1", {
        serviceToken: SERVICE_TOKEN
      });
      assert.equal(claimed.body.limits.long_video_sec, LONG_VIDEO_SEC);
    } finally {
      harness.restore();
    }

    const python = readFileSync(join(repo, "worker-pc", "worker.py"), "utf8");
    const found = /LONG_VIDEO_SEC", "(\d+)"/.exec(python);
    assert.ok(found, "worker.py does not default LONG_VIDEO_SEC");
    assert.equal(Number(found[1]), LONG_VIDEO_SEC, "the two files disagree");
    assert.ok(
      python.includes('sent("long_video_sec", LONG_VIDEO_SEC)'),
      "the worker does not take it from the API, so a stale .env still decides"
    );
    assert.ok(
      python.includes("long_above is None else long_above"),
      "the value from the API never reaches the place that writes the times"
    );
  });

  test("the PC worker's ceiling matches this file's, or a video is refused twice over", () => {
    const python = readFileSync(join(repo, "worker-pc", "worker.py"), "utf8");
    const read = (name) => {
      const found = new RegExp(`${name}", "(\\d+)"`).exec(python);
      assert.ok(found, `worker.py does not default ${name}`);
      return Number(found[1]);
    };
    assert.equal(read("MAX_DURATION_SEC"), MAX_VIDEO_SEC);
    assert.equal(read("WARN_ABOVE_SEC"), WARN_ABOVE_SEC);
    assert.equal(read("MAX_TRANSCRIPT_CHARS"), MAX_TRANSCRIPT_CHARS);
  });
});

// ------------------------------------------------------------------ end to end

describe("a very long video, from saving it to reading it", () => {
  let harness;
  let amy;
  let ben;
  let clip;
  let benClip;

  const ANALYSIS = {
    summary: "A long interview about selling online, covered end to end.",
    sections: [{ at: "0:00:00", heading: "Opening", detail: "Introductions." }],
    key_points: ["one point"],
    learn_more: ["Meesho"],
    claims: [],
    suggested_task: null,
    topic: "e-commerce",
    sub_topic: "interviews",
    kind: "other",
    items: []
  };

  before(async () => {
    harness = await createTestEnv();
    amy = await harness.mintToken("amy");
    ben = await harness.mintToken("ben");

    // Both have a key. Ben saved it FIRST, so under D10 alone Ben's key would pay.
    for (const [token, key] of [[ben, "bens-key-value-not-real"], [amy, "amys-key-value-not-real"]]) {
      await harness.call(worker, "/v1/settings", {
        method: "PUT",
        token,
        body: { provider: "gemini", api_key: key }
      });
    }

    const bensSave = await harness.call(worker, "/v1/clips", {
      method: "POST",
      token: ben,
      body: { url: "https://www.facebook.com/share/r/ANHOURLONG/" }
    });
    benClip = bensSave.body.clip;
    const amysSave = await harness.call(worker, "/v1/clips", {
      method: "POST",
      token: amy,
      body: { url: "https://www.facebook.com/share/r/ANHOURLONG/" }
    });
    clip = amysSave.body.clip;
  });

  after(() => {
    harness.answerProviderWith(null);
    harness.restore();
  });

  test("the worker is handed it, reads the length and asks — nothing is downloaded", async () => {
    const claimed = await harness.call(worker, "/v1/queue?limit=5", { serviceToken: SERVICE_TOKEN });
    assert.equal(claimed.body.sources.length, 1);
    assert.equal(claimed.body.sources[0].long_ok, 0, "nobody has said yes yet");

    const asked = await harness.call(worker, `/v1/sources/${clip.source_id}/too-long`, {
      method: "POST",
      serviceToken: SERVICE_TOKEN,
      body: { duration_sec: 69 * 60, title: "An hour with a seller", creator: "Ecom Guruji" }
    });
    assert.equal(asked.body.applied, true);

    const row = harness.database.prepare("SELECT * FROM sources WHERE id = ?").get(clip.source_id);
    assert.equal(row.state, "needs_ok");
    assert.equal(row.error, null, "a question is not a failure and must not read as one");
    assert.equal(row.error_detail, null);
    assert.equal(row.duration_sec, 69 * 60);
    assert.equal(row.creator, "Ecom Guruji", "what was read for free is kept");
    assert.equal(row.attempts, 0, "the claim that discovered the length is not held against it");
  });

  test("while it waits, the worker is never handed it again", async () => {
    const claimed = await harness.call(worker, "/v1/queue?limit=5", { serviceToken: SERVICE_TOKEN });
    assert.equal(claimed.body.sources.length, 0);
  });

  test("both people who saved it are shown the question, with the length", async () => {
    for (const token of [amy, ben]) {
      const delta = await harness.call(worker, "/v1/sync?since=0", { token });
      const source = delta.body.sources.find((row) => row.id === clip.source_id);
      assert.equal(source.state, "needs_ok");
      assert.equal(source.duration_sec, 69 * 60);
    }
  });

  test("'not now' parks it, and parked is not failed", async () => {
    const parked = await harness.call(worker, `/v1/clips/${clip.id}/long-park`, {
      method: "POST",
      token: amy
    });
    assert.equal(parked.status, 200);

    const row = harness.database.prepare("SELECT * FROM sources WHERE id = ?").get(clip.source_id);
    assert.equal(row.state, "parked");
    assert.equal(row.error, null, "a parked video must never carry an error");
    assert.notEqual(row.state, "failed");

    const claimed = await harness.call(worker, "/v1/queue?limit=5", { serviceToken: SERVICE_TOKEN });
    assert.equal(claimed.body.sources.length, 0, "a parked video is never retried");
  });

  test("a parked video can be approved later, and is not lost", async () => {
    const approved = await harness.call(worker, `/v1/clips/${clip.id}/long-ok`, {
      method: "POST",
      token: amy
    });
    assert.equal(approved.status, 200);

    const row = harness.database.prepare("SELECT * FROM sources WHERE id = ?").get(clip.source_id);
    assert.equal(row.state, "pending");
    assert.equal(row.attempts, 0, "an agreed video gets a full set of tries");
    assert.equal(row.long_ok_by, "amy");
  });

  test("the worker is now told it may go ahead without asking again", async () => {
    const claimed = await harness.call(worker, "/v1/queue?limit=5", { serviceToken: SERVICE_TOKEN });
    assert.equal(claimed.body.sources.length, 1);
    assert.equal(claimed.body.sources[0].long_ok, 1);
  });

  test("whoever said yes is whoever pays for reading it", async () => {
    harness.answerProviderWith(() => harness.geminiReplyWith(ANALYSIS));
    const before = harness.providerCalls.length;

    await harness.call(worker, `/v1/sources/${clip.source_id}/transcript`, {
      method: "POST",
      serviceToken: SERVICE_TOKEN,
      body: {
        text: "[0:00:00] a long conversation about selling online",
        lang: "en",
        engine: "test",
        duration_sec: 69 * 60
      }
    });

    const used = harness.providerCalls.slice(before);
    assert.equal(used.length, 1);
    const sent = JSON.parse(used[0].options.body);
    // Ben saved it first, so D10 alone would have spent Ben's allowance on a video Amy
    // approved. It must be Amy's key that was used.
    assert.match(
      used[0].options.headers["x-goog-api-key"],
      /amys-key-value-not-real/,
      "the person who approved an hour-long video is the person who pays for it"
    );
    assert.match(sent.contents[0].parts[0].text, /LONG video/, "it still gets the long prompt");

    const row = harness.database.prepare("SELECT state FROM sources WHERE id = ?").get(clip.source_id);
    assert.equal(row.state, "analyzed");
  });

  test("everyone who saved it gets the summary, as always", async () => {
    for (const token of [amy, ben]) {
      const delta = await harness.call(worker, "/v1/sync?since=0", { token });
      const analysis = delta.body.analyses.find((row) => row.source_id === clip.source_id);
      assert.equal(analysis.summary, ANALYSIS.summary);
    }
    assert.ok(benClip.id, "and Ben's own clip still points at it");
  });
});

// ------------------------------------------------------------------ the edges

describe("the edges of asking", () => {
  let harness;
  let amy;
  let clip;

  before(async () => {
    harness = await createTestEnv();
    amy = await harness.mintToken("amy");
    const saved = await harness.call(worker, "/v1/clips", {
      method: "POST",
      token: amy,
      body: { url: "https://www.facebook.com/share/r/SEVENHOURS/" }
    });
    clip = saved.body.clip;
  });

  after(() => harness.restore());

  test("past the ceiling it is refused outright, not asked about", async () => {
    await harness.call(worker, "/v1/queue?limit=5", { serviceToken: SERVICE_TOKEN });
    const asked = await harness.call(worker, `/v1/sources/${clip.source_id}/too-long`, {
      method: "POST",
      serviceToken: SERVICE_TOKEN,
      body: { duration_sec: 7 * 3600, title: "Seven hours" }
    });
    assert.equal(asked.body.refused, true);

    const row = harness.database.prepare("SELECT * FROM sources WHERE id = ?").get(clip.source_id);
    assert.equal(row.state, "failed", "no answer he could give would make this one fit");
    assert.match(row.error, /past the 6-hour limit/);
    assert.equal(row.error_detail, "refused too_long");
  });

  test("a video past the ceiling cannot be approved into existence", async () => {
    const approved = await harness.call(worker, `/v1/clips/${clip.id}/long-ok`, {
      method: "POST",
      token: amy
    });
    assert.equal(approved.status, 400);
  });

  test("an ordinary reel cannot be approved or parked, because it was never asked about", async () => {
    const saved = await harness.call(worker, "/v1/clips", {
      method: "POST",
      token: amy,
      body: { url: "https://www.facebook.com/share/r/ANORDINARYREEL/" }
    });
    for (const action of ["long-ok", "long-park"]) {
      const answer = await harness.call(worker, `/v1/clips/${saved.body.clip.id}/${action}`, {
        method: "POST",
        token: amy
      });
      assert.equal(answer.status, 400);
    }
  });

  test("nobody can answer for a clip that is not theirs", async () => {
    const ben = await harness.mintToken("ben");
    const answer = await harness.call(worker, `/v1/clips/${clip.id}/long-ok`, {
      method: "POST",
      token: ben
    });
    assert.equal(answer.status, 404, "somebody else's clip answers the same as one that is gone");
  });

  test("signing in is required to answer at all", async () => {
    const answer = await harness.call(worker, `/v1/clips/${clip.id}/long-ok`, { method: "POST" });
    assert.equal(answer.status, 401);
  });

  test("a late worker cannot drag a finished video back into being asked about", async () => {
    const saved = await harness.call(worker, "/v1/clips", {
      method: "POST",
      token: amy,
      body: { url: "https://www.facebook.com/share/r/ALREADYDONE/" }
    });
    harness.database
      .prepare("UPDATE sources SET state = 'analyzed' WHERE id = ?")
      .run(saved.body.clip.source_id);

    const asked = await harness.call(worker, `/v1/sources/${saved.body.clip.source_id}/too-long`, {
      method: "POST",
      serviceToken: SERVICE_TOKEN,
      body: { duration_sec: 60 * 60 }
    });
    assert.equal(asked.body.applied, false);

    const row = harness.database
      .prepare("SELECT state FROM sources WHERE id = ?")
      .get(saved.body.clip.source_id);
    assert.equal(row.state, "analyzed");
  });

  test("the worker's report is not reachable without the service token", async () => {
    const asked = await harness.call(worker, `/v1/sources/${clip.source_id}/too-long`, {
      method: "POST",
      token: amy,
      body: { duration_sec: 60 * 60 }
    });
    assert.equal(asked.status, 401);
  });
});
