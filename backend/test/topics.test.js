// Topics (D27). Two rules run through all of this and are what these tests exist to pin:
//
//   * The AI names a topic from the reel ALONE. It is never shown anyone's topic list,
//     because the analysis it produces is shared by everyone who saved that reel (D10).
//     The moment a topic list reaches the prompt, one analysis stops serving two people
//     and the cost model is gone.
//   * The topic ROWS are per-user (D18). The same proposed name lands in one person's
//     notebook and creates another person's, and neither can touch the other.
//
// Plus the promise that a topic you set by hand is final.

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";

import worker from "../src/worker.js";
import { cleanTopicName, normaliseTopicName } from "../src/topics.js";
import { createTestEnv } from "./helpers/testenv.js";

const SERVICE_TOKEN = "service-token-for-tests";

describe("matching names, so one subject does not split in two", () => {
  test("case, spacing and plurals all meet on one key", () => {
    const key = normaliseTopicName("Amazon Listings");
    assert.equal(normaliseTopicName("amazon listing"), key);
    assert.equal(normaliseTopicName("  AMAZON   LISTING  "), key);
    assert.equal(normaliseTopicName("Amazon listings!"), key);
    assert.equal(normaliseTopicName("The Amazon Listings"), key);
  });

  test("the awkward plurals still meet", () => {
    assert.equal(normaliseTopicName("Pricing Strategies"), normaliseTopicName("pricing strategy"));
    assert.equal(normaliseTopicName("Taxes"), normaliseTopicName("tax"));
  });

  test("a word that merely ends in s is not butchered", () => {
    assert.equal(normaliseTopicName("Business"), "business");
    assert.equal(normaliseTopicName("Analysis"), "analysis");
  });

  test("different subjects stay different", () => {
    assert.notEqual(normaliseTopicName("Amazon listings"), normaliseTopicName("Meesho listings"));
    assert.notEqual(normaliseTopicName("pricing"), normaliseTopicName("packaging"));
  });

  test("a name that says nothing is treated as no name at all", () => {
    for (const junk of ["", "   ", "null", "None", "n/a", "Unknown", "General", null, undefined]) {
      assert.equal(cleanTopicName(junk), "", "this should not become a topic");
    }
  });

  test("quotes and padding the model adds are stripped, not stored", () => {
    assert.equal(cleanTopicName('  "Amazon listings"  '), "Amazon listings");
    assert.equal(cleanTopicName("Amazon\n  listings"), "Amazon listings");
  });

  test("a whole sentence is dropped rather than cut off mid-word", () => {
    const sentence = "How to fix your Amazon listings when the conversion rate has collapsed";
    assert.equal(cleanTopicName(sentence), "");
  });
});

describe("the AI names a topic, and each notebook files it for itself", () => {
  const ANALYSIS = {
    summary: "The video explains how to rewrite an Amazon title so it ranks.",
    key_points: ["put the keyword first", "keep it under 200 characters"],
    learn_more: ["Amazon A9"],
    claims: [{ claim: "titles drive 60% of ranking", confidence: "low", why: "no source" }],
    suggested_task: "Rewrite the top 10 titles",
    topic: "Amazon listings",
    sub_topic: "Titles"
  };

  let harness;
  let amy;
  let ben;

  const reel = (name) => "https://www.instagram.com/reel/" + name + "/";
  const save = (token, name) =>
    harness.call(worker, "/v1/clips", { method: "POST", token, body: { url: reel(name) } });

  const sourceFor = (name) =>
    harness.database.prepare("SELECT * FROM sources WHERE url_canonical LIKE ?").get("%" + name + "%");

  const clipFor = (user, name) =>
    harness.database
      .prepare("SELECT * FROM clips WHERE user_id = ? AND source_id = ?")
      .get(user, sourceFor(name).id);

  const topicsOf = (user) =>
    harness.database
      .prepare("SELECT * FROM topics WHERE user_id = ? ORDER BY parent_id, name")
      .all(user);

  const transcribe = async (name) => {
    const source = sourceFor(name);
    harness.database.prepare("UPDATE sources SET state = 'downloading' WHERE id = ?").run(source.id);
    const response = await harness.call(worker, "/v1/sources/" + source.id + "/transcript", {
      method: "POST",
      serviceToken: SERVICE_TOKEN,
      body: { text: "the words that were said in the video", lang: "en", engine: "test" }
    });
    assert.equal(response.status, 200);
  };

  before(async () => {
    harness = await createTestEnv();
    amy = await harness.mintToken("amy");
    ben = await harness.mintToken("ben");

    // Amy holds the key, so the automatic run at transcript time is charged to her.
    await harness.call(worker, "/v1/settings", {
      method: "PUT",
      token: amy,
      body: { provider: "gemini", api_key: "amys-key-value-not-a-real-one" }
    });
    harness.answerProviderWith(() => harness.geminiReplyWith(ANALYSIS));

    // Both save the same reel BEFORE it is transcribed, so one analysis has to serve two
    // notebooks — the case the whole cost model rests on.
    await save(amy, "TOPIC1");
    await save(ben, "TOPIC1");
    await transcribe("TOPIC1");
  });

  after(() => {
    harness.answerProviderWith(null);
    harness.restore();
  });

  test("one reel, one call to the AI, however many people saved it", () => {
    assert.equal(harness.providerCalls.length, 1, "a second call means the analysis is not shared");
  });

  test("the prompt carries the transcript and nobody's topic list", () => {
    const prompt = harness.providerCalls[0].options.body;

    assert.match(prompt, /the words that were said in the video/, "the transcript must be sent");
    assert.match(prompt, /You have not been shown anyone/, "the AI is told it is naming blind");
    assert.doesNotMatch(
      prompt,
      /existing topics:|your topics|topic list:/i,
      "showing the AI a topic list would make this analysis personal and unshareable (D10)"
    );
  });

  test("the proposed name is stored once, on the shared analysis", () => {
    const rows = harness.database
      .prepare("SELECT user_id, topic, sub_topic FROM analyses WHERE source_id = ?")
      .all(sourceFor("TOPIC1").id);

    assert.equal(rows.length, 1, "one analysis, not one per user");
    assert.equal(rows[0].user_id, "", "it is the shared row");
    assert.equal(rows[0].topic, "Amazon listings");
    assert.equal(rows[0].sub_topic, "Titles");
  });

  test("each person gets their OWN topic rows, never a shared one", () => {
    const amys = topicsOf("amy");
    const bens = topicsOf("ben");

    assert.equal(amys.length, 2, "a topic and a sub-topic");
    assert.equal(bens.length, 2);
    assert.deepEqual(amys.map((row) => row.name).sort(), ["Amazon listings", "Titles"]);

    const shared = amys.filter((row) => bens.some((other) => other.id === row.id));
    assert.equal(shared.length, 0, "two notebooks must never point at the same topic row");
  });

  test("the sub-topic sits under the topic, not beside it", () => {
    const parent = topicsOf("amy").find((row) => row.parent_id === "");
    const child = topicsOf("amy").find((row) => row.parent_id !== "");

    assert.equal(parent.name, "Amazon listings");
    assert.equal(child.name, "Titles");
    assert.equal(child.parent_id, parent.id);
  });

  test("the clip is filed at the deepest level named, in each person's own notebook", () => {
    const amysChild = topicsOf("amy").find((row) => row.parent_id !== "");
    const bensChild = topicsOf("ben").find((row) => row.parent_id !== "");

    assert.equal(clipFor("amy", "TOPIC1").topic_id, amysChild.id);
    assert.equal(clipFor("ben", "TOPIC1").topic_id, bensChild.id);
    assert.equal(clipFor("amy", "TOPIC1").topic_set_by, "ai");
  });

  test("a name differing only by case or plural reuses the topic instead of splitting it", async () => {
    harness.answerProviderWith(() =>
      harness.geminiReplyWith({ ...ANALYSIS, topic: "amazon listing", sub_topic: "titles" })
    );

    await save(amy, "TOPIC2");
    await transcribe("TOPIC2");

    assert.equal(topicsOf("amy").length, 2, "'amazon listing' must land in 'Amazon listings'");
    assert.equal(
      clipFor("amy", "TOPIC2").topic_id,
      clipFor("amy", "TOPIC1").topic_id,
      "both clips belong in the same place"
    );

    harness.answerProviderWith(() => harness.geminiReplyWith(ANALYSIS));
  });

  test("saving a reel someone else already had summarised files it with no new AI call", async () => {
    const callsBefore = harness.providerCalls.length;
    await save(ben, "TOPIC2");

    assert.equal(harness.providerCalls.length, callsBefore, "the name was already known — D10");
    assert.ok(clipFor("ben", "TOPIC2").topic_id, "it should not arrive unsorted");
    assert.equal(clipFor("ben", "TOPIC2").topic_set_by, "ai");
  });

  test("sync hands the app the topics and where each clip sits", async () => {
    const sync = await harness.call(worker, "/v1/sync", { token: amy });

    assert.equal(sync.status, 200);
    assert.ok(sync.body.topics.some((row) => row.name === "Amazon listings"));
    assert.ok(sync.body.topics.every((row) => row.user_id === "amy"), "never another user's topics");
    assert.ok(sync.body.clips.every((clip) => "topic_id" in clip && "topic_set_by" in clip));
  });

  test("a reel the AI gave no topic to is left unfiled rather than filed under nothing", async () => {
    const noTopic = { ...ANALYSIS };
    delete noTopic.topic;
    delete noTopic.sub_topic;
    harness.answerProviderWith(() => harness.geminiReplyWith(noTopic));

    await save(amy, "NOTOPIC");
    await transcribe("NOTOPIC");

    assert.equal(clipFor("amy", "NOTOPIC").topic_id, null);
    assert.equal(sourceFor("NOTOPIC").state, "analyzed", "a missing topic is not a failed analysis");
    assert.ok(
      harness.database
        .prepare("SELECT summary FROM analyses WHERE source_id = ?")
        .get(sourceFor("NOTOPIC").id).summary,
      "the summary is still stored — it is good work"
    );

    harness.answerProviderWith(() => harness.geminiReplyWith(ANALYSIS));
  });

  test("what you set by hand is final — nothing automatic moves it again", async () => {
    const clip = clipFor("amy", "TOPIC1");
    const set = await harness.call(worker, "/v1/clips/" + clip.id + "/topic", {
      method: "PUT",
      token: amy,
      body: { topic: "Packaging", sub_topic: null }
    });
    assert.equal(set.status, 200);

    const moved = clipFor("amy", "TOPIC1");
    assert.equal(moved.topic_set_by, "user");
    assert.equal(topicsOf("amy").find((row) => row.id === moved.topic_id).name, "Packaging");

    // Every automatic filing route, aimed at this clip in turn.
    await save(amy, "TOPIC1");
    const sorted = await harness.call(worker, "/v1/topics/sort", { method: "POST", token: amy });
    assert.equal(sorted.status, 200);

    assert.equal(clipFor("amy", "TOPIC1").topic_id, moved.topic_id, "it must not have been moved");
    assert.equal(clipFor("amy", "TOPIC1").topic_set_by, "user");
  });

  test("another person's clip cannot be refiled", async () => {
    const response = await harness.call(worker, "/v1/clips/" + clipFor("ben", "TOPIC1").id + "/topic", {
      method: "PUT",
      token: amy,
      body: { topic: "Nonsense" }
    });

    assert.equal(response.status, 404);
    assert.ok(
      !topicsOf("amy").some((row) => row.name === "Nonsense"),
      "a refused request must not leave a topic behind"
    );
  });
});

describe("sorting the clips that were summarised before topics existed", () => {
  const OLD_ANALYSIS = {
    summary: "The video explains how to photograph jewellery on a white background.",
    key_points: ["use diffused light"],
    learn_more: ["softbox"],
    claims: [],
    suggested_task: null
  };

  let harness;
  let cara;
  let dan;

  const reel = (name) => "https://www.instagram.com/reel/" + name + "/";
  const save = (token, name) =>
    harness.call(worker, "/v1/clips", { method: "POST", token, body: { url: reel(name) } });

  const sourceFor = (name) =>
    harness.database.prepare("SELECT * FROM sources WHERE url_canonical LIKE ?").get("%" + name + "%");

  const clipFor = (user, name) =>
    harness.database
      .prepare("SELECT * FROM clips WHERE user_id = ? AND source_id = ?")
      .get(user, sourceFor(name).id);

  const transcribe = async (name) => {
    const source = sourceFor(name);
    harness.database.prepare("UPDATE sources SET state = 'downloading' WHERE id = ?").run(source.id);
    await harness.call(worker, "/v1/sources/" + source.id + "/transcript", {
      method: "POST",
      serviceToken: SERVICE_TOKEN,
      body: { text: "the words that were said", lang: "en", engine: "test" }
    });
  };

  before(async () => {
    harness = await createTestEnv();
    cara = await harness.mintToken("cara");
    dan = await harness.mintToken("dan");

    await harness.call(worker, "/v1/settings", {
      method: "PUT",
      token: cara,
      body: { provider: "gemini", api_key: "caras-key-value-not-a-real-one" }
    });

    // The state this feature exists for: summarised by a prompt that had never heard of
    // topics, so the analysis is good and the topic column is empty.
    harness.answerProviderWith(() => harness.geminiReplyWith(OLD_ANALYSIS));
    await save(cara, "OLD1");
    await save(cara, "OLD2");
    await transcribe("OLD1");
    await transcribe("OLD2");
  });

  after(() => {
    harness.answerProviderWith(null);
    harness.restore();
  });

  test("they start unfiled, with their summaries intact", () => {
    assert.equal(clipFor("cara", "OLD1").topic_id, null);
    assert.equal(clipFor("cara", "OLD2").topic_id, null);
    assert.ok(
      harness.database
        .prepare("SELECT summary FROM analyses WHERE source_id = ?")
        .get(sourceFor("OLD1").id).summary
    );
  });

  test("one press names them from the summary already stored, and never re-summarises", async () => {
    harness.answerProviderWith((url, options) => {
      assert.match(options.body, /photograph jewellery on a white background/, "the summary is the input");
      assert.doesNotMatch(options.body, /the words that were said/, "the transcript must not be re-sent");
      return harness.geminiReplyWith({ topic: "Product photography", sub_topic: "Lighting" });
    });

    const response = await harness.call(worker, "/v1/topics/sort", { method: "POST", token: cara });

    assert.equal(response.status, 200);
    assert.equal(response.body.sorted, 2);
    assert.equal(response.body.remaining, 0);
    assert.equal(response.body.error, null);

    const summary = harness.database
      .prepare("SELECT summary FROM analyses WHERE source_id = ?")
      .get(sourceFor("OLD1").id).summary;
    assert.match(summary, /photograph jewellery/, "the summary must be untouched");
  });

  test("both land in one topic, not one topic each", () => {
    assert.ok(clipFor("cara", "OLD1").topic_id);
    assert.equal(clipFor("cara", "OLD1").topic_id, clipFor("cara", "OLD2").topic_id);
    assert.equal(clipFor("cara", "OLD1").topic_set_by, "ai");
  });

  test("the name is written back to the shared analysis, so the next saver gets it free", async () => {
    const stored = harness.database
      .prepare("SELECT topic, sub_topic FROM analyses WHERE source_id = ? AND user_id = ''")
      .get(sourceFor("OLD1").id);
    assert.equal(stored.topic, "Product photography");
    assert.equal(stored.sub_topic, "Lighting");

    const callsBefore = harness.providerCalls.length;
    await save(dan, "OLD1");

    assert.equal(harness.providerCalls.length, callsBefore, "no second call for a reel already named");
    assert.ok(clipFor("dan", "OLD1").topic_id, "Dan's clip is filed");
    assert.notEqual(
      clipFor("dan", "OLD1").topic_id,
      clipFor("cara", "OLD1").topic_id,
      "into Dan's own topic row, not Cara's"
    );
  });

  test("pressing it again does nothing and costs nothing", async () => {
    const callsBefore = harness.providerCalls.length;
    const response = await harness.call(worker, "/v1/topics/sort", { method: "POST", token: cara });

    assert.equal(response.body.sorted, 0);
    assert.equal(response.body.remaining, 0);
    assert.equal(harness.providerCalls.length, callsBefore);
  });

  test("a clip the AI cannot name leaves the queue instead of being asked about for ever", async () => {
    // The app presses sort while `remaining` is above zero. A clip that can never be
    // named has to stop counting as remaining, or that loop never ends and every press
    // spends another call on the same hopeless clip.
    harness.answerProviderWith(() => harness.geminiReplyWith(OLD_ANALYSIS));
    await save(cara, "UNNAMEABLE");
    await transcribe("UNNAMEABLE");

    harness.answerProviderWith(() => harness.geminiReplyWith({ topic: "None", sub_topic: null }));
    const first = await harness.call(worker, "/v1/topics/sort", { method: "POST", token: cara });

    assert.equal(first.status, 200);
    assert.equal(first.body.sorted, 0, "nothing could be named");
    assert.equal(first.body.remaining, 0, "but nothing is left waiting either");
    assert.equal(clipFor("cara", "UNNAMEABLE").topic_id, null, "it is still unfiled, honestly");

    const callsBefore = harness.providerCalls.length;
    const second = await harness.call(worker, "/v1/topics/sort", { method: "POST", token: cara });

    assert.equal(second.body.remaining, 0);
    assert.equal(harness.providerCalls.length, callsBefore, "a second press must not cost anything");
  });

  test("without a key it says so plainly rather than failing quietly", async () => {
    // Cara's key summarises it, back when there were no topics, so the shared analysis has
    // a summary and no name. Dan then saves the same reel and has nothing to name it with.
    harness.answerProviderWith(() => harness.geminiReplyWith(OLD_ANALYSIS));
    await save(cara, "OLD3");
    await transcribe("OLD3");
    await save(dan, "OLD3");
    assert.equal(clipFor("dan", "OLD3").topic_id, null, "there was no name to file it under");

    const response = await harness.call(worker, "/v1/topics/sort", { method: "POST", token: dan });

    assert.equal(response.status, 400);
    assert.match(response.body.error, /Connect an AI account/);
  });
});
