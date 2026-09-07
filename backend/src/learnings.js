// What the user LEARNED from a reel, and the text that goes out to get it (D29).
//
// The loop this file serves:
//   1. The reel goes out to whatever AI the user already talks to, along with an
//      instruction to teach them and then hand back one fenced json block.
//   2. The conversation happens over there.
//   3. The json comes back here, is checked, and is stored against the clip.
//
// Where a connector exists (Stage 3) the same shape is written straight in and steps 1
// and 3 stop being copy and paste. Nothing else about it changes, which is why the shape
// lives here on its own rather than inside the paste handler.

// The seven fields of D29. Six are lists; the seventh is which AI it was, and the date
// the row was written.
export const LEARNING_LISTS = [
  "learned",
  "verdicts",
  "actions",
  "still_open",
  "corrections",
  "look_into"
];

// A verdict is one of three words and nothing else. "probably" and "mostly true" are how
// a list of claims turns back into prose nobody can filter on later.
export const VERDICTS = ["true", "false", "unsure"];

const LIMITS = {
  items: 50,
  item: 2000,
  learnedWith: 200
};

/**
 * The text a user copies into their AI app. It carries what the reel said, the claims
 * worth checking, and the words themselves — then asks for the learning back.
 *
 * The teaching instruction comes FIRST and the json block second, deliberately. Asked for
 * json up front, a model answers in json and skips the conversation, which is the entire
 * point of the feature.
 */
export function buildLearningPrompt({ summary, keyPoints, claims, transcript }) {
  const lines = [
    "I saved a short social-media video and I want to actually understand it, not just",
    "file it away. Teach me what is in it.",
    "",
    "Work with me first — explain it properly, tell me where it is right and where it is",
    "wrong or oversimplified, and answer whatever I ask. Take as long as we need.",
    "",
    "When I say we are done, and ONLY then, end your reply with one fenced json block in",
    "exactly this shape, so I can file what we worked out:",
    "",
    "```json",
    "{",
    '  "learned": ["what I now understand, in plain sentences"],',
    '  "verdicts": [{"claim": "a claim the video made", "verdict": "true|false|unsure", "why": "the reason"}],',
    '  "actions": ["what I said I would actually do about it"],',
    '  "still_open": ["what we did not settle"],',
    '  "corrections": ["where the video was wrong or misleading"],',
    '  "look_into": ["worth reading or trying next"],',
    '  "learned_with": "which AI app and model this was"',
    "}",
    "```",
    "",
    "Every list may be empty. Do not invent entries to fill them.",
    ""
  ];

  if (summary) lines.push("WHAT THE VIDEO SAID:", summary, "");

  const points = (keyPoints || []).filter(Boolean);
  if (points.length) {
    lines.push("THE MAIN POINTS:");
    for (const point of points) lines.push(`- ${point}`);
    lines.push("");
  }

  // The claims go out with the confidence already on them, so the conversation starts
  // from what is already doubted rather than re-deriving it.
  const doubts = (claims || []).filter(Boolean);
  if (doubts.length) {
    lines.push("CLAIMS IT MADE, AND HOW MUCH THEY WERE TRUSTED:");
    for (const entry of doubts) {
      const claim = String(entry?.claim ?? entry);
      const confidence = entry?.confidence ? ` [${entry.confidence} confidence]` : "";
      const why = entry?.why ? ` — ${entry.why}` : "";
      lines.push(`- ${claim}${confidence}${why}`);
    }
    lines.push("");
  }

  if (transcript) lines.push("EVERYTHING THAT WAS SAID:", transcript);

  return lines.join("\n");
}

/**
 * Returns the problems with a pasted learning. Empty means it can be stored.
 *
 * Same contract as validateAnalysis: a list of field names a person can be shown, never
 * a thrown error, so the app can say what to fix instead of "invalid".
 */
export function validateLearning(payload) {
  const problems = [];

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return ["it is not an object"];
  }

  for (const field of LEARNING_LISTS) {
    const value = payload[field];
    // Missing is treated as empty. A session that produced no corrections is a normal
    // session, and refusing the whole thing over an absent list would throw away a real
    // conversation for a formatting slip.
    if (value === null || value === undefined) continue;
    if (!Array.isArray(value)) problems.push(field);
    else if (value.length > LIMITS.items) problems.push(`${field} has too many items`);
    else if (value.some((item) => JSON.stringify(item ?? "").length > LIMITS.item)) {
      problems.push(`${field} has an item that is too long`);
    }
  }

  // Array.isArray, not a truthiness check. `verdicts` as an object, a number or a string
  // is not iterable, so `for...of` THREW — out of a function whose whole contract is to
  // return a list of problems, past the route, into the router's catch, and back to him as
  // a bare 500 with his entire copied AI conversation discarded and nothing saying what
  // was wrong with it.
  for (const entry of Array.isArray(payload.verdicts) ? payload.verdicts : []) {
    if (!entry || typeof entry !== "object") { problems.push("a verdict is not an object"); break; }
    if (!String(entry.claim || "").trim()) { problems.push("a verdict has no claim"); break; }
    if (!VERDICTS.includes(String(entry.verdict || "").toLowerCase())) {
      problems.push(`a verdict must be one of: ${VERDICTS.join(", ")}`);
      break;
    }
  }

  if (payload.learned_with !== null && payload.learned_with !== undefined
      && typeof payload.learned_with !== "string") {
    problems.push("learned_with");
  }

  // An entirely empty learning is not a learning. Without this the paste box happily
  // stores `{}` and the clip grows a row saying nothing, which is worse than no row.
  const empty = LEARNING_LISTS.every((field) => !(payload[field] || []).length);
  if (empty && !problems.length) problems.push("it is empty — nothing was learned in it");

  return problems;
}

/** The payload as the columns of one row: the six lists as JSON text, the seventh trimmed. */
export function learningColumns(payload) {
  const columns = {};
  for (const field of LEARNING_LISTS) {
    const value = payload[field];
    columns[field] = JSON.stringify(Array.isArray(value) ? value : []);
  }
  columns.learned_with =
    String(payload.learned_with || "").trim().slice(0, LIMITS.learnedWith) || null;
  return columns;
}
