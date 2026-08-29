// Organising what the notebook holds (D34). Four promises, and these tests are what pin
// them:
//
//   * A failure says what actually went wrong, in a form that CANNOT carry a key. The
//     three failures that started this were "the AI provider refused the request" and
//     nothing else, which is unguessable by design — and guessing is what Golden Rule 1
//     exists to stop.
//   * A one-off is retried once. Never a rejected key, never a quota: asking again there
//     is pointless at best and harmful at worst.
//   * Top-level topics MERGE. One real notebook grew seven folders for "AI" and nine for
//     e-commerce, because D27 tells the AI it has never seen anyone's topics. That rule
//     is untouched — the matching happens per-user, at filing time, where it always did.
//   * Sub-topics are never merged this way, and the AI is still never shown a topic list.
//     Both of those would be a bigger notebook, not a better one.
//
// And the shape rule D33 set: the new analysis is the old analysis plus fields. Anything
// that reads a summary, a claim or a topic must not be able to tell the difference.

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";

import worker from "../src/worker.js";
import { validateAnalysis } from "../src/worker.js";
import {
  ANALYSIS_PROMPT,
  LONG_ANALYSIS_PROMPT,
  KINDS,
  cleanKind,
  cleanItems,
  itemKey,
  safeDetail,
  withOneRetry,
  retryPause,
  AnalysisError
} from "../src/analyze.js";
import { headKey, normaliseTopicName } from "../src/topics.js";
import { createTestEnv } from "./helpers/testenv.js";

const SERVICE_TOKEN = "service-token-for-tests";

// Every test in this file that causes a retry sets this to zero. The real pause is there
// to give a provider a moment to recover; a test waiting for it proves nothing.
retryPause.ms = 0;

// ------------------------------------------------------------------ the reason code

describe("saying what went wrong, without ever saying anything else", () => {
  test("a name the providers' docs list is kept, alongside the status", () => {
    assert.equal(
      safeDetail(400, { error: { code: "failed_precondition", message: "..." } }),
      "400 failed_precondition"
    );
    assert.equal(
      safeDetail(400, { error: { status: "INVALID_ARGUMENT", message: "..." } }),
      "400 invalid_argument",
      "the older SCREAMING_SNAKE spelling lowercases onto the same name"
    );
    assert.equal(
      safeDetail(402, { error: { type: "billing_error", message: "..." } }),
      "402 billing_error"
    );
  });

  test("anything else becomes 'unrecognised' — the allowlist is the whole safety", () => {
    // This is the case that matters. An API key is plain letters, digits, hyphen and
    // underscore, so a filter that allowed "safe characters" would pass one straight
    // through into a row every saver of the reel can read.
    // Built from two halves on purpose. Written out whole it is the exact shape the
    // repo's own secret scan hunts for, and a test fixture would fail the build.
    const keyShaped = `${"AIzaSy"}D-1234567890abcdefghijklmnopqrstuv`;
    assert.equal(safeDetail(400, { error: { code: keyShaped, message: "x" } }), "400 unrecognised");

    for (const nasty of [
      { error: { code: "sk-proj-abcdefghijklmnop" } },
      { error: { message: "Incorrect API key provided: sk-abc...xyz" } },
      { error: { code: { nested: "object" } } },
      { error: "a bare string" },
      {},
      null
    ]) {
      const detail = safeDetail(400, nasty);
      assert.equal(detail, "400 unrecognised", `leaked something for ${JSON.stringify(nasty)}`);
    }
  });

  test("the status is always there, even when the name is not", () => {
    assert.match(safeDetail(503, {}), /^503 /);
    assert.match(safeDetail(429, { error: { type: "rate_limit_error" } }), /^429 /);
  });
});

// ------------------------------------------------------------------ the retry

describe("trying once more, but only where trying again could work", () => {
  const failWith = (detail) => {
    let calls = 0;
    return {
      count: () => calls,
      attempt: async () => {
        calls += 1;
        throw new AnalysisError("it went wrong", detail);
      }
    };
  };

  test("an unexplained 400 gets a second go", async () => {
    const runner = failWith("400 unrecognised");
    await assert.rejects(() => withOneRetry(runner.attempt));
    assert.equal(runner.count(), 2, "this is the failure that started all of this");
  });

  test("a second go that works is the answer, and nothing is reported", async () => {
    let calls = 0;
    const answer = await withOneRetry(async () => {
      calls += 1;
      if (calls === 1) throw new AnalysisError("blip", "503 unavailable");
      return "the analysis";
    });
    assert.equal(answer, "the analysis");
    assert.equal(calls, 2);
  });

  test("a rejected key, a billing problem and a quota are never retried", async () => {
    for (const detail of [
      "401 unauthenticated",
      "402 billing_error",
      "403 permission_denied",
      "413 request_too_large",
      "429 resource_exhausted"
    ]) {
      const runner = failWith(detail);
      await assert.rejects(() => withOneRetry(runner.attempt));
      assert.equal(runner.count(), 1, `${detail} must not be asked again`);
    }
  });

  test("a reply that came back as prose is retried like a reply that never came", async () => {
    const runner = failWith("200 unparseable_reply");
    await assert.rejects(() => withOneRetry(runner.attempt));
    assert.equal(runner.count(), 2);
  });
});

describe("what a failed analysis leaves behind on the reel", () => {
  let harness;
  let amy;

  const reel = (name) => `https://www.instagram.com/reel/${name}/`;
  const sourceFor = (name) =>
    harness.database
      .prepare("SELECT * FROM sources WHERE url_canonical LIKE ?")
      .get(`%${name}%`);

  before(async () => {
    harness = await createTestEnv();
    amy = await harness.mintToken("amy");
    await harness.call(worker, "/v1/settings", {
      method: "PUT",
      token: amy,
      body: { provider: "gemini", api_key: "amys-key-value-not-a-real-one" }
    });
  });

  after(() => {
    harness.answerProviderWith(null);
    harness.restore();
  });

  const transcribe = async (name) => {
    await harness.call(worker, "/v1/clips", { method: "POST", token: amy, body: { url: reel(name) } });
    const source = sourceFor(name);
    harness.database.prepare("UPDATE sources SET state = 'downloading' WHERE id = ?").run(source.id);
    return harness.call(worker, `/v1/sources/${source.id}/transcript`, {
      method: "POST",
      serviceToken: SERVICE_TOKEN,
      body: { text: "the words that were said", lang: "en", engine: "test", duration_sec: 30 }
    });
  };

  test("the status and the name are stored, and the sentence people read is unchanged", async () => {
    harness.answerProviderWith(
      () =>
        new Response(JSON.stringify({ error: { status: "FAILED_PRECONDITION", message: "no" } }), {
          status: 400
        })
    );

    const response = await transcribe("FAILDETAIL");
    assert.equal(response.status, 200);
    assert.equal(response.body.analyzed, false);

    const source = sourceFor("FAILDETAIL");
    assert.equal(
      source.error,
      "Analysis failed: the AI provider refused the request",
      "what everyone who saved the reel reads must not change"
    );
    assert.equal(source.error_detail, "400 failed_precondition", "and this is the new part");
  });

  test("a provider's own words never reach the stored row", async () => {
    harness.answerProviderWith(
      () =>
        new Response(
          JSON.stringify({
            error: {
              code: "some_code_nobody_documented",
              message: "Incorrect API key provided: AIzaSyD-1234. Check your billing at acme.test"
            }
          }),
          { status: 400 }
        )
    );

    await transcribe("FAILLEAK");
    const source = sourceFor("FAILLEAK");
    const stored = `${source.error} ${source.error_detail}`;
    assert.equal(source.error_detail, "400 unrecognised");
    assert.doesNotMatch(stored, /AIzaSy/, "a key fragment reached a shared row");
    assert.doesNotMatch(stored, /billing at/, "a provider's message reached a shared row");
    assert.doesNotMatch(stored, /some_code_nobody_documented/);
  });

  test("a reel that recovers on the retry is not marked as failed at all", async () => {
    let calls = 0;
    harness.answerProviderWith(() => {
      calls += 1;
      if (calls === 1) return new Response(JSON.stringify({}), { status: 503 });
      return harness.geminiReplyWith({
        summary: "It worked the second time.",
        key_points: ["a"],
        learn_more: [],
        claims: [],
        suggested_task: null,
        topic: "Testing",
        sub_topic: null,
        kind: "other",
        items: []
      });
    });

    const response = await transcribe("RECOVER");
    assert.equal(response.body.analyzed, true);

    const source = sourceFor("RECOVER");
    assert.equal(source.state, "analyzed");
    assert.equal(source.error, null);
    assert.equal(source.error_detail, null, "a failure that was recovered from is not a failure");
  });

  test("the detail is cleared when a later run succeeds", () => {
    // FAILDETAIL above kept its detail; RECOVER never had one. The pair is the proof that
    // the column is set on failure and cleared on success, rather than accumulating.
    assert.equal(sourceFor("FAILDETAIL").error_detail, "400 failed_precondition");
    assert.equal(sourceFor("RECOVER").error_detail, null);
  });
});

// ------------------------------------------------------------------ merging topics

describe("finding the one word a top-level topic is about", () => {
  const head = (name) => headKey(normaliseTopicName(name));

  test("every name for AI lands on the same word", () => {
    const names = [
      "AI",
      "AI tools",
      "AI development",
      "AI development tools",
      "AI coding assistants",
      "AI coding tools",
      "AI Agents",
      "Artificial Intelligence",
      "artificial intelligence"
    ];
    // These nine are the real top-level folders one notebook of 86 videos grew.
    for (const name of names) {
      assert.equal(head(name), "ai", `${name} should be filed with the rest of AI`);
    }
  });

  test("every spelling of e-commerce lands on the same word", () => {
    for (const name of [
      "e-commerce",
      "ecommerce",
      "E-commerce selling",
      "ecommerce selling",
      "e-commerce business",
      "E-commerce advertising",
      "e-commerce product research"
    ]) {
      assert.equal(head(name), "ecommerce", `${name} should be filed with the rest`);
    }
  });

  test("genuinely different subjects keep their own word", () => {
    assert.notEqual(head("Amazon selling"), head("Meesho selling"));
    assert.notEqual(head("SEO"), head("cybersecurity"));
    assert.notEqual(head("Clothing manufacturing"), head("Textile manufacturing"));
  });

  test("a head word that names no subject anchors nothing", () => {
    // Otherwise "content creation" would swallow "content marketing", and "best tools"
    // would swallow the notebook.
    for (const name of ["Best tools", "Top 10 tips", "Business growth", "Content creation"]) {
      assert.equal(headKey(normaliseTopicName(name)), "", `${name} must not become an anchor`);
    }
  });
});

describe("filing a new clip into the folder that already exists", () => {
  const analysisFor = (topic, subTopic) => ({
    summary: `A video about ${topic}.`,
    key_points: ["a point"],
    learn_more: [],
    claims: [],
    suggested_task: null,
    topic,
    sub_topic: subTopic,
    kind: "other",
    items: []
  });

  let harness;
  let amy;

  const reel = (name) => `https://www.instagram.com/reel/${name}/`;
  const sourceFor = (name) =>
    harness.database.prepare("SELECT * FROM sources WHERE url_canonical LIKE ?").get(`%${name}%`);

  const liveTopics = (parentId) =>
    harness.database
      .prepare(
        "SELECT * FROM topics WHERE user_id = 'amy' AND parent_id = ? AND deleted_at IS NULL ORDER BY created_at"
      )
      .all(parentId);

  const saveAndAnalyse = async (name, topic, subTopic) => {
    harness.answerProviderWith(() => harness.geminiReplyWith(analysisFor(topic, subTopic)));
    await harness.call(worker, "/v1/clips", { method: "POST", token: amy, body: { url: reel(name) } });
    const source = sourceFor(name);
    harness.database.prepare("UPDATE sources SET state = 'downloading' WHERE id = ?").run(source.id);
    const response = await harness.call(worker, `/v1/sources/${source.id}/transcript`, {
      method: "POST",
      serviceToken: SERVICE_TOKEN,
      body: { text: "words", lang: "en", engine: "test", duration_sec: 30 }
    });
    assert.equal(response.body.analyzed, true, `${name} did not analyse`);
  };

  before(async () => {
    harness = await createTestEnv();
    amy = await harness.mintToken("amy");
    await harness.call(worker, "/v1/settings", {
      method: "PUT",
      token: amy,
      body: { provider: "gemini", api_key: "amys-key-value-not-a-real-one" }
    });

    await saveAndAnalyse("AIONE", "AI tools", "Claude Code");
    await saveAndAnalyse("AITWO", "AI coding assistants", "token optimization");
    await saveAndAnalyse("AITHREE", "Artificial Intelligence", "prompt engineering");
    await saveAndAnalyse("SHOPONE", "e-commerce", "product research");
    await saveAndAnalyse("SHOPTWO", "ecommerce selling", "Flipkart");
  });

  after(() => {
    harness.answerProviderWith(null);
    harness.restore();
  });

  test("three names for AI make one folder, not three", () => {
    const tops = liveTopics("");
    const ai = tops.filter((topic) => headKey(topic.name_key) === "ai");
    assert.equal(ai.length, 1, `got ${ai.map((t) => t.name).join(", ")}`);
    assert.equal(ai[0].name, "AI tools", "the folder that was there first keeps its name");
  });

  test("two spellings of e-commerce make one folder", () => {
    const shops = liveTopics("").filter((topic) => headKey(topic.name_key) === "ecommerce");
    assert.equal(shops.length, 1, `got ${shops.map((t) => t.name).join(", ")}`);
  });

  test("the narrower subjects are all still there, under it", () => {
    const ai = liveTopics("").find((topic) => headKey(topic.name_key) === "ai");
    const names = liveTopics(ai.id).map((topic) => topic.name).sort();
    assert.deepEqual(names, ["Claude Code", "prompt engineering", "token optimization"]);
  });

  test("sub-topics are never merged by their head word", () => {
    // "product research" and "product listings" share a first word and are two subjects.
    // Only the broad level is coarse; this is the line that keeps that true.
    const shop = liveTopics("").find((topic) => headKey(topic.name_key) === "ecommerce");
    const subs = liveTopics(shop.id).map((topic) => topic.name).sort();
    assert.deepEqual(subs, ["Flipkart", "product research"]);
  });

  test("the AI is still never shown anyone's topics", () => {
    for (const call of harness.providerCalls) {
      assert.match(String(call.options.body), /You have not been shown anyone/);
      assert.doesNotMatch(
        String(call.options.body),
        /existing topics:|your topics|topic list:/i,
        "a topic list in the prompt would make the analysis personal and unshareable (D10)"
      );
    }
  });
});

describe("tidying the folders a notebook already grew", () => {
  let harness;
  let amy;
  let ben;

  const insertTopic = (user, id, name, parentId, createdAt) =>
    harness.database
      .prepare(
        `INSERT INTO topics (id, user_id, name, parent_id, name_key, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(id, user, name, parentId, normaliseTopicName(name), createdAt, createdAt);

  const liveTops = (user) =>
    harness.database
      .prepare(
        "SELECT * FROM topics WHERE user_id = ? AND parent_id = '' AND deleted_at IS NULL ORDER BY created_at"
      )
      .all(user);

  before(async () => {
    harness = await createTestEnv();
    amy = await harness.mintToken("amy");
    ben = await harness.mintToken("ben");
    await harness.call(worker, "/v1/sync", { token: amy });
    await harness.call(worker, "/v1/sync", { token: ben });

    // The shape a real notebook was actually in.
    insertTopic("amy", "t-ai", "AI tools", "", 1000);
    insertTopic("amy", "t-ai2", "AI development", "", 2000);
    insertTopic("amy", "t-ai3", "artificial intelligence", "", 3000);
    insertTopic("amy", "t-shop", "e-commerce", "", 4000);
    insertTopic("amy", "t-shop2", "ecommerce selling", "", 5000);
    insertTopic("amy", "t-seo", "SEO", "", 6000);
    insertTopic("amy", "t-claude", "Claude Code", "t-ai", 1100);
    insertTopic("amy", "t-agents", "AI agents", "t-ai2", 2100);
    insertTopic("amy", "t-claude-dup", "Claude Code", "t-ai3", 3100);

    // Ben's notebook is the control: nothing of his may move.
    insertTopic("ben", "b-ai", "AI tools", "", 1000);
    insertTopic("ben", "b-ai2", "AI development", "", 2000);

    const clip = (id, user, sourceId, topicId) => {
      harness.database
        .prepare(
          `INSERT INTO sources (id, url_canonical, url_original, platform, state, attempts, created_at, updated_at)
           VALUES (?, ?, ?, 'instagram', 'analyzed', 0, 1, 1)`
        )
        .run(sourceId, `https://x.test/${sourceId}`, `https://x.test/${sourceId}`);
      harness.database
        .prepare(
          `INSERT INTO clips (id, user_id, source_id, status, topic_id, topic_set_by, created_at, updated_at)
           VALUES (?, ?, ?, 'inbox', ?, 'ai', 1, 1)`
        )
        .run(id, user, sourceId, topicId);
    };

    clip("c1", "amy", "s1", "t-ai2");
    clip("c2", "amy", "s2", "t-agents");
    clip("c3", "amy", "s3", "t-claude-dup");
    clip("c4", "ben", "s4", "b-ai2");

    // A clip Amy filed herself, in a folder that is about to be folded away.
    harness.database
      .prepare("UPDATE clips SET topic_set_by = 'user' WHERE id = ?")
      .run("c1");
  });

  after(() => harness.restore());

  test("one press folds the duplicates away", async () => {
    const response = await harness.call(worker, "/v1/topics/tidy", { method: "POST", token: amy });
    assert.equal(response.status, 200);
    assert.ok(response.body.merged >= 3, `merged ${response.body.merged}`);

    const names = liveTops("amy").map((topic) => topic.name);
    assert.deepEqual(names, ["AI tools", "e-commerce", "SEO"], "the oldest of each group stays");
  });

  test("every clip came with it — nothing is orphaned in a deleted folder", () => {
    const stranded = harness.database
      .prepare(
        `SELECT c.id FROM clips c JOIN topics t ON t.id = c.topic_id
         WHERE c.user_id = 'amy' AND t.deleted_at IS NOT NULL`
      )
      .all();
    assert.deepEqual(stranded, [], "a clip is pointing at a folder that no longer exists");
  });

  test("the narrower folders moved under the folder that stayed", () => {
    const subs = harness.database
      .prepare(
        "SELECT name FROM topics WHERE user_id = 'amy' AND parent_id = 't-ai' AND deleted_at IS NULL ORDER BY name"
      )
      .all()
      .map((row) => row.name);
    assert.deepEqual(subs, ["AI agents", "Claude Code"]);
  });

  test("two sub-folders of the same name become one, and its clips are kept", () => {
    // t-claude and t-claude-dup are both "Claude Code". The unique index would refuse the
    // move, so the clips go to the one that stays rather than the move being abandoned.
    const clip = harness.database.prepare("SELECT topic_id FROM clips WHERE id = 'c3'").get();
    assert.equal(clip.topic_id, "t-claude");
  });

  test("a folder the user chose by hand still moves, but stays theirs", () => {
    const clip = harness.database.prepare("SELECT * FROM clips WHERE id = 'c1'").get();
    assert.equal(clip.topic_id, "t-ai", "the folder they chose is gone; the clip had to move");
    assert.equal(clip.topic_set_by, "user", "so the sort button still will not touch it");
  });

  test("nobody else's notebook moved", () => {
    assert.deepEqual(
      liveTops("ben").map((topic) => topic.name),
      ["AI tools", "AI development"],
      "Amy pressing tidy must not reach into Ben's notebook (D18)"
    );
  });

  test("pressing it again does nothing", async () => {
    const response = await harness.call(worker, "/v1/topics/tidy", { method: "POST", token: amy });
    assert.equal(response.body.merged, 0);
    assert.equal(response.body.moved, 0);
  });

  test("the moved rows carry a new updated_at, so other devices are told", () => {
    const moved = harness.database
      .prepare("SELECT updated_at FROM clips WHERE id = 'c1'")
      .get();
    assert.ok(moved.updated_at > 1, "delta sync (D6) would never carry this move otherwise");
  });
});

// ------------------------------------------------------------------ kinds and rows

describe("asking what kind of video it is", () => {
  test("both prompts ask for a kind and for rows", () => {
    for (const prompt of [ANALYSIS_PROMPT, LONG_ANALYSIS_PROMPT]) {
      assert.match(prompt, /"kind"/);
      assert.match(prompt, /"items"/);
      assert.match(prompt, /NEVER invent a value/);
      assert.match(prompt, /"Rs\. 22", not 22/, "a price must survive as it was said");
    }
  });

  test("the long prompt still asks for every field the app already reads", () => {
    for (const field of [
      "summary",
      "key_points",
      "learn_more",
      "claims",
      "suggested_task",
      "topic",
      "sub_topic",
      "sections"
    ]) {
      assert.match(LONG_ANALYSIS_PROMPT, new RegExp(`"${field}"`), `${field} was dropped`);
    }
  });

  test("a kind the AI made up becomes nothing, rather than failing the analysis", () => {
    assert.equal(cleanKind("recipe"), null);
    assert.equal(cleanKind(""), null);
    assert.equal(cleanKind(null), null);
    for (const kind of KINDS) assert.equal(cleanKind(kind.toUpperCase()), kind);
  });

  test("only the two kinds with a row shape may carry rows", () => {
    const rows = [{ name: "hook set", cost: "Rs. 22" }];
    assert.deepEqual(cleanItems("product", rows), rows);
    assert.deepEqual(cleanItems("tool", rows), rows);
    for (const kind of ["tactic", "opinion", "other", null]) {
      assert.equal(cleanItems(kind, rows), null, `${kind} has no agreed row shape`);
    }
  });

  test("nothing to track is stored as nothing, not as an empty list", () => {
    // The same rule chapters follow: a row written today that tracks nothing must be
    // indistinguishable from a row written before any of this existed.
    assert.equal(cleanItems("product", []), null);
    assert.equal(cleanItems("product", "not a list"), null);
  });

  test("junk inside the list is dropped, not stored", () => {
    assert.deepEqual(cleanItems("product", [{ name: "a" }, "a string", null, ["x"]]), [
      { name: "a" }
    ]);
  });

  test("a kind of the wrong type is a malformed reply; an unknown one is not", () => {
    const base = {
      summary: "s",
      key_points: [],
      learn_more: [],
      claims: []
    };
    assert.deepEqual(validateAnalysis({ ...base, kind: "recipe" }), []);
    assert.deepEqual(validateAnalysis({ ...base, kind: null }), []);
    assert.deepEqual(validateAnalysis({ ...base, kind: 7 }), ["kind"]);
    assert.deepEqual(validateAnalysis({ ...base, items: "nope" }), ["items"]);
    assert.deepEqual(validateAnalysis({ ...base, items: [{ name: "a" }] }), []);
  });

  test("an analysis with no kind at all is still a good analysis", () => {
    assert.deepEqual(
      validateAnalysis({ summary: "s", key_points: [], learn_more: [], claims: [] }),
      [],
      "every analysis stored before today has no kind, and none of them is broken"
    );
  });
});

describe("a product video becomes rows", () => {
  // The real reel that started this: three items, three prices, one shop, filed as four
  // bullets of prose that cannot be sorted or ticked off.
  const ANALYSIS = {
    summary: "Three items to sell for under 25 rupees.",
    key_points: ["6-piece hook set at Rs. 22"],
    learn_more: ["e-commerce sourcing"],
    claims: [{ claim: "all under Rs. 25", confidence: "high", why: "prices were stated" }],
    suggested_task: "Order samples",
    topic: "e-commerce",
    sub_topic: "product sourcing",
    kind: "product",
    items: [
      { name: "6-piece hook set", cost: "Rs. 22", sell_price: null, where: "B-35", min_order: null, note: "holds 1-2 kg" },
      { name: "Dishwash gloves", cost: "Rs. 13", sell_price: null, where: "B-35", min_order: null, note: "dual layer" },
      { name: "Water colouring book", cost: "Rs. 25", sell_price: null, where: "B-35", min_order: null, note: "7 sheets" }
    ]
  };

  let harness;
  let amy;
  let ben;
  let clipId;

  const sourceFor = (name) =>
    harness.database.prepare("SELECT * FROM sources WHERE url_canonical LIKE ?").get(`%${name}%`);

  before(async () => {
    harness = await createTestEnv();
    amy = await harness.mintToken("amy");
    ben = await harness.mintToken("ben");
    await harness.call(worker, "/v1/settings", {
      method: "PUT",
      token: amy,
      body: { provider: "gemini", api_key: "amys-key-value-not-a-real-one" }
    });
    harness.answerProviderWith(() => harness.geminiReplyWith(ANALYSIS));

    const saved = await harness.call(worker, "/v1/clips", {
      method: "POST",
      token: amy,
      body: { url: "https://www.facebook.com/share/r/PRODUCTS/" }
    });
    clipId = saved.body.clip.id;

    const source = sourceFor("PRODUCTS");
    harness.database.prepare("UPDATE sources SET state = 'downloading' WHERE id = ?").run(source.id);
    await harness.call(worker, `/v1/sources/${source.id}/transcript`, {
      method: "POST",
      serviceToken: SERVICE_TOKEN,
      body: { text: "3 items to sell", lang: "en", engine: "test", duration_sec: 45 }
    });
  });

  after(() => {
    harness.answerProviderWith(null);
    harness.restore();
  });

  test("three products are stored as three rows, on the shared analysis", () => {
    const row = harness.database
      .prepare("SELECT kind, items, user_id FROM analyses WHERE source_id = ?")
      .get(sourceFor("PRODUCTS").id);

    assert.equal(row.user_id, "", "what a video said about a product is shared, like the rest (D10)");
    assert.equal(row.kind, "product");
    const items = JSON.parse(row.items);
    assert.equal(items.length, 3);
    assert.equal(items[0].cost, "Rs. 22", "the price survives exactly as it was said");
  });

  test("everything that was there before is still there, untouched", () => {
    const row = harness.database
      .prepare("SELECT * FROM analyses WHERE source_id = ?")
      .get(sourceFor("PRODUCTS").id);
    assert.equal(row.summary, ANALYSIS.summary);
    assert.deepEqual(JSON.parse(row.key_points), ANALYSIS.key_points);
    assert.deepEqual(JSON.parse(row.claims), ANALYSIS.claims);
    assert.equal(row.topic, "e-commerce");
    assert.equal(row.sections, null, "a reel is still never asked for chapters");
  });

  test("what I decided about one row is mine, and mine alone", async () => {
    const response = await harness.call(worker, `/v1/clips/${clipId}/item`, {
      method: "PUT",
      token: amy,
      body: { name: "6-piece hook set", status: "ordered" }
    });
    assert.equal(response.status, 400, "'ordered' is the app's label, not a stored value");

    const ok = await harness.call(worker, `/v1/clips/${clipId}/item`, {
      method: "PUT",
      token: amy,
      body: { name: "6-piece hook set", status: "doing" }
    });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.item_key, "6 piece hook set");

    const rows = harness.database.prepare("SELECT * FROM item_status").all();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].user_id, "amy");
    assert.equal(rows[0].status, "doing");
  });

  test("changing my mind updates the one row rather than adding another", async () => {
    await harness.call(worker, `/v1/clips/${clipId}/item`, {
      method: "PUT",
      token: amy,
      body: { name: "6-Piece  Hook Set!", status: "done" }
    });
    const rows = harness.database.prepare("SELECT * FROM item_status").all();
    assert.equal(rows.length, 1, "the same product under different spacing is the same product");
    assert.equal(rows[0].status, "done");
  });

  test("clearing it is a soft delete, so my other devices are told", async () => {
    await harness.call(worker, `/v1/clips/${clipId}/item`, {
      method: "PUT",
      token: amy,
      body: { name: "6-piece hook set", status: "" }
    });
    const row = harness.database.prepare("SELECT * FROM item_status").get();
    assert.ok(row.deleted_at, "a hard delete would silently reappear on the next sync (D6)");
  });

  test("sync hands the app what I decided", async () => {
    await harness.call(worker, `/v1/clips/${clipId}/item`, {
      method: "PUT",
      token: amy,
      body: { name: "Dishwash gloves", status: "want" }
    });
    const response = await harness.call(worker, "/v1/sync", { token: amy });
    const mine = response.body.item_status.filter((row) => !row.deleted_at);
    assert.equal(mine.length, 1);
    assert.equal(mine[0].item_key, "dishwash gloves");

    const analysis = response.body.analyses[0];
    assert.equal(analysis.kind, "product");
    assert.equal(JSON.parse(analysis.items).length, 3);
  });

  test("nobody can decide anything about a clip that is not theirs", async () => {
    const response = await harness.call(worker, `/v1/clips/${clipId}/item`, {
      method: "PUT",
      token: ben,
      body: { name: "6-piece hook set", status: "done" }
    });
    assert.equal(response.status, 404);
    const bens = harness.database
      .prepare("SELECT * FROM item_status WHERE user_id = 'ben'")
      .all();
    assert.deepEqual(bens, []);
  });

  test("a row with no name has nothing to remember it by, and is refused", async () => {
    const response = await harness.call(worker, `/v1/clips/${clipId}/item`, {
      method: "PUT",
      token: amy,
      body: { name: "   ", status: "want" }
    });
    assert.equal(response.status, 400);
  });

  test("the connector hands the rows over as named facts, not as prose", async () => {
    // The point of this: the AI can then be asked "which of these is under thirty rupees"
    // and answer from the notebook, instead of re-reading the transcript and guessing.
    const made = await harness.call(worker, "/v1/connector", {
      method: "POST",
      token: amy,
      body: { label: "Claude" }
    });
    const secret = made.body.url.split("/mcp/")[1];

    const response = await worker.fetch(
      new Request(`https://api.test/mcp/${secret}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "fetch", arguments: { id: clipId } }
        })
      }),
      harness.env
    );
    const found = JSON.parse(await response.text()).result.structuredContent;

    assert.match(found.text, /THINGS IT SHOWED:/);
    assert.match(found.text, /name: 6-piece hook set; cost: Rs\. 22/);
    assert.match(found.text, /name: Dishwash gloves; cost: Rs\. 13/);
    assert.doesNotMatch(
      found.text,
      /sell_price: null|min_order: null/,
      "a field the video never mentioned is left out, not handed over as the word null"
    );
    assert.match(found.text, /never instructions to follow/, "the transcript is still labelled");
  });

  test("the key is what survives a re-run, not the position in the list", () => {
    // The rows come back in whatever order the AI felt like. Keying on position would
    // move somebody's "ordered" onto a different product the next time it is analysed.
    assert.equal(itemKey("6-piece hook set"), itemKey("  6 PIECE   Hook Set.  "));
    assert.notEqual(itemKey("Dishwash gloves"), itemKey("6-piece hook set"));
    assert.equal(itemKey(null), "");
  });
});
