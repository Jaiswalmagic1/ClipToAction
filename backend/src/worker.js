// ClipToAction API — Cloudflare Worker over D1.
//
// Two callers:
//   * the app      — authenticates with a Firebase ID token (Google sign-in)
//   * the PC worker — authenticates with the WORKER_SERVICE_TOKEN secret
//
// Two rules run through everything here:
//   * The shared layer is written by the Worker alone. Anything a user typed is stored
//     against that user, never into a row other people read (D10).
//   * No failure is swallowed — a source that fails to download or analyse carries an
//     error the app can show. That error is a fixed classification, never a provider's
//     response body, because the shared row is visible to everyone who saved the reel.

import { verifyFirebaseToken, encryptSecret, tokensMatch, AuthError } from "./auth.js";
import { canonicalUrl, platformFromUrl, extractUrl, isSupportedUrl } from "./canonical.js";
import { ANALYSIS_PROMPT, analyzeSource, parseAnalysis, AnalysisError } from "./analyze.js";

const PROVIDERS = ["gemini", "groq", "openai", "anthropic", "xai", "manual"];
const SHARED = ""; // analyses.user_id value meaning "produced by the Worker, safe to share"

const MAX_BODY_BYTES = 256 * 1024;
const MAX_SAVES_PER_DAY = 200;
const CLAIM_LEASE_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 3;
const DAY_MS = 24 * 60 * 60 * 1000;

const LIMITS = {
  summary: 8000,
  item: 2000,
  items: 50,
  note: 20000,
  apiKey: 400,
  url: 2000,
  transcript: 200000
};

function corsHeaders(env) {
  return {
    // The PC worker is not a browser and never preflights, so X-Service-Token does not
    // belong in the allowed set.
    "Access-Control-Allow-Origin": env.APP_ORIGIN || "*",
    "Access-Control-Allow-Methods": "GET,POST,PATCH,PUT,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Authorization"
  };
}

function json(env, data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(env) }
  });
}

function fail(env, message, status = 400) {
  return json(env, { error: message }, status);
}

const now = () => Date.now();
const newId = () => crypto.randomUUID();

/** A problem with the caller's request. Carries the status the router should return. */
class RequestError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

/** Rejects oversized bodies before spending CPU parsing them. */
async function readJson(request) {
  const declared = Number(request.headers.get("Content-Length") || 0);
  if (declared > MAX_BODY_BYTES) throw new RequestError("That request is too large.", 413);

  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) throw new RequestError("That request is too large.", 413);

  try {
    return JSON.parse(text || "{}");
  } catch {
    throw new RequestError("Body must be valid JSON.", 400);
  }
}

async function requireUser(request, env) {
  const header = request.headers.get("Authorization") || "";
  if (!header.startsWith("Bearer ")) throw new AuthError("Sign in first.");
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
  if (!tokensMatch(provided, env.WORKER_SERVICE_TOKEN)) throw new AuthError("Bad service token");
}

// ---------------------------------------------------------------- user routes

async function saveClip(request, env, userId) {
  const body = await readJson(request);
  const url = extractUrl(String(body.url || "").slice(0, LIMITS.url));
  if (!url) return fail(env, "Send a link — nothing else is needed.");

  // Only hosts we recognise. An arbitrary URL here would let a signed-in user aim the PC
  // worker at their own server, or at an address inside the operator's own network.
  if (!isSupportedUrl(url)) {
    return fail(env, "That link is from a site ClipToAction does not support yet.");
  }

  let canonical;
  try {
    canonical = canonicalUrl(url);
  } catch {
    return fail(env, "That does not look like a valid link.");
  }

  const timestamp = now();
  const saved = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM clips WHERE user_id = ?1 AND created_at > ?2`
  )
    .bind(userId, timestamp - DAY_MS)
    .first();
  if ((saved?.n || 0) >= MAX_SAVES_PER_DAY) {
    return fail(env, "You have saved a lot today. Try again tomorrow.", 429);
  }

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
  await env.DB.prepare(
    `INSERT INTO clips (id, user_id, source_id, status, created_at, updated_at)
     VALUES (?1, ?2, ?3, 'inbox', ?4, ?4)
     ON CONFLICT (user_id, source_id) DO UPDATE SET deleted_at = NULL, updated_at = ?4`
  )
    .bind(newId(), userId, sourceId, timestamp)
    .run();

  const clip = await env.DB.prepare(`SELECT * FROM clips WHERE user_id = ?1 AND source_id = ?2`)
    .bind(userId, sourceId)
    .first();

  return json(env, { clip, reused: Boolean(existing) }, 201);
}

async function deltaSync(request, env, userId) {
  const since = Math.max(Number(new URL(request.url).searchParams.get("since")) || 0, 0);
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

  // Shared rows are pivoted on the joining clip, not on their own timestamp. A reel
  // transcribed last week and saved today has an old transcript and a new clip — filtering
  // on the transcript alone would hand the user a permanently blank clip.
  const sources = await env.DB.prepare(
    `SELECT s.* FROM sources s
     JOIN clips c ON c.source_id = s.id
     WHERE c.user_id = ?1 AND (s.updated_at > ?2 OR c.created_at > ?2)`
  )
    .bind(userId, since)
    .all();

  const transcripts = await env.DB.prepare(
    `SELECT t.* FROM transcripts t
     JOIN clips c ON c.source_id = t.source_id
     WHERE c.user_id = ?1 AND (t.created_at > ?2 OR c.created_at > ?2)`
  )
    .bind(userId, since)
    .all();

  // Shared analyses plus this user's own pasted ones. Never another user's paste.
  const analyses = await env.DB.prepare(
    `SELECT a.* FROM analyses a
     JOIN clips c ON c.source_id = a.source_id
     WHERE c.user_id = ?1
       AND (a.user_id = ?3 OR a.user_id = ?4)
       AND (a.created_at > ?2 OR c.created_at > ?2)`
  )
    .bind(userId, since, SHARED, userId)
    .all();

  // The user's own settings, so the settings screen can show what they actually chose
  // instead of opening on a default and an empty key box every time. Sent on every sync
  // rather than gated on `since`: it is a single row, and `last_seen_at` moves on every
  // request anyway, so gating it would return it every time regardless.
  //
  // `has_key` and never the key. The stored value is only ever decrypted inside the Worker
  // to call a provider (D11), and there is a test that it cannot come back through here.
  const user = await env.DB.prepare(`SELECT ai_provider, ai_key_cipher FROM users WHERE id = ?1`)
    .bind(userId)
    .first();

  return json(env, {
    now: timestamp,
    settings: {
      ai_provider: user?.ai_provider || null,
      has_key: Boolean(user?.ai_key_cipher)
    },
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
  const body = await readJson(request);
  const text = String(body.body || "").trim();
  if (!body.clip_id || !text) return fail(env, "A note needs a clip and some text.");
  if (text.length > LIMITS.note) return fail(env, "That note is too long.");

  const owned = await env.DB.prepare(`SELECT id FROM clips WHERE id = ?1 AND user_id = ?2`)
    .bind(body.clip_id, userId)
    .first();
  if (!owned) return fail(env, "Clip not found.", 404);

  const timestamp = now();
  const id = newId();
  await env.DB.prepare(
    `INSERT INTO notes (id, user_id, clip_id, body, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?5)`
  )
    .bind(id, userId, body.clip_id, text, timestamp)
    .run();

  return json(env, { id }, 201);
}

async function setStatus(request, env, userId, clipId) {
  const body = await readJson(request);
  const allowed = ["inbox", "keep", "done", "archived"];
  if (!allowed.includes(body.status)) {
    return fail(env, `Status must be one of: ${allowed.join(", ")}`);
  }

  const result = await env.DB.prepare(
    `UPDATE clips SET status = ?1, updated_at = ?2 WHERE id = ?3 AND user_id = ?4`
  )
    .bind(body.status, now(), clipId, userId)
    .run();

  if (!result.meta.changes) return fail(env, "Clip not found.", 404);
  return json(env, { ok: true });
}

async function saveSettings(request, env, userId) {
  const body = await readJson(request);
  if (!PROVIDERS.includes(body.provider)) {
    return fail(env, `Provider must be one of: ${PROVIDERS.join(", ")}`);
  }
  if (body.api_key && String(body.api_key).length > LIMITS.apiKey) {
    return fail(env, "That does not look like an API key.");
  }

  const timestamp = now();
  const suppliedKey = String(body.api_key || "").trim();

  // 'manual' is the copy-paste tier. Choosing it is a statement that no key is in use, so
  // the stored one goes rather than sitting encrypted for nothing.
  if (body.provider === "manual") {
    await env.DB.prepare(
      `UPDATE users SET ai_provider = ?1, ai_key_cipher = NULL, last_seen_at = ?2 WHERE id = ?3`
    )
      .bind(body.provider, timestamp, userId)
      .run();
    return json(env, { ok: true, provider: body.provider, key_stored: false });
  }

  if (suppliedKey) {
    const cipher = await encryptSecret(suppliedKey, env.KEY_ENCRYPTION_SECRET);
    await env.DB.prepare(
      `UPDATE users SET ai_provider = ?1, ai_key_cipher = ?2, last_seen_at = ?3 WHERE id = ?4`
    )
      .bind(body.provider, cipher, timestamp, userId)
      .run();
    return json(env, { ok: true, provider: body.provider, key_stored: true });
  }

  // No key was sent, so the stored one is left alone. This screen is also how someone
  // changes which AI they use, and the key is never shown back to them — so if saving
  // without retyping it wiped it, they would have no way of noticing. Their clips would
  // simply stop being summarised with nothing on screen to explain why, which is the
  // silent failure Golden Rule 29 forbids.
  await env.DB.prepare(`UPDATE users SET ai_provider = ?1, last_seen_at = ?2 WHERE id = ?3`)
    .bind(body.provider, timestamp, userId)
    .run();

  const existing = await env.DB.prepare(`SELECT ai_key_cipher FROM users WHERE id = ?1`)
    .bind(userId)
    .first();

  return json(env, {
    ok: true,
    provider: body.provider,
    key_stored: Boolean(existing?.ai_key_cipher)
  });
}

// ---------------------------------------------------------------- service routes

async function claimQueue(request, env) {
  const requested = Number(new URL(request.url).searchParams.get("limit"));
  const limit = Math.min(Math.max(Number.isFinite(requested) ? requested : 3, 1), 10);
  const timestamp = now();

  // Anything that used up its attempts and then went quiet is retired here rather than
  // sitting in 'downloading' forever with no error — a clip stuck on "pending" and nothing
  // to show for it is the silent failure Golden Rule 29 forbids.
  await env.DB.prepare(
    `UPDATE sources
     SET state = 'failed',
         error = COALESCE(error, 'Gave up after ' || attempts || ' attempts.'),
         claimed_at = NULL, updated_at = ?1
     WHERE state = 'downloading' AND attempts >= ?2 AND COALESCE(claimed_at, 0) < ?3`
  )
    .bind(timestamp, MAX_ATTEMPTS, timestamp - CLAIM_LEASE_MS)
    .run();

  // A claim is a lease. Without the timeout, a worker that dies mid-download leaves the
  // source in 'downloading' forever.
  const rows = await env.DB.prepare(
    `SELECT id, url_canonical, url_original, platform, attempts
     FROM sources
     WHERE attempts < ?3
       AND (state = 'pending'
            OR (state = 'downloading' AND COALESCE(claimed_at, 0) < ?2))
     ORDER BY created_at
     LIMIT ?1`
  )
    .bind(limit, timestamp - CLAIM_LEASE_MS, MAX_ATTEMPTS)
    .all();

  // Each claim is conditional on the row still being in the state we selected it in, so
  // two workers polling at once cannot both win the same source — the second one's UPDATE
  // matches nothing and that row is dropped from its batch.
  const claimed = [];
  for (const row of rows.results) {
    const result = await env.DB.prepare(
      `UPDATE sources
       SET state = 'downloading', attempts = attempts + 1, claimed_at = ?1, updated_at = ?1
       WHERE id = ?2
         AND (state = 'pending'
              OR (state = 'downloading' AND COALESCE(claimed_at, 0) < ?3))`
    )
      .bind(timestamp, row.id, timestamp - CLAIM_LEASE_MS)
      .run();

    if (result.meta.changes) claimed.push(row);
  }

  return json(env, { sources: claimed });
}

async function storeTranscript(request, env, sourceId) {
  const body = await readJson(request);
  const text = String(body.text || "").trim();
  if (!text) return fail(env, "Transcript text is required.");
  if (text.length > LIMITS.transcript) return fail(env, "That transcript is too long.");

  const timestamp = now();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO transcripts (source_id, text, lang, engine, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT (source_id) DO UPDATE SET text = ?2, lang = ?3, engine = ?4, created_at = ?5`
    ).bind(sourceId, text, body.lang || null, body.engine || "unknown", timestamp),
    env.DB.prepare(
      // Only a source still in flight may be completed. A worker whose lease expired can
      // come back late, and without this it would overwrite a newer transcript.
      `UPDATE sources
       SET state = 'transcribed', title = COALESCE(?1, title),
           duration_sec = COALESCE(?2, duration_sec), error = NULL, claimed_at = NULL,
           updated_at = ?3
       WHERE id = ?4 AND state = 'downloading'`
    ).bind(body.title || null, body.duration_sec || null, timestamp, sourceId)
  ]);

  // If anyone who saved this reel has a key connected, analyse it now and share the result
  // with everyone else who saved it. If nobody has one, the source stays at 'transcribed'
  // and the app offers the copy-paste tier instead — that is not a failure.
  try {
    const analysis = await analyzeSource(env, sourceId, text);
    if (analysis) {
      const problems = await storeAnalysis(
        env,
        sourceId,
        SHARED,
        analysis.payload,
        analysis.provider,
        analysis.model
      );
      if (problems.length) throw new AnalysisError("the AI's reply was malformed");
    }
    return json(env, { ok: true, analyzed: Boolean(analysis) });
  } catch (error) {
    // sources.error is read by every user who saved this reel, so it carries a fixed
    // classification — never a provider's response body, which can contain a fragment of
    // the key that failed and the account it belongs to.
    const reason = error instanceof AnalysisError ? error.publicReason : "something went wrong";
    await env.DB.prepare(`UPDATE sources SET error = ?1, updated_at = ?2 WHERE id = ?3`)
      .bind(`Analysis failed: ${reason}`, now(), sourceId)
      .run();
    return json(env, { ok: true, analyzed: false, analysis_error: reason });
  }
}

export function validateAnalysis(payload) {
  const problems = [];

  const summary = String(payload?.summary || "").trim();
  if (!summary) problems.push("summary");
  else if (summary.length > LIMITS.summary) problems.push("summary is too long");

  for (const field of ["key_points", "learn_more", "claims"]) {
    const value = payload?.[field];
    if (!Array.isArray(value)) problems.push(field);
    else if (value.length > LIMITS.items) problems.push(`${field} has too many items`);
    else if (value.some((item) => JSON.stringify(item ?? "").length > LIMITS.item)) {
      problems.push(`${field} has an item that is too long`);
    }
  }

  return problems;
}

/**
 * Stores an analysis. `ownerId` is SHARED ('') only for Worker-produced results — a user's
 * paste is stored against that user so it can never overwrite what others read.
 * Returns an array of problems; empty means it was stored.
 */
async function storeAnalysis(env, sourceId, ownerId, payload, provider, model) {
  const problems = validateAnalysis(payload);
  if (problems.length) return problems;

  const timestamp = now();
  const statements = [
    env.DB.prepare(
      `INSERT INTO analyses
         (source_id, user_id, provider, model, summary, key_points, learn_more, claims,
          suggested_task, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
       ON CONFLICT (source_id, user_id) DO UPDATE SET
         provider = ?3, model = ?4, summary = ?5, key_points = ?6, learn_more = ?7,
         claims = ?8, suggested_task = ?9, created_at = ?10`
    ).bind(
      sourceId,
      ownerId,
      provider,
      model || null,
      String(payload.summary).trim(),
      JSON.stringify(payload.key_points),
      JSON.stringify(payload.learn_more),
      JSON.stringify(payload.claims),
      payload.suggested_task || null,
      timestamp
    )
  ];

  // Only a Worker-produced analysis completes the pipeline. If a user's paste could set
  // this, anyone could mark a reel 'analyzed' and it would never be downloaded at all.
  if (ownerId === SHARED) {
    statements.push(
      env.DB.prepare(
        `UPDATE sources SET state = 'analyzed', error = NULL, claimed_at = NULL, updated_at = ?1
         WHERE id = ?2`
      ).bind(timestamp, sourceId)
    );
  }

  await env.DB.batch(statements);
  return [];
}

async function storeFailure(request, env, sourceId) {
  const body = await readJson(request);
  const message = String(body.error || "Unknown failure").slice(0, 500);

  // `AND state = 'downloading'` is what stops a worker whose lease already expired from
  // dragging a finished source back into the queue. Without it, a late timeout from a
  // stalled worker would reset a reel that another worker had since transcribed and
  // analysed — and put an error on it that every user who saved it would see.
  const result = await env.DB.prepare(
    `UPDATE sources
     SET state = CASE WHEN attempts >= ?4 THEN 'failed' ELSE 'pending' END,
         error = ?1, claimed_at = NULL, updated_at = ?2
     WHERE id = ?3 AND state = 'downloading'`
  )
    .bind(message, now(), sourceId, MAX_ATTEMPTS)
    .run();

  return json(env, { ok: true, applied: Boolean(result.meta.changes) });
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

  if (!row) return fail(env, "No transcript yet for this clip.", 404);
  return json(env, { prompt: ANALYSIS_PROMPT + row.text });
}

async function acceptPastedAnalysis(request, env, userId, clipId) {
  // A paste is only meaningful against a transcript this user can already see, which also
  // stops anyone pasting an analysis for a reel that has not been downloaded yet.
  const clip = await env.DB.prepare(
    `SELECT c.source_id FROM clips c
     JOIN transcripts t ON t.source_id = c.source_id
     WHERE c.id = ?1 AND c.user_id = ?2`
  )
    .bind(clipId, userId)
    .first();
  if (!clip) return fail(env, "No transcript yet for this clip.", 404);

  const body = await readJson(request);

  let payload;
  try {
    payload = parseAnalysis(String(body.pasted || "").slice(0, MAX_BODY_BYTES));
  } catch {
    return fail(
      env,
      "That does not look like the AI's answer. Copy the whole reply, including the json block."
    );
  }

  const problems = await storeAnalysis(
    env,
    clip.source_id,
    userId,
    payload,
    "manual",
    body.model || null
  );
  if (problems.length) {
    return fail(env, `The analysis is missing or malformed: ${problems.join(", ")}. Nothing was saved.`);
  }
  return json(env, { ok: true });
}

// ---------------------------------------------------------------- router

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders(env) });

    const { pathname } = new URL(request.url);
    const segments = pathname.split("/").filter(Boolean);

    // Staging serves the app from static assets alongside this API (D26). Assets are
    // matched by filename, and `html_handling = "none"` keeps /app.html literal — but that
    // also means the bare address matches no file and would fall through to the 404 below.
    // Somebody typing the address on a phone must land on the app, not on a JSON error.
    // Guarded on the binding: production has no assets and is unaffected.
    if (env.ASSETS && (pathname === "/" || pathname === "")) {
      return env.ASSETS.fetch(new Request(new URL("/index.html", request.url), request));
    }

    try {
      if (segments[0] !== "v1") return fail(env, "Not found.", 404);

      // Every handler call below is `return await`, not `return`. A bare `return` hands
      // back the promise and lets a rejection escape this try/catch entirely — the
      // request then fails with a raw 500, no CORS headers, and the internal error text
      // exposed. The oversized-body test caught exactly that.

      // --- service (PC worker)
      if (segments[1] === "queue" && request.method === "GET") {
        requireService(request, env);
        return await claimQueue(request, env);
      }
      if (segments[1] === "sources" && segments[2]) {
        requireService(request, env);
        if (segments[3] === "transcript" && request.method === "POST") {
          return await storeTranscript(request, env, segments[2]);
        }
        if (segments[3] === "error" && request.method === "POST") {
          return await storeFailure(request, env, segments[2]);
        }
      }

      // --- user (app)
      const userId = await requireUser(request, env);

      if (segments[1] === "clips" && !segments[2] && request.method === "POST") {
        return await saveClip(request, env, userId);
      }
      if (segments[1] === "sync" && request.method === "GET") {
        return await deltaSync(request, env, userId);
      }
      if (segments[1] === "notes" && request.method === "POST") {
        return await addNote(request, env, userId);
      }
      if (segments[1] === "settings" && request.method === "PUT") {
        return await saveSettings(request, env, userId);
      }
      if (segments[1] === "clips" && segments[2]) {
        if (!segments[3] && request.method === "PATCH") {
          return await setStatus(request, env, userId, segments[2]);
        }
        if (segments[3] === "prompt" && request.method === "GET") {
          return await buildPrompt(env, userId, segments[2]);
        }
        if (segments[3] === "analysis" && request.method === "POST") {
          return await acceptPastedAnalysis(request, env, userId, segments[2]);
        }
      }

      return fail(env, "Not found.", 404);
    } catch (error) {
      if (error instanceof AuthError) return fail(env, error.message, 401);
      if (error instanceof RequestError) return fail(env, error.message, error.status);
      // Anything else is ours, not theirs. Internal text can quote SQL and bound values,
      // so it never reaches the client.
      console.error("Unhandled worker error:", error);
      return fail(env, "Something went wrong.", 500);
    }
  }
};
