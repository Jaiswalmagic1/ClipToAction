// Every claim the connector's search makes, with a test that fails when the claim is
// deleted.
//
// Round eighteen's regression half applied eleven mutations to the round-seventeen commit —
// ranking weights all set to 1, "every word must appear" loosened to "any word", the folder
// and status filters removed outright, `fetch` put back to reading the entire notebook —
// and the whole suite stayed green for every one of them. A feature with no test that
// bites is a feature nobody has checked since the day it was written.
//
// It also found four things that were simply wrong, all of which return silence rather than
// an error: a question in Hindi returned the WHOLE notebook labelled as matches, the
// `status` enum offered a word the notebook does not store, the video's own title and its
// address were not searched at all, and a date written any other way matched nothing.

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";

import worker from "../src/worker.js";
import { createTestEnv } from "./helpers/testenv.js";

const DAY = 24 * 60 * 60 * 1000;

describe("what search promises, proved one claim at a time", () => {
  let harness;
  let token;
  let secret;

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

  const reel = async (key, {
    platformTitle = null, summary = null, transcript = "some words",
    creator = null, topic = null, subTopic = null, kind = null,
    status = null, daysAgo = 1
  }) => {
    const saved = await harness.call(worker, "/v1/clips", {
      method: "POST",
      token,
      body: { url: `https://www.instagram.com/reel/${key}/` }
    });
    const clip = saved.body.clip;
    const at = Date.now() - daysAgo * DAY;

    harness.database
      .prepare(
        `UPDATE sources SET state = 'analyzed', title = ?, creator = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(platformTitle, creator, at, clip.source_id);
    harness.database.prepare("UPDATE clips SET created_at = ? WHERE id = ?").run(at, clip.id);
    if (status) {
      harness.database.prepare("UPDATE clips SET status = ? WHERE id = ?").run(status, clip.id);
    }
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
                                 learn_more, claims, topic, sub_topic, kind, created_at)
           VALUES (?, '', 'gemini', ?, '[]', '[]', '[]', ?, ?, ?, ?)
           ON CONFLICT (source_id, user_id) DO UPDATE SET summary = excluded.summary`
        )
        .run(clip.source_id, summary, topic, subTopic, kind, at);
    }
    return clip;
  };

  before(async () => {
    harness = await createTestEnv();
    token = await harness.mintToken("vish");

    // The subject is ONLY in the video's own title, not in the summary.
    await reel("KUNDAN", {
      platformTitle: "Kundan haar wholesale rates in Jaipur",
      summary: "A wholesaler talks through what he charges shops.",
      transcript: "he explains his rates",
      daysAgo: 2
    });
    await reel("HINDI", {
      platformTitle: "मीशो पर कीमत कैसे तय करें",
      summary: "Pricing on Meesho, explained by a seller.",
      transcript: "मीशो पर कीमत तय करने का तरीका",
      creator: "seller_bhai",
      daysAgo: 3
    });
    // Filler: mentions neither subject, is the most recent, and is filed nowhere — though
    // the reading proposed a folder for it.
    for (let n = 0; n < 6; n += 1) {
      await reel(`FILLER${n}`, {
        summary: "A reel about something else entirely.",
        transcript: "unrelated words about unrelated things",
        topic: "Selling",
        subTopic: "Odds",
        daysAgo: 0
      });
    }
    // One in a folder he actually made, and one he has put in the Keeping pile. Its
    // shortcode appears in NO other field — the address is the only place to find it.
    const filed = await reel("ZX9QW", {
      summary: "A reel he put in a folder by hand.",
      transcript: "put away by hand",
      daysAgo: 4
    });
    const at = Date.now();
    const makeTopic = (id, name, parentId) =>
      harness.database
        .prepare(
          `INSERT INTO topics (id, user_id, name, parent_id, name_key, created_at, updated_at)
           VALUES (?, 'vish', ?, ?, ?, ?, ?)`
        )
        .run(id, name, parentId, name.toLowerCase(), at, at);
    makeTopic("t-buying", "Buying", "");
    makeTopic("t-suppliers", "Suppliers", "t-buying");
    harness.database
      .prepare("UPDATE clips SET topic_id = 't-suppliers' WHERE id = ?")
      .run(filed.id);
    await reel("KEPT", {
      summary: "A reel he is keeping.",
      transcript: "worth keeping",
      status: "keep",
      daysAgo: 5
    });

    const made = await harness.call(worker, "/v1/connector", {
      method: "POST",
      token,
      body: { label: "Claude" }
    });
    secret = made.body.url.split("/mcp/")[1];
  });

  after(() => harness.restore());

  // ---- the four things that were simply wrong ----

  test("a question in Hindi finds the Hindi reel, not the whole notebook", async () => {
    // `wordsOf` split on anything outside a-z, so every Devanagari character was a
    // separator and the query reduced to no words at all. No words means "no query", which
    // returns everything — so a question in his own language handed the AI nine filler
    // reels reported as matches, with nothing in the reply to say the words had not been
    // read. Half of what he saves is in Hindi.
    const found = await call("search", { query: "मीशो कीमत" });
    assert.equal(found.total, 1, `${found.total} reels came back for a Hindi question`);
    assert.match(found.results[0].title, /मीशो/);
  });

  test("and a query of pure punctuation returns nothing, and says why", async () => {
    const found = await call("search", { query: "!!!???" });
    assert.equal(found.total, 0, "punctuation was answered with the entire notebook");
    assert.match(found.note, /No words could be read/i, found.note);
  });

  test("the video's own title is searchable, not just the summary's first line", async () => {
    // "Kundan haar wholesale rates in Jaipur" is the title the platform gave. The haystack
    // was built from `titleOf`, which was the SUMMARY's first sentence — so a word that is
    // in the video's real title found nothing here while the app's own search box found it,
    // which is the one thing `ownRows`' docblock promises can never happen.
    const found = await call("search", { query: "kundan" });
    assert.ok(found.total >= 1, "the video's own title is not being searched");
    assert.match(found.results[0].title, /Kundan haar/);
    assert.equal(found.results[0].matched_in, "title");
  });

  test("and so is the link, which is often all somebody has kept", async () => {
    // `zx9qw` is the shortcode and appears in no title, summary or transcript, so the only
    // way to find it is the address — which the app's own search box reads and this did not.
    const found = await call("search", { query: "zx9qw" });
    assert.equal(found.total, 1, "the address is not being searched");
    assert.equal(found.results[0].matched_in, "link");
  });

  test("the Keeping pile is askable by the word the notebook stores", async () => {
    // The schema's enum offered "keeping" — the app's button label — while the column holds
    // "keep". Because it is an enum, "keeping" was the only word a strict client could send,
    // so "what am I keeping?" was answered "nothing", however much was in the pile.
    const stored = await call("search", { status: "keep" });
    assert.equal(stored.total, 1, "status:keep found nothing");
    const label = await call("search", { status: "keeping" });
    assert.equal(label.total, 1, "the app's own word for the pile found nothing");

    // And the schema has to OFFER the stored word. It is an enum, so whatever it lists is
    // the only thing a strict client can send — listing "keeping" alone was what made "what
    // am I keeping?" answerable only by luck.
    const response = await worker.fetch(
      new Request(`https://api.test/mcp/${secret}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })
      }),
      harness.env
    );
    const listed = JSON.parse(await response.text());
    const search = listed.result.tools.find((one) => one.name === "search");
    assert.ok(
      search.inputSchema.properties.status.enum.includes("keep"),
      `the schema offers ${JSON.stringify(search.inputSchema.properties.status.enum)},`
        + " none of which is the word the notebook stores"
    );
  });

  test("a date written any other way is said out loud, not silently ignored", async () => {
    // A string comparison against YYYY-MM-DD, with no validation: a full timestamp, a
    // single-digit month or the word "yesterday" all matched nothing and read to the AI as
    // an empty notebook.
    const found = await call("search", { saved_after: "2026-9-1" });
    assert.ok(found.total > 0, "a malformed date silently emptied the notebook");
    assert.match(found.note, /YYYY-MM-DD/, found.note);
  });

  test("the folder filter means the folder HE put it in", async () => {
    // It matched the analysis's proposed topic too — so `folder:"Selling"` returned six
    // reels that are not filed anywhere, whose own fetch then says "Filed under: nothing
    // yet". Naming folders that do not exist is the exact fault D66 removed from fetch.
    const his = await call("search", { folder: "Suppliers" });
    assert.equal(his.total, 1, "his own folder found nothing");

    const proposed = await call("search", { folder: "Selling" });
    assert.equal(
      proposed.total,
      0,
      `${proposed.total} reels came back for a folder he has never made`
    );
  });

  // ---- the claims that survived deletion ----

  test("every word has to appear, not just one of them", async () => {
    // Loosened to "any word", the whole suite stayed green.
    const both = await call("search", { query: "kundan wholesale" });
    assert.equal(both.total, 1);
    const oneMissing = await call("search", { query: "kundan aeroplane" });
    assert.equal(
      oneMissing.total,
      0,
      `a word that is in no reel at all still matched ${oneMissing.total}`
    );
  });

  test("and a search that matches nothing says which way to move", async () => {
    const found = await call("search", { query: "kundan aeroplane" });
    assert.match(found.note, /fewer/i, found.note);
  });

  test("where a word was found decides the order, not how recent it is", async () => {
    // With every weight set to 1 the suite stayed green. "Meesho" is in one reel's title
    // and in another's transcript only; the title must come first even though the other is
    // the most recent thing in the notebook.
    // A word that is in NO shortcode, so the address cannot join in and skew it, and the
    // reel that is ABOUT it is the OLDER of the two — so if recency or a flat weighting
    // decided the order, the passing mention would come first.
    await reel("AAAA1", {
      platformTitle: "Polki setting, start to finish",
      summary: "A bench jeweller shows the whole job.",
      transcript: "he works through it",
      daysAgo: 9
    });
    await reel("AAAA2", {
      platformTitle: "An unrelated video",
      summary: "Nothing to do with it.",
      transcript: "and then he mentions polki once, in passing, near the end",
      daysAgo: 0
    });
    const found = await call("search", { query: "polki" });
    assert.equal(found.total, 2, `${found.total} matched`);
    assert.equal(
      found.results[0].matched_in,
      "title",
      "a passing mention in an hour of speech outranked the reel it is about:"
        + ` ${found.results[0].title} (${found.results[0].matched_in})`
    );
    assert.equal(found.results[1].matched_in, "the words spoken");
  });
});
