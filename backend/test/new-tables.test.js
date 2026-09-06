// The two new tables, and the rule that a new one never spends an allowance by itself
// (D38, D39).
//
// D38 came out of reading all 202 analysed videos in the real notebook, not out of an idea
// about what people might save. Two shapes had real, repeated evidence and everything else
// was rejected for thin evidence — so what these tests pin is narrow on purpose:
//
//   * "prompt" is its own kind, because wording you paste into an AI was arriving as a
//     "tool" and filling a tool's columns with nulls.
//   * "tactic" carries rows now, where D34 said it should not. D34's reason still holds
//     for the STEPS of a method — those are key_points — so the rule the prompt states is
//     one row per thing worth trying, and that is what keeps it from being the same list
//     twice.
//   * A kind with no agreed row shape still gets none, whatever the AI volunteers.
//   * `shapes_version` is what makes the offer to re-read older reels finite: a reel that
//     was asked under the current shapes and had nothing is never offered again.

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import worker from "../src/worker.js";
import {
  ANALYSIS_PROMPT,
  LONG_ANALYSIS_PROMPT,
  KINDS,
  KINDS_WITH_ROWS,
  ITEM_SHAPES_VERSION,
  cleanKind,
  cleanItems
} from "../src/analyze.js";
import { createTestEnv } from "./helpers/testenv.js";

const SERVICE_TOKEN = "service-token-for-tests";
const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// ------------------------------------------------------------------ the shapes

describe("the kinds that earn a table", () => {
  test("prompt is a kind, and the two that carry nothing still carry nothing", () => {
    assert.ok(KINDS.includes("prompt"));
    assert.deepEqual(KINDS_WITH_ROWS, ["product", "tool", "tactic", "prompt"]);
    assert.equal(cleanKind("prompt"), "prompt");
    // An opinion's substance is its claims, and "other" has nothing shared to put in a
    // column. A second, emptier home for either would be a worse notebook (D34).
    for (const kind of ["opinion", "other"]) {
      assert.equal(
        cleanItems(kind, [{ name: "something the AI volunteered" }]),
        null,
        `${kind} must not be given rows`
      );
    }
  });

  test("a tactic and a prompt keep their rows; a made-up kind keeps none", () => {
    assert.equal(cleanItems("tactic", [{ name: "Switch on Sunday Pickup" }]).length, 1);
    assert.equal(cleanItems("prompt", [{ name: "/botanical leaf" }]).length, 1);
    assert.equal(cleanKind("setting"), null, "a kind nobody agreed on is not a kind");
    assert.equal(cleanItems(null, [{ name: "x" }]), null);
  });

  test("rows that are not objects are dropped rather than stored", () => {
    const rows = cleanItems("prompt", ["just a string", null, ["a", "list"], { name: "ok" }]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].name, "ok");
  });

  test("both prompts ask for the same six kinds and the same row shapes", () => {
    for (const prompt of [ANALYSIS_PROMPT, LONG_ANALYSIS_PROMPT]) {
      for (const kind of KINDS) {
        assert.ok(prompt.includes(`"${kind}"`), `${kind} is missing from a prompt`);
      }
      assert.ok(prompt.includes('"app"'), "the prompt row shape is missing");
      assert.ok(prompt.includes("ONE THING WORTH TRYING"), "the tactic row rule is missing");
      // The rule that stops a tactic's table from being its steps repeated.
      assert.match(
        prompt,
        /The steps\s+belong in "key_points" and must not be repeated here\./,
        "nothing stops a tactic table from repeating the main points"
      );
    }
  });

  test("the app and the Worker agree on which shapes are current", () => {
    const app = readFileSync(join(repo, "index.html"), "utf8");
    const found = /const SHAPES_VERSION = (\d+);/.exec(app);
    assert.ok(found, "the app does not say which row shapes it knows");
    assert.equal(
      Number(found[1]),
      ITEM_SHAPES_VERSION,
      "an app a version behind would offer to re-read the same reels for ever"
    );
  });
});

// ------------------------------------------------------------------ end to end

describe("a video full of wording to paste into an AI", () => {
  const ANALYSIS = {
    summary: "Five slash commands that turn a product photo into an advert.",
    key_points: ["/botanical leaf puts the product in foliage"],
    learn_more: ["ChatGPT"],
    claims: [{ claim: "no editing needed", confidence: "medium", why: "shown once" }],
    suggested_task: "Try one on a bangle photo",
    topic: "AI marketing",
    sub_topic: "product photography",
    kind: "prompt",
    items: [
      {
        name: "/botanical leaf",
        does: "puts the product among leaves",
        app: "ChatGPT",
        text: "Place this product on a marble slab surrounded by botanical leaves",
        needs: "a product photo"
      },
      {
        name: "/tropical",
        does: "a beach background",
        app: "ChatGPT",
        text: null,
        needs: "a product photo"
      }
    ]
  };

  let harness;
  let token;
  let clipId;
  let sourceId;

  before(async () => {
    harness = await createTestEnv();
    token = await harness.mintToken("vish");
    await harness.call(worker, "/v1/settings", {
      method: "PUT",
      token,
      body: { provider: "gemini", api_key: "not-a-real-key-value-at-all" }
    });
    harness.answerProviderWith(() => harness.geminiReplyWith(ANALYSIS));

    const saved = await harness.call(worker, "/v1/clips", {
      method: "POST",
      token,
      body: { url: "https://www.facebook.com/share/r/PROMPTS/" }
    });
    clipId = saved.body.clip.id;
    sourceId = saved.body.clip.source_id;

    harness.database.prepare("UPDATE sources SET state = 'downloading' WHERE id = ?").run(sourceId);
    await harness.call(worker, `/v1/sources/${sourceId}/transcript`, {
      method: "POST",
      serviceToken: SERVICE_TOKEN,
      body: { text: "five slash commands", lang: "en", engine: "test", duration_sec: 40 }
    });
  });

  after(() => {
    harness.answerProviderWith(null);
    harness.restore();
  });

  test("the rows are stored on the shared analysis, wording and all", () => {
    const row = harness.database
      .prepare("SELECT kind, items, user_id, shapes_version FROM analyses WHERE source_id = ?")
      .get(sourceId);
    assert.equal(row.user_id, "", "what a video said is shared, like every other kind (D10)");
    assert.equal(row.kind, "prompt");
    assert.equal(row.shapes_version, ITEM_SHAPES_VERSION);

    const items = JSON.parse(row.items);
    assert.equal(items.length, 2);
    assert.equal(items[0].text, ANALYSIS.items[0].text, "the wording survives word for word");
    assert.equal(items[1].text, null, "a prompt the video did not read out stays null");
  });

  test("a decision about one prompt is remembered against that person", async () => {
    const answer = await harness.call(worker, `/v1/clips/${clipId}/item`, {
      method: "PUT",
      token,
      body: { name: "/botanical leaf", status: "doing" }
    });
    assert.equal(answer.status, 200);

    const delta = await harness.call(worker, "/v1/sync?since=0", { token });
    const decision = delta.body.item_status.find((entry) => entry.item_key === "botanical leaf");
    assert.equal(decision.status, "doing");
  });

  test("nothing else about the analysis changed shape", () => {
    const row = harness.database
      .prepare("SELECT summary, key_points, claims, topic, sections FROM analyses WHERE source_id = ?")
      .get(sourceId);
    assert.equal(row.summary, ANALYSIS.summary);
    assert.deepEqual(JSON.parse(row.key_points), ANALYSIS.key_points);
    assert.equal(row.sections, null, "a short reel is still never asked for chapters");
    assert.equal(row.topic, "AI marketing");
  });
});

// ------------------------------------------------------------------ the offer (D39)

describe("a new table never spends an allowance by itself", () => {
  let harness;
  let token;
  let sourceId;

  const answer = (kind, items) => ({
    summary: "Something worth trying on Meesho.",
    key_points: ["turn it on in the seller panel"],
    learn_more: ["Meesho"],
    claims: [],
    suggested_task: null,
    topic: "e-commerce",
    sub_topic: "Meesho",
    kind,
    items
  });

  before(async () => {
    harness = await createTestEnv();
    token = await harness.mintToken("vish");
    await harness.call(worker, "/v1/settings", {
      method: "PUT",
      token,
      body: { provider: "gemini", api_key: "not-a-real-key-value-at-all" }
    });
    harness.answerProviderWith(() => harness.geminiReplyWith(answer("tactic", [])));

    const saved = await harness.call(worker, "/v1/clips", {
      method: "POST",
      token,
      body: { url: "https://www.facebook.com/share/r/OLDONE/" }
    });
    sourceId = saved.body.clip.source_id;
    harness.database.prepare("UPDATE sources SET state = 'downloading' WHERE id = ?").run(sourceId);
    await harness.call(worker, `/v1/sources/${sourceId}/transcript`, {
      method: "POST",
      serviceToken: SERVICE_TOKEN,
      body: { text: "one meesho setting", lang: "en", engine: "test", duration_sec: 50 }
    });
  });

  after(() => {
    harness.answerProviderWith(null);
    harness.restore();
  });

  test("a reel read against the old shapes is offered for re-reading", async () => {
    // Exactly what every analysis in the real notebook looks like today: a kind, no rows,
    // and no version, because it was written before the version existed.
    harness.database
      .prepare("UPDATE analyses SET shapes_version = NULL, items = NULL WHERE source_id = ?")
      .run(sourceId);

    harness.answerProviderWith(() =>
      harness.geminiReplyWith(
        answer("tactic", [
          {
            name: "Switch on Sunday Pickup",
            does: "orders picked up on Sundays",
            where: "Meesho seller panel",
            effort: null,
            note: "through Sunday Pickup Support"
          }
        ])
      )
    );

    const run = await harness.call(worker, "/v1/kinds", { method: "POST", token });
    assert.equal(run.status, 200);
    assert.equal(run.body.done, 1, "the reel behind the current shapes was re-read");

    const row = harness.database
      .prepare("SELECT kind, items, shapes_version FROM analyses WHERE source_id = ? AND user_id = ''")
      .get(sourceId);
    assert.equal(row.shapes_version, ITEM_SHAPES_VERSION);
    assert.equal(JSON.parse(row.items).length, 1, "the tactic now has a row to tick off");
  });

  test("a reel already read under the current shapes is never re-read again", async () => {
    const before = harness.providerCalls.length;
    const run = await harness.call(worker, "/v1/kinds", { method: "POST", token });
    assert.equal(run.body.done, 0);
    assert.equal(run.body.remaining, 0);
    assert.equal(
      harness.providerCalls.length,
      before,
      "nothing may be spent on a reel that was already asked under these shapes"
    );
  });

  test("a reel that was asked and truly had nothing is not offered for ever", async () => {
    harness.answerProviderWith(() => harness.geminiReplyWith(answer("tactic", [])));
    harness.database
      .prepare("UPDATE analyses SET shapes_version = NULL WHERE source_id = ?")
      .run(sourceId);

    await harness.call(worker, "/v1/kinds", { method: "POST", token });
    const row = harness.database
      .prepare("SELECT items, shapes_version FROM analyses WHERE source_id = ? AND user_id = ''")
      .get(sourceId);
    assert.equal(row.items, null, "nothing to track is stored as nothing, never as []");
    assert.equal(
      row.shapes_version,
      ITEM_SHAPES_VERSION,
      "it was ASKED, so it must not be counted as behind again"
    );

    const run = await harness.call(worker, "/v1/kinds", { method: "POST", token });
    assert.equal(run.body.remaining, 0);
  });

  test("without a key nothing is attempted, and it says so", async () => {
    harness.database.prepare("DELETE FROM ai_keys WHERE user_id = 'vish'").run();
    harness.database
      .prepare("UPDATE analyses SET shapes_version = NULL WHERE source_id = ?")
      .run(sourceId);

    const before = harness.providerCalls.length;
    const run = await harness.call(worker, "/v1/kinds", { method: "POST", token });
    assert.equal(run.status, 400);
    assert.match(run.body.error, /Connect an AI account/);
    assert.equal(harness.providerCalls.length, before);
  });
});
