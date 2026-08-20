// Tier 3 (D9) has a user paste a chat AI's reply back into the app. Whatever they
// paste is untrusted text: it may be fenced, unfenced, wrapped in chatter, or the
// wrong thing entirely. These tests pin the two rules that keep that safe —
// parse what is genuinely there, and refuse to store anything malformed
// (Golden Rule 29: fail visibly, never save garbage).

import { test } from "node:test";
import assert from "node:assert/strict";

import { parseAnalysis } from "../src/analyze.js";
import { validateAnalysis } from "../src/worker.js";

const goodPayload = {
  summary: "The video explains three ways to price handmade jewellery.",
  key_points: ["Cost plus 2.5x", "Check competitor listings", "Raise prices in Q4"],
  learn_more: ["keystone pricing", "Meesho price benchmarking"],
  claims: [{ claim: "Most sellers underprice by 30%", confidence: "low", why: "No source given" }],
  suggested_task: "Reprice the top 10 listings"
};

test("parses a fenced json block, ignoring surrounding chatter", () => {
  const pasted = [
    "Sure! Here is the analysis you asked for:",
    "```json",
    JSON.stringify(goodPayload),
    "```",
    "Let me know if you want anything changed."
  ].join("\n");

  assert.deepEqual(parseAnalysis(pasted), goodPayload);
});

test("parses a bare fence with no language tag", () => {
  const pasted = "```\n" + JSON.stringify(goodPayload) + "\n```";
  assert.deepEqual(parseAnalysis(pasted), goodPayload);
});

test("parses raw json when the AI omitted the fence", () => {
  assert.deepEqual(parseAnalysis(JSON.stringify(goodPayload)), goodPayload);
});

test("throws when the paste is not the AI's answer at all", () => {
  assert.throws(() => parseAnalysis("I can't help with that."));
  assert.throws(() => parseAnalysis(""));
  assert.throws(() => parseAnalysis("```json\n{ oops not json\n```"));
});

test("a complete analysis validates clean", () => {
  assert.deepEqual(validateAnalysis(goodPayload), []);
});

test("every missing or wrong-typed field is reported, not just the first", () => {
  const problems = validateAnalysis({ summary: "   ", key_points: "not an array" });

  assert.ok(problems.includes("summary"), "blank summary must be caught");
  assert.ok(problems.includes("key_points"), "a string is not a list of key points");
  assert.ok(problems.includes("learn_more"), "missing learn_more must be caught");
  assert.ok(problems.includes("claims"), "missing claims must be caught");
});

test("null and undefined are rejected rather than throwing", () => {
  assert.ok(validateAnalysis(null).length > 0);
  assert.ok(validateAnalysis(undefined).length > 0);
});

test("suggested_task is optional", () => {
  const { suggested_task, ...withoutTask } = goodPayload;
  assert.deepEqual(validateAnalysis(withoutTask), []);
});
