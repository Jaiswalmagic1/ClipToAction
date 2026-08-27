// Long videos (D33). The 30-minute ceiling is gone, and the thing that actually had to
// change was not the number — it was what gets asked of the AI.
//
// Three promises run through all of this:
//
//   * A reel is untouched. It gets the same prompt, the same limits and the same stored
//     row it got before any of this existed. The whole feature is additive or it is a
//     regression wearing a feature's clothes.
//   * The long shape is the short shape PLUS chapters. Every field the app, the connector
//     and topic filing already read is still there, so none of them had to change.
//   * The tidying never reaches the database. What is stored is word for word what was
//     said; only the copy handed to the AI has the hesitation taken out of it.

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";

import worker from "../src/worker.js";
import { validateAnalysis } from "../src/worker.js";
import {
  ANALYSIS_PROMPT,
  LONG_ANALYSIS_PROMPT,
  LONG_VIDEO_SEC,
  isLong,
  promptFor,
  tidyTranscript
} from "../src/analyze.js";
import { createTestEnv } from "./helpers/testenv.js";

const SERVICE_TOKEN = "service-token-for-tests";
const NINETY_MINUTES = 90 * 60;

describe("where the line between a clip and a long video falls", () => {
  test("ten minutes is still a clip, and a second past it is not", () => {
    assert.equal(isLong(LONG_VIDEO_SEC), false, "exactly ten minutes is still short");
    assert.equal(isLong(LONG_VIDEO_SEC + 1), true);
  });

  test("a video that never reported its length is treated as short", () => {
    // Instagram reports no duration (see HANDOVER.md). Guessing "long" there would send
    // every Instagram reel the wrong prompt and ask for chapters that cannot exist.
    for (const unknown of [0, null, undefined, ""]) {
      assert.equal(isLong(unknown), false);
    }
  });

  test("each length gets its own prompt, and they are genuinely different asks", () => {
    assert.equal(promptFor(60), ANALYSIS_PROMPT);
    assert.equal(promptFor(NINETY_MINUTES), LONG_ANALYSIS_PROMPT);

    assert.match(ANALYSIS_PROMPT, /3-4 sentences/);
    assert.doesNotMatch(ANALYSIS_PROMPT, /sections/, "a reel is never asked for chapters");
    assert.match(LONG_ANALYSIS_PROMPT, /"sections"/);
    assert.match(LONG_ANALYSIS_PROMPT, /8-12 sentences/);
  });

  test("the long prompt still asks for every field the short one does", () => {
    for (const field of [
      "summary",
      "key_points",
      "learn_more",
      "claims",
      "suggested_task",
      "topic",
      "sub_topic"
    ]) {
      assert.match(
        LONG_ANALYSIS_PROMPT,
        new RegExp(`"${field}"`),
        `${field} is read by the app, the connector or topic filing — dropping it breaks them`
      );
    }
  });

  test("the long prompt forbids inventing a time", () => {
    assert.match(LONG_ANALYSIS_PROMPT, /Never invent a time/);
  });
});

describe("tidying the transcript for the AI", () => {
  test("standalone hesitation goes", () => {
    assert.equal(tidyTranscript("So, um, the price went up."), "So, the price went up.");
    // Nothing is recapitalised. Taking a word off the front leaves the next one lower
    // case, which reads oddly and matters to nobody: only the AI ever sees this copy.
    assert.equal(tidyTranscript("Uh, yes. Hmm, maybe."), "yes. maybe.");
  });

  test("a real word that merely contains one is left alone", () => {
    // The whole risk of this feature in one test. "I'm", "summary" and "human" all carry
    // meaning, and a filter that reached inside a word would quietly wreck the transcript.
    const kept = "I'm humming a summary of the human umbrella museum.";
    assert.equal(tidyTranscript(kept), kept);
  });

  test("the time markers survive, because the AI is told to copy them", () => {
    const marked = "[0:00:00] Welcome. [0:14:32] Now, um, the pricing part.";
    const tidied = tidyTranscript(marked);
    assert.match(tidied, /\[0:00:00\]/);
    assert.match(tidied, /\[0:14:32\]/);
    assert.doesNotMatch(tidied, /um/);
  });

  test("whisper's loop on silence collapses to one", () => {
    const looped = "Thanks for watching. Thanks for watching. Thanks for watching. Now the real point.";
    assert.equal(tidyTranscript(looped), "Thanks for watching. Now the real point.");
  });

  test("a stutter inside a sentence collapses too", () => {
    assert.equal(tidyTranscript("The the the price is fixed."), "The price is fixed.");
  });

  test("a sentence legitimately repeated later in the video is kept", () => {
    // Only an IMMEDIATE repeat is whisper stuttering. The same line said again ten minutes
    // on is the speaker making a point twice, and dropping it would lose real content.
    const text = "Price it high. Then explain why. Price it high.";
    assert.equal(tidyTranscript(text), text);
  });

  test("it is safe on the empty and the absent", () => {
    assert.equal(tidyTranscript(""), "");
    assert.equal(tidyTranscript(null), "");
  });

  test("an hour of speech tidies quickly, not eventually", () => {
    // A back-reference regex for repeated sentences passed every test above and then took
    // longer than the analysis itself on real input. This pins the cheap implementation.
    const hour = "Right, um, so the margin on this is about twelve percent. ".repeat(12000);
    const started = Date.now();
    tidyTranscript(hour);
    assert.ok(Date.now() - started < 3000, "tidying must not become the slow part");
  });
});

describe("what counts as a valid analysis depends on the length", () => {
  const base = {
    summary: "It explains how to price handmade jewellery.",
    key_points: ["Cost plus 2.5x"],
    learn_more: ["keystone pricing"],
    claims: [{ claim: "Most sellers underprice", confidence: "low", why: "no source" }],
    suggested_task: null
  };

  test("a reel is judged exactly as it was before any of this", () => {
    assert.deepEqual(validateAnalysis(base), []);
    assert.deepEqual(validateAnalysis(base, 60), []);
  });

  test("a long video's longer answer is accepted, and a reel's is not", () => {
    const many = { ...base, key_points: Array.from({ length: 120 }, (_, i) => `point ${i}`) };
    assert.deepEqual(validateAnalysis(many, NINETY_MINUTES), []);
    assert.deepEqual(validateAnalysis(many, 60), ["key_points has too many items"]);
  });

  test("a long video's longer summary is accepted, and a reel's is not", () => {
    const long = { ...base, summary: "x".repeat(12000) };
    assert.deepEqual(validateAnalysis(long, NINETY_MINUTES), []);
    assert.deepEqual(validateAnalysis(long, 60), ["summary is too long"]);
  });

  test("chapters are optional, like a topic — a long video without them still stores", () => {
    assert.deepEqual(validateAnalysis(base, NINETY_MINUTES), []);
    assert.deepEqual(validateAnalysis({ ...base, sections: null }, NINETY_MINUTES), []);
  });

  test("chapters of the wrong type are a malformed reply, not a missing field", () => {
    assert.deepEqual(
      validateAnalysis({ ...base, sections: "chapter one" }, NINETY_MINUTES),
      ["sections"]
    );
  });

  test("a runaway number of chapters is refused", () => {
    const runaway = {
      ...base,
      sections: Array.from({ length: 200 }, (_, i) => ({ at: "0:00:00", heading: `h${i}` }))
    };
    assert.deepEqual(validateAnalysis(runaway, NINETY_MINUTES), ["sections has too many items"]);
  });
});

describe("a ninety-minute video, end to end", () => {
  const SPOKEN =
    "[0:00:00] Right, um, so today we are talking about pricing. " +
    "[0:00:30] The margin on handmade pieces is about twelve percent.";

  const LONG_ANALYSIS = {
    summary: "A ninety minute conversation about pricing handmade jewellery, covering margin, positioning and when to raise prices.",
    sections: [
      { at: "0:00:00", heading: "What the talk is about", detail: "The speaker sets out the ground." },
      { at: "0:00:30", heading: "Margins on handmade pieces", detail: "Twelve percent is named." }
    ],
    key_points: ["margin is about twelve percent"],
    learn_more: ["keystone pricing"],
    claims: [{ claim: "twelve percent is typical", confidence: "medium", why: "one speaker's figure" }],
    suggested_task: "Recheck the margin on the top 10 pieces",
    topic: "Pricing",
    sub_topic: "Handmade jewellery"
  };

  let harness;
  let amy;
  let sourceId;
  let clipId;

  before(async () => {
    harness = await createTestEnv();
    amy = await harness.mintToken("amy");

    await harness.call(worker, "/v1/settings", {
      method: "PUT",
      token: amy,
      body: { provider: "gemini", api_key: "amys-key-value-not-a-real-one" }
    });
    harness.answerProviderWith(() => harness.geminiReplyWith(LONG_ANALYSIS));

    await harness.call(worker, "/v1/clips", {
      method: "POST",
      token: amy,
      body: { url: "https://www.youtube.com/watch?v=LONGTALK01" }
    });

    const source = harness.database
      .prepare("SELECT * FROM sources WHERE url_canonical LIKE ?")
      .get("%LONGTALK01%");
    sourceId = source.id;
    harness.database.prepare("UPDATE sources SET state = 'downloading' WHERE id = ?").run(sourceId);

    const response = await harness.call(worker, `/v1/sources/${sourceId}/transcript`, {
      method: "POST",
      serviceToken: SERVICE_TOKEN,
      body: {
        text: SPOKEN,
        lang: "en",
        engine: "faster-whisper:small:translate",
        title: "Pricing handmade jewellery",
        duration_sec: NINETY_MINUTES
      }
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.analyzed, true);

    clipId = harness.database
      .prepare("SELECT id FROM clips WHERE user_id = ? AND source_id = ?")
      .get("amy", sourceId).id;
  });

  after(() => {
    harness.answerProviderWith(null);
    harness.restore();
  });

  const sentBody = () => JSON.parse(harness.providerCalls[0].options.body);
  const sentPrompt = () => sentBody().contents[0].parts[0].text;

  test("the AI was sent the long prompt, not the reel one", () => {
    assert.match(sentPrompt(), /LONG video/, "a ninety minute talk must not get the reel prompt");
    assert.match(sentPrompt(), /"sections"/);
  });

  test("the AI was given room to answer at length", () => {
    // At the reel's ceiling a chaptered reply runs out mid-sentence, and a cut-off reply is
    // not a shorter answer — it is unparseable JSON that reaches the user as an error.
    assert.ok(
      sentBody().generationConfig.maxOutputTokens > 4096,
      "a chaptered reply does not fit in a reel's output budget"
    );
  });

  test("the hesitation was taken out of what the AI was sent", () => {
    assert.doesNotMatch(sentPrompt(), /Right, um, so today/);
    assert.match(sentPrompt(), /Right, so today we are talking about pricing/);
  });

  test("and the time markers reached it intact", () => {
    // Chapters are only possible because these survive the tidying. If they stopped
    // arriving, the AI would invent times instead of copying them.
    assert.match(sentPrompt(), /\[0:00:00\]/);
    assert.match(sentPrompt(), /\[0:00:30\]/);
  });

  test("but the transcript stored is word for word what was said", () => {
    const stored = harness.database
      .prepare("SELECT text FROM transcripts WHERE source_id = ?")
      .get(sourceId);
    assert.equal(stored.text, SPOKEN, "tidying is for the AI only and must never be stored");
  });

  test("the chapters were stored, with the times they came back with", () => {
    const row = harness.database
      .prepare("SELECT sections FROM analyses WHERE source_id = ? AND user_id = ''")
      .get(sourceId);
    const sections = JSON.parse(row.sections);
    assert.equal(sections.length, 2);
    assert.equal(sections[0].at, "0:00:00");
    assert.equal(sections[1].heading, "Margins on handmade pieces");
  });

  test("everything the app already read is still there", () => {
    const row = harness.database
      .prepare("SELECT * FROM analyses WHERE source_id = ? AND user_id = ''")
      .get(sourceId);
    assert.ok(row.summary);
    assert.deepEqual(JSON.parse(row.key_points), ["margin is about twelve percent"]);
    assert.equal(row.topic, "Pricing");
    assert.equal(row.sub_topic, "Handmade jewellery");
  });

  test("sync hands the chapters to the app", async () => {
    const response = await harness.call(worker, "/v1/sync?since=0", { token: amy });
    const analysis = response.body.analyses.find((a) => a.source_id === sourceId);
    assert.ok(analysis, "the analysis must reach the app at all");
    assert.equal(JSON.parse(analysis.sections)[1].at, "0:00:30");
  });

  test("the copy-paste tier is handed the same prompt a connected key would have sent", async () => {
    // D9's three tiers must produce the same shape. If the pasted prompt were the reel one,
    // somebody with no key would get a 3-sentence summary of a ninety-minute talk and no
    // chapters, for the same video that gives a keyed user both.
    const response = await harness.call(worker, `/v1/clips/${clipId}/prompt`, { token: amy });
    assert.equal(response.status, 200);
    assert.match(response.body.prompt, /LONG video/);
    assert.match(response.body.prompt, /"sections"/);
    assert.doesNotMatch(response.body.prompt, /Right, um, so today/);
  });
});

describe("a reel is left exactly as it was", () => {
  const REEL_ANALYSIS = {
    summary: "Three ways to price handmade jewellery.",
    key_points: ["Cost plus 2.5x"],
    learn_more: ["keystone pricing"],
    claims: [{ claim: "sellers underprice", confidence: "low", why: "no source" }],
    suggested_task: null,
    topic: "Pricing",
    sub_topic: null
  };

  let harness;
  let amy;
  let sourceId;

  before(async () => {
    harness = await createTestEnv();
    amy = await harness.mintToken("amy");

    await harness.call(worker, "/v1/settings", {
      method: "PUT",
      token: amy,
      body: { provider: "gemini", api_key: "amys-key-value-not-a-real-one" }
    });
    harness.answerProviderWith(() => harness.geminiReplyWith(REEL_ANALYSIS));

    await harness.call(worker, "/v1/clips", {
      method: "POST",
      token: amy,
      body: { url: "https://www.instagram.com/reel/SHORTONE1/" }
    });

    const source = harness.database
      .prepare("SELECT * FROM sources WHERE url_canonical LIKE ?")
      .get("%SHORTONE1%");
    sourceId = source.id;
    harness.database.prepare("UPDATE sources SET state = 'downloading' WHERE id = ?").run(sourceId);

    await harness.call(worker, `/v1/sources/${sourceId}/transcript`, {
      method: "POST",
      serviceToken: SERVICE_TOKEN,
      // Instagram reports no duration at all, so this is the commonest case in the product.
      body: { text: "price it at cost plus two and a half times", lang: "en", engine: "test" }
    });
  });

  after(() => {
    harness.answerProviderWith(null);
    harness.restore();
  });

  test("it still gets the reel prompt, with no mention of chapters", () => {
    const sent = JSON.parse(harness.providerCalls[0].options.body).contents[0].parts[0].text;
    assert.match(sent, /short social-media video/);
    assert.doesNotMatch(sent, /"sections"/);
  });

  test("its stored row has no chapters, exactly as before they existed", () => {
    const row = harness.database
      .prepare("SELECT sections FROM analyses WHERE source_id = ? AND user_id = ''")
      .get(sourceId);
    assert.equal(row.sections, null, "null, not '[]' — a reel's row must be unchanged");
  });
});
