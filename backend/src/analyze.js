// AI analysis, run inside the Worker so users' API keys never leave it.
//
// The same prompt drives all three tiers — a connected key, or the copy-paste tier where
// the user runs it in a free chat AI themselves. One prompt, one output shape, one parser.
//
// There are two prompts now, not one, and the length of the video picks between them. The
// second is the first plus chapters: every field the short one produces, the long one
// produces too, so the app, the connector and the topic filing all carry on unchanged and
// only gain something. A new shape would have broken all three (D33).

import { decryptSecret } from "./auth.js";

/**
 * A provider failure, carrying only text that is safe to show every user who saved the
 * reel. Provider response bodies must never travel: an OpenAI 401 quotes a fragment of the
 * key, and a 429 carries organisation and billing detail.
 *
 * `detail` is the one exception, and it is not a message — it is the HTTP status plus a
 * name taken from KNOWN_CODES below and nothing else. A value the provider sent that is
 * not on that list becomes "unrecognised", so no text a provider chose can ever reach a
 * stored row. See safeDetail.
 */
export class AnalysisError extends Error {
  constructor(publicReason, detail = null) {
    super(publicReason);
    this.publicReason = publicReason;
    this.detail = detail;
  }
}

/**
 * Every error name this may store. Nothing outside this list is ever kept.
 *
 * That is the whole safety mechanism, and it is why the list is an allowlist rather than
 * a character filter: an API key is plain letters, digits, hyphen and underscore, so a
 * filter that allowed "safe characters" would happily pass a key straight through.
 *
 * Checked against the providers' own docs on 2026-08-29 (D13):
 *   Gemini    — ai.google.dev/gemini-api/docs/api-errors. The body is
 *               {"error":{"code","message"}}, code being the snake_case name, falling back
 *               to the snake_case HTTP status. Older replies also carry a SCREAMING_SNAKE
 *               "status", which lowercases onto the same names.
 *   Anthropic — platform.claude.com/docs/en/api/errors. The body is
 *               {"type":"error","error":{"type","message"},"request_id"}.
 * The OpenAI-compatible names below are NOT doc-verified — they are here so a familiar
 * name survives rather than becoming "unrecognised", and nothing depends on them.
 */
const KNOWN_CODES = new Set([
  // Gemini: the snake_case HTTP statuses
  "bad_request", "unauthorized", "forbidden", "not_found", "conflict",
  "requested_range_not_satisfiable", "too_many_requests", "client_closed_request",
  "internal_server_error", "not_implemented", "service_unavailable", "gateway_timeout",
  // Gemini: the canonical names
  "invalid_argument", "failed_precondition", "permission_denied", "unauthenticated",
  "resource_exhausted", "out_of_range", "aborted", "internal", "unavailable",
  "deadline_exceeded", "cancelled", "already_exists", "unimplemented", "unknown",
  "data_loss",
  // Anthropic
  "invalid_request_error", "authentication_error", "billing_error", "permission_error",
  "not_found_error", "conflict_error", "request_too_large", "rate_limit_error",
  "api_error", "timeout_error", "overloaded_error",
  // OpenAI-compatible — not doc-verified
  "insufficient_quota", "invalid_api_key", "model_not_found", "context_length_exceeded",
  "rate_limit_exceeded", "server_error"
]);

/**
 * What actually went wrong, in a form that cannot carry anybody's key or billing detail:
 * the HTTP status, and a name only if the provider sent one this file already knows.
 *
 * Without it, a 400 — which is most of what a provider can say — arrives as "the AI
 * provider refused the request" and there is nothing left to work from. Guessing at the
 * cause instead of recording it is exactly what Golden Rule 1 exists to stop.
 */
export function safeDetail(status, body) {
  const raw = body?.error?.status ?? body?.error?.code ?? body?.error?.type;
  const name = String(typeof raw === "object" ? "" : (raw ?? "")).trim().toLowerCase();
  return `${status} ${KNOWN_CODES.has(name) ? name : "unrecognised"}`;
}

/** Reads a failed reply's body without ever letting a parse failure hide the real error. */
async function detailFrom(response) {
  try {
    return safeDetail(response.status, await response.json());
  } catch {
    return `${response.status} unrecognised`;
  }
}

function classify(status) {
  if (status === 401 || status === 403) return "the connected AI key was rejected";
  // Documented by Anthropic as 402 billing_error, and by Gemini as a 400 the caller cannot
  // fix by retrying. Buried in "refused the request" it looked like a fault in the reel.
  if (status === 402) return "the AI account has a billing problem";
  if (status === 404) return "the AI provider does not have that model";
  if (status === 429) return "the AI provider's rate or quota limit was reached";
  if (status >= 500) return "the AI provider was unavailable";
  return "the AI provider refused the request";
}

/**
 * Statuses where asking again is pointless or harmful. A rejected key stays rejected; a
 * billing problem needs a human; and asking again after a 429 is what a rate limit is
 * there to stop. Everything else — including the 400s nobody can yet explain, and the
 * provider's own outages — is worth exactly one more try.
 */
const NEVER_RETRY = new Set([401, 402, 403, 413, 429]);
const RETRY_PAUSE_MS = 1500;

/** How long to wait before the one retry. Overridable so tests do not sleep. */
export const retryPause = { ms: RETRY_PAUSE_MS };

function shouldRetry(error) {
  if (!(error instanceof AnalysisError)) return false;
  const status = Number(String(error.detail || "").split(" ")[0]);
  return !NEVER_RETRY.has(status);
}

/**
 * Runs `attempt` once more if the first go failed in a way that asking again could fix.
 *
 * These failures are one-offs — three in eighty-six saves, on three different days, with
 * nothing in common between the videos. A one-off should be retried, not shown to the
 * person as a reel that cannot be summarised.
 */
export async function withOneRetry(attempt) {
  try {
    return await attempt();
  } catch (error) {
    if (!shouldRetry(error)) throw error;
    if (retryPause.ms > 0) await new Promise((done) => setTimeout(done, retryPause.ms));
    return attempt();
  }
}

/**
 * What kind of video this is. Everything is one of these — "other" is the honest answer,
 * not a failure, and it behaves exactly as every video behaved before kinds existed.
 */
export const KINDS = ["product", "tool", "tactic", "opinion", "other"];

/**
 * The rules that turn a kind into columns.
 *
 * Only "product" and "tool" earn a row shape, because only those two carry facts that a
 * person wants to sort, compare and tick off. A tactic's steps are already what
 * `key_points` is, and an opinion's substance is already what `claims` is — giving them a
 * second, emptier home would be a worse notebook, not a better one.
 *
 * Written once and used by both prompts, so a long video and a reel can never disagree
 * about what a product is.
 */
export const KIND_RULES = `
Rules for "kind" and "items":
- "kind" is what sort of video this is:
  - "product" — it shows things to buy, sell or source, with prices, suppliers or shops.
  - "tool" — it introduces an app, a website, a service or a code project.
  - "tactic" — it teaches a method or steps for doing something.
  - "opinion" — it argues a point, busts myths, or warns about something.
  - "other" — anything else. Use it whenever you are unsure. It is not a failure.
- "items" is a list, and it is EMPTY ([]) unless the kind is "product" or "tool".
- When the kind is "product", each item is:
  {"name": "the item", "cost": "what it costs to buy, as said", "sell_price": "what it
   sells for, as said, or null", "where": "the shop, supplier or market named, or null",
   "min_order": "the smallest quantity named, or null", "note": "one short line of spec"}
- When the kind is "tool", each item is:
  {"name": "the tool", "does": "one line on what it does", "popularity": "stars, users or
   downloads as said, or null", "price": "free, paid, open-source — as said, or null",
   "link": "the address given, or null", "install": "the command or step given, or null"}
- One entry per thing named. Three products mentioned means three items, never one.
- NEVER invent a value. Anything the video did not say is null.
- Copy prices and figures exactly as they were said, currency and all — "Rs. 22", not 22.
`;

export const ANALYSIS_PROMPT = `You are analysing the transcript of a short social-media video.

Reply with ONE fenced json code block and nothing else — no preamble, no explanation.

\`\`\`json
{
  "summary": "3-4 sentences on what this video actually said",
  "key_points": ["the specific facts, numbers, tactics or steps mentioned"],
  "learn_more": ["tools, terms, people or concepts named that are worth studying further"],
  "claims": [{"claim": "a claim made", "confidence": "high|medium|low", "why": "why you rated it that way"}],
  "suggested_task": "one concrete action worth taking, or null",
  "topic": "the broad subject this belongs under",
  "sub_topic": "the narrower subject inside that topic, or null",
  "kind": "product | tool | tactic | opinion | other",
  "items": []
}
\`\`\`

Rules for "topic" and "sub_topic":
- Name them from this video alone. You have not been shown anyone's existing topics.
- Use the plainest, most ordinary name for the subject, so that other videos about the
  same subject would be given the same name. "Amazon listings", not "Amazon listing
  optimisation secrets".
- "topic" is the broad subject, one to three words. "sub_topic" is the narrower subject
  inside it, or null if the video is not about anything narrower.
- Never name them after this specific video, its speaker, or its title.
${KIND_RULES}
TRANSCRIPT:
`;

// Past ten minutes a video stops being a clip. A 3-4 sentence summary of a ninety-minute
// interview is not a short answer, it is a useless one — so the ask changes with the
// length. Every field above is still here, in the same shape, plus chapters.
export const LONG_VIDEO_SEC = 600;

export const LONG_ANALYSIS_PROMPT = `You are analysing the transcript of a LONG video — a talk, an interview, a podcast or a lecture, not a short clip. It may run for an hour or more.

The transcript has times written into it, like [0:14:32]. They are there so a person can get back into the video. Use them.

Reply with ONE fenced json code block and nothing else — no preamble, no explanation.

\`\`\`json
{
  "summary": "8-12 sentences covering the whole video from start to finish, not just its opening",
  "sections": [{"at": "0:00:00", "heading": "what this stretch is about, a few words", "detail": "2-3 sentences on what was actually said in it"}],
  "key_points": ["the specific facts, numbers, tactics or steps mentioned, in the order they came up"],
  "learn_more": ["tools, terms, people or concepts named that are worth studying further"],
  "claims": [{"claim": "a claim made", "confidence": "high|medium|low", "why": "why you rated it that way"}],
  "suggested_task": "one concrete action worth taking, or null",
  "topic": "the broad subject this belongs under",
  "sub_topic": "the narrower subject inside that topic, or null",
  "kind": "product | tool | tactic | opinion | other",
  "items": []
}
\`\`\`

Rules for "sections":
- Follow the video's own turns. A new section starts where the subject actually changes,
  not on a fixed clock. Some will be two minutes long and some twenty.
- Between 5 and 24 of them. If the video only ever discusses one thing, say so in five
  sections rather than inventing twenty.
- "at" is COPIED from a time marker in the transcript — the nearest one at or before where
  that subject starts. Never invent a time, and never guess one that is not written down.
- "heading" names the subject in plain words. Not "Part 3", not the speaker's name.
- Cover the whole video. The last section must come from near the end, not the middle.

Rules for "topic" and "sub_topic":
- Name them from this video alone. You have not been shown anyone's existing topics.
- Use the plainest, most ordinary name for the subject, so that other videos about the
  same subject would be given the same name. "Amazon listings", not "Amazon listing
  optimisation secrets".
- "topic" is the broad subject, one to three words. "sub_topic" is the narrower subject
  inside it, or null if the video is not about anything narrower.
- Never name them after this specific video, its speaker, or its title.
${KIND_RULES}
TRANSCRIPT:
`;

/** Kinds this file recognises. Anything else the AI says becomes null — "not tracked". */
export function cleanKind(raw) {
  const value = String(raw ?? "").trim().toLowerCase();
  return KINDS.includes(value) ? value : null;
}

/**
 * The rows a kind is allowed to carry.
 *
 * A kind with no row shape gets none, however many the AI volunteered: there is no agreed
 * meaning for a "tactic" row, so storing one would put shapeless objects into a table
 * people read. Null and not "[]", for the same reason `sections` is null — a video with
 * nothing to track is then identical to every video stored before items existed.
 */
export function cleanItems(kind, raw) {
  if (kind !== "product" && kind !== "tool") return null;
  if (!Array.isArray(raw) || !raw.length) return null;
  return raw.filter((item) => item && typeof item === "object" && !Array.isArray(item));
}

/** What a person may say about one tracker row. Labelled per kind by the app. */
export const ITEM_STATUSES = ["want", "doing", "done", "no"];

/**
 * The name of a tracker row, flattened so the same row is recognised again after the
 * analysis has been re-run and the rows have come back in a different order or with the
 * wording nudged. Empty when there is no name to key on.
 */
export function itemKey(name) {
  return String(name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .slice(0, 120);
}

/** Which of the two prompts this video gets. Length decides, nothing else. */
export function promptFor(durationSec) {
  return isLong(durationSec) ? LONG_ANALYSIS_PROMPT : ANALYSIS_PROMPT;
}

/** One place decides what "long" means, so nothing can disagree about it. */
export function isLong(durationSec) {
  return Number(durationSec || 0) > LONG_VIDEO_SEC;
}

// Standalone hesitation only. Never inside a word, and never a word that carries meaning:
// "Mmm, no" loses nothing, but a filter that reached "I'm", "human" or "summary" would.
// The comma the hesitation was wearing goes with it -- taking "um" out of "So, um, the
// price" and leaving its comma behind gives "So,, the price".
const FILLER = /(^|[\s(])(?:u[mh]+|erm+|mm+|hmm+|uh huh)(?=[\s,.!?)]|$)\s*,?\s*/gi;

/**
 * Tidies a transcript for the AI only. What is stored stays word for word — this runs on
 * the way out, so nothing is ever lost from the record.
 *
 * Deliberately timid. It removes hesitation noises and whisper's own stutter, and nothing
 * else. The large saving would come from summarising the transcript before sending it,
 * and that is exactly the thing that would cost the detail the analysis is for.
 * Time markers like [0:14:32] are left alone — the long prompt is told to copy them.
 */
export function tidyTranscript(text) {
  const withoutFiller = String(text || "").replace(FILLER, "$1");

  // Whisper loops on music and silence, emitting the same sentence again and again. This
  // walks the sentences rather than using a back-reference, which on an hour of speech can
  // backtrack for longer than the analysis itself takes.
  const kept = [];
  let previous = "";
  for (const sentence of withoutFiller.split(/(?<=[.!?])\s+/)) {
    const key = sentence.trim().toLowerCase();
    if (key && key === previous) continue;
    if (key) previous = key;
    kept.push(sentence);
  }

  return kept
    .join(" ")
    // The same word said three or more times running — the other shape whisper's stutter
    // takes, inside a sentence rather than across two.
    .replace(/\b(\w+)(\s+\1\b){2,}/gi, "$1")
    .replace(/\s+/g, " ")
    .replace(/\s+([,.!?])/g, "$1")
    // Belt and braces for punctuation left stranded by whatever was removed above.
    .replace(/,(\s*,)+/g, ",")
    .trim();
}

// For clips summarised before topics existed (D27). It works from the summary already
// stored rather than the transcript — there is nothing to re-summarise, only a name to
// put on it, and the summary is a fraction of the length. The rules are word for word the
// ones above, so a clip named this way is indistinguishable from one named at the time.
export const TOPIC_PROMPT = `Below is a summary of a short social-media video.

Reply with ONE fenced json code block and nothing else — no preamble, no explanation.

\`\`\`json
{
  "topic": "the broad subject this belongs under",
  "sub_topic": "the narrower subject inside that topic, or null"
}
\`\`\`

Rules:
- Name them from this video alone. You have not been shown anyone's existing topics.
- Use the plainest, most ordinary name for the subject, so that other videos about the
  same subject would be given the same name. "Amazon listings", not "Amazon listing
  optimisation secrets".
- "topic" is the broad subject, one to three words. "sub_topic" is the narrower subject
  inside it, or null if the video is not about anything narrower.
- Never name them after this specific video, its speaker, or its title.

SUMMARY:
`;

// Providers that speak the OpenAI /chat/completions shape. Endpoints and model IDs
// checked against each provider's own docs on 2026-08-12 (see backend/README.md for
// which ones the docs confirmed and which are still unverified).
const OPENAI_COMPATIBLE = {
  openai: { url: "https://api.openai.com/v1/chat/completions", model: "gpt-5.6-luna" },
  groq: { url: "https://api.groq.com/openai/v1/chat/completions", model: "llama-3.3-70b-versatile" },
  xai: { url: "https://api.x.ai/v1/chat/completions", model: "grok-4.6" }
};

const GEMINI_MODEL = "gemini-3.5-flash-lite";
const ANTHROPIC_MODEL = "claude-haiku-4-5";
const MAX_OUTPUT_TOKENS = 4096;
// A long video's reply is a different size of thing: up to 24 chapters with a few
// sentences each, on top of everything the short reply already carries. At 4096 it runs
// out mid-sentence, and a cut-off reply is not a short analysis — it is unparseable JSON,
// which reaches the user as "the AI's reply was not in the expected format".
const LONG_MAX_OUTPUT_TOKENS = 16384;

/** Pulls the JSON object out of a model reply, fenced or not. */
export function parseAnalysis(raw) {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(String(raw));
  return JSON.parse(fenced ? fenced[1] : raw);
}

async function callGemini(prompt, apiKey, maxTokens) {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
    {
      method: "POST",
      // The key goes in a header, not the query string — a Google error that echoes the
      // request URI would otherwise carry the whole key into a shared error column.
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.2, maxOutputTokens: maxTokens }
      })
    }
  );

  if (!response.ok) {
    throw new AnalysisError(classify(response.status), await detailFrom(response));
  }
  const body = await response.json();
  const text = body.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new AnalysisError("the AI returned an empty reply", "200 empty_reply");
  return { text, model: body.modelVersion || GEMINI_MODEL };
}

async function callOpenAICompatible(prompt, apiKey, provider, maxTokens) {
  const { url, model } = OPENAI_COMPATIBLE[provider];
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      max_completion_tokens: maxTokens,
      messages: [{ role: "user", content: prompt }]
    })
  });

  if (!response.ok) {
    throw new AnalysisError(classify(response.status), await detailFrom(response));
  }
  const body = await response.json();
  const text = body.choices?.[0]?.message?.content;
  if (!text) throw new AnalysisError("the AI returned an empty reply", "200 empty_reply");
  return { text, model };
}

async function callAnthropic(prompt, apiKey, maxTokens) {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: maxTokens,
      temperature: 0.2,
      messages: [{ role: "user", content: prompt }]
    })
  });

  if (!response.ok) {
    throw new AnalysisError(classify(response.status), await detailFrom(response));
  }
  const body = await response.json();
  const text = body.content?.[0]?.text;
  if (!text) throw new AnalysisError("the AI returned an empty reply", "200 empty_reply");
  return { text, model: ANTHROPIC_MODEL };
}

/** Sends one prompt to whichever provider this key belongs to. */
async function callProvider(prompt, apiKey, provider, maxTokens = MAX_OUTPUT_TOKENS) {
  if (provider === "gemini") return callGemini(prompt, apiKey, maxTokens);
  if (provider === "anthropic") return callAnthropic(prompt, apiKey, maxTokens);
  if (OPENAI_COMPATIBLE[provider]) {
    return callOpenAICompatible(prompt, apiKey, provider, maxTokens);
  }
  throw new AnalysisError("that AI provider is not supported");
}

/**
 * Names a topic for a summary that already exists, using this user's own key — they
 * pressed the button, so it is their allowance being spent, never an earlier saver's.
 * Returns null when they have no key connected.
 */
export async function proposeTopic(env, userId, summary) {
  const owner = await env.DB.prepare(
    `SELECT ai_provider, ai_key_cipher
     FROM users
     WHERE id = ?1
       AND ai_key_cipher IS NOT NULL
       AND ai_provider IS NOT NULL
       AND ai_provider != 'manual'`
  )
    .bind(userId)
    .first();
  if (!owner) return null;

  const apiKey = await decryptSecret(owner.ai_key_cipher, env.KEY_ENCRYPTION_SECRET);

  return withOneRetry(async () => {
    const result = await callProvider(TOPIC_PROMPT + summary, apiKey, owner.ai_provider);
    try {
      const payload = parseAnalysis(result.text);
      return { topic: payload?.topic, sub_topic: payload?.sub_topic };
    } catch {
      throw new AnalysisError(
        "the AI's reply was not in the expected format",
        "200 unparseable_reply"
      );
    }
  });
}

/**
 * Analyses a transcript using a connected key belonging to any user who saved this reel.
 * Returns null when nobody who saved it has a key — that is the normal copy-paste path,
 * not an error.
 */
/**
 * `payerId` names the one person whose key must be used. It is set when somebody presses
 * "Summarise this one" for themselves: they are volunteering their own allowance, and
 * quietly spending an earlier saver's instead would be wrong. Left null — the automatic
 * run when a transcript lands — the first saver with a key pays, which is D10's cost model
 * and is unchanged.
 */
export async function analyzeSource(env, sourceId, transcript, payerId = null, durationSec = 0) {
  const owner = payerId
    ? await env.DB.prepare(
        `SELECT ai_provider, ai_key_cipher
         FROM users
         WHERE id = ?1
           AND ai_key_cipher IS NOT NULL
           AND ai_provider IS NOT NULL
           AND ai_provider != 'manual'`
      )
        .bind(payerId)
        .first()
    : await env.DB.prepare(
    `SELECT u.ai_provider, u.ai_key_cipher
     FROM clips c
     JOIN users u ON u.id = c.user_id
     WHERE c.source_id = ?1
       AND u.ai_key_cipher IS NOT NULL
       AND u.ai_provider IS NOT NULL
       AND u.ai_provider != 'manual'
     ORDER BY c.created_at
     LIMIT 1`
  )
    .bind(sourceId)
    .first();

  if (!owner) return null;

  const apiKey = await decryptSecret(owner.ai_key_cipher, env.KEY_ENCRYPTION_SECRET);
  const prompt = promptFor(durationSec) + tidyTranscript(transcript);
  const maxTokens = isLong(durationSec) ? LONG_MAX_OUTPUT_TOKENS : MAX_OUTPUT_TOKENS;

  // The call and the reading of it are retried together, because a reply that came back as
  // prose instead of JSON is the same kind of one-off as a reply that did not come back.
  const { payload, model } = await withOneRetry(async () => {
    const result = await callProvider(prompt, apiKey, owner.ai_provider, maxTokens);
    try {
      return { payload: parseAnalysis(result.text), model: result.model };
    } catch {
      throw new AnalysisError(
        "the AI's reply was not in the expected format",
        "200 unparseable_reply"
      );
    }
  });

  return { payload, provider: owner.ai_provider, model };
}
