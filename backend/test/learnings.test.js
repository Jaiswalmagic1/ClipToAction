// The learning loop (D29). What these tests exist to pin:
//
//   * A learning belongs to ONE person and one of their clips. It is the first thing an
//     outside AI app will ever write into this database, so "Ben cannot write onto Amy's
//     reel, and never sees hers" has to be true before a connector exists, not after.
//   * The shape is fixed. The whole point of seven fields instead of free text is that a
//     learning can be filtered and searched a year later — a verdict of "probably true"
//     quietly turns the notebook back into prose.
//   * The paste route and the connector route land on the SAME validation. A second,
//     laxer door into the table is how the shape stops being fixed.

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";

import worker from "../src/worker.js";
import { buildLearningPrompt, validateLearning, learningColumns } from "../src/learnings.js";
import { createTestEnv } from "./helpers/testenv.js";

const SERVICE_TOKEN = "service-token-for-tests";

const GOOD = {
  learned: ["Amazon reads the first 80 characters of a title before anything else."],
  verdicts: [
    { claim: "titles drive 60% of ranking", verdict: "false", why: "no source, and the number moves" },
    { claim: "keyword first helps", verdict: "true", why: "matches Amazon's own style guide" }
  ],
  actions: ["Rewrite the top 10 titles this week"],
  still_open: ["Whether it applies to Meesho at all"],
  corrections: ["The video said 200 characters; the real limit is per category"],
  look_into: ["Amazon A9"],
  learned_with: "Claude Free"
};

describe("the fixed shape, checked before anything is stored", () => {
  test("a full learning passes", () => {
    assert.deepEqual(validateLearning(GOOD), []);
  });

  test("a missing list is treated as empty, not as a broken reply", () => {
    const { corrections, still_open, ...rest } = GOOD;
    assert.deepEqual(validateLearning(rest), []);
  });

  test("an empty learning is refused — a row that says nothing is worse than no row", () => {
    assert.deepEqual(validateLearning({}), ["it is empty — nothing was learned in it"]);
    assert.deepEqual(
      validateLearning({ learned: [], verdicts: [], actions: [] }),
      ["it is empty — nothing was learned in it"]
    );
  });

  test("a verdict must be one of the three words", () => {
    const problems = validateLearning({
      ...GOOD,
      verdicts: [{ claim: "something", verdict: "mostly true", why: "hedging" }]
    });
    assert.ok(
      problems.some((problem) => problem.includes("true, false, unsure")),
      "anything outside the three words turns the notebook back into prose"
    );
  });

  test("a verdict with no claim is refused", () => {
    const problems = validateLearning({ ...GOOD, verdicts: [{ verdict: "true", why: "because" }] });
    assert.deepEqual(problems, ["a verdict has no claim"]);
  });

  test("a list that is not a list is reported by name", () => {
    assert.deepEqual(validateLearning({ ...GOOD, actions: "rewrite the titles" }), ["actions"]);
  });

  test("nothing may be pasted in unbounded", () => {
    const problems = validateLearning({ ...GOOD, learned: ["x".repeat(3000)] });
    assert.deepEqual(problems, ["learned has an item that is too long"]);
    assert.deepEqual(
      validateLearning({ ...GOOD, look_into: Array(60).fill("a") }),
      ["look_into has too many items"]
    );
  });

  test("a bare string or an array is not a learning", () => {
    assert.deepEqual(validateLearning("I learned a lot"), ["it is not an object"]);
    assert.deepEqual(validateLearning([GOOD]), ["it is not an object"]);
  });

  test("the columns are the six lists as json and the seventh trimmed", () => {
    const columns = learningColumns({ learned: ["a"], learned_with: "  Claude Free  " });
    assert.equal(columns.learned, '["a"]');
    assert.equal(columns.verdicts, "[]", "an absent list is stored as empty, never as null");
    assert.equal(columns.learned_with, "Claude Free");
    assert.equal(learningColumns({ learned: ["a"] }).learned_with, null);
  });
});

describe("the text that goes out to the AI app", () => {
  const prompt = buildLearningPrompt({
    summary: "How to rewrite an Amazon title.",
    keyPoints: ["put the keyword first"],
    claims: [{ claim: "titles drive 60% of ranking", confidence: "low", why: "no source" }],
    transcript: "the words that were said in the video"
  });

  test("it carries everything known about the reel", () => {
    assert.match(prompt, /How to rewrite an Amazon title/);
    assert.match(prompt, /put the keyword first/);
    assert.match(prompt, /titles drive 60% of ranking/);
    assert.match(prompt, /low confidence/, "the doubt already recorded goes out with the claim");
    assert.match(prompt, /the words that were said in the video/);
  });

  test("it asks to teach FIRST and hand back json last", () => {
    assert.ok(
      prompt.indexOf("Teach me") < prompt.indexOf("```json"),
      "asked for json up front, a model answers in json and skips the conversation — "
        + "which is the entire feature"
    );
    assert.match(prompt, /true\|false\|unsure/, "the three words are specified");
  });

  test("a reel with no summary still produces a usable prompt", () => {
    const bare = buildLearningPrompt({ transcript: "just the words" });
    assert.match(bare, /just the words/);
    assert.doesNotMatch(bare, /WHAT THE VIDEO SAID/, "an empty heading with nothing under it");
  });
});

describe("saving a learning against a real clip", () => {
  let harness;
  let amy;
  let ben;
  let amysClip;

  const reel = (name) => `https://www.instagram.com/reel/${name}/`;

  const sourceFor = (name) =>
    harness.database.prepare("SELECT * FROM sources WHERE url_canonical LIKE ?").get(`%${name}%`);

  const learningsOf = (user) =>
    harness.database.prepare("SELECT * FROM learnings WHERE user_id = ?").all(user);

  before(async () => {
    harness = await createTestEnv();
    amy = await harness.mintToken("amy");
    ben = await harness.mintToken("ben");

    // No AI key anywhere, so no analysis is ever made. This is the person the feature has
    // to work for: the copy-out route is the one thing that needs no key of your own.
    await harness.call(worker, "/v1/clips", {
      method: "POST",
      token: amy,
      body: { url: reel("LEARN1") }
    });

    const source = sourceFor("LEARN1");
    harness.database.prepare("UPDATE sources SET state = 'downloading' WHERE id = ?").run(source.id);
    await harness.call(worker, `/v1/sources/${source.id}/transcript`, {
      method: "POST",
      serviceToken: SERVICE_TOKEN,
      body: { text: "the words that were said in the video", lang: "en", engine: "test" }
    });

    amysClip = harness.database
      .prepare("SELECT * FROM clips WHERE user_id = ? AND source_id = ?")
      .get("amy", source.id);
  });

  after(() => harness.restore());

  test("the prompt comes back even with no analysis on the reel", async () => {
    const response = await harness.call(worker, `/v1/clips/${amysClip.id}/learn-prompt`, { token: amy });
    assert.equal(response.status, 200);
    assert.match(response.body.prompt, /the words that were said in the video/);
  });

  test("a pasted reply is stored, json block and all", async () => {
    const pasted = [
      "Right — here is what we worked out together.",
      "```json",
      JSON.stringify(GOOD, null, 2),
      "```"
    ].join("\n");

    const response = await harness.call(worker, `/v1/clips/${amysClip.id}/learning`, {
      method: "POST",
      token: amy,
      body: { pasted }
    });
    assert.equal(response.status, 201);

    const rows = learningsOf("amy");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].clip_id, amysClip.id);
    assert.equal(rows[0].learned_with, "Claude Free");
    assert.equal(JSON.parse(rows[0].verdicts)[0].verdict, "false");
  });

  test("a connector sending the object itself lands on the same validation", async () => {
    const good = await harness.call(worker, `/v1/clips/${amysClip.id}/learning`, {
      method: "POST",
      token: amy,
      body: { learning: { learned: ["something else entirely"], learned_with: "ChatGPT" } }
    });
    assert.equal(good.status, 201);

    const bad = await harness.call(worker, `/v1/clips/${amysClip.id}/learning`, {
      method: "POST",
      token: amy,
      body: { learning: { verdicts: [{ claim: "x", verdict: "maybe", why: "y" }] } }
    });
    assert.equal(bad.status, 400, "the connector must not be a laxer door into the same table");
    assert.equal(learningsOf("amy").length, 2, "and nothing was stored by the refused call");
  });

  test("a malformed paste is refused with words a person can act on", async () => {
    const response = await harness.call(worker, `/v1/clips/${amysClip.id}/learning`, {
      method: "POST",
      token: amy,
      body: { pasted: "I had a great chat about this but forgot the json" }
    });
    assert.equal(response.status, 400);
    assert.match(response.body.error, /Copy the whole reply/);
    assert.equal(learningsOf("amy").length, 2);
  });

  test("Ben cannot write a learning onto Amy's reel", async () => {
    const response = await harness.call(worker, `/v1/clips/${amysClip.id}/learning`, {
      method: "POST",
      token: ben,
      body: { learning: GOOD }
    });
    assert.equal(response.status, 404, "another notebook's clip must not even confirm it exists");
    assert.equal(learningsOf("ben").length, 0);
  });

  test("Ben cannot read the prompt for Amy's reel either", async () => {
    const response = await harness.call(worker, `/v1/clips/${amysClip.id}/learn-prompt`, { token: ben });
    assert.equal(response.status, 404);
  });

  test("sync carries Amy's learnings to Amy and to nobody else", async () => {
    const hers = await harness.call(worker, "/v1/sync?since=0", { token: amy });
    assert.equal(hers.body.learnings.length, 2);
    assert.ok(hers.body.learnings.every((row) => row.clip_id === amysClip.id));

    const his = await harness.call(worker, "/v1/sync?since=0", { token: ben });
    assert.deepEqual(his.body.learnings, [], "a learning is the most personal row in here");
  });

  test("the clip itself moves, so every device is told the reel changed", async () => {
    const stored = harness.database
      .prepare("SELECT updated_at FROM clips WHERE id = ?")
      .get(amysClip.id).updated_at;

    const delta = await harness.call(worker, `/v1/sync?since=${stored - 1}`, { token: amy });
    assert.ok(
      delta.body.clips.some((clip) => clip.id === amysClip.id),
      "a reel that has been learned from must not still look untouched in the list"
    );
  });
});
