// More than one AI key, spent in order (D35).
//
// The rotation rule is narrow on purpose, and the narrowness is the whole feature:
//
//   * ONLY a spent allowance moves to the next key.
//   * A rejected key STOPS the run and is shown — even when a later key would have
//     worked. A key that has gone bad has to be noticed, and a rotation that stepped
//     silently past it would hide it for ever. That is the case this file exists for.
//   * A provider outage or a malformed reply is nobody's key's fault, so no key is marked.
//   * Whose keys, in what order, is D10 unchanged: the first saver's whole list, then the
//     next saver's. Everybody it reaches saved that reel and gets the analysis.
//   * "Summarise this one" spends the presser's keys and NEVER falls through to anyone
//     else's — they volunteered their own allowance, not a stranger's.

import { test, before, after, beforeEach, describe } from "node:test";
import assert from "node:assert/strict";

import worker from "../src/worker.js";
import { RETRY_AFTER_MS, forDisplay } from "../src/keys.js";
import { categoryOf } from "../src/analyze.js";
import { AnalysisError, retryPause } from "../src/analyze.js";
import { createTestEnv } from "./helpers/testenv.js";

const SERVICE_TOKEN = "service-token-for-tests";

// Deliberately not shaped like real keys: CI's secret scan reads this file too.
const KEY_ONE = "first-key-value-not-a-real-one";
const KEY_TWO = "second-key-value-not-a-real-one";
const KEY_THREE = "third-key-value-not-a-real-one";

const ANALYSIS = {
  summary: "It explains how to price handmade jewellery.",
  key_points: ["Cost plus 2.5x"],
  learn_more: ["keystone pricing"],
  claims: [{ claim: "sellers underprice", confidence: "low", why: "no source" }],
  suggested_task: null,
  topic: "Pricing",
  sub_topic: null
};

const refusal = (status, type) =>
  new Response(JSON.stringify({ error: { type } }), { status });

describe("which failures are about the key, and which are not", () => {
  test("only a spent allowance is an exhaustion", () => {
    assert.equal(categoryOf(new AnalysisError("x", "429 rate_limit_error")), "exhausted");
  });

  test("a wrong key and an unpayable account are both the key's fault", () => {
    assert.equal(categoryOf(new AnalysisError("x", "401 unauthorized")), "rejected");
    assert.equal(categoryOf(new AnalysisError("x", "403 forbidden")), "rejected");
    assert.equal(categoryOf(new AnalysisError("x", "402 billing_error")), "rejected");
  });

  test("an outage is not the key's fault, and is not anybody else's account's either", () => {
    // This distinction is why a good key does not get taken out of the rotation the day a
    // provider has a bad afternoon — and why the run stops instead of walking every other
    // saver's list spending their allowance on a call that cannot succeed.
    assert.equal(categoryOf(new AnalysisError("x", "503 service_unavailable")), "other");
    assert.equal(categoryOf(new AnalysisError("x", "500 upstream")), "other");
    assert.equal(categoryOf(new AnalysisError("x")), "other");
  });

  test("but a model that account has not got is worth trying somewhere else", () => {
    // A key list can hold gemini, anthropic, groq and openai at once (D35). "It failed
    // here" then says nothing about what happens over there: a model missing from one
    // account, or one model that will not answer in JSON, used to stop the reel dead for
    // everybody, with a perfectly good account on another provider never tried.
    assert.equal(categoryOf(new AnalysisError("x", "404 model_not_found")), "unsuitable");
    assert.equal(categoryOf(new AnalysisError("x", "400 unrecognised")), "unsuitable");
    assert.equal(categoryOf(new AnalysisError("x", "200 unparseable_reply")), "unsuitable");
  });
});

describe("what the app is allowed to see of a key", () => {
  const row = {
    id: "k1",
    label: "work gmail",
    provider: "gemini",
    key_cipher: "THE-CIPHERTEXT",
    position: 0,
    state: "ready",
    last_error: null,
    last_error_detail: null,
    last_error_at: null,
    exhausted_at: null,
    last_used_at: 5
  };

  test("never the key, and never the ciphertext", () => {
    const shown = JSON.stringify(forDisplay(row));
    assert.ok(!shown.includes("THE-CIPHERTEXT"));
    assert.ok(!shown.includes("cipher"));
  });

  test("a key still inside its cooling-off period reads as out of allowance", () => {
    const at = 1_000_000_000;
    const shown = forDisplay({ ...row, state: "exhausted", exhausted_at: at - 60_000 }, at);
    assert.equal(shown.state, "exhausted");
    assert.equal(shown.ready_again_at, at - 60_000 + RETRY_AFTER_MS);
  });

  test("once the hour is up it reads as ready, because it is about to be tried", () => {
    // Saying "out of allowance" about a key the Worker will use on the next reel would be
    // a lie by the time the person read it.
    const at = 1_000_000_000;
    const shown = forDisplay({ ...row, state: "exhausted", exhausted_at: at - RETRY_AFTER_MS - 1 }, at);
    assert.equal(shown.state, "ready");
    assert.equal(shown.ready_again_at, null);
  });

  test("a rejected key never quietly becomes ready again", () => {
    const shown = forDisplay({ ...row, state: "rejected", last_error: "the connected AI key was rejected" });
    assert.equal(shown.state, "rejected");
    assert.match(shown.last_error, /rejected/);
  });
});

describe("spending one person's list", () => {
  let harness;
  let amy;
  let saved = 0;

  // Which key each call used, read off the header Gemini takes it in.
  const keyUsed = (options) => JSON.parse(JSON.stringify(options.headers))["x-goog-api-key"];

  const addKey = (token, api_key, label) =>
    harness.call(worker, "/v1/keys", { method: "POST", token, body: { provider: "gemini", api_key, label } });

  const keysOf = (token) => harness.call(worker, "/v1/keys", { token });

  const saveAndTranscribe = async (token, name) => {
    await harness.call(worker, "/v1/clips", {
      method: "POST",
      token,
      body: { url: `https://www.instagram.com/reel/${name}/` }
    });
    const source = harness.database
      .prepare("SELECT * FROM sources WHERE url_canonical LIKE ?")
      .get(`%${name}%`);
    harness.database.prepare("UPDATE sources SET state = 'downloading' WHERE id = ?").run(source.id);
    const response = await harness.call(worker, `/v1/sources/${source.id}/transcript`, {
      method: "POST",
      serviceToken: SERVICE_TOKEN,
      body: { text: "the words that were said", lang: "en", engine: "test" }
    });
    return { source, response };
  };

  const stateOf = (label) =>
    harness.database.prepare("SELECT * FROM ai_keys WHERE label = ?").get(label);

  before(async () => {
    retryPause.ms = 0;
    harness = await createTestEnv();
    amy = await harness.mintToken("amy");
    await addKey(amy, KEY_ONE, "first");
    await addKey(amy, KEY_TWO, "second");
    await addKey(amy, KEY_THREE, "third");
  });

  beforeEach(() => {
    harness.providerCalls.length = 0;
  });

  after(() => {
    harness.answerProviderWith(null);
    harness.restore();
    retryPause.ms = 1500;
  });

  test("they are held in the order they were added", async () => {
    const listed = (await keysOf(amy)).body.keys;
    assert.deepEqual(listed.map((k) => k.label), ["first", "second", "third"]);
    assert.deepEqual(listed.map((k) => k.state), ["ready", "ready", "ready"]);
  });

  test("the first key is used while it works, and the others are left alone", async () => {
    harness.answerProviderWith(() => harness.geminiReplyWith(ANALYSIS));
    await saveAndTranscribe(amy, `WORKS${saved++}`);

    assert.equal(harness.providerCalls.length, 1);
    assert.equal(keyUsed(harness.providerCalls[0].options), KEY_ONE);
  });

  test("a spent allowance moves to the next key, and the reel still gets summarised", async () => {
    harness.answerProviderWith((url, options) =>
      keyUsed(options) === KEY_ONE
        ? refusal(429, "rate_limit_error")
        : harness.geminiReplyWith(ANALYSIS)
    );

    const { source, response } = await saveAndTranscribe(amy, `SPENT${saved++}`);
    assert.equal(response.body.analyzed, true, "the second key must have finished the job");
    assert.deepEqual(
      harness.providerCalls.map((c) => keyUsed(c.options)),
      [KEY_ONE, KEY_TWO],
      "exactly one step down the list, not a scattergun"
    );

    const stored = harness.database
      .prepare("SELECT summary FROM analyses WHERE source_id = ? AND user_id = ''")
      .get(source.id);
    assert.ok(stored.summary, "the analysis is stored however far down the list it came from");
  });

  test("the spent key is marked, with the reason, so it can be seen", async () => {
    const key = stateOf("first");
    assert.equal(key.state, "exhausted");
    assert.match(key.last_error, /rate or quota limit/);
    assert.equal(key.last_error_detail, "429 rate_limit_error");
    assert.ok(key.exhausted_at, "and when, because that is what brings it back");
  });

  test("the key that worked is recorded as working, which clears any old error off it", async () => {
    const key = stateOf("second");
    assert.equal(key.state, "ready");
    assert.equal(key.last_error, null);
    assert.ok(key.last_used_at);
  });

  test("a spent key is skipped entirely while it is cooling off", async () => {
    harness.answerProviderWith(() => harness.geminiReplyWith(ANALYSIS));
    await saveAndTranscribe(amy, `SKIP${saved++}`);

    assert.deepEqual(
      harness.providerCalls.map((c) => keyUsed(c.options)),
      [KEY_TWO],
      "the exhausted first key must not be asked again inside the hour"
    );
  });

  test("and it comes back on its own once the hour is up", async () => {
    harness.database
      .prepare("UPDATE ai_keys SET exhausted_at = ? WHERE label = 'first'")
      .run(Date.now() - RETRY_AFTER_MS - 1000);

    harness.answerProviderWith(() => harness.geminiReplyWith(ANALYSIS));
    await saveAndTranscribe(amy, `WAKE${saved++}`);

    assert.equal(keyUsed(harness.providerCalls[0].options), KEY_ONE, "first in the list again");
    assert.equal(stateOf("first").state, "ready", "and no longer wearing yesterday's failure");
  });

  test("A REJECTED KEY STOPS THE RUN, even though the next key would have worked", async () => {
    // The case this whole feature was asked for. Rotating past a dead key would leave it
    // sitting there broken and unnoticed while the others quietly carried it.
    harness.answerProviderWith((url, options) =>
      keyUsed(options) === KEY_ONE
        ? refusal(401, "unauthorized")
        : harness.geminiReplyWith(ANALYSIS)
    );

    const { source, response } = await saveAndTranscribe(amy, `DEAD${saved++}`);

    assert.deepEqual(
      harness.providerCalls.map((c) => keyUsed(c.options)),
      [KEY_ONE],
      "it must not have gone on to the next key"
    );
    assert.equal(response.body.analyzed, false);
    assert.match(response.body.analysis_error, /key was rejected/);

    // The REEL's row says something every reader can act on. It is shared, so a sentence
    // about one person's AI account would be shown to people whose own accounts are fine —
    // and would send them to look at a key with nothing wrong with it.
    const reel = harness.database.prepare("SELECT error FROM sources WHERE id = ?").get(source.id);
    assert.match(reel.error, /summarise it there/, "and the reel says what to do about it");
    assert.ok(!/key was rejected/.test(reel.error), "a stranger's account named on a shared row");
    // The specific reason is not lost: it is against the key, for its owner.
    assert.match(stateOf("first").last_error, /rejected/);
    assert.equal(stateOf("first").state, "rejected");
  });

  test("a rejected key does not heal with time, unlike a spent one", async () => {
    harness.database
      .prepare("UPDATE ai_keys SET exhausted_at = ? WHERE label = 'first'")
      .run(Date.now() - RETRY_AFTER_MS - 1000);

    harness.answerProviderWith(() => harness.geminiReplyWith(ANALYSIS));
    await saveAndTranscribe(amy, `STILLDEAD${saved++}`);

    assert.ok(
      !harness.providerCalls.some((c) => keyUsed(c.options) === KEY_ONE),
      "waiting does not make a wrong key right"
    );
  });

  test("putting a new key in its place brings it back, with a clean slate", async () => {
    const dead = stateOf("first");
    const response = await harness.call(worker, `/v1/keys/${dead.id}`, {
      method: "PATCH",
      token: amy,
      body: { api_key: "replacement-key-value-not-a-real-one" }
    });
    assert.equal(response.status, 200);

    const fixed = stateOf("first");
    assert.equal(fixed.state, "ready");
    assert.equal(fixed.last_error, null, "the old key's failure is not the new key's record");
    assert.equal(fixed.last_error_detail, null);
  });

  test("an outage marks nobody's key, because it is nobody's key's fault", async () => {
    const before = stateOf("first");
    harness.answerProviderWith(() => refusal(503, "service_unavailable"));

    const { response } = await saveAndTranscribe(amy, `OUTAGE${saved++}`);

    assert.equal(response.body.analyzed, false);
    assert.match(response.body.analysis_error, /unavailable/);
    const after = stateOf("first");
    assert.equal(after.state, before.state, "a good key must not be blamed for an outage");
    assert.equal(after.last_error, before.last_error);
  });

  test("when every key is spent it says the list is empty, not that one provider said no", async () => {
    harness.answerProviderWith(() => refusal(429, "rate_limit_error"));

    const { response } = await saveAndTranscribe(amy, `ALLGONE${saved++}`);

    assert.equal(response.body.analyzed, false);
    assert.match(response.body.analysis_error, /all 3 connected AI keys are out of allowance/);
    assert.equal(harness.providerCalls.length, 3, "every key is tried before giving up");
  });
});

describe("whose keys pay, when more than one person saved the reel", () => {
  let harness;
  let amy;
  let ben;

  const keyUsed = (options) => JSON.parse(JSON.stringify(options.headers))["x-goog-api-key"];
  const AMYS_FIRST = "amys-first-key-value-not-a-real-one";
  const AMYS_SECOND = "amys-second-key-value-not-a-real-one";
  const BENS = "bens-key-value-not-a-real-one";

  before(async () => {
    retryPause.ms = 0;
    harness = await createTestEnv();
    amy = await harness.mintToken("amy");
    ben = await harness.mintToken("ben");

    const add = (token, api_key, label) =>
      harness.call(worker, "/v1/keys", {
        method: "POST",
        token,
        body: { provider: "gemini", api_key, label }
      });

    await add(amy, AMYS_FIRST, "amy 1");
    await add(amy, AMYS_SECOND, "amy 2");
    await add(ben, BENS, "ben 1");

    // Amy saves first, so under D10 hers is the list that pays.
    await harness.call(worker, "/v1/clips", {
      method: "POST",
      token: amy,
      body: { url: "https://www.instagram.com/reel/SHAREDONE/" }
    });
    await harness.call(worker, "/v1/clips", {
      method: "POST",
      token: ben,
      body: { url: "https://www.instagram.com/reel/SHAREDONE/" }
    });
  });

  after(() => {
    harness.answerProviderWith(null);
    harness.restore();
    retryPause.ms = 1500;
  });

  test("the first saver's WHOLE list is spent before anyone else's is touched", async () => {
    harness.answerProviderWith((url, options) =>
      keyUsed(options) === BENS
        ? harness.geminiReplyWith(ANALYSIS)
        : refusal(429, "rate_limit_error")
    );

    const source = harness.database
      .prepare("SELECT * FROM sources WHERE url_canonical LIKE ?")
      .get("%SHAREDONE%");
    harness.database.prepare("UPDATE sources SET state = 'downloading' WHERE id = ?").run(source.id);

    const response = await harness.call(worker, `/v1/sources/${source.id}/transcript`, {
      method: "POST",
      serviceToken: SERVICE_TOKEN,
      body: { text: "the words that were said", lang: "en", engine: "test" }
    });

    assert.equal(response.body.analyzed, true);
    assert.deepEqual(
      harness.providerCalls.map((c) => keyUsed(c.options)),
      [AMYS_FIRST, AMYS_SECOND, BENS],
      "both of Amy's, in her order, and only then Ben's"
    );
  });

  test("Ben gets the analysis his key paid for, which is what makes this fair", () => {
    const source = harness.database
      .prepare("SELECT * FROM sources WHERE url_canonical LIKE ?")
      .get("%SHAREDONE%");
    const shared = harness.database
      .prepare("SELECT summary FROM analyses WHERE source_id = ? AND user_id = ''")
      .get(source.id);
    assert.ok(shared.summary, "one shared analysis, readable by everyone who saved it (D10)");
  });

  test("pressing 'summarise this one' NEVER reaches another person's keys", async () => {
    // The presser volunteered their own allowance. Falling through here would quietly
    // spend a stranger's, which is exactly what the payer branch exists to prevent.
    await harness.call(worker, "/v1/clips", {
      method: "POST",
      token: ben,
      body: { url: "https://www.instagram.com/reel/BENSOWN/" }
    });
    const source = harness.database
      .prepare("SELECT * FROM sources WHERE url_canonical LIKE ?")
      .get("%BENSOWN%");
    harness.database.prepare("UPDATE sources SET state = 'downloading' WHERE id = ?").run(source.id);

    harness.answerProviderWith(() => refusal(429, "rate_limit_error"));
    await harness.call(worker, `/v1/sources/${source.id}/transcript`, {
      method: "POST",
      serviceToken: SERVICE_TOKEN,
      body: { text: "bens own reel", lang: "en", engine: "test" }
    });

    const clip = harness.database
      .prepare("SELECT id FROM clips WHERE user_id = 'ben' AND source_id = ?")
      .get(source.id);

    harness.providerCalls.length = 0;
    harness.answerProviderWith(() => refusal(429, "rate_limit_error"));
    await harness.call(worker, `/v1/clips/${clip.id}/summarise`, { method: "POST", token: ben });

    const used = harness.providerCalls.map((c) => keyUsed(c.options));
    assert.ok(!used.includes(AMYS_FIRST) && !used.includes(AMYS_SECOND), "never Amy's");
  });
});

describe("holding the list, and keeping it to yourself", () => {
  let harness;
  let amy;
  let ben;

  before(async () => {
    harness = await createTestEnv();
    amy = await harness.mintToken("amy");
    ben = await harness.mintToken("ben");
    await harness.call(worker, "/v1/keys", {
      method: "POST",
      token: amy,
      body: { provider: "gemini", api_key: KEY_ONE, label: "mine" }
    });
  });

  after(() => harness.restore());

  test("a key is stored encrypted, never in the clear", () => {
    const row = harness.database.prepare("SELECT key_cipher FROM ai_keys WHERE label = 'mine'").get();
    assert.ok(row.key_cipher);
    assert.ok(!row.key_cipher.includes(KEY_ONE));
  });

  test("neither the list nor sync ever carries the key back out", async () => {
    for (const path of ["/v1/keys", "/v1/sync?since=0"]) {
      const body = JSON.stringify((await harness.call(worker, path, { token: amy })).body);
      assert.ok(!body.includes(KEY_ONE), `${path} must not carry the key`);
      assert.ok(!body.includes("cipher"), `${path} must not carry the ciphertext either`);
    }
  });

  test("sync says a key is held, because the list is what decides that now", async () => {
    const sync = await harness.call(worker, "/v1/sync?since=0", { token: amy });
    assert.equal(sync.body.settings.has_key, true);
    assert.equal(sync.body.ai_keys.length, 1);
    assert.equal(sync.body.ai_keys[0].label, "mine");
  });

  test("somebody else's list is not in my sync, and I cannot touch it", async () => {
    const bensSync = await harness.call(worker, "/v1/sync?since=0", { token: ben });
    assert.deepEqual(bensSync.body.ai_keys, []);
    assert.equal(bensSync.body.settings.has_key, false);

    const mine = harness.database.prepare("SELECT id FROM ai_keys WHERE label = 'mine'").get();
    const patched = await harness.call(worker, `/v1/keys/${mine.id}`, {
      method: "PATCH",
      token: ben,
      body: { label: "stolen" }
    });
    assert.equal(patched.status, 404);

    const deleted = await harness.call(worker, `/v1/keys/${mine.id}`, {
      method: "DELETE",
      token: ben
    });
    assert.equal(deleted.status, 404);
    assert.equal(
      harness.database.prepare("SELECT label FROM ai_keys WHERE id = ?").get(mine.id).label,
      "mine"
    );
  });

  test("a key can be renamed and moved without being retyped", async () => {
    const mine = harness.database.prepare("SELECT id FROM ai_keys WHERE label = 'mine'").get();
    const before = harness.database.prepare("SELECT key_cipher FROM ai_keys WHERE id = ?").get(mine.id);

    await harness.call(worker, `/v1/keys/${mine.id}`, {
      method: "PATCH",
      token: amy,
      body: { label: "work gmail", position: 3 }
    });

    const after = harness.database.prepare("SELECT * FROM ai_keys WHERE id = ?").get(mine.id);
    assert.equal(after.label, "work gmail");
    assert.equal(after.position, 3);
    assert.equal(after.key_cipher, before.key_cipher, "renaming must not disturb the key");
  });

  test("the copy-paste tier is having no keys, so choosing it empties the list", async () => {
    await harness.call(worker, "/v1/settings", {
      method: "PUT",
      token: amy,
      body: { provider: "manual" }
    });
    const left = harness.database
      .prepare("SELECT COUNT(*) n FROM ai_keys WHERE user_id = 'amy'")
      .get().n;
    assert.equal(left, 0);

    const sync = await harness.call(worker, "/v1/sync?since=0", { token: amy });
    assert.equal(sync.body.settings.has_key, false);
  });

  test("'manual' cannot be one entry in a list of keys", async () => {
    const response = await harness.call(worker, "/v1/keys", {
      method: "POST",
      token: amy,
      body: { provider: "manual", api_key: KEY_ONE }
    });
    assert.equal(response.status, 400);
  });

  test("a key is required to add a key", async () => {
    const response = await harness.call(worker, "/v1/keys", {
      method: "POST",
      token: amy,
      body: { provider: "gemini", api_key: "   " }
    });
    assert.equal(response.status, 400);
  });

  test("the list has a ceiling, so it stays something a person can read", async () => {
    for (let i = 0; i < 10; i += 1) {
      const response = await harness.call(worker, "/v1/keys", {
        method: "POST",
        token: ben,
        body: { provider: "gemini", api_key: `ben-key-${i}-not-a-real-one` }
      });
      assert.equal(response.status, 201, `key ${i} should fit`);
    }
    const overflow = await harness.call(worker, "/v1/keys", {
      method: "POST",
      token: ben,
      body: { provider: "gemini", api_key: "ben-key-11-not-a-real-one" }
    });
    assert.equal(overflow.status, 400);
  });

  test("signing out of the API is still required to see any of it", async () => {
    const response = await harness.call(worker, "/v1/keys");
    assert.equal(response.status, 401);
  });
});
