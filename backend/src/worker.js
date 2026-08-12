// ClipToAction API — Cloudflare Worker over D1.
//
// Two callers:
//   * the app      — authenticates with a Firebase ID token (Google sign-in)
//   * the PC worker — authenticates with the WORKER_SERVICE_TOKEN secret
//
// Nothing here ever returns a stored API key to a client, and no failure is swallowed:
// a source that fails to download or transcribe keeps its error text so the app can show
// it instead of leaving the user staring at a clip stuck on "pending".

import { verifyFirebaseToken, encryptSecret, tokensMatch } from "./auth.js";
import { canonicalUrl, platformFromUrl, extractUrl } from "./canonical.js";
import { ANALYSIS_PROMPT, analyzeSource, parseAnalysis } from "./analyze.js";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,PATCH,PUT,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type,Authorization,X-Service-Token"
};

const PROVIDERS = ["gemini", "groq", "openai", "anthropic", "xai", "manual"];

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS }
  });
}

function fail(message, status = 400) {
  return json({ error: message }, status);
}

const now = () => Date.now();
const newId = () => crypto.randomUUID();

async function requireUser(request, env) {
  const header = request.headers.get("Authorization") || "";
  if (!header.startsWith("Bearer ")) throw new Error("Missing bearer token");
  const claims = await verifyFirebaseToken(header.slice(7), env.FIREBASE_PROJECT_ID);

  const timestamp = now();
  await env.DB.prepare(
    `INSERT INTO users (id, email, display_name, created_at, last_seen_at)
     VALUES (?1, ?2, ?3, ?4, ?4)
     ON CONFLICT (id) DO UPDATE SET last_seen_at = ?4, email = ?2`
  )
    .bind(claims.sub, claims.email || null, claims.name || null, timestamp)
    .run();

  return claims.sub;
}

function requireService(request, env) {
  const provided = request.headers.get("X-Service-Token") || "";
  if (!tokensMatch(provided, env.WORKER_SERVICE_TOKEN)) throw new Error("Bad service token");
}

// ---------------------------------------------------------------- user routes

async function saveClip(request, env, userId) {
  const body = await request.json();
  const url = extractUrl(body.url || "");
  if (!url) return fail("Send a link — nothing else is needed.");

  let canonical;
  try {
    canonical = canonicalUrl(url);
  } catch {
    return fail("That does not look like a valid link.");
  }

  const timestamp = now();
  const existing = await env.DB.prepare(`SELECT id FROM sources WHERE url_canonical = ?1`)
    .bind(canonical)
    .first();

  let sourceId = existing?.id;
  if (!sourceId) {
    sourceId = newId();
    await env.DB.prepare(
      `INSERT INTO sources
         (id, url_canonical, url_original, platform, state, attempts, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, 'pending', 0, ?5, ?5)`
    )
      .bind(sourceId, canonical, url, platformFromUrl(url), timestamp)
      .run();
  }

  // A second save of the same reel by the same user is a no-op, not a duplicate.
  const clipId = newId();
  await env.DB.prepare(
    `INSERT INTO clips (id, user_id, source_id, status, created_at, updated_at)
     VALUES (?1, ?2, ?3, 'inbox', ?4, ?4)
     ON CONFLICT (user_id, source_id) DO UPDATE SET deleted_at = NULL, updated_at = ?4`
  )
    .bind(clipId, userId, sourceId, timestamp)
    .run();

  const clip = await env.DB.prepare(
    `SELECT * FROM clips WHERE user_id = ?1 AND source_id = ?2`
  )
    .bind(userId, sourceId)
    .first();

  return json({ clip, reused: Boolean(existing) }, 201);
}

async function deltaSync(request, env, userId) {
  const since = Number(new URL(request.url).searchParams.get("since") || 0);
  const timestamp = now();

  const scoped = (table) =>
    env.DB.prepare(`SELECT * FROM ${table} WHERE user_id = ?1 AND updated_at > ?2`)
      .bind(userId, since)
      .all();

  const [clips, notes, questions, topics, tasks] = await Promise.all([
    scoped("clips"),
    scoped("notes"),
    scoped("questions"),
    scoped("topics"),
    scoped("tasks")
  ]);

  // Shared rows are returned only for sources this user actually saved.
  const shared = (table, keyColumn) =>
    env.DB.prepare(
      `SELECT t.* FROM ${table} t
       JOIN clips c ON c.source_id = t.${keyColumn}
       WHERE c.user_id = ?1 AND t.created_at > ?2`
    )
      .bind(userId, since)
      .all();

  const sources = await env.DB.prepare(
    `SELECT s.* FROM sources s
     JOIN clips c ON c.source_id = s.id
     WHERE c.user_id = ?1 AND s.updated_at > ?2`
  )
    .bind(userId, since)
    .all();

  const [transcripts, analyses] = await Promise.all([
    shared("transcripts", "source_id"),
    shared("analyses", "source_id")
  ]);

  return json({
    now: timestamp,
    clips: clips.results,
    notes: notes.results,
    questions: questions.results,
    topics: topics.results,
    tasks: tasks.results,
    sources: sources.results,
    transcripts: transcripts.results,
    analyses: analyses.results
  });
}

async function addNote(request, env, userId) {
  const body = await request.json();
  if (!body.clip_id || !String(body.body || "").trim()) {
    return fail("A note needs a clip and some text.");
  }

  const owned = await env.DB.prepare(`SELECT id FROM clips WHERE id = ?1 AND user_id = ?2`)
    .bind(body.clip_id, userId)
    .first();
  if (!owned) return fail("Clip not found.", 404);

  const timestamp = now();
  const id = newId();
  await env.DB.prepare(
    `INSERT INTO notes (id, user_id, clip_id, body, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?5)`
  )
    .bind(id, userId, body.clip_id, String(body.body).trim(), timestamp)
    .run();

  return json({ id }, 201);
}

async function setStatus(request, env, userId, clipId) {
  const body = await request.json();
  const allowed = ["inbox", "keep", "done", "archived"];
  if (!allowed.includes(body.status)) return fail(`Status must be one of: ${allowed.join(", ")}`);

  const result = await env.DB.prepare(
    `UPDATE clips SET status = ?1, updated_at = ?2 WHERE id = ?3 AND user_id = ?4`
  )
    .bind(body.status, now(), clipId, userId)
    .run();

  if (!result.meta.changes) return fail("Clip not found.", 404);
  return json({ ok: true });
}

async function saveSettings(request, env, userId) {
  const body = await request.json();
  if (!PROVIDERS.includes(body.provider)) {
    return fail(`Provider must be one of: ${PROVIDERS.join(", ")}`);
  }

  // 'manual' is the copy-paste tier — it has no key to store.
  const cipher =
    body.provider === "manual" || !body.api_key
      ? null
      : await encryptSecret(String(body.api_key), env.KEY_ENCRYPTION_SECRET);

  await env.DB.prepare(`UPDATE users SET ai_provider = ?1, ai_key_cipher = ?2 WHERE id = ?3`)
    .bind(body.provider, cipher, userId)
    .run();

  return json({ ok: true, provider: body.provider, key_stored: Boolean(cipher) });
}

// ---------------------------------------------------------------- service routes

async function claimQueue(request, env) {
  const limit = Math.min(Number(new URL(request.url).searchParams.get("limit") || 3), 10);
  const rows = await env.DB.prepare(
    `SELECT id, url_canonical, url_original, platform, attempts
     FROM sources
     WHERE state = 'pending' AND attempts < 3
     ORDER BY created_at
     LIMIT ?1`
  )
    .bind(limit)
    .all();

  for (const row of rows.results) {
    await env.DB.prepare(
      `UPDATE sources SET state = 'downloading', attempts = attempts + 1, updated_at = ?1
       WHERE id = ?2`
    )
      .bind(now(), row.id)
      .run();
  }

  return json({ sources: rows.results });
}

async function storeTranscript(request, env, sourceId) {
  const body = await request.json();
  if (!String(body.text || "").trim()) return fail("Transcript text is required.");

  const timestamp = now();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO transcripts (source_id, text, lang, engine, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT (source_id) DO UPDATE SET text = ?2, lang = ?3, engine = ?4, created_at = ?5`
    ).bind(sourceId, body.text, body.lang || null, body.engine || "unknown", timestamp),
    env.DB.prepare(
      `UPDATE sources
       SET state = 'transcribed', title = COALESCE(?1, title), duration_sec = COALESCE(?2, duration_sec),
           error = NULL, updated_at = ?3
       WHERE id = ?4`
    ).bind(body.title || null, body.duration_sec || null, timestamp, sourceId)
  ]);

  // If anyone who saved this reel has a key connected, analyse it now and share the
  // result with everyone else who saved it. If nobody has one, the source stays at
  // 'transcribed' and the app offers the copy-paste tier instead — that is not a failure.
  try {
    const analysis = await analyzeSource(env, sourceId, body.text);
    if (analysis) {
      const problems = await storeAnalysis(
        env,
        sourceId,
        analysis.payload,
        analysis.provider,
        analysis.model
      );
      if (problems.length) throw new Error(`AI reply was malformed: ${problems.join(", ")}`);
    }
    return json({ ok: true, analyzed: Boolean(analysis) });
  } catch (error) {
    // The transcript is safe either way — record why analysis failed so the app can show it.
    await env.DB.prepare(`UPDATE sources SET error = ?1, updated_at = ?2 WHERE id = ?3`)
      .bind(`Analysis failed: ${error.message}`.slice(0, 500), now(), sourceId)
      .run();
    return json({ ok: true, analyzed: false, analysis_error: error.message });
  }
}

export function validateAnalysis(payload) {
  const problems = [];
  if (!String(payload?.summary || "").trim()) problems.push("summary");
  for (const field of ["key_points", "learn_more", "claims"]) {
    if (!Array.isArray(payload?.[field])) problems.push(field);
  }
  return problems;
}

/** Returns an array of problems — empty means it was stored. */
async function storeAnalysis(env, sourceId, payload, provider, model) {
  const problems = validateAnalysis(payload);
  if (problems.length) return problems;

  const timestamp = now();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO analyses
         (source_id, provider, model, summary, key_points, learn_more, claims, suggested_task, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
       ON CONFLICT (source_id) DO NOTHING`
    ).bind(
      sourceId,
      provider,
      model || null,
      String(payload.summary).trim(),
      JSON.stringify(payload.key_points),
      JSON.stringify(payload.learn_more),
      JSON.stringify(payload.claims),
      payload.suggested_task || null,
      timestamp
    ),
    env.DB.prepare(
      `UPDATE sources SET state = 'analyzed', error = NULL, updated_at = ?1 WHERE id = ?2`
    ).bind(timestamp, sourceId)
  ]);

  return [];
}

async function storeFailure(request, env, sourceId) {
  const body = await request.json();
  const message = String(body.error || "Unknown failure").slice(0, 500);
  await env.DB.prepare(
    `UPDATE sources
     SET state = CASE WHEN attempts >= 3 THEN 'failed' ELSE 'pending' END,
         error = ?1, updated_at = ?2
     WHERE id = ?3`
  )
    .bind(message, now(), sourceId)
    .run();

  return json({ ok: true });
}

// ---------------------------------------------------------------- tier 3: copy-paste

async function buildPrompt(env, userId, clipId) {
  const row = await env.DB.prepare(
    `SELECT t.text FROM clips c
     JOIN transcripts t ON t.source_id = c.source_id
     WHERE c.id = ?1 AND c.user_id = ?2`
  )
    .bind(clipId, userId)
    .first();

  if (!row) return fail("No transcript yet for this clip.", 404);
  return json({ prompt: ANALYSIS_PROMPT + row.text });
}

async function acceptPastedAnalysis(request, env, userId, clipId) {
  const clip = await env.DB.prepare(`SELECT source_id FROM clips WHERE id = ?1 AND user_id = ?2`)
    .bind(clipId, userId)
    .first();
  if (!clip) return fail("Clip not found.", 404);

  const body = await request.json();

  let payload;
  try {
    payload = parseAnalysis(body.pasted || "");
  } catch {
    return fail(
      "That does not look like the AI's answer. Copy the whole reply, including the json block."
    );
  }

  const problems = await storeAnalysis(env, clip.source_id, payload, "manual", body.model || null);
  if (problems.length) {
    return fail(`The analysis is missing or malformed: ${problems.join(", ")}. Nothing was saved.`);
  }
  return json({ ok: true });
}

// ---------------------------------------------------------------- router

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });

    const { pathname } = new URL(request.url);
    const segments = pathname.split("/").filter(Boolean);

    try {
      if (segments[0] !== "v1") return fail("Not found.", 404);

      // --- service (PC worker)
      if (segments[1] === "queue" && request.method === "GET") {
        requireService(request, env);
        return claimQueue(request, env);
      }
      if (segments[1] === "sources" && segments[2]) {
        requireService(request, env);
        if (segments[3] === "transcript" && request.method === "POST") {
          return storeTranscript(request, env, segments[2]);
        }
        if (segments[3] === "analysis" && request.method === "POST") {
          const body = await request.json();
          const problems = await storeAnalysis(
            env,
            segments[2],
            body.analysis,
            body.provider || "worker",
            body.model
          );
          if (problems.length) {
            return fail(`The analysis is missing or malformed: ${problems.join(", ")}.`);
          }
          return json({ ok: true });
        }
        if (segments[3] === "error" && request.method === "POST") {
          return storeFailure(request, env, segments[2]);
        }
      }

      // --- user (app)
      const userId = await requireUser(request, env);

      if (segments[1] === "clips" && !segments[2] && request.method === "POST") {
        return saveClip(request, env, userId);
      }
      if (segments[1] === "sync" && request.method === "GET") {
        return deltaSync(request, env, userId);
      }
      if (segments[1] === "notes" && request.method === "POST") {
        return addNote(request, env, userId);
      }
      if (segments[1] === "settings" && request.method === "PUT") {
        return saveSettings(request, env, userId);
      }
      if (segments[1] === "clips" && segments[2]) {
        if (!segments[3] && request.method === "PATCH") {
          return setStatus(request, env, userId, segments[2]);
        }
        if (segments[3] === "prompt" && request.method === "GET") {
          return buildPrompt(env, userId, segments[2]);
        }
        if (segments[3] === "analysis" && request.method === "POST") {
          return acceptPastedAnalysis(request, env, userId, segments[2]);
        }
      }

      return fail("Not found.", 404);
    } catch (error) {
      const unauthorized = /token/i.test(error.message);
      return fail(error.message, unauthorized ? 401 : 500);
    }
  }
};
