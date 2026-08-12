// AI analysis, run inside the Worker so users' API keys never leave it.
//
// The same prompt drives all three tiers — a connected key, or the copy-paste tier where
// the user runs it in a free chat AI themselves. One prompt, one output shape, one parser.

import { decryptSecret } from "./auth.js";

export const ANALYSIS_PROMPT = `You are analysing the transcript of a short social-media video.

Reply with ONE fenced json code block and nothing else — no preamble, no explanation.

\`\`\`json
{
  "summary": "3-4 sentences on what this video actually said",
  "key_points": ["the specific facts, numbers, tactics or steps mentioned"],
  "learn_more": ["tools, terms, people or concepts named that are worth studying further"],
  "claims": [{"claim": "a claim made", "confidence": "high|medium|low", "why": "why you rated it that way"}],
  "suggested_task": "one concrete action worth taking, or null"
}
\`\`\`

TRANSCRIPT:
`;

// Providers that speak the OpenAI /chat/completions shape.
const OPENAI_COMPATIBLE = {
  openai: { url: "https://api.openai.com/v1/chat/completions", model: "gpt-4o-mini" },
  groq: { url: "https://api.groq.com/openai/v1/chat/completions", model: "llama-3.3-70b-versatile" },
  xai: { url: "https://api.x.ai/v1/chat/completions", model: "grok-2-latest" }
};

const GEMINI_MODEL = "gemini-3.5-flash-lite";
const ANTHROPIC_MODEL = "claude-haiku-4-5-20251001";

/** Pulls the JSON object out of a model reply, fenced or not. */
export function parseAnalysis(raw) {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(String(raw));
  return JSON.parse(fenced ? fenced[1] : raw);
}

async function callGemini(prompt, apiKey) {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.2, maxOutputTokens: 2048 }
      })
    }
  );

  if (!response.ok) throw new Error(`Gemini ${response.status}: ${await response.text()}`);
  const body = await response.json();
  const text = body.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("Gemini returned no text");
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
      messages: [{ role: "user", content: prompt }]
    })
  });

  if (!response.ok) throw new Error(`${provider} ${response.status}: ${await response.text()}`);
  const body = await response.json();
  const text = body.choices?.[0]?.message?.content;
  if (!text) throw new Error(`${provider} returned no text`);
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
      max_tokens: 2048,
      temperature: 0.2,
      messages: [{ role: "user", content: prompt }]
    })
  });

  if (!response.ok) throw new Error(`Anthropic ${response.status}: ${await response.text()}`);
  const body = await response.json();
  const text = body.content?.[0]?.text;
  if (!text) throw new Error("Anthropic returned no text");
  return { text, model: ANTHROPIC_MODEL };
}

/**
 * Analyses a transcript using a connected key belonging to any user who saved this reel.
 * Returns null when nobody who saved it has a key — that is the normal copy-paste path,
 * not an error.
 */
export async function analyzeSource(env, sourceId, transcript) {
  const owner = await env.DB.prepare(
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
  const prompt = ANALYSIS_PROMPT + transcript;

  let result;
  if (owner.ai_provider === "gemini") {
    result = await callGemini(prompt, apiKey);
  } else if (owner.ai_provider === "anthropic") {
    result = await callAnthropic(prompt, apiKey);
  } else if (OPENAI_COMPATIBLE[owner.ai_provider]) {
    result = await callOpenAICompatible(prompt, apiKey, owner.ai_provider);
  } else {
    throw new Error(`Unsupported provider: ${owner.ai_provider}`);
  }

  return {
    payload: parseAnalysis(result.text),
    provider: owner.ai_provider,
    model: result.model
  };
}
