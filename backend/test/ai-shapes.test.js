// What happens when the AI returns the right JSON with the wrong shape inside it.
//
// Every feature in this product rests on a model returning an agreed shape, and the single
// commonest thing a model gets wrong is a list of STRINGS where a list of objects was
// asked for. Six rounds of review looked at whether the code was correct; the round that
// asked "what if the model slips" found seven separate places where it did not matter what
// the code did, because what came back was already garbage — and one of them wrote garbage
// into a row every other saver of that reel can read.
//
// Nothing here is hypothetical. Each of these was reproduced against the real Worker.

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";

import worker from "../src/worker.js";
import { validateAnalysis } from "../src/worker.js";
import { cleanSections, cleanClaims, cleanItems, retryPause } from "../src/analyze.js";
import { cleanTopicName } from "../src/topics.js";
import { validateLearning } from "../src/learnings.js";
import { validateRelook } from "../src/relook.js";
import { createTestEnv } from "./helpers/testenv.js";
import { loadApp, syncPayload } from "./helpers/appharness.js";

const SERVICE_TOKEN = "service-token-for-tests";
retryPause.ms = 0;

// ------------------------------------------------------------------ the cleaners

describe("chapters that are not chapters", () => {
  test("a list of strings is dropped, not stored", () => {
    // `entry.at` on a string resolves to `String.prototype.at` — a function, and truthy.
    // The app printed `function at() { [native code] }` where the time belonged and lost
    // the heading with it. D33's one deliverable, rendered as JS internals.
    assert.equal(cleanSections(["Opening", "Pricing"]), null);
    assert.equal(cleanSections([null, undefined]), null);
    assert.equal(cleanSections([["nested"]]), null);
    assert.equal(cleanSections("not a list"), null);
  });

  test("the good ones survive a bad one beside them", () => {
    const kept = cleanSections([
      "Opening",
      { at: "0:12:00", heading: "Pricing", detail: "How he works out a margin." },
      null
    ]);
    assert.equal(kept.length, 1);
    assert.equal(kept[0].heading, "Pricing");
  });

  test("a chapter with no heading is not a chapter", () => {
    assert.equal(cleanSections([{ at: "0:00:00", detail: "words" }]), null);
  });
});

describe("claims that are not claims", () => {
  test("a list of strings is dropped", () => {
    // Worse than chapters: a claim stored as a string lost its own text on screen AND
    // could never reach "doubted, and not checked" on Home, which reads `confidence`.
    assert.deepEqual(cleanClaims(["Meesho charges 5 percent"]), []);
    assert.deepEqual(cleanClaims([null]), []);
    assert.deepEqual(cleanClaims("nope"), []);
  });

  test("the good ones survive", () => {
    const kept = cleanClaims([
      null,
      { claim: "titles drive ranking", confidence: "low", why: "no source" }
    ]);
    assert.equal(kept.length, 1);
    assert.equal(kept[0].confidence, "low");
  });
});

describe("a summary that is not text", () => {
  const base = { key_points: [], learn_more: [], claims: [] };

  test("an object is refused rather than stored as [object Object]", () => {
    // `String({})` is non-empty, so a truthiness check sailed through and the words
    // "[object Object]" sat under "What it said" for ever.
    assert.ok(validateAnalysis({ ...base, summary: { text: "hello" } }).includes("summary"));
    assert.ok(validateAnalysis({ ...base, summary: ["hello"] }).includes("summary"));
    assert.ok(validateAnalysis({ ...base, summary: 42 }).includes("summary"));
  });

  test("and a real one still passes", () => {
    assert.deepEqual(validateAnalysis({ ...base, summary: "It said some things." }), []);
  });
});

describe("a topic that is not a name", () => {
  test("an object is not a folder called [object Object]", () => {
    // This one reached the SHARED row, so the folder appeared in the notebook of every
    // other person who had saved that reel.
    assert.equal(cleanTopicName({ name: "Meesho" }), "");
    assert.equal(cleanTopicName(["Meesho"]), "");
    assert.equal(cleanTopicName(42), "");
    assert.equal(cleanTopicName(null), "");
  });

  test("a real name still comes through", () => {
    assert.equal(cleanTopicName("  e-commerce  "), "e-commerce");
  });
});

describe("a learning that is not shaped like one", () => {
  test("it returns problems rather than throwing", () => {
    // `for (const entry of payload.verdicts || [])` threw on anything not iterable — out
    // of a function whose whole contract is to return a list of problems, past the route,
    // into the router's catch, and back to him as a bare 500 with his entire copied AI
    // conversation discarded and nothing saying what was wrong with it.
    for (const verdicts of [{ a: "true" }, 42, true, "yes"]) {
      const problems = validateLearning({ learned: ["something"], verdicts });
      assert.ok(Array.isArray(problems), `it threw on ${JSON.stringify(verdicts)}`);
    }
  });

  test("and a real one still passes", () => {
    assert.deepEqual(
      validateLearning({
        learned: ["The first eighty characters carry the weight"],
        verdicts: [{ claim: "titles drive ranking", verdict: "false", why: "invented" }]
      }),
      []
    );
  });
});

describe("a look back that is not shaped like one", () => {
  test("a wordy but well-shaped reply is NOT refused", () => {
    // The other way to get this wrong. The prompt asks for "one or two sentences" and a
    // model routinely writes four — and a cap that refused it cost him the whole batch and
    // the call, to enforce a brevity nobody needed enforced.
    const wordy = {
      themes: [{ name: "Meesho selling", why: "x".repeat(1200) }],
      act_now: [{ do: "Switch on Sunday Pickup", because: "y".repeat(1200), from: "A reel" }],
      note: "z".repeat(3000)
    };
    assert.deepEqual(validateRelook(wordy), []);
  });

  test("but an absurd one still is", () => {
    assert.ok(
      validateRelook({
        themes: [{ name: "a", why: "x".repeat(9000) }],
        act_now: [{ do: "b" }]
      }).length
    );
  });
});

describe("tracker rows whose names are not names", () => {
  test("two object-named rows do not become one row", () => {
    // `itemKey` flattens a row's name to recognise it again, and `String({})` flattens to
    // the single key "object object" — so two such rows on one video WERE the same row.
    // He marks one "done" and the other says done as well: a decision about one thing,
    // silently attached to another.
    const kept = cleanItems("product", [
      { name: { text: "Kundan set" }, cost: "120" },
      { name: { text: "Pearl set" }, cost: "150" }
    ]);
    assert.deepEqual(kept, []);
  });

  test("a field that is an object is dropped, not drawn as [object Object]", () => {
    const kept = cleanItems("tool", [
      { name: "Canva", does: { line: "designs" }, price: "free", link: null }
    ]);
    assert.deepEqual(kept, [{ name: "Canva", price: "free", link: null }]);
  });

  test("a price that came back as a number is still a price", () => {
    const kept = cleanItems("product", [{ name: "Kundan set", cost: 120, where: null }]);
    assert.deepEqual(kept, [{ name: "Kundan set", cost: 120, where: null }]);
  });
});

// ------------------------------------------------------------------ the read path

describe("rows that were already stored before any of this was checked", () => {
  // The Worker drops the wrong shapes on the way in now. Rows written BEFORE it did are
  // sitting in the live database today — staging already holds analyses from the
  // long-videos code — so every place that READS one has to survive them too.
  let harness;
  let amy;
  let secret;
  let clip;

  before(async () => {
    harness = await createTestEnv();
    amy = await harness.mintToken("amy");

    await harness.call(worker, "/v1/clips", {
      method: "POST",
      token: amy,
      body: { url: "https://www.facebook.com/share/r/OLDBADROW/" }
    });
    const source = harness.database
      .prepare("SELECT * FROM sources WHERE url_canonical LIKE ?")
      .get("%OLDBADROW%");
    harness.database.prepare("UPDATE sources SET state = 'downloading' WHERE id = ?").run(source.id);
    await harness.call(worker, `/v1/sources/${source.id}/transcript`, {
      method: "POST",
      serviceToken: SERVICE_TOKEN,
      body: { text: "[0:00:00] a long talk", lang: "en", engine: "test", duration_sec: 69 * 60 }
    });

    // Written straight into the table, the way the old code would have.
    harness.database
      .prepare(
        `INSERT INTO analyses (source_id, user_id, provider, model, summary, key_points,
                               learn_more, claims, sections, kind, items, created_at)
         VALUES (?, '', 'gemini', 'test', 'An hour of talk.', ?, ?, ?, ?, 'tactic', ?, ?)
         ON CONFLICT (source_id, user_id) DO UPDATE SET
           key_points = excluded.key_points, learn_more = excluded.learn_more,
           claims = excluded.claims, sections = excluded.sections, items = excluded.items`
      )
      .run(
        source.id,
        JSON.stringify([{ point: "an object where a line belongs" }]),
        JSON.stringify([{ term: "another one" }]),
        JSON.stringify(["a claim that is only a string"]),
        JSON.stringify(["Opening", "Pricing"]),
        JSON.stringify(["Switch on Sunday Pickup"]),
        Date.now()
      );

    clip = harness.database
      .prepare("SELECT * FROM clips WHERE user_id = ? AND source_id = ?")
      .get("amy", source.id);

    const made = await harness.call(worker, "/v1/connector", {
      method: "POST",
      token: amy,
      body: { label: "Claude" }
    });
    secret = made.body.url.split("/mcp/")[1];
  });

  after(() => harness.restore());

  test("the connector shows none of it as garbage", async () => {
    const response = await worker.fetch(
      new Request(`https://api.test/mcp/${secret}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "fetch", arguments: { id: clip.id } }
        })
      }),
      harness.env
    );
    const found = JSON.parse(await response.text()).result.structuredContent;

    // `.at` on a string is a real method, and truthy.
    assert.ok(!found.text.includes("native code"), "a chapter printed as JS internals");
    assert.ok(!found.text.includes("[object Object]"), "a point printed as [object Object]");
    assert.ok(!found.text.includes("HOW IT RUNS"), "a heading with no chapters under it");
    assert.ok(!found.text.includes("[unrated]"), "a claim with its own text missing");
    // And what WAS right is still there.
    assert.ok(found.text.includes("An hour of talk."));
  });

  test("and neither does the app", async () => {
    const app = await loadApp(
      syncPayload({
        clips: [clip],
        sources: [
          harness.database.prepare("SELECT * FROM sources WHERE id = ?").get(clip.source_id)
        ],
        analyses: [
          harness.database
            .prepare("SELECT * FROM analyses WHERE source_id = ? AND user_id = ''")
            .get(clip.source_id)
        ]
      }),
      { hash: `#/clip/${clip.id}` }
    );

    const page = app.text("clipView");
    assert.ok(page.length > 50, "the page drew nothing at all");
    assert.ok(!page.includes("native code"));
    assert.ok(!page.includes("[object Object]"));
    assert.ok(page.includes("An hour of talk."));
    app.restore();
  });
});

// ------------------------------------------------------------------ end to end

describe("a reel whose analysis came back the wrong shape all through", () => {
  let harness;
  let token;
  let clip;

  before(async () => {
    harness = await createTestEnv();
    token = await harness.mintToken("vish");
    await harness.call(worker, "/v1/settings", {
      method: "PUT",
      token,
      body: { provider: "gemini", api_key: "not-a-real-key-value-at-all" }
    });
    harness.answerProviderWith(() =>
      harness.geminiReplyWith({
        summary: "An hour of talk about selling online.",
        // Every one of these is the wrong shape, and every one of them passed before.
        sections: ["Opening", "Pricing"],
        claims: ["Meesho charges 5 percent", null],
        key_points: ["a real point"],
        learn_more: [],
        suggested_task: null,
        topic: { name: "e-commerce" },
        sub_topic: null,
        kind: "tactic",
        items: ["Switch on Sunday Pickup"]
      })
    );

    const saved = await harness.call(worker, "/v1/clips", {
      method: "POST",
      token,
      body: { url: "https://www.facebook.com/share/r/WRONGSHAPE/" }
    });
    clip = saved.body.clip;
    harness.database.prepare("UPDATE sources SET state = 'downloading' WHERE id = ?").run(clip.source_id);
    await harness.call(worker, `/v1/sources/${clip.source_id}/transcript`, {
      method: "POST",
      serviceToken: SERVICE_TOKEN,
      body: { text: "[0:00:00] a long talk", lang: "en", engine: "test", duration_sec: 69 * 60 }
    });
  });

  after(() => {
    harness.answerProviderWith(null);
    harness.restore();
  });

  test("the summary is kept, because it is the part that was right", () => {
    const row = harness.database
      .prepare("SELECT * FROM analyses WHERE source_id = ? AND user_id = ''")
      .get(clip.source_id);
    assert.equal(row.summary, "An hour of talk about selling online.");
    assert.deepEqual(JSON.parse(row.key_points), ["a real point"]);
  });

  test("and nothing that was wrong is stored at all", () => {
    const row = harness.database
      .prepare("SELECT * FROM analyses WHERE source_id = ? AND user_id = ''")
      .get(clip.source_id);
    assert.equal(row.sections, null, "chapters that were strings");
    assert.deepEqual(JSON.parse(row.claims), [], "claims that were strings and nulls");
    assert.equal(row.items, null, "rows that were strings");
    assert.equal(row.topic, null, "a topic that was an object");
  });

  test("no folder called [object Object] was made, in anybody's notebook", () => {
    const folders = harness.database.prepare("SELECT name FROM topics").all();
    assert.ok(!folders.some((row) => row.name.includes("object Object")));
  });

  test("and the reel is offered for another read exactly once", async () => {
    const row = harness.database
      .prepare("SELECT shapes_version FROM analyses WHERE source_id = ? AND user_id = ''")
      .get(clip.source_id);
    assert.ok(row.shapes_version < 0, "recorded as asked, and as not usable");

    const before = harness.providerCalls.length;
    const run = await harness.call(worker, "/v1/kinds", { method: "POST", token });
    assert.equal(run.body.done, 0);
    assert.equal(run.body.remaining, 0);
    assert.equal(harness.providerCalls.length, before, "and never read on a loop");
  });
});
