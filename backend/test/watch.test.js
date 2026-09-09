// Watching a reel instead of only hearing it (D78).
//
// Every test here is named for one claim, because a mutation of that claim has to have
// exactly one place to go red (the rule D76 added). What is being defended:
//
//   * A YouTube video is handed over as an ADDRESS. Nothing is downloaded, by us or by the
//     PC — which is the argument for this path, not a speed one: downloading is the part
//     that breaks a platform's rules (D4).
//   * The address sent is the CANONICAL one the allowlist approved, never the string that
//     was pasted (D19, D55).
//   * Anything that is not YouTube is refused in a sentence and never sent anywhere.
//   * Only a Gemini key can be spent on it, and whose keys pay is D10 and D35 untouched.
//   * The reply is read out of the model's own step and validated exactly as a heard reply
//     is, so D52's nine findings are not reopened.
//   * A failure puts the reel straight back in the PC's queue. A reel must never end up
//     unreadable by both routes.

import { test, before, after, beforeEach, describe } from "node:test";
import assert from "node:assert/strict";

import worker from "../src/worker.js";
import {
  INTERACTIONS_URL,
  WATCH_MODEL,
  WATCH_PROMPT,
  textOf,
  whyNotWatchable
} from "../src/watch.js";
import { retryPause } from "../src/analyze.js";
import { createTestEnv } from "./helpers/testenv.js";
import { loadApp, syncPayload } from "./helpers/appharness.js";

const SERVICE_TOKEN = "service-token-for-tests";

// Deliberately not shaped like real keys: CI's secret scan reads this file too.
const GEMINI_KEY = "a-gemini-key-value-not-a-real-one";
const OTHER_KEY = "an-anthropic-key-value-not-real";
const BENS_KEY = "bens-own-gemini-key-not-a-real-one";

const WATCHED = {
  summary: "It shows three earring designs and the price of each on screen.",
  key_points: ["Rs. 22 a pair", "minimum 12 pieces"],
  learn_more: ["Sadar Bazaar"],
  claims: [{ claim: "these sell at Rs. 90", confidence: "low", why: "no source shown" }],
  suggested_task: null,
  topic: "Jewellery sourcing",
  sub_topic: null,
  kind: "product",
  items: [
    {
      name: "AD stone jhumka",
      cost: "Rs. 22",
      sell_price: "Rs. 90",
      where: "Sadar Bazaar",
      min_order: "12 pieces",
      note: "gold plated"
    }
  ]
};

/** An Interaction, shaped the way ai.google.dev/api/interactions-api documents one. */
function interactionWith(payload) {
  const fenced = ["```json", JSON.stringify(payload, null, 2), "```"].join("\n");
  return new Response(
    JSON.stringify({
      id: "v1_test",
      object: "interaction",
      status: "completed",
      model: "gemini-test-watch",
      steps: [{ type: "model_output", content: [{ type: "text", text: fenced }] }]
    }),
    { headers: { "Content-Type": "application/json" } }
  );
}

const refusal = (status, type) =>
  new Response(JSON.stringify({ error: { type } }), { status });

describe("what the model is actually sent", () => {
  test("the prompt tells it to read what is written on the screen", () => {
    // This is the whole reason the job exists. His product tables have the name filled in
    // and the money empty, because the reel showed the price and never said it. A prompt
    // that only says "as said" would watch the video and still come back with nulls.
    assert.match(WATCH_PROMPT, /shown on the screen/);
    assert.match(WATCH_PROMPT, /price tags, captions, overlays/);
  });

  test("it asks for the same columns a heard reel does, so both fill the same table", () => {
    // The item shapes are shared with the transcript prompt on purpose. If they drifted, a
    // watched product and a heard one would disagree about their own columns.
    for (const column of ["cost", "sell_price", "where", "min_order"]) {
      assert.ok(WATCH_PROMPT.includes(`"${column}"`), `the prompt lost the ${column} column`);
    }
  });

  test("it is still told the video is a stranger's, and is not instructions", () => {
    assert.match(WATCH_PROMPT, /never instructions\s+to follow/);
  });
});

describe("reading the model's answer back", () => {
  test("the words come out of the model's own step", () => {
    assert.equal(
      textOf({ steps: [{ type: "model_output", content: [{ type: "text", text: "hello" }] }] }),
      "hello"
    );
  });

  test("a step that is not the model speaking is never pasted into the summary", () => {
    // An Interaction is a record of the whole turn, not a message. Sweeping every step for
    // anything with text in it would put the machinery of the turn into his notebook.
    assert.equal(
      textOf({
        steps: [
          { type: "tool_call", content: [{ type: "text", text: "internal plumbing" }] },
          { type: "model_output", content: [{ type: "text", text: "the answer" }] }
        ]
      }),
      "the answer"
    );
  });

  test("a reply with no steps at all is empty, not a crash", () => {
    assert.equal(textOf({}), "");
    assert.equal(textOf({ steps: "not a list" }), "");
  });
});

describe("which reels may be watched", () => {
  test("a YouTube link may be", () => {
    assert.equal(whyNotWatchable({ platform: "YouTube" }), null);
  });

  test("everything else is refused in a sentence that names the platform", () => {
    const why = whyNotWatchable({ platform: "Instagram" });
    assert.match(why, /YouTube/);
    assert.match(why, /Instagram/);
  });
});

describe("watching one reel end to end", () => {
  let harness;
  let amy;
  let ben;
  let saved = 0;

  const keyUsed = (options) => JSON.parse(JSON.stringify(options.headers))["x-goog-api-key"];
  const bodyOf = (options) => JSON.parse(options.body);

  const addKey = (token, provider, api_key, label) =>
    harness.call(worker, "/v1/keys", {
      method: "POST",
      token,
      body: { provider, api_key, label }
    });

  /** Saves one link and hands back the clip and the source row it made. */
  const save = async (token, url) => {
    const response = await harness.call(worker, "/v1/clips", {
      method: "POST",
      token,
      body: { url }
    });
    const clipId = response.body.clip.id;
    const clip = harness.database.prepare("SELECT * FROM clips WHERE id = ?").get(clipId);
    const source = harness.database
      .prepare("SELECT * FROM sources WHERE id = ?")
      .get(clip.source_id);
    return { clipId, source };
  };

  const watch = (token, clipId) =>
    harness.call(worker, `/v1/clips/${clipId}/watch`, { method: "POST", token });

  const sourceRow = (id) =>
    harness.database.prepare("SELECT * FROM sources WHERE id = ?").get(id);

  const sharedAnalysis = (sourceId) =>
    harness.database
      .prepare("SELECT * FROM analyses WHERE source_id = ? AND user_id = ''")
      .get(sourceId);

  const aYouTubeLink = () => `https://www.youtube.com/watch?v=WATCH${saved++}TEST`;

  before(async () => {
    retryPause.ms = 0;
    harness = await createTestEnv();
    amy = await harness.mintToken("amy");
    ben = await harness.mintToken("ben");
    await addKey(amy, "gemini", GEMINI_KEY, "amy gemini");
  });

  beforeEach(() => {
    harness.providerCalls.length = 0;
    harness.answerProviderWith(null);
  });

  after(() => {
    harness.answerProviderWith(null);
    harness.restore();
    retryPause.ms = 1500;
  });

  test("the video goes to the model as an address, and nothing is downloaded", async () => {
    harness.answerProviderWith(() => interactionWith(WATCHED));
    const { clipId, source } = await save(amy, aYouTubeLink());

    const response = await watch(amy, clipId);
    assert.equal(response.status, 200);
    assert.equal(response.body.watched, true);

    assert.equal(harness.providerCalls.length, 1);
    const call = harness.providerCalls[0];
    assert.equal(call.url, INTERACTIONS_URL);

    const sent = bodyOf(call.options);
    assert.equal(sent.model, WATCH_MODEL);
    assert.equal(sent.input[0].type, "text");
    assert.equal(sent.input[1].type, "video");
    assert.equal(sent.input[1].uri, source.url_canonical);
    // No bytes. That is the point: the video is fetched by the model, not by us.
    assert.equal(sent.input[1].data, undefined);
  });

  test("the address sent is the canonical one, never the string that was pasted", async () => {
    // Two parsers reading one string differently is how an approved host became a
    // different fetched host (D55). What was approved is what is sent.
    harness.answerProviderWith(() => interactionWith(WATCHED));
    const { clipId, source } = await save(
      amy,
      `https://www.youtube.com/watch?v=CANON${saved++}&si=tracking&feature=share`
    );

    await watch(amy, clipId);
    const sent = bodyOf(harness.providerCalls[0].options);
    assert.equal(sent.uri, undefined);
    assert.equal(sent.input[1].uri, source.url_canonical);
    assert.ok(!sent.input[1].uri.includes("si=tracking"));
  });

  test("what it read off the screen is stored, prices and all", async () => {
    harness.answerProviderWith(() => interactionWith(WATCHED));
    const { clipId, source } = await save(amy, aYouTubeLink());
    await watch(amy, clipId);

    const stored = sharedAnalysis(source.id);
    assert.ok(stored, "nothing was stored");
    const items = JSON.parse(stored.items);
    assert.equal(items[0].cost, "Rs. 22");
    assert.equal(items[0].sell_price, "Rs. 90");
    assert.equal(items[0].min_order, "12 pieces");
    assert.equal(items[0].where, "Sadar Bazaar");
    assert.equal(sourceRow(source.id).state, "analyzed");
  });

  test("a reel being watched is never handed to the PC", async () => {
    // The whole of "no download at all" is this. While `read_by` is set the machine is not
    // offered the source, so it is never fetched from YouTube.
    //
    // Two guards hold it, and either one alone is enough: the query that picks work up, and
    // the conditional claim that takes it. That is deliberate — the claim is what survives a
    // watch starting in the gap between the two — and it means a mutation of one of them
    // leaves this green. Both have to go before it goes red, which is what was run.
    const { source } = await save(amy, aYouTubeLink());
    harness.database
      .prepare("UPDATE sources SET read_by = 'watch', read_by_at = ? WHERE id = ?")
      .run(Date.now(), source.id);

    const queue = await harness.call(worker, "/v1/queue?limit=50", {
      serviceToken: SERVICE_TOKEN
    });
    const handed = queue.body.sources.map((row) => row.id);
    assert.ok(!handed.includes(source.id), "the PC was offered a reel that is being watched");
    assert.equal(sourceRow(source.id).state, "pending");
  });

  test("a watch the Worker never finished does not strand the reel for ever", async () => {
    // A watch is one request. If that request dies part-way — the platform's own ceiling
    // on a long call, a deploy landing mid-flight — nothing is left to clear the column,
    // and without a clock on it the reel sits out of the PC's queue for ever with no
    // summary and nothing on any screen. That is D56 and Golden Rule 29 both.
    const { source } = await save(amy, aYouTubeLink());
    harness.database
      .prepare("UPDATE sources SET read_by = 'watch', read_by_at = ? WHERE id = ?")
      .run(Date.now() - 60 * 60 * 1000, source.id);

    const queue = await harness.call(worker, "/v1/queue?limit=50", {
      serviceToken: SERVICE_TOKEN
    });
    assert.ok(
      queue.body.sources.map((row) => row.id).includes(source.id),
      "a watch that never finished kept the reel away from the PC for ever"
    );
  });

  test("a watch that fails puts the reel straight back in the PC's queue", async () => {
    // A reel must never be stranded between the two routes with nothing on screen saying
    // so (Golden Rule 29).
    harness.answerProviderWith(() => refusal(503, "service_unavailable"));
    const { clipId, source } = await save(amy, aYouTubeLink());

    const response = await watch(amy, clipId);
    assert.equal(response.status, 400);
    assert.match(response.body.error, /Could not watch it/);

    assert.equal(sourceRow(source.id).read_by, null);
    const queue = await harness.call(worker, "/v1/queue?limit=50", {
      serviceToken: SERVICE_TOKEN
    });
    assert.ok(queue.body.sources.map((row) => row.id).includes(source.id));
  });

  test("hitting the free daily limit says so on his screen, and names the eight hours", async () => {
    // Google allows eight hours of YouTube a day on the free tier. A 429 is a spent
    // allowance, so D35's rotation marks the key and moves on — and once every key is
    // marked it reports its own summary, "all your keys are out of allowance", which sends
    // him to look at keys that have nothing wrong with them. The reason has to survive to
    // the screen (Golden Rule 29).
    //
    // Her own account, because this test deliberately burns a key for an hour.
    const eve = await harness.mintToken("eve");
    await addKey(eve, "gemini", "eve-gemini-key-not-a-real-one", "eve gemini");
    harness.answerProviderWith(() => refusal(429, "resource_exhausted"));
    const { clipId } = await save(eve, aYouTubeLink());

    const response = await watch(eve, clipId);
    assert.equal(response.status, 400);
    assert.match(response.body.error, /8 hours/);
    assert.match(response.body.error, /daily limit/);

    // And against the key itself, so Settings says why it is asleep rather than "rate limit".
    const key = harness.database.prepare("SELECT * FROM ai_keys WHERE label = ?").get("eve gemini");
    assert.equal(key.state, "exhausted");
    assert.match(key.last_error, /8 hours/);
  });

  test("an Instagram reel is refused in a sentence and never sent anywhere", async () => {
    const { clipId } = await save(amy, `https://www.instagram.com/reel/NOTWATCH${saved++}/`);
    const response = await watch(amy, clipId);

    assert.equal(response.status, 400);
    assert.match(response.body.error, /YouTube/);
    assert.equal(harness.providerCalls.length, 0);
  });

  test("watching never replaces a summary that is already there", async () => {
    harness.answerProviderWith(() => interactionWith(WATCHED));
    const { clipId, source } = await save(amy, aYouTubeLink());
    await watch(amy, clipId);
    const first = sharedAnalysis(source.id).created_at;

    harness.providerCalls.length = 0;
    const again = await watch(amy, clipId);
    assert.equal(again.body.already, true);
    assert.equal(harness.providerCalls.length, 0, "it spent an allowance for nothing");
    assert.equal(sharedAnalysis(source.id).created_at, first);
  });

  test("a watched reply is validated exactly as a heard one is, and nothing is stored", async () => {
    // D52's nine findings are about the model returning the right JSON with the wrong thing
    // inside it. This path goes through the same storeAnalysis, so a summary that is not a
    // summary is refused here too.
    harness.answerProviderWith(() => interactionWith({ ...WATCHED, summary: "" }));
    const { clipId, source } = await save(amy, aYouTubeLink());

    const response = await watch(amy, clipId);
    assert.equal(response.status, 400);
    assert.match(response.body.detail, /malformed/);
    assert.equal(sharedAnalysis(source.id), undefined);
    assert.equal(sourceRow(source.id).read_by, null);
  });

  test("only a Gemini key is spent on watching; another provider's is left alone", async () => {
    // Being handed a video address is a Gemini feature. An Anthropic key cannot do it, is
    // not a candidate, and must not be marked as having failed — it is perfectly good for
    // the text path it was connected for.
    const cal = await harness.mintToken("cal");
    await addKey(cal, "anthropic", OTHER_KEY, "cal anthropic");

    const { clipId, source } = await save(cal, aYouTubeLink());
    const response = await watch(cal, clipId);

    assert.equal(response.status, 400);
    assert.match(response.body.error, /Gemini key/);
    assert.equal(harness.providerCalls.length, 0);

    const key = harness.database.prepare("SELECT * FROM ai_keys WHERE label = ?").get("cal anthropic");
    assert.equal(key.state, "ready");
    assert.equal(key.last_error, null);
    assert.equal(sourceRow(source.id).read_by, null);
  });

  test("whose allowance pays is D10 unchanged: the first saver's key, not the presser's", async () => {
    // Ben has a perfectly good key OF HIS OWN. He saves a reel Amy had already saved, and
    // he is the one who presses. Amy's key still pays, because she saved it first — that
    // is D10, the same rule the automatic run has always used, and this build invents no
    // new one. Ben having his own key is the whole point of the test: without it, "the
    // presser pays" and "the first saver pays" cannot be told apart.
    await addKey(ben, "gemini", BENS_KEY, "ben gemini");
    harness.answerProviderWith(() => interactionWith(WATCHED));
    const link = aYouTubeLink();
    await save(amy, link);
    const bens = await save(ben, link);

    const response = await watch(ben, bens.clipId);
    assert.equal(response.status, 200);
    assert.equal(harness.providerCalls.length, 1);
    assert.equal(keyUsed(harness.providerCalls[0].options), GEMINI_KEY);
    assert.notEqual(keyUsed(harness.providerCalls[0].options), BENS_KEY);
  });

  test("a reel only he saved, with no key of his own, is told plainly and left alone", async () => {
    // This is his own account exactly: no AI key on it. Watching builds correctly and does
    // nothing, and the app has to say why rather than sit there.
    const dan = await harness.mintToken("dan");
    const { clipId, source } = await save(dan, aYouTubeLink());

    const response = await watch(dan, clipId);
    assert.equal(response.status, 400);
    assert.match(response.body.error, /Gemini key/);
    assert.equal(harness.providerCalls.length, 0);
    assert.equal(sourceRow(source.id).read_by, null);
  });

  test("somebody else's clip cannot be watched on his savers' allowance", async () => {
    const { clipId } = await save(amy, aYouTubeLink());
    const response = await watch(ben, clipId);
    assert.equal(response.status, 404);
    assert.equal(harness.providerCalls.length, 0);
  });
});

// ---------------------------------------------------------------- the app's own page
//
// A route nothing in the app can reach is a feature that does not exist (D44). These run
// `index.html` itself against a real-shaped notebook: the offer has to be ON the clip's
// page, for the right reels, with what it costs written beside it — not in a tooltip
// (Golden Rule 28) and not only in a log (Golden Rule 29).

const when = Date.now();

function notebookWith(platform) {
  return syncPayload({
    clips: [{
      id: "c1", user_id: "vish", source_id: "s1", status: "inbox",
      topic_id: null, topic_set_by: null, relooked_at: null,
      created_at: when - 1000, updated_at: when, deleted_at: null
    }],
    sources: [{
      id: "s1",
      url_canonical: "https://youtube.com/watch?v=abc",
      url_original: "https://youtube.com/watch?v=abc",
      platform,
      title: "A reel", creator: null, duration_sec: null, state: "pending",
      error: null, error_detail: null, attempts: 0,
      created_at: when - 1000, updated_at: when
    }],
    analyses: [],
    transcripts: []
  });
}

const wordsOn = (app) =>
  app.$("clipView").walk().map((one) => one.textContent || "").join(" ");

describe("the offer on the clip's page", () => {
  test("a YouTube reel with nothing written down yet is offered watching", async () => {
    const app = await loadApp(notebookWith("YouTube"), { hash: "#/clip/c1" });
    assert.match(wordsOn(app), /Watch it instead/);
  });

  test("what it costs is written beside the button, not hidden in a tooltip", async () => {
    // Google's page says the YouTube feature is free while in preview, caps the free tier
    // at eight hours of video a day, and warns the price and limits are likely to change.
    // He reads that BEFORE he presses, or he has not been told (Golden Rule 28).
    const app = await loadApp(notebookWith("YouTube"), { hash: "#/clip/c1" });
    const words = wordsOn(app);
    assert.match(words, /8 hours/);
    assert.match(words, /likely to change/);
    // And that nothing knows how long it is, because nothing has been fetched (D42's
    // protection, said in the only way it can be said here).
    assert.match(words, /how long this video is is not/);
  });

  test("an Instagram reel is never offered it, because it cannot be done", async () => {
    const app = await loadApp(notebookWith("Instagram"), { hash: "#/clip/c1" });
    assert.doesNotMatch(wordsOn(app), /Watch it instead/);
  });
});
