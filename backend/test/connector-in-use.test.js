// Sitting where the AI sits.
//
// Round ten attacked this connector for security. Round seventeen asked the question
// nobody had: does it actually WORK — can a model answer the things a person asks their AI
// about their own notebook? Of seven such questions, two were answered well, two only by
// luck, and three not at all.
//
// Everything here goes over the real JSON-RPC wire against the real Worker, because a
// passing unit test tells you what is covered and not whether the feature is any good.

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";

import worker from "../src/worker.js";
import { createTestEnv } from "./helpers/testenv.js";

const SERVICE_TOKEN = "service-token-for-tests";

describe("what an AI can actually answer from this notebook", () => {
  let harness;
  let token;
  let secret;
  const clipOf = new Map();

  const call = async (name, args) => {
    const response = await worker.fetch(
      new Request(`https://api.test/mcp/${secret}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name, arguments: args }
        })
      }),
      harness.env
    );
    const body = JSON.parse(await response.text());
    return body.result?.structuredContent ?? body;
  };

  /** One reel, written straight in the way the pipeline would have left it. */
  const reel = async (key, { title, summary, kind = null, items = null, creator = null,
    topic = null, subTopic = null, transcript = "some words", state = "analyzed",
    error = null, daysAgo = 1, note = null }) => {
    const saved = await harness.call(worker, "/v1/clips", {
      method: "POST",
      token,
      body: { url: `https://www.instagram.com/reel/${key}/` }
    });
    const clip = saved.body.clip;
    clipOf.set(key, clip);
    const at = Date.now() - daysAgo * 24 * 60 * 60 * 1000;

    harness.database
      .prepare(
        `UPDATE sources SET state = ?, error = ?, title = ?, creator = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(state, error, title, creator, at, clip.source_id);
    harness.database
      .prepare("UPDATE clips SET created_at = ? WHERE id = ?")
      .run(at, clip.id);
    // A reel that never got that far has no transcript row at all, which is what a failed
    // or waiting one looks like in the database.
    if (transcript) {
      harness.database
        .prepare(
          `INSERT INTO transcripts (source_id, text, lang, engine, created_at)
           VALUES (?, ?, 'en', 'test', ?)
           ON CONFLICT (source_id) DO UPDATE SET text = excluded.text`
        )
        .run(clip.source_id, transcript, at);
    }

    if (summary) {
      harness.database
        .prepare(
          `INSERT INTO analyses (source_id, user_id, provider, summary, key_points,
                                 learn_more, claims, topic, sub_topic, kind, items, created_at)
           VALUES (?, '', 'gemini', ?, '[]', '[]', '[]', ?, ?, ?, ?, ?)
           ON CONFLICT (source_id, user_id) DO UPDATE SET summary = excluded.summary`
        )
        .run(clip.source_id, summary, topic, subTopic, kind,
          items ? JSON.stringify(items) : null, at);
    }

    if (note) {
      await harness.call(worker, "/v1/notes", {
        method: "POST",
        token,
        body: { clip_id: clip.id, body: note }
      });
    }
    return clip;
  };

  before(async () => {
    harness = await createTestEnv();
    token = await harness.mintToken("vish");

    // Twenty filler reels that mention both words, saved most recently — the shape that
    // made the old search return twenty of these and none of the four real ones.
    for (let n = 0; n < 20; n += 1) {
      await reel(`FILLER${n}`, {
        title: `Filler reel ${n}`,
        summary: `A reel about meesho and pricing and returns, number ${n}.`,
        daysAgo: 1
      });
    }

    await reel("REAL1", {
      title: "How to price on Meesho without losing money",
      summary: "Working out the pricing on Meesho once commission and returns are counted.",
      topic: "Selling",
      subTopic: "Meesho",
      daysAgo: 40
    });
    await reel("JAIPUR", {
      title: "A Jaipur wholesaler on margins",
      summary: "What margin a kundan set leaves once the wholesaler is paid.",
      creator: "jaipur_kundan_wholesale",
      daysAgo: 50
    });
    await reel("SUNDAY", {
      title: "Sunday Pickup, explained",
      summary: "What Sunday Pickup does and how to switch it on.",
      kind: "tactic",
      items: [{ name: "Switch on Sunday Pickup", does: "orders collected on Sundays" }],
      daysAgo: 60
    });
    await reel("TOOLS", {
      title: "Three apps for listing photos",
      summary: "Apps that clean up a product photo.",
      kind: "tool",
      items: [{ name: "Photoroom", does: "cuts the background out" }],
      daysAgo: 70
    });
    await reel("BROKEN", {
      title: null,
      summary: null,
      state: "failed",
      error: "That account is private, so nothing could be fetched.",
      transcript: null,
      daysAgo: 3
    });
    await reel("WAITING", {
      title: "A four-hour talk",
      summary: null,
      state: "needs_ok",
      transcript: null,
      daysAgo: 2
    });

    const made = await harness.call(worker, "/v1/connector", {
      method: "POST",
      token,
      body: { label: "Claude" }
    });
    secret = made.body.url.split("/mcp/")[1];
  });
  after(() => harness.restore());

  test("\"what did I save about Meesho pricing\" finds the reel that answers it", async () => {
    const found = await call("search", { query: "meesho pricing" });
    const ids = found.results.map((one) => one.id);
    assert.ok(
      ids.includes(clipOf.get("REAL1").id),
      "twenty filler reels came back and the one that answers the question did not"
    );
    // And it is at the top, not buried under the filler.
    assert.equal(found.results[0].id, clipOf.get("REAL1").id);
  });

  test("the words need not sit next to each other, or in that order", async () => {
    for (const query of ["pricing on Meesho", "pricing meesho", "meesho, pricing"]) {
      const found = await call("search", { query });
      assert.ok(
        found.results.some((one) => one.id === clipOf.get("REAL1").id),
        `"${query}" found nothing`
      );
    }
  });

  test("and it says how many there really were", async () => {
    const found = await call("search", { query: "meesho" });
    assert.ok(found.total > found.showing, "the count and the page are the same number");
    assert.equal(found.showing, found.results.length);
    assert.match(found.note, /reels match/);
  });

  test("\"what is in my notebook\" is answerable at all", async () => {
    const found = await call("search", {});
    assert.ok(found.results.length > 0, "an empty question reads as an empty notebook");
    assert.equal(found.total, 26);
    assert.ok(found.results[0].saved_on, "nothing says when anything was saved");
  });

  test("and so is \"what did I save last week\"", async () => {
    const lastWeek = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    const found = await call("search", { saved_after: lastWeek });
    assert.ok(found.total >= 1);
    assert.ok(
      !found.results.some((one) => one.id === clipOf.get("JAIPUR").id),
      "a reel from fifty days ago came back as this week's"
    );
  });

  test("\"what tools have I collected\" asks for tools, not the word tool", async () => {
    const found = await call("search", { kind: "tool" });
    assert.equal(found.total, 1);
    assert.equal(found.results[0].id, clipOf.get("TOOLS").id);
  });

  test("\"what did that jeweller in Jaipur say\" finds them by name", async () => {
    const found = await call("search", { creator: "jaipur" });
    assert.equal(found.total, 1);
    assert.equal(found.results[0].id, clipOf.get("JAIPUR").id);
  });

  test("a reel that could not be read says so, rather than looking empty", async () => {
    const found = await call("fetch", { id: clipOf.get("BROKEN").id });
    assert.match(found.text, /could not be read/);
    assert.match(found.text, /account is private/);

    // Listed by date rather than by words, since a failed reel has no words in it.
    // India dates, like the server's — a UTC one is a different day for five and a half
    // hours out of every twenty-four.
    const istDay = (at) =>
      new Date(at + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const threeDaysAgo = istDay(Date.now() - 3 * 24 * 60 * 60 * 1000);
    const listed = await call("search", { saved_before: threeDaysAgo });
    const row = listed.results.find((one) => one.id === clipOf.get("BROKEN").id);
    assert.ok(row, "a failed reel is missing from the list altogether");
    assert.match(row.state, /could not be read/, "the list gives no hint either");
  });

  test("and one waiting on his go-ahead says that", async () => {
    const found = await call("fetch", { id: clipOf.get("WAITING").id });
    assert.match(found.text, /waiting for the owner to say yes/);
  });

  test("what he has decided about a tracker row is in the reply", async () => {
    const clip = clipOf.get("SUNDAY");
    await harness.call(worker, `/v1/clips/${clip.id}/item`, {
      method: "PUT",
      token,
      body: { name: "Switch on Sunday Pickup", status: "done" }
    });

    const found = await call("fetch", { id: clip.id });
    assert.match(
      found.text,
      /has done this/,
      "the AI cannot tell he has already done it, and will tell him to go and do it"
    );
  });

  test("a very long video's words are cut, and the cut is said out loud", async () => {
    const clip = clipOf.get("REAL1");
    harness.database
      .prepare("UPDATE transcripts SET text = ? WHERE source_id = ?")
      .run("x".repeat(200000), clip.source_id);

    const found = await call("fetch", { id: clip.id });
    assert.ok(found.text.length < 120000, `the reply was ${found.text.length} characters`);
    assert.match(found.text, /Cut here/);
    assert.match(found.text, /200000 characters of speech/);
  });

  test("the folder it reports is the one he has it in", async () => {
    const clip = clipOf.get("REAL1");
    await harness.call(worker, `/v1/clips/${clip.id}/topic`, {
      method: "PUT",
      token,
      body: { topic: "Jaipur suppliers", sub_topic: "Kundan" }
    });

    const found = await call("fetch", { id: clip.id });
    assert.match(found.text, /Filed under: Jaipur suppliers/);
    assert.ok(
      !found.text.includes("Filed under: Selling"),
      "it named the folder the reading suggested, not the one he actually uses"
    );
  });

  test("a verdict is stored in the notebook's own three words", async () => {
    const clip = clipOf.get("SUNDAY");
    const saved = await call("save_learning", {
      clip_id: clip.id,
      learned: ["Sunday Pickup is worth switching on"],
      verdicts: [{ claim: "it is free", verdict: "True", why: "their own page says so" }]
    });
    assert.equal(saved.saved, true);

    const found = await call("fetch", { id: clip.id });
    assert.match(found.text, /= true \(/, "a fourth verdict word entered the notebook");
  });
});
