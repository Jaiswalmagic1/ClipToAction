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
 */
export class AnalysisError extends Error {
  constructor(publicReason) {
    super(publicReason);
    this.publicReason = publicReason;
  }
}

function classify(status) {
  if (status === 401 || status === 403) return "the connected AI key was rejected";
  if (status === 429) return "the AI provider's rate or quota limit was reached";
  if (status >= 500) return "the AI provider was unavailable";
  return "the AI provider refused the request";
}

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
  "sub_topic": "the narrower subject inside that topic, or null"
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
  "sub_topic": "the narrower subject inside that topic, or null"
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

TRANSCRIPT:
`;

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

  if (!response.ok) throw new AnalysisError(classify(response.status));
  const body = await response.json();
  const text = body.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new AnalysisError("the AI returned an empty reply");
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

  if (!response.ok) throw new AnalysisError(classify(response.status));
  const body = await response.json();
  const text = body.choices?.[0]?.message?.content;
  if (!text) throw new AnalysisError("the AI returned an empty reply");
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

  if (!response.ok) throw new AnalysisError(classify(response.status));
  const body = await response.json();
  const text = body.content?.[0]?.text;
  if (!text) throw new AnalysisError("the AI returned an empty reply");
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
  const result = await callProvider(TOPIC_PROMPT + summary, apiKey, owner.ai_provider);

  try {
    const payload = parseAnalysis(result.text);
    return { topic: payload?.topic, sub_topic: payload?.sub_topic };
  } catch {
    throw new AnalysisError("the AI's reply was not in the expected format");
  }
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
  const result = await callProvider(
    promptFor(durationSec) + tidyTranscript(transcript),
    apiKey,
    owner.ai_provider,
    isLong(durationSec) ? LONG_MAX_OUTPUT_TOKENS : MAX_OUTPUT_TOKENS
  );

  let payload;
  try {
    payload = parseAnalysis(result.text);
  } catch {
    throw new AnalysisError("the AI's reply was not in the expected format");
  }

  return { payload, provider: owner.ai_provider, model: result.model };
}
