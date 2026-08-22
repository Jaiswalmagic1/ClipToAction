// AI analysis, run inside the Worker so users' API keys never leave it.
//
// The same prompt drives all three tiers — a connected key, or the copy-paste tier where
// the user runs it in a free chat AI themselves. One prompt, one output shape, one parser.

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

/** Pulls the JSON object out of a model reply, fenced or not. */
export function parseAnalysis(raw) {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(String(raw));
  return JSON.parse(fenced ? fenced[1] : raw);
}

async function callGemini(prompt, apiKey) {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
    {
      method: "POST",
      // The key goes in a header, not the query string — a Google error that echoes the
      // request URI would otherwise carry the whole key into a shared error column.
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.2, maxOutputTokens: MAX_OUTPUT_TOKENS }
      })
    }
  );

  if (!response.ok) throw new AnalysisError(classify(response.status));
  const body = await response.json();
  const text = body.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new AnalysisError("the AI returned an empty reply");
  return { text, model: body.modelVersion || GEMINI_MODEL };
}

async function callOpenAICompatible(prompt, apiKey, provider) {
  const { url, model } = OPENAI_COMPATIBLE[provider];
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      max_completion_tokens: MAX_OUTPUT_TOKENS,
      messages: [{ role: "user", content: prompt }]
    })
  });

  if (!response.ok) throw new AnalysisError(classify(response.status));
  const body = await response.json();
  const text = body.choices?.[0]?.message?.content;
  if (!text) throw new AnalysisError("the AI returned an empty reply");
  return { text, model };
}

async function callAnthropic(prompt, apiKey) {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: MAX_OUTPUT_TOKENS,
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
async function callProvider(prompt, apiKey, provider) {
  if (provider === "gemini") return callGemini(prompt, apiKey);
  if (provider === "anthropic") return callAnthropic(prompt, apiKey);
  if (OPENAI_COMPATIBLE[provider]) return callOpenAICompatible(prompt, apiKey, provider);
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
export async function analyzeSource(env, sourceId, transcript, payerId = null) {
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
  const result = await callProvider(ANALYSIS_PROMPT + transcript, apiKey, owner.ai_provider);

  let payload;
  try {
    payload = parseAnalysis(result.text);
  } catch {
    throw new AnalysisError("the AI's reply was not in the expected format");
  }

  return { payload, provider: owner.ai_provider, model: result.model };
}
