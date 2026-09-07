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
import {
  canonicalUrl,
  platformFromUrl,
  extractUrl,
  isSupportedUrl,
  asItWasUnderstood
} from "./canonical.js";
import { forDisplay } from "./keys.js";
import {
  promptFor,
  tidyTranscript,
  isLong,
  LONG_VIDEO_SEC,
  analyzeSource,
  parseAnalysis,
  proposeTopic,
  askOnTheirOwnKeys,
  cleanKind,
  cleanItems,
  cleanSections,
  cleanClaims,
  cleanLines,
  cleanOneLine,
  KINDS_WITH_ROWS,
  itemKey,
  ITEM_STATUSES,
  ITEM_SHAPES_VERSION,
  AnalysisError
} from "./analyze.js";
import {
  cleanTopicName,
  fileClipIntoTopic,
  fileSourceForAllSavers,
  setClipTopicByHand,
  tidyTopics
} from "./topics.js";
import {
  buildLearningPrompt,
  learningColumns,
  validateLearning
} from "./learnings.js";
import { handleMcp, hashSecret, newConnectorSecret } from "./mcp.js";
import {
  WARN_ABOVE_SEC,
  MAX_VIDEO_SEC,
  MAX_TRANSCRIPT_CHARS,
  needsPermission,
  tooLongForAnyone,
  whatItCosts
} from "./longvideo.js";
import {
  DEFAULT_RELOOK_DAYS,
  RELOOK_CHOICES,
  RELOOK_PROMPT,
  MAX_RELOOK_CLIPS,
  relookLines,
  relookState,
  validateRelook
} from "./relook.js";

const PROVIDERS = ["gemini", "groq", "openai", "anthropic", "xai", "manual"];

// Enough to hold a few free accounts across a couple of providers, and low enough that a
// list stays something a person can actually read down and reason about (D35).
const MAX_AI_KEYS = 10;
const SHARED = ""; // analyses.user_id value meaning "produced by the Worker, safe to share"
const THE_WORKER = ""; // workers.id value meaning "the one PC worker"

// How long after its last check-in the PC worker is still called working. It asks for work
// every 30 seconds even when there is none, so a few minutes of silence is already well
// past normal — but not so tight that one slow request reads as an outage.
const WORKER_QUIET_AFTER_MS = 5 * 60 * 1000;

const MAX_BODY_BYTES = 256 * 1024;
// A transcript is the one body that is legitimately enormous, and it has its own cap
// because the general one is far below it: 256KB is about 4.8 hours of speech, so a
// five-hour video would have had its transcript REFUSED AS TOO LARGE after the machine
// had already spent three hours making it — the exact failure D42 raised the limits to
// prevent.
//
// Four megabytes for four hundred thousand characters looks absurd until you count what
// actually goes down the wire. This cap is in BYTES and the limit it protects is in
// CHARACTERS, and the two are only the same for plain English. Python's `requests` writes
// JSON with `ensure_ascii=True`, so every character outside ASCII travels as a six-byte
// escape. At 700KB a three-hour video in his own language was transcribed for hours,
// refused with "that request is too large", reported to him as "could not reach
// ClipToAction", and then re-downloaded and re-transcribed twice more before being retired
// as failed. Whisper is asked to translate (D28), so this should not arise — but "should"
// is what the last cap rested on, and the machine time it costs when it is wrong is
// measured in hours of his own PC.
//
// The real limit on what can be STORED is untouched: MAX_TRANSCRIPT_CHARS is checked on
// the parsed text. This only stops the transport refusing something the content rules
// allow. A test pins the worst case — every character escaped — rather than English.
export const MAX_TRANSCRIPT_BODY_BYTES = 4 * 1024 * 1024;
const MAX_SAVES_PER_DAY = 200;
// The same idea for the two things a person can write as often as they like. Every
// notebook shares ONE free database, so filling it or burning the day's write allowance
// does not hurt the person doing it — it takes every other notebook down with it, and an
// empty notebook reads exactly like lost data. Set far above any real day's work: he
// writes a handful of notes a day, and a learning is the end of a whole conversation.
const MAX_NOTES_PER_DAY = 500;
const MAX_LEARNINGS_PER_DAY = 200;
const CLAIM_LEASE_MS = 15 * 60 * 1000;
// A long video is a different size of job (D42): six hours of video is around three and a
// half hours of a machine's time, and the lease above would expire in the middle of it —
// a second worker would then claim the same video, and the retirement sweep below would
// mark it failed while the first machine was still working on it. So a video whose length
// is known to be long gets a lease that covers the work it actually is.
const LONG_CLAIM_LEASE_MS = 8 * 60 * 60 * 1000;
// And the lease for a video nobody has measured yet, which is EVERY video on its first
// claim: `duration_sec` is written after the work, not before it. A 28-minute video is
// under the threshold, so it is never asked about and never measured — and at roughly 0.6
// of its length it takes longer to transcribe than fifteen minutes. The server would hand
// it out again while a machine still held it, and a second machine's late transcript would
// re-run the analysis on somebody's key and REPLACE the rows, orphaning any decision he
// had recorded against them. Ninety minutes covers anything that can reach here unasked,
// and still frees a genuinely dead worker's claim the same day.
const UNMEASURED_CLAIM_LEASE_MS = 90 * 60 * 1000;
const MAX_ATTEMPTS = 3;
// How many old clips one press of "sort my old clips" may name. Each one is a call out
// to a provider, and a Worker request has a hard ceiling on how many of those it may
// make. The app presses again while `remaining` is above zero, so the cap costs nothing
// but keeps a notebook of any size inside one request's budget.
const MAX_SORT_PER_REQUEST = 10;
// How many live connector addresses one notebook may hold. Enough for Claude and ChatGPT
// and a spare; low enough that a leaked one is noticed rather than lost in a list.
const MAX_CONNECTORS = 5;
// How many failed attempts to find out who made a video before it is left alone (D40). A
// failure is not an answer, so it must not settle the question — but a question that is
// never settled is a queue that never ends, and this is what closes it.
const MAX_CREATOR_TRIES = 3;
const DAY_MS = 24 * 60 * 60 * 1000;

const LIMITS = {
  summary: 8000,
  item: 2000,
  items: 50,
  note: 20000,
  apiKey: 400,
  url: 2000,
  // Raised with the six-hour ceiling (D42). It lives in longvideo.js because the PC worker
  // has to refuse a video BEFORE spending three hours on one whose words would not fit.
  transcript: MAX_TRANSCRIPT_CHARS,
  // A channel name. Long enough for the padded ones creators actually use, short enough
  // that nothing else can be smuggled into a column the app draws (D40).
  creator: 200,
  // Facebook hands back the whole caption as the title, and `titleOf` in the app already
  // cuts it down for display — but the stored value was unbounded.
  title: 500,
  // One action. The prompt asks for a single concrete thing to do, and this was the one
  // field in the whole analysis with no ceiling at all — 300,000 characters of it stored
  // cleanly and synced to every device.
  task: 2000
};

// A long video's analysis is a bigger object than a reel's, and the reel's ceilings would
// reject a good one. Applied only when the video is actually long, so nothing a reel
// produces is judged by a looser rule than it is today (D33).
const LONG_LIMITS = {
  summary: 24000,
  item: 2000,
  items: 200,
  sections: 24
};

function limitsFor(durationSec) {
  return isLong(durationSec) ? { ...LIMITS, ...LONG_LIMITS } : LIMITS;
}

/**
 * How long this source's claim lasts, as SQL. Written once and used by all three places
 * that read a lease, so they cannot disagree about when a claim has expired — a claim one
 * query thinks is live and another thinks is stale is how a job gets marked failed while
 * it is still running.
 *
 * The numbers are interpolated rather than bound. They are this file's own constants and
 * never anything a caller sent, and doing it this way means the three queries below keep
 * the placeholder numbering they already had — which is the part of a query that goes
 * wrong silently.
 */
const LEASE_SQL =
  "(CASE"
  + ` WHEN duration_sec IS NULL THEN ${UNMEASURED_CLAIM_LEASE_MS}`
  + ` WHEN duration_sec > ${WARN_ABOVE_SEC} THEN ${LONG_CLAIM_LEASE_MS}`
  + ` ELSE ${CLAIM_LEASE_MS} END)`;

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

/**
 * Rejects oversized bodies before spending CPU parsing them.
 *
 * `Content-Length` is bytes and `text.length` is characters, and both are compared against
 * the same number. That is only safe because the one body that comes near the cap is a
 * transcript. `text.length` counts characters and the cap is named in bytes, which are
 * only the same thing for plain English — so the transcript cap is now sized for the worst
 * case instead, six bytes a character, and the content limit is what actually bites. See
 * MAX_TRANSCRIPT_BODY_BYTES.
 */
async function readJson(request, cap = MAX_BODY_BYTES) {
  const declared = Number(request.headers.get("Content-Length") || 0);
  if (declared > cap) throw new RequestError("That request is too large.", 413);

  const text = await request.text();
  if (text.length > cap) throw new RequestError("That request is too large.", 413);

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
  let asUnderstood;
  try {
    canonical = canonicalUrl(url);
    // What gets stored and handed to the PC worker is this parser's own reading of the
    // address, never the raw text. See asItWasUnderstood — the host that was approved has
    // to be the host that is fetched.
    asUnderstood = asItWasUnderstood(url);
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

  // Look, insert, then look AGAIN — because between the look and the insert somebody else
  // can save the same reel.
  //
  // `url_canonical` is UNIQUE, which is the whole point of the shared layer (D10): one row
  // per video, one download, one transcript, however many people save it. Two people
  // saving a brand-new reel in the same second both missed the SELECT, and the second
  // INSERT hit that constraint and escaped as a bare 500 — the save simply lost, with
  // "Something went wrong" and no hint that pressing again would work. It is a reel doing
  // the rounds that gets saved twice at once, so this is likeliest exactly when the
  // product is working.
  //
  // `findOrCreateTopic` in topics.js has done it this way, with a comment about this same
  // race, since topics existed. This was the one place that had not.
  let sourceId = (
    await env.DB.prepare(`SELECT id FROM sources WHERE url_canonical = ?1`)
      .bind(canonical)
      .first()
  )?.id;
  // Whether this video was already known before this save — what the app is told, so it
  // can say "already being read" rather than "queued".
  const reused = Boolean(sourceId);

  if (!sourceId) {
    await env.DB.prepare(
      `INSERT INTO sources
         (id, url_canonical, url_original, platform, state, attempts, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, 'pending', 0, ?5, ?5)
       ON CONFLICT (url_canonical) DO NOTHING`
    )
      .bind(newId(), canonical, asUnderstood, platformFromUrl(url), timestamp)
      .run();

    // Whoever won, this reads the row that is actually there.
    sourceId = (
      await env.DB.prepare(`SELECT id FROM sources WHERE url_canonical = ?1`)
        .bind(canonical)
        .first()
    )?.id;
    if (!sourceId) return fail(env, "Could not save that link. Please try again.", 503);
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

  // Saving a reel somebody else already had summarised: the topic was named long before
  // this user existed, so file it now rather than leaving their clip looking unsorted for
  // no reason. Same guard as everywhere else — never over a topic they set by hand.
  try {
    const shared = await env.DB.prepare(
      `SELECT topic, sub_topic FROM analyses WHERE source_id = ?1 AND user_id = ?2`
    )
      .bind(sourceId, SHARED)
      .first();
    if (shared?.topic) {
      await fileClipIntoTopic(env, userId, clip?.id, shared, timestamp, newId);
    }
  } catch {
    // Unfiled, and the app offers to sort it. Never a reason to fail the save itself.
  }

  return json(env, { clip, reused }, 201);
}

async function deltaSync(request, env, userId) {
  const since = Math.max(Number(new URL(request.url).searchParams.get("since")) || 0, 0);
  const timestamp = now();

  const scoped = (table) =>
    env.DB.prepare(`SELECT * FROM ${table} WHERE user_id = ?1 AND updated_at > ?2`)
      .bind(userId, since)
      .all();

  const [clips, notes, questions, topics, tasks, learnings, itemStatus, relooks] =
    await Promise.all([
      scoped("clips"),
      scoped("notes"),
      scoped("questions"),
      scoped("topics"),
      scoped("tasks"),
      scoped("learnings"),
      scoped("item_status"),
      scoped("relooks")
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

  // `sources` is shared, and since D42 it carries `long_ok_by` — somebody's account id.
  // Anybody who saves the same link would otherwise be handed the id of whoever approved
  // that video. It is stripped here rather than by naming the columns, because a column
  // list is exactly the thing that silently stops being complete (D44). What the app can
  // legitimately know is whether the person looking is the one who approved it.
  const visibleSources = sources.results.map(({ long_ok_by: approver, ...row }) => ({
    ...row,
    long_ok_mine: approver ? approver === userId : null
  }));

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
  const user = await env.DB.prepare(`SELECT ai_provider FROM users WHERE id = ?1`)
    .bind(userId)
    .first();

  // The keys themselves, as the app is allowed to see them (D35): what each is called,
  // whose provider it is, whether it is working, and why not when it is not. Never the key
  // and never the ciphertext — `forDisplay` is what enforces that, and a test proves no
  // sync response can carry one.
  const keys = await env.DB.prepare(
    `SELECT id, label, provider, position, state, last_error, last_error_detail,
            last_error_at, exhausted_at, last_used_at
     FROM ai_keys WHERE user_id = ?1 ORDER BY position, created_at`
  )
    .bind(userId)
    .all();

  // Whether the machine that downloads and transcribes is running. Not per-user, and
  // deliberately shown to everybody: when it is off, nobody's reels are moving, and the
  // reason a clip is stuck belongs on screen rather than nowhere (Golden Rule 29).
  //
  // `last_seen_at` and a plain verdict, never a hostname or an address — the worker is
  // somebody's home PC.
  const worker = await env.DB.prepare(`SELECT last_seen_at FROM workers WHERE id = ?1`)
    .bind(THE_WORKER)
    .first();

  // The addresses this user has handed to an AI app (D29). Metadata only — the secret
  // itself is shown once, when it is made, and is not recoverable from anywhere. Sent on
  // every sync like `settings`, because it is a handful of rows with no `updated_at` to
  // gate on and the settings screen needs it to say what is connected.
  const connectors = await env.DB.prepare(
    `SELECT id, label, created_at, last_used_at FROM connector_tokens
     WHERE user_id = ?1 AND revoked_at IS NULL ORDER BY created_at`
  )
    .bind(userId)
    .all();

  // Whether a re-look is being offered, and over how many reels (D41). Sent on every sync
  // like `settings`: it is one small object, it depends on the clock as much as on the
  // rows, and the banner has to be able to appear the moment enough time has passed.
  const relook = await relookFor(env, userId, timestamp);

  return json(env, {
    now: timestamp,
    connectors: connectors.results,
    relook,
    settings: {
      ai_provider: user?.ai_provider || null,
      // The list IS the setting now. Having any key at all is what makes the Worker
      // summarise for you; having none is the copy-paste tier (D35).
      has_key: keys.results.length > 0
    },
    ai_keys: keys.results.map((row) => forDisplay(row, timestamp)),
    worker: {
      last_seen_at: worker?.last_seen_at || null,
      running: Boolean(worker && timestamp - worker.last_seen_at < WORKER_QUIET_AFTER_MS)
    },
    clips: clips.results,
    notes: notes.results,
    questions: questions.results,
    topics: topics.results,
    tasks: tasks.results,
    learnings: learnings.results,
    item_status: itemStatus.results,
    relooks: relooks.results,
    sources: visibleSources,
    transcripts: transcripts.results,
    analyses: analyses.results
  });
}

/**
 * Whether this person has already written their day's worth into one table.
 *
 * Not about them: D1 is ONE free database behind every notebook, so the cost of an
 * unbounded writer falls on everybody else's. The caps are far above any real day's use —
 * they exist so that one account cannot end the day for the rest.
 */
async function pastTheDayFor(env, table, userId, cap) {
  const written = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM ${table} WHERE user_id = ?1 AND created_at > ?2`
  )
    .bind(userId, now() - DAY_MS)
    .first();
  return (written?.n || 0) >= cap;
}

async function addNote(request, env, userId) {
  const body = await readJson(request);
  const text = String(body.body || "").trim();
  if (!body.clip_id || !text) return fail(env, "A note needs a clip and some text.");
  if (text.length > LIMITS.note) return fail(env, "That note is too long.");

  if (await pastTheDayFor(env, "notes", userId, MAX_NOTES_PER_DAY)) {
    return fail(env, "You have written a lot of notes today. Try again tomorrow.", 429);
  }

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
  // the stored ones go rather than sitting encrypted for nothing. With a list rather than
  // a single key this throws away more than it used to, which is why the app asks first —
  // the endpoint does what it is told, and the warning belongs on screen (D35).
  if (body.provider === "manual") {
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM ai_keys WHERE user_id = ?1`).bind(userId),
      env.DB.prepare(`UPDATE users SET ai_provider = ?1, last_seen_at = ?2 WHERE id = ?3`)
        .bind(body.provider, timestamp, userId)
    ]);
    return json(env, { ok: true, provider: body.provider, key_stored: false });
  }

  // A key given here replaces the FIRST key in the list, which is what this screen has
  // always meant: "the key I use". Adding a second is POST /v1/keys, deliberately a
  // different action so that saving this screen can never quietly append a duplicate.
  if (suppliedKey) {
    const cipher = await encryptSecret(suppliedKey, env.KEY_ENCRYPTION_SECRET);
    const first = await env.DB.prepare(
      `SELECT id FROM ai_keys WHERE user_id = ?1 ORDER BY position, created_at LIMIT 1`
    )
      .bind(userId)
      .first();

    await env.DB.batch([
      first
        ? env.DB.prepare(
            // A replaced key is a new key: whatever the old one was refused for says
            // nothing about this one, so it starts ready with a clean slate.
            `UPDATE ai_keys
             SET provider = ?1, key_cipher = ?2, state = 'ready', last_error = NULL,
                 last_error_detail = NULL, last_error_at = NULL, exhausted_at = NULL,
                 updated_at = ?3
             WHERE id = ?4`
          ).bind(body.provider, cipher, timestamp, first.id)
        : env.DB.prepare(
            `INSERT INTO ai_keys
               (id, user_id, label, provider, key_cipher, position, state, created_at, updated_at)
             VALUES (?1, ?2, NULL, ?3, ?4, 0, 'ready', ?5, ?5)`
          ).bind(newId(), userId, body.provider, cipher, timestamp),
      env.DB.prepare(`UPDATE users SET ai_provider = ?1, last_seen_at = ?2 WHERE id = ?3`)
        .bind(body.provider, timestamp, userId)
    ]);
    return json(env, { ok: true, provider: body.provider, key_stored: true });
  }

  // No key was sent, so the stored ones are left alone. This screen is also how someone
  // changes which AI they use, and the key is never shown back to them — so if saving
  // without retyping it wiped it, they would have no way of noticing. Their clips would
  // simply stop being summarised with nothing on screen to explain why, which is the
  // silent failure Golden Rule 29 forbids.
  await env.DB.prepare(`UPDATE users SET ai_provider = ?1, last_seen_at = ?2 WHERE id = ?3`)
    .bind(body.provider, timestamp, userId)
    .run();

  const count = await env.DB.prepare(
    `SELECT COUNT(*) AS held FROM ai_keys WHERE user_id = ?1`
  )
    .bind(userId)
    .first();

  return json(env, { ok: true, provider: body.provider, key_stored: (count?.held || 0) > 0 });
}

// ---------------------------------------------------------------- the key list (D35)

/** Everything about this person's keys except the keys. */
async function listKeys(env, userId) {
  const rows = await env.DB.prepare(
    `SELECT id, label, provider, position, state, last_error, last_error_detail,
            last_error_at, exhausted_at, last_used_at
     FROM ai_keys WHERE user_id = ?1 ORDER BY position, created_at`
  )
    .bind(userId)
    .all();
  const timestamp = now();
  return json(env, { keys: rows.results.map((row) => forDisplay(row, timestamp)) });
}

/** Adds one key to the end of this person's list. */
async function addKey(request, env, userId) {
  const body = await readJson(request);

  // 'manual' is the absence of a key, so it cannot be one entry in a list of them.
  if (!PROVIDERS.includes(body.provider) || body.provider === "manual") {
    return fail(env, `Provider must be one of: ${PROVIDERS.filter((p) => p !== "manual").join(", ")}`);
  }

  const suppliedKey = String(body.api_key || "").trim();
  if (!suppliedKey) return fail(env, "An API key is required.");
  if (suppliedKey.length > LIMITS.apiKey) return fail(env, "That does not look like an API key.");

  const label = String(body.label || "").trim().slice(0, 60) || null;

  const held = await env.DB.prepare(
    `SELECT COUNT(*) AS held, COALESCE(MAX(position), -1) AS last FROM ai_keys WHERE user_id = ?1`
  )
    .bind(userId)
    .first();
  if ((held?.held || 0) >= MAX_AI_KEYS) {
    return fail(env, `That is the most keys one account can hold (${MAX_AI_KEYS}).`);
  }

  const timestamp = now();
  const id = newId();
  const cipher = await encryptSecret(suppliedKey, env.KEY_ENCRYPTION_SECRET);

  await env.DB.prepare(
    `INSERT INTO ai_keys
       (id, user_id, label, provider, key_cipher, position, state, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'ready', ?7, ?7)`
  )
    .bind(id, userId, label, body.provider, cipher, (held?.last ?? -1) + 1, timestamp)
    .run();

  return json(env, { id, provider: body.provider, label }, 201);
}

/**
 * Renames a key, replaces it, moves it up or down the order, or wakes it up.
 *
 * Replacing the key clears whatever the old one was refused for — the new one has not
 * been refused anything yet, and carrying the old error forward would leave a working key
 * sitting there labelled broken.
 */
async function updateKey(request, env, userId, keyId) {
  const body = await readJson(request);

  const existing = await env.DB.prepare(
    `SELECT id FROM ai_keys WHERE id = ?1 AND user_id = ?2`
  )
    .bind(keyId, userId)
    .first();
  if (!existing) return fail(env, "No such key.", 404);

  const timestamp = now();
  const sets = ["updated_at = ?1"];
  const values = [timestamp];

  if (body.label !== undefined) {
    values.push(String(body.label || "").trim().slice(0, 60) || null);
    sets.push(`label = ?${values.length}`);
  }

  if (body.provider !== undefined) {
    if (!PROVIDERS.includes(body.provider) || body.provider === "manual") {
      return fail(env, "That is not a provider a key can belong to.");
    }
    values.push(body.provider);
    sets.push(`provider = ?${values.length}`);
  }

  if (body.position !== undefined) {
    const position = Number(body.position);
    if (!Number.isInteger(position) || position < 0 || position >= MAX_AI_KEYS) {
      return fail(env, "That is not a place in the list.");
    }
    values.push(position);
    sets.push(`position = ?${values.length}`);
  }

  const suppliedKey = String(body.api_key || "").trim();
  if (suppliedKey) {
    if (suppliedKey.length > LIMITS.apiKey) {
      return fail(env, "That does not look like an API key.");
    }
    values.push(await encryptSecret(suppliedKey, env.KEY_ENCRYPTION_SECRET));
    sets.push(`key_cipher = ?${values.length}`);
  }

  // A replaced key, or one the person has explicitly told us to try again, starts clean.
  if (suppliedKey || body.state === "ready") {
    sets.push("state = 'ready'", "last_error = NULL", "last_error_detail = NULL");
    sets.push("last_error_at = NULL", "exhausted_at = NULL");
  }

  values.push(keyId);
  await env.DB.prepare(`UPDATE ai_keys SET ${sets.join(", ")} WHERE id = ?${values.length}`)
    .bind(...values)
    .run();

  return json(env, { ok: true });
}

async function removeKey(env, userId, keyId) {
  const result = await env.DB.prepare(`DELETE FROM ai_keys WHERE id = ?1 AND user_id = ?2`)
    .bind(keyId, userId)
    .run();
  if (!result.meta.changes) return fail(env, "No such key.", 404);
  return json(env, { ok: true });
}

// ---------------------------------------------------------------- service routes

async function claimQueue(request, env) {
  const requested = Number(new URL(request.url).searchParams.get("limit"));
  const limit = Math.min(Math.max(Number.isFinite(requested) ? requested : 3, 1), 10);
  const timestamp = now();

  // The worker asks for work every 30 seconds whether there is any or not, so this call is
  // its heartbeat and no new request had to be invented for it. Recorded before the claim
  // rather than after: a worker that checks in and then fails to claim is still alive, and
  // the app should say so.
  await env.DB.prepare(
    `INSERT INTO workers (id, last_seen_at) VALUES (?1, ?2)
     ON CONFLICT (id) DO UPDATE SET last_seen_at = ?2`
  )
    .bind(THE_WORKER, timestamp)
    .run();

  // Anything that used up its attempts and then went quiet is retired here rather than
  // sitting in 'downloading' forever with no error — a clip stuck on "pending" and nothing
  // to show for it is the silent failure Golden Rule 29 forbids.
  await env.DB.prepare(
    `UPDATE sources
     SET state = 'failed',
         error = COALESCE(error, 'Gave up after ' || attempts || ' attempts.'),
         claimed_at = NULL, updated_at = ?1
     WHERE state = 'downloading' AND attempts >= ?2
       AND COALESCE(claimed_at, 0) + ${LEASE_SQL} < ?1`
  )
    .bind(timestamp, MAX_ATTEMPTS)
    .run();

  // A claim is a lease. Without the timeout, a worker that dies mid-download leaves the
  // source in 'downloading' forever.
  // `long_ok` tells the worker this one has already been said yes to, so it downloads it
  // without asking again (D42). 'needs_ok' and 'parked' are not in this query at all, so a
  // video waiting on an answer is never picked up.
  const rows = await env.DB.prepare(
    `SELECT id, url_canonical, url_original, platform, attempts,
            CASE WHEN long_ok_at IS NULL THEN 0 ELSE 1 END AS long_ok
     FROM sources
     WHERE attempts < ?3
       AND (state = 'pending'
            OR (state = 'downloading'
                AND COALESCE(claimed_at, 0) + ${LEASE_SQL} < ?2))
     ORDER BY created_at
     LIMIT ?1`
  )
    .bind(limit, timestamp, MAX_ATTEMPTS)
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
              OR (state = 'downloading'
                  AND COALESCE(claimed_at, 0) + ${LEASE_SQL} < ?1))`
    )
      .bind(timestamp, row.id)
      .run();

    if (result.meta.changes) claimed.push(row);
  }

  // The rules travel with the work (D45). The threshold and the ceiling used to live only
  // in a gitignored `.env` on one PC, where a stale value silently changed what the app was
  // telling him — the exact trap that left three of his videos failed for a month. The
  // worker prefers these over its own settings, so there is one authority and it is here.
  return json(env, {
    sources: claimed,
    limits: {
      warn_above_sec: WARN_ABOVE_SEC,
      max_video_sec: MAX_VIDEO_SEC,
      max_transcript_chars: MAX_TRANSCRIPT_CHARS,
      // The fourth number that has to agree across three files, and the one D45 left
      // behind on the PC. It decides whether times are written INTO the transcript here
      // and whether the prompt ASKS for them there — so a stale value in a gitignored
      // .env means an hour-long talk is asked to copy time markers out of a transcript
      // that has none, and comes back with no chapters at all and nothing saying why.
      long_video_sec: LONG_VIDEO_SEC
    }
  });
}

async function storeTranscript(request, env, sourceId) {
  const body = await readJson(request, MAX_TRANSCRIPT_BODY_BYTES);
  const text = String(body.text || "").trim();
  if (!text) return fail(env, "Transcript text is required.");
  if (text.length > LIMITS.transcript) return fail(env, "That transcript is too long.");

  // The length decides which of the two prompts this gets, so it has to be known here.
  // The worker sends it; anything already on the row is the fallback for a re-post.
  const facts = await sourceFacts(env, sourceId);
  const durationSec = Number(body.duration_sec || 0) || facts.duration_sec;

  const timestamp = now();

  // BOTH statements, in one batch, and BOTH carrying the same guard.
  //
  // The guard matters because a worker whose lease had expired — while a second machine
  // was already transcribing the same video — could otherwise write its transcript, run
  // the analysis AGAIN on somebody's key, and REPLACE the stored rows. `item_status` is
  // keyed on a row's flattened name (D34), so a re-run that reworded one silently orphaned
  // a decision he had made.
  //
  // And they are one batch because separating them left a hole of its own: the state moved
  // to 'transcribed', the transcript insert then failed, and the reel was stuck for ever —
  // no longer claimable, no transcript, no analysis, and NO ERROR, for every saver of that
  // link. Either both land or neither does.
  const [insert, moved] = await env.DB.batch([
    env.DB.prepare(
      // The same guard as below, expressed as a WHERE on a SELECT, so this cannot land
      // without the state change beside it.
      `INSERT INTO transcripts (source_id, text, lang, engine, created_at)
       SELECT ?1, ?2, ?3, ?4, ?5
       WHERE EXISTS (SELECT 1 FROM sources WHERE id = ?1 AND state = 'downloading')
       ON CONFLICT (source_id) DO UPDATE SET
         text = ?2, lang = ?3, engine = ?4, created_at = ?5`
    ).bind(sourceId, text, body.lang || null, body.engine || "unknown", timestamp),
    env.DB.prepare(
      // Only a source still in flight may be completed.
      `UPDATE sources
       SET state = 'transcribed', title = COALESCE(?1, title),
           duration_sec = COALESCE(?2, duration_sec), error = NULL, error_detail = NULL,
           claimed_at = NULL,
           creator = COALESCE(?5, creator),
           -- Only when the worker actually LOOKED. A machine still running the code from
           -- before D40 sends no creator field at all, and marking those as settled
           -- would put every reel saved between deploying the Worker and restarting that
           -- machine permanently beyond the backfill — no creator, ever, with nothing on
           -- screen saying why. Absent means "not asked", not "asked and nobody named".
           creator_checked_at = CASE WHEN ?6 = 1 THEN ?3 ELSE creator_checked_at END,
           updated_at = ?3
       WHERE id = ?4 AND state = 'downloading'`
    ).bind(
      cleanTitle(body.title),
      body.duration_sec || null,
      timestamp,
      sourceId,
      // D40. Whoever made it, as the platform reported it, alongside the title it came
      // with. Marked as looked-for only when the field was sent at all — see above.
      cleanCreator(body.creator),
      Object.prototype.hasOwnProperty.call(body, "creator") ? 1 : 0
    )
  ]);

  if (!moved.meta.changes) {
    // Somebody else finished this one. Nothing was written and nothing is spent.
    return json(env, { ok: true, applied: false });
  }
  // Belt and braces: the two guards are identical, so this cannot happen — and if it ever
  // did, an analysis over a transcript that is not there would be worse than saying so.
  if (!insert.meta.changes) return fail(env, "Could not store that transcript.", 409);

  // If anyone who saved this reel has a key connected, analyse it now and share the result
  // with everyone else who saved it. If nobody has one, the source stays at 'transcribed'
  // and the app offers the copy-paste tier instead — that is not a failure.
  try {
    // Whoever agreed to this video's length is whoever pays for reading it (D42). Left
    // null for everything else, which is D10's cost model unchanged: the first saver with
    // a key pays. Nobody's daily allowance should go on an hour-long video they did not
    // ask for and did not approve.
    let analysis = await analyzeSource(env, sourceId, text, facts.long_ok_by, durationSec);

    // The approver turns out to have nothing to pay with — no key, or one that has since
    // been removed, rejected or spent. "You pay" was a rule about WHO SHOULD pay, not a
    // reason to throw an hour of somebody's PC away: without this the video sits at
    // 'transcribed' with no error for ever while another saver's working key goes unused,
    // which is the silent failure Golden Rule 29 forbids. So it falls back to D10.
    if (!analysis && facts.long_ok_by) {
      analysis = await analyzeSource(env, sourceId, text, null, durationSec);
    }
    if (analysis) {
      const problems = await storeAnalysis(
        env,
        sourceId,
        SHARED,
        analysis.payload,
        analysis.provider,
        analysis.model,
        durationSec
      );
      if (problems.length) throw new AnalysisError(...malformed(problems));
    }
    return json(env, { ok: true, analyzed: Boolean(analysis) });
  } catch (error) {
    // sources.error is read by every user who saved this reel, so it carries a fixed
    // classification — never a provider's response body, which can contain a fragment of
    // the key that failed and the account it belongs to.
    //
    // sources.error_detail is the HTTP status and a name from a fixed list in analyze.js,
    // and can carry nothing else — see safeDetail there. It is the difference between
    // knowing what went wrong next time and guessing at it (Golden Rule 1).
    const reason = error instanceof AnalysisError ? error.publicReason : "something went wrong";
    const detail = error instanceof AnalysisError ? error.detail : null;
    await env.DB.prepare(
      `UPDATE sources SET error = ?1, error_detail = ?2, updated_at = ?3 WHERE id = ?4`
    )
      .bind(`Analysis failed: ${reason}`, detail, now(), sourceId)
      .run();
    return json(env, { ok: true, analyzed: false, analysis_error: reason, detail });
  }
}

/**
 * The arguments for an AnalysisError about our own validation, not the provider's.
 * The field names are this file's own words, so nothing a provider wrote travels.
 */
function malformed(problems) {
  return ["the AI's reply was malformed", `200 malformed:${problems.join(",")}`.slice(0, 120)];
}

/**
 * The two things about a source that decide how its transcript is read: how long it is
 * (D33, which of the two prompts it gets) and who agreed to its length (D42, whose key
 * pays for it). Both null-safe — an old row has neither.
 */
async function sourceFacts(env, sourceId) {
  const row = await env.DB.prepare(
    `SELECT duration_sec, long_ok_by FROM sources WHERE id = ?1`
  )
    .bind(sourceId)
    .first();
  return {
    duration_sec: Number(row?.duration_sec || 0),
    long_ok_by: row?.long_ok_by || null
  };
}

export function validateAnalysis(payload, durationSec = 0) {
  const problems = [];
  const limits = limitsFor(durationSec);

  // A string, not merely something that stringifies. `String({})` is "[object Object]",
  // which is non-empty and sailed through — and then sat under "What it said" for ever.
  const summary = typeof payload?.summary === "string" ? payload.summary.trim() : "";
  if (!summary) problems.push("summary");
  else if (summary.length > limits.summary) problems.push("summary is too long");

  for (const field of ["key_points", "learn_more", "claims"]) {
    const value = payload?.[field];
    if (!Array.isArray(value)) problems.push(field);
    else if (value.length > limits.items) problems.push(`${field} has too many items`);
    else if (value.some((item) => JSON.stringify(item ?? "").length > limits.item)) {
      problems.push(`${field} has an item that is too long`);
    }
  }

  // Chapters are optional in exactly the way a topic is (D27): a long video that came back
  // without them is a summary worth keeping, not a broken reply. Only a wrong *type* is a
  // problem. A short reel is never asked for them, and one that volunteers them is still
  // checked rather than trusted.
  const sections = payload?.sections;
  if (sections !== null && sections !== undefined) {
    if (!Array.isArray(sections)) problems.push("sections");
    else if (sections.length > (limits.sections || LONG_LIMITS.sections)) {
      problems.push("sections has too many items");
    } else if (sections.some((item) => JSON.stringify(item ?? "").length > limits.item)) {
      problems.push("sections has an item that is too long");
    }
  }

  // A kind of the wrong TYPE is a malformed reply; a kind that is simply not one of the
  // five is not. cleanKind turns that into null and the video sits outside the trackers,
  // which is visible, rather than a good summary being thrown away over one word.
  if (payload?.kind !== null && payload?.kind !== undefined && typeof payload.kind !== "string") {
    problems.push("kind");
  }

  // Same rule as sections: optional, and only a wrong type or an unreasonable size is a
  // problem. cleanItems drops rows belonging to a kind that has no row shape.
  const items = payload?.items;
  if (items !== null && items !== undefined) {
    if (!Array.isArray(items)) problems.push("items");
    else if (items.length > limits.items) problems.push("items has too many items");
    else if (items.some((item) => JSON.stringify(item ?? "").length > limits.item)) {
      problems.push("items has an item that is too long");
    }
  }

  // Optional, like suggested_task. A missing topic is not a broken analysis — it leaves
  // the clip unfiled, which the app shows and offers to sort, rather than throwing away a
  // good summary over a field the model happened to skip.
  //
  // A topic of the wrong TYPE used to be reported as malformed, which threw the whole
  // analysis away — summary, points, claims and all — over one field. `cleanTopicName`
  // now refuses anything that is not a string outright, so a wrong type behaves exactly
  // like a missing one: the clip is left unfiled and the app offers to sort it. Keeping
  // the good nine tenths of a reply beats discarding it to punish the tenth.
  //
  // Being lenient here is only safe BECAUSE that guard exists. Without it an object became
  // the folder "[object Object]" — on the shared row, so in everybody's notebook.

  return problems;
}

/**
 * Stores an analysis. `ownerId` is SHARED ('') only for Worker-produced results — a user's
 * paste is stored against that user so it can never overwrite what others read.
 * Returns an array of problems; empty means it was stored.
 */
async function storeAnalysis(env, sourceId, ownerId, payload, provider, model, durationSec = 0) {
  const problems = validateAnalysis(payload, durationSec);
  if (problems.length) return problems;

  const timestamp = now();
  // What sort of video this is, and the rows that sort of video carries (D34). Both are
  // null for anything that named no kind, which is every analysis stored before today —
  // so an old row and a new one that tracks nothing are indistinguishable, and nothing
  // has to be backfilled.
  const kind = cleanKind(payload.kind);
  const rows = cleanItems(kind, payload.items);
  // Chapters and claims get the same treatment as rows: anything not the agreed shape is
  // dropped HERE, once, rather than defended against at every place that reads it.
  const chapters = cleanSections(payload.sections);
  const claims = cleanClaims(payload.claims);
  const points = cleanLines(payload.key_points);
  const worthStudying = cleanLines(payload.learn_more);
  // The last field with no guard on it. Anything that is not text becomes nothing, exactly
  // as a missing one does — rather than throwing on the way to the database and taking a
  // whole good analysis down with it. See cleanOneLine.
  const task = cleanOneLine(payload.suggested_task, LIMITS.task);

  // Anything the model asked for that came back and could not be used at all — which is
  // what happens when a tactic video answers `items: ["Sunday Pickup", "Open Box"]`, a list
  // of strings where a list of objects was asked for.
  //
  // That is NOT the same as a video with nothing to track, and it must not be recorded as
  // though it were: an empty table nothing can ever fill, and no signal anywhere that it
  // went wrong.
  //
  // It started as rows alone, and that was too narrow: a three-hour talk costs hours of his
  // PC, and if its chapters came back as strings they were dropped to NULL — which is
  // indistinguishable from "this video had none", so D33's one deliverable went missing for
  // ever with nothing saying so and no way to ask again. Every list that was ASKED for and
  // came back unusable counts now, and the reel is offered one more read because of it.
  const droppedEverything = (asked, kept) =>
    Array.isArray(asked) && asked.length > 0 && !(kept && kept.length);

  const replyWasMangled =
    (KINDS_WITH_ROWS.includes(kind) && droppedEverything(payload.items, rows))
    || droppedEverything(payload.sections, chapters)
    || droppedEverything(payload.claims, claims)
    || droppedEverything(payload.key_points, points);

  const statements = [
    env.DB.prepare(
      `INSERT INTO analyses
         (source_id, user_id, provider, model, summary, key_points, learn_more, claims,
          suggested_task, topic, sub_topic, sections, kind, items, shapes_version,
          created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)
       ON CONFLICT (source_id, user_id) DO UPDATE SET
         provider = ?3, model = ?4, summary = ?5, key_points = ?6, learn_more = ?7,
         claims = ?8, kind = ?13, shapes_version = ?15, created_at = ?16,
         -- What a second reading may take away, and what it may not.
         --
         -- Every field here is OPTIONAL in a reply on purpose: validateAnalysis lets a
         -- video come back with no chapters and no topic rather than throwing away a good
         -- summary over a field the model skipped. That is right for a FIRST reading. On a
         -- second one — "Read those again", a button this build puts on his home screen —
         -- the row already has them, and writing every column blindly replaced the
         -- chapters of every long video it touched with nothing, stamped the shapes
         -- version so the reel never comes round again, and left no error and no path that
         -- could ever derive them back. Hours of talk, and the only way back into it.
         --
         -- Blanket COALESCE was the wrong correction the other way: it kept a sub-topic
         -- stapled to a topic it never belonged to, and kept product rows on a video the
         -- new reading calls an opinion — which the app then hides and the connector still
         -- reads out, so the two disagree about what the video contains.
         --
         -- So, field by field. A re-read asks the SAME full question, so an answer that
         -- omits something is usually a real answer.
         --
         --   suggested_task — replaced. A complete reading that names no action is saying
         --     there is none, and a stale one keeps telling him to do something about a
         --     video that no longer suggests it.
         suggested_task = ?9,
         --   topic and sub_topic — a PAIR. A new topic brings its own sub-topic, null and
         --     all; no new topic leaves both alone. They are never crossed.
         topic = COALESCE(?10, topic),
         sub_topic = CASE WHEN ?10 IS NULL THEN sub_topic ELSE ?11 END,
         --   sections — never destroyed. Only a LONG video is asked for chapters, they
         --     cost hours of his PC, and nothing anywhere re-derives them.
         sections = COALESCE(?12, sections),
         --   items — belong to the kind. Same kind, keep what was there rather than lose
         --     rows to one thin reading; different kind, the old rows are about something
         --     the video is no longer said to be, and they go. The bare column name
         --     here is the row as it stands, before this update.
         items = CASE WHEN ?13 IS NOT NULL AND ?13 <> kind THEN ?14 ELSE COALESCE(?14, items) END`
    ).bind(
      sourceId,
      ownerId,
      provider,
      model || null,
      String(payload.summary).trim(),
      JSON.stringify(points),
      JSON.stringify(worthStudying),
      JSON.stringify(claims),
      task,
      cleanTopicName(payload.topic) || null,
      cleanTopicName(payload.sub_topic) || null,
      // Null rather than "[]" when there are none, so a reel's row is exactly what it was
      // before chapters existed and the app can tell "no chapters" from "none found".
      chapters ? JSON.stringify(chapters) : null,
      kind,
      rows && rows.length ? JSON.stringify(rows) : null,
      // Which set of row shapes this reply was asked for. Written whatever came back,
      // including "nothing to track": the point of the number is that a reel which was
      // ASKED and had nothing is never offered for re-reading again (D39).
      //
      // A reply whose rows were ALL unusable is recorded as the NEGATIVE of the version.
      // That is one number doing two jobs, deliberately: `ABS(...)` puts it at the current
      // version so the queue still shrinks — leaving it NULL made every press re-read the
      // same reels for ever and spent four hundred calls on twelve of them — while the
      // sign says "asked, and what came back was not usable", so it is distinguishable in
      // the database and comes round again by itself the next time the shapes change.
      replyWasMangled ? -ITEM_SHAPES_VERSION : ITEM_SHAPES_VERSION,
      timestamp
    )
  ];

  // Only a Worker-produced analysis completes the pipeline. If a user's paste could set
  // this, anyone could mark a reel 'analyzed' and it would never be downloaded at all.
  if (ownerId === SHARED) {
    statements.push(
      env.DB.prepare(
        `UPDATE sources SET state = 'analyzed', error = NULL, error_detail = NULL,
             claimed_at = NULL, updated_at = ?1
         WHERE id = ?2`
      ).bind(timestamp, sourceId)
    );
  }

  await env.DB.batch(statements);

  // Filing happens after the analysis is safely stored, and can never undo it. A filing
  // failure leaves the clip with no topic, which the app shows as unfiled and offers to
  // sort — a visible home for the failure (Golden Rule 29). Letting it throw instead would
  // reach storeTranscript's catch and mark a reel that analysed perfectly well as failed,
  // for everyone who saved it.
  const proposed = { topic: payload.topic, sub_topic: payload.sub_topic };
  try {
    if (ownerId === SHARED) {
      await fileSourceForAllSavers(env, sourceId, proposed, timestamp, newId);
    } else {
      // A user's own pasted analysis files only their own clip. Nobody else can see it,
      // so nobody else's notebook may move because of it (D18).
      const own = await env.DB.prepare(
        `SELECT id FROM clips WHERE user_id = ?1 AND source_id = ?2 AND deleted_at IS NULL`
      )
        .bind(ownerId, sourceId)
        .first();
      if (own) await fileClipIntoTopic(env, ownerId, own.id, proposed, timestamp, newId);
    }
  } catch {
    // Left unfiled on purpose — see above.
  }

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
         error = ?1, error_detail = NULL, claimed_at = NULL, updated_at = ?2
     WHERE id = ?3 AND state = 'downloading'`
  )
    .bind(message, now(), sourceId, MAX_ATTEMPTS)
    .run();

  return json(env, { ok: true, applied: Boolean(result.meta.changes) });
}

// ---------------------------------------------------------------- very long videos (D42)

/**
 * "This one is long — here is what it will cost." The PC worker reports the length it read
 * from the metadata and stops, having downloaded nothing.
 *
 * The video goes to 'needs_ok' and sits there. It is not failed, it carries no error, and
 * it is outside the claim query, so nothing touches it again until somebody answers.
 *
 * A length past the ceiling is the one case that IS a failure, and it fails here rather
 * than after three hours of work: no answer he could give would make a seven-hour video
 * fit, so asking him would be asking a question with one answer.
 */
async function reportTooLong(request, env, sourceId) {
  const body = await readJson(request);
  const durationSec = Math.max(Number(body.duration_sec || 0), 0);
  const timestamp = now();

  if (tooLongForAnyone(durationSec)) {
    const hours = Math.round(MAX_VIDEO_SEC / 3600);
    await env.DB.prepare(
      // Guarded exactly like the branch below, and for the same reason: a worker whose
      // lease expired can come back late, and this one writes 'failed' — so without the
      // guard a stale report buries a video another worker has since transcribed and
      // analysed, and every saver of that reel sees an error on a reel that worked.
      `UPDATE sources
       SET state = 'failed',
           error = ?1, error_detail = 'refused too_long', claimed_at = NULL,
           duration_sec = COALESCE(?2, duration_sec), title = COALESCE(?3, title),
           creator = COALESCE(?4, creator),
           -- Only when the worker actually looked, exactly as storeTranscript does: a
           -- machine running the code from before D40 sends no creator field, and
           -- marking those settled would put them permanently beyond the backfill.
           creator_checked_at = CASE WHEN ?7 = 1 THEN ?5 ELSE creator_checked_at END,
           updated_at = ?5
       WHERE id = ?6 AND state = 'downloading'`
    )
      .bind(
        `This video is ${Math.round(durationSec / 60)} minutes long, past the ${hours}-hour limit.`,
        durationSec || null,
        cleanTitle(body.title),
        cleanCreator(body.creator),
        timestamp,
        sourceId,
        Object.prototype.hasOwnProperty.call(body, "creator") ? 1 : 0
      )
      .run();
    return json(env, { ok: true, refused: true });
  }

  // The Worker decides what is long, not the machine that reported it (D42).
  //
  // Refusing outright would have stranded it: the source stays claimed, the lease expires,
  // it is claimed again, and after three goes it is retired as "gave up after 3 attempts"
  // — a reel thrown away over a disagreement about a number. So it goes back in the queue
  // to be downloaded normally, which is what should have happened in the first place.
  if (!needsPermission(durationSec)) {
    await env.DB.prepare(
      // `attempts = 0` for the same reason the branch below resets them: this is not a
      // failed try, it is a machine and this Worker disagreeing about a threshold. Left
      // counting, three rounds of that disagreement would retire the reel as "gave up
      // after 3 attempts" — which is the outcome this branch exists to prevent.
      `UPDATE sources
       SET state = 'pending', attempts = 0, claimed_at = NULL,
           duration_sec = COALESCE(?1, duration_sec), updated_at = ?2
       WHERE id = ?3 AND state = 'downloading'`
    )
      .bind(durationSec || null, timestamp, sourceId)
      .run();
    return json(env, { ok: true, not_long: true });
  }

  // Only a source the worker actually holds may be moved. A worker whose lease expired can
  // come back late, and without this it would drag a video somebody has since approved and
  // transcribed back into "waiting to be asked about".
  const result = await env.DB.prepare(
    `UPDATE sources
     SET state = 'needs_ok', error = NULL, error_detail = NULL, claimed_at = NULL,
         attempts = 0,
         duration_sec = COALESCE(?1, duration_sec), title = COALESCE(?2, title),
         creator = COALESCE(?3, creator),
         -- Only when the worker actually looked, exactly as storeTranscript does: a
         -- machine running the code from before D40 sends no creator field, and marking
         -- those settled would put them permanently beyond the backfill (D46).
         creator_checked_at = CASE WHEN ?6 = 1 THEN ?4 ELSE creator_checked_at END,
         updated_at = ?4
     WHERE id = ?5 AND state = 'downloading'`
  )
    .bind(
      durationSec || null,
      cleanTitle(body.title),
      cleanCreator(body.creator),
      timestamp,
      sourceId,
      Object.prototype.hasOwnProperty.call(body, "creator") ? 1 : 0
    )
    .run();

  return json(env, { ok: true, applied: Boolean(result.meta.changes) });
}

/**
 * "Yes, do it." The video goes back into the queue with a note that its length has been
 * agreed to, so the worker downloads it next time round without asking again.
 *
 * `long_ok_by` is the person who pressed, and it is not bookkeeping. A long video can
 * spend most of a free daily allowance, and D10 would otherwise have the first saver with
 * a key pay for a video somebody else approved. Whoever says yes pays for that one.
 *
 * Attempts go back to zero: the claim that discovered the length used one up, and a video
 * that has just been agreed to deserves a full set of tries.
 */
async function approveLongVideo(env, userId, clipId) {
  const clip = await env.DB.prepare(
    `SELECT c.source_id, s.state, s.duration_sec FROM clips c
     JOIN sources s ON s.id = c.source_id
     WHERE c.id = ?1 AND c.user_id = ?2 AND c.deleted_at IS NULL`
  )
    .bind(clipId, userId)
    .first();
  if (!clip) return fail(env, "No such clip.", 404);

  if (clip.state !== "needs_ok" && clip.state !== "parked") {
    return fail(env, "That video is not waiting to be approved.");
  }
  if (tooLongForAnyone(clip.duration_sec)) {
    return fail(env, "That video is past the length this can handle at all.");
  }

  const timestamp = now();
  await env.DB.prepare(
    `UPDATE sources
     SET state = 'pending', attempts = 0, error = NULL, error_detail = NULL,
         claimed_at = NULL, long_ok_at = ?1, long_ok_by = ?2, updated_at = ?1
     WHERE id = ?3 AND state IN ('needs_ok', 'parked')`
  )
    .bind(timestamp, userId, clip.source_id)
    .run();

  return json(env, { ok: true });
}

/**
 * "Not now." The video is parked, and parked is not failed.
 *
 * It keeps no error, it is never retried, and it can be approved at any time afterwards —
 * that is the whole difference, and it is the one he asked for by name. A refused video
 * that came back as "could not be read" would be a video he had thrown away without
 * meaning to.
 */
async function parkLongVideo(env, userId, clipId) {
  const clip = await env.DB.prepare(
    `SELECT c.source_id, s.state FROM clips c
     JOIN sources s ON s.id = c.source_id
     WHERE c.id = ?1 AND c.user_id = ?2 AND c.deleted_at IS NULL`
  )
    .bind(clipId, userId)
    .first();
  if (!clip) return fail(env, "No such clip.", 404);
  if (clip.state !== "needs_ok") return fail(env, "That video is not waiting to be approved.");

  const timestamp = now();
  await env.DB.prepare(
    `UPDATE sources
     SET state = 'parked', error = NULL, error_detail = NULL, claimed_at = NULL,
         updated_at = ?1
     WHERE id = ?2 AND state = 'needs_ok'`
  )
    .bind(timestamp, clip.source_id)
    .run();

  return json(env, { ok: true });
}

// ---------------------------------------------------------------- who made it (D40)

/**
 * A video's own title, trimmed to something a row can hold.
 *
 * Third-party text, like the creator name below, so it is capped rather than trusted to be
 * a sensible length — Facebook hands back the whole caption as the title.
 */
export function cleanTitle(raw) {
  const title = String(raw ?? "").replace(/\s+/g, " ").trim();
  return title ? title.slice(0, LIMITS.title) : null;
}

/**
 * A creator name, as the platform reported it, trimmed to something a row can hold.
 *
 * Kept as plain text and never turned into a link. It comes out of somebody else's video,
 * and the app draws it as a word you can search by — never as an address to tap.
 */
export function cleanCreator(raw) {
  const name = String(raw ?? "").replace(/\s+/g, " ").trim();
  return name ? name.slice(0, LIMITS.creator) : null;
}

/**
 * The videos still missing a creator, for the PC worker to fill in slowly (D40).
 *
 * Deliberately its own queue and not part of `/v1/queue`. Nothing here is downloaded — it
 * is one metadata read per video — and it must never compete with a reel somebody is
 * waiting on, so the worker only asks for these when it has no real work and puts a pause
 * between each one. Facebook and Instagram will rate-limit a machine that asks two hundred
 * questions in two minutes, and being blocked would cost him transcription, not just this.
 *
 * `creator_checked_at` and not `creator IS NULL` alone: a video whose platform will not say
 * who made it must leave the queue, or the worker asks about it for ever.
 */
async function creatorQueue(request, env) {
  const requested = Number(new URL(request.url).searchParams.get("limit"));
  const limit = Math.min(Math.max(Number.isFinite(requested) ? requested : 2, 1), 10);

  const rows = await env.DB.prepare(
    `SELECT id, url_original, platform FROM sources
     WHERE creator IS NULL AND creator_checked_at IS NULL
     ORDER BY creator_tries, created_at DESC
     LIMIT ?1`  /* matches idx_sources_creator_todo, so the sort is free */
  )
    .bind(limit)
    .all();

  // Counted only when there is something to count. This runs on every idle poll — every
  // thirty seconds, for ever — and an unconditional COUNT(*) over `sources` is a table
  // scan whether or not the backfill has anything left to do. On a free D1 allowance that
  // is a quarter of the daily read budget spent on asking a question whose answer is zero
  // (D5: this has to stay free to run). The index added in migration 0014 covers both.
  const left = rows.results.length
    ? await env.DB.prepare(
        `SELECT COUNT(*) AS n FROM sources WHERE creator IS NULL AND creator_checked_at IS NULL`
      ).first()
    : { n: 0 };

  return json(env, { sources: rows.results, remaining: Number(left?.n || 0) });
}

/**
 * Stores who made one video, or records what happened when we tried to find out.
 *
 * `asked` is the whole distinction, and it is not bookkeeping. A lookup that SUCCEEDED and
 * named nobody is an answer: that video is settled and leaves the queue. A lookup that
 * FAILED is not an answer, and treating it as one is how a single rate-limit walks the
 * whole notebook marking two hundred videos "asked, nobody named" without having asked
 * anything — the creator column empty for ever, and nothing on screen saying why.
 *
 * So a failure counts instead. Three of them and the video is left alone anyway, because a
 * queue that never ends is the other way to get this wrong.
 *
 * Nothing else on the source is touched: this must never move a video's state, its error
 * or its transcript, because it runs over reels that are already finished.
 */
async function storeCreator(request, env, sourceId) {
  const body = await readJson(request);
  const name = cleanCreator(body.creator);
  // Absent means "asked" — the field was added after the route, and an older worker that
  // does not send it is one that only ever posted after a successful lookup.
  const asked = body.asked === undefined ? true : Boolean(body.asked);
  const timestamp = now();

  const result = await env.DB.prepare(
    `UPDATE sources
     SET creator = CASE WHEN creator IS NULL THEN ?1 ELSE creator END,
         creator_tries = creator_tries + ?4,
         creator_checked_at = CASE
           WHEN ?5 = 1 OR creator_tries + ?4 >= ?6 THEN ?2 ELSE creator_checked_at END,
         updated_at = ?2
     WHERE id = ?3`
  )
    .bind(name, timestamp, sourceId, asked ? 0 : 1, asked ? 1 : 0, MAX_CREATOR_TRIES)
    .run();

  if (!result.meta.changes) return fail(env, "No such video.", 404);
  return json(env, { ok: true, creator: name, settled: asked });
}

// ---------------------------------------------------------------- tier 3: copy-paste

async function buildPrompt(env, userId, clipId) {
  const row = await env.DB.prepare(
    `SELECT t.text, s.duration_sec FROM clips c
     JOIN transcripts t ON t.source_id = c.source_id
     JOIN sources s ON s.id = c.source_id
     WHERE c.id = ?1 AND c.user_id = ?2`
  )
    .bind(clipId, userId)
    .first();

  if (!row) return fail(env, "No transcript yet for this clip.", 404);
  // The same prompt the Worker would have used, and the same tidied transcript. What a
  // person pastes into a free chat AI has to be what a connected key would have sent, or
  // the two tiers quietly produce different answers for the same reel (D9).
  return json(env, { prompt: promptFor(row.duration_sec) + tidyTranscript(row.text) });
}

/**
 * Summarise one clip the user already has, on their own key, because they asked.
 *
 * A summary is otherwise only ever made at the moment a transcript lands. Someone who
 * saves ten reels and connects an AI afterwards would get summaries on the eleventh and
 * nothing at all for the ten already sitting there — a dead end with no way out of it
 * inside the app.
 *
 * Deliberately one clip per press rather than sweeping the backlog the moment a key is
 * connected: these run on free allowances, and quietly spending someone's daily limit
 * without being asked would look like the app breaking for no reason.
 */
async function summariseOnDemand(request, env, userId, clipId) {
  const row = await env.DB.prepare(
    `SELECT c.source_id, t.text, s.duration_sec FROM clips c
     JOIN transcripts t ON t.source_id = c.source_id
     JOIN sources s ON s.id = c.source_id
     WHERE c.id = ?1 AND c.user_id = ?2`
  )
    .bind(clipId, userId)
    .first();
  if (!row) return fail(env, "No transcript yet for this clip.", 404);

  const already = await env.DB.prepare(
    `SELECT 1 AS found FROM analyses WHERE source_id = ?1 AND user_id = ?2`
  )
    .bind(row.source_id, SHARED)
    .first();
  if (already) return json(env, { ok: true, already: true });

  try {
    const analysis = await analyzeSource(
      env,
      row.source_id,
      row.text,
      userId,
      row.duration_sec
    );
    if (!analysis) {
      return fail(env, "Connect an AI account in Settings first, or use copy and paste.");
    }

    const problems = await storeAnalysis(
      env,
      row.source_id,
      SHARED,
      analysis.payload,
      analysis.provider,
      analysis.model,
      row.duration_sec
    );
    if (problems.length) throw new AnalysisError(...malformed(problems));
    return json(env, { ok: true });
  } catch (error) {
    // Unlike the automatic run, nothing is written to `sources.error` here. That column is
    // read by everyone who saved the reel, and one person's key failing is not a fact
    // about the reel. The person who pressed the button is watching, so the reason goes
    // back to them and nowhere else.
    const reason = error instanceof AnalysisError ? error.publicReason : "something went wrong";
    const detail = error instanceof AnalysisError ? error.detail : null;
    return json(env, { error: `Could not summarise it: ${reason}`, detail }, 400);
  }
}

async function acceptPastedAnalysis(request, env, userId, clipId) {
  // A paste is only meaningful against a transcript this user can already see, which also
  // stops anyone pasting an analysis for a reel that has not been downloaded yet.
  const clip = await env.DB.prepare(
    `SELECT c.source_id, s.duration_sec FROM clips c
     JOIN transcripts t ON t.source_id = c.source_id
     JOIN sources s ON s.id = c.source_id
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

  // The app sends which AI he pasted from. Anything that is not text is simply not
  // recorded — `String({})` would have gone to the database as a value it cannot store and
  // lost the whole pasted conversation to a bare 500.
  const model = cleanOneLine(body.model, 120);

  const problems = await storeAnalysis(
    env,
    clip.source_id,
    userId,
    payload,
    "manual",
    model,
    clip.duration_sec
  );
  if (problems.length) {
    return fail(env, `The analysis is missing or malformed: ${problems.join(", ")}. Nothing was saved.`);
  }
  return json(env, { ok: true });
}

// ---------------------------------------------------------------- the connector (D29)

/**
 * Mints the address the user pastes into their AI app.
 *
 * The secret is returned HERE AND NOWHERE ELSE. Only its hash is stored, so this response
 * is the single moment it exists in readable form — which is why the app shows it with a
 * copy button and says plainly that it will not be shown again.
 */
async function createConnector(request, env, userId) {
  const body = await readJson(request);
  const label = String(body.label || "").trim().slice(0, 80) || null;

  const existing = await env.DB.prepare(
    `SELECT COUNT(*) AS held FROM connector_tokens WHERE user_id = ?1 AND revoked_at IS NULL`
  )
    .bind(userId)
    .first();
  if ((existing?.held || 0) >= MAX_CONNECTORS) {
    return fail(env, "That is as many connectors as one notebook may have. Turn one off first.");
  }

  const secret = newConnectorSecret();
  const timestamp = now();
  const id = newId();

  await env.DB.prepare(
    `INSERT INTO connector_tokens (id, user_id, token_hash, label, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5)`
  )
    .bind(id, userId, await hashSecret(secret), label, timestamp)
    .run();

  // Built from the address this very request arrived on, so it is by definition one the
  // AI app can reach — staging and production each produce their own without config.
  const url = `${new URL(request.url).origin}/mcp/${secret}`;
  return json(env, { id, url, label, created_at: timestamp }, 201);
}

/** Turns one off. Kept as a row, so "I turned that off on the 3rd" stays answerable. */
async function revokeConnector(env, userId, connectorId) {
  const result = await env.DB.prepare(
    `UPDATE connector_tokens SET revoked_at = ?1
     WHERE id = ?2 AND user_id = ?3 AND revoked_at IS NULL`
  )
    .bind(now(), connectorId, userId)
    .run();

  if (!result.meta.changes) return fail(env, "No such connector.", 404);
  return json(env, { ok: true });
}

// ---------------------------------------------------------------- the learning loop (D29)

/**
 * The text to take to an AI app. Everything known about the reel — what it said, what it
 * claimed and how much that was trusted, and the words themselves — wrapped in the
 * instruction to teach first and hand the learning back at the end.
 *
 * A transcript is required and an analysis is not. Someone with no AI key has no summary
 * and no claims, and the words alone are still worth discussing; refusing them here would
 * put the one feature that needs no key of your own behind having one.
 */
async function buildLearnPrompt(env, userId, clipId) {
  const row = await env.DB.prepare(
    `SELECT t.text AS transcript, a.summary, a.key_points, a.claims
     FROM clips c
     JOIN transcripts t ON t.source_id = c.source_id
     LEFT JOIN analyses a ON a.source_id = c.source_id AND a.user_id IN (?2, ?3)
     WHERE c.id = ?1 AND c.user_id = ?2
     ORDER BY CASE WHEN a.user_id = ?2 THEN 0 ELSE 1 END`
  )
    .bind(clipId, userId, SHARED)
    .first();

  if (!row) return fail(env, "No transcript yet for this clip.", 404);

  const list = (value) => {
    try {
      const parsed = JSON.parse(value || "[]");
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  };

  return json(env, {
    prompt: buildLearningPrompt({
      summary: row.summary || "",
      keyPoints: list(row.key_points),
      claims: list(row.claims),
      transcript: row.transcript
    })
  });
}

/**
 * Stores what came back. Two ways in, on purpose:
 *
 *   * `pasted` — the AI's whole reply, json block and all, for the apps that cannot
 *     connect to us. Gemini is in this group and will be for as long as Google keeps
 *     custom apps inside the US (D29).
 *   * `learning` — the object itself, which is what a connector will send in Stage 3.
 *
 * Both land on the same validation and the same row, so the connector never becomes a
 * second, laxer door into the same table.
 */
async function saveLearning(request, env, userId, clipId) {
  const owned = await env.DB.prepare(`SELECT id FROM clips WHERE id = ?1 AND user_id = ?2`)
    .bind(clipId, userId)
    .first();
  if (!owned) return fail(env, "Clip not found.", 404);

  const body = await readJson(request);

  let payload;
  if (body.pasted !== undefined) {
    try {
      payload = parseAnalysis(String(body.pasted));
    } catch {
      return fail(
        env,
        "That does not look like the AI's answer. Copy the whole reply, including the json block."
      );
    }
  } else {
    payload = body.learning;
  }

  const problems = validateLearning(payload);
  if (problems.length) {
    return fail(env, `That learning is missing or malformed: ${problems.join(", ")}. Nothing was saved.`);
  }

  if (await pastTheDayFor(env, "learnings", userId, MAX_LEARNINGS_PER_DAY)) {
    return fail(env, "You have saved a lot of conversations today. Try again tomorrow.", 429);
  }

  const columns = learningColumns(payload);
  const timestamp = now();
  const id = newId();

  await env.DB.prepare(
    `INSERT INTO learnings
       (id, user_id, clip_id, learned, verdicts, actions, still_open, corrections,
        look_into, learned_with, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11)`
  )
    .bind(
      id,
      userId,
      clipId,
      columns.learned,
      columns.verdicts,
      columns.actions,
      columns.still_open,
      columns.corrections,
      columns.look_into,
      columns.learned_with,
      timestamp
    )
    .run();

  // The clip moves too, so a reel that has been learned from is not still sitting in the
  // list looking untouched — and so delta sync carries the change to every device.
  await env.DB.prepare(`UPDATE clips SET updated_at = ?1 WHERE id = ?2 AND user_id = ?3`)
    .bind(timestamp, clipId, userId)
    .run();

  return json(env, { id }, 201);
}

/**
 * What the user has decided about one row of a product or tool tracker (D34).
 *
 * Keyed to the clip, like every other per-user write, so ownership is checked the same
 * way. An empty status clears the decision — a soft delete, so delta sync carries the
 * clearing to their other devices instead of the row silently reappearing.
 */
async function setItemStatus(request, env, userId, clipId) {
  const body = await readJson(request);
  const key = itemKey(body.name);
  if (!key) return fail(env, "That row has no name to remember it by.");

  const status = String(body.status || "").trim().toLowerCase();
  if (status && !ITEM_STATUSES.includes(status)) return fail(env, "Unknown status.");

  const clip = await env.DB.prepare(
    `SELECT source_id FROM clips WHERE id = ?1 AND user_id = ?2 AND deleted_at IS NULL`
  )
    .bind(clipId, userId)
    .first();
  if (!clip) return fail(env, "Clip not found.", 404);

  const timestamp = now();
  await env.DB.prepare(
    `INSERT INTO item_status
       (id, user_id, source_id, item_key, status, created_at, updated_at, deleted_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, ?7)
     ON CONFLICT (user_id, source_id, item_key) DO UPDATE SET
       status = ?5, updated_at = ?6, deleted_at = ?7`
  )
    .bind(
      newId(),
      userId,
      clip.source_id,
      key,
      status || "want",
      timestamp,
      status ? null : timestamp
    )
    .run();

  return json(env, { ok: true, item_key: key, status: status || null });
}

/**
 * "Tidy my folders" — folds together the top-level topics that are the same broad
 * subject under different names, and moves their clips across.
 *
 * Costs nothing and calls nobody: the rule is the one every new clip is already filed by,
 * applied to what a notebook accumulated before it existed. Safe to press twice — the
 * second press finds nothing left to do.
 */
async function tidyMyTopics(env, userId) {
  const result = await tidyTopics(env, userId, now());
  return json(env, { ok: true, ...result });
}

/**
 * "Sort my old clips" (D27) — for the clips summarised before topics existed.
 *
 * Two kinds get sorted. One is a reel somebody else has since had named, where the name
 * is already sitting in the shared analysis and filing it costs nothing. The other has no
 * name yet, and is named from the summary already stored — not the transcript, and never
 * by re-summarising, because the summary itself is finished work.
 *
 * A clip whose topic the user set by hand is never included: fileClipIntoTopic refuses it,
 * and it is filtered out here too so it cannot even cost a call.
 */
async function sortOldClips(request, env, userId) {
  const timestamp = now();

  // `topic_set_by IS NULL` is what makes this queue shrink. A clip that has been through
  // here once is marked even when nothing could be named for it, so the app pressing
  // "sort" until `remaining` reaches zero always terminates. Filtering on topic_id alone
  // would leave an unnameable clip in the queue for ever, and the app would loop.
  const pending = await env.DB.prepare(
    `SELECT c.id, a.summary, a.topic, a.sub_topic, c.source_id
     FROM clips c
     JOIN analyses a ON a.source_id = c.source_id AND a.user_id = ?2
     WHERE c.user_id = ?1
       AND c.deleted_at IS NULL
       AND c.topic_id IS NULL
       AND c.topic_set_by IS NULL
     ORDER BY c.created_at DESC`
  )
    .bind(userId, SHARED)
    .all();

  const queue = pending.results;
  let attempted = 0;
  let sorted = 0;
  let failure = null;

  for (const row of queue.slice(0, MAX_SORT_PER_REQUEST)) {
    try {
      let names = { topic: row.topic, sub_topic: row.sub_topic };

      if (!cleanTopicName(names.topic)) {
        const proposed = await proposeTopic(env, userId, row.summary);
        if (!proposed) {
          // Nothing has been spent and nothing can be. Say so outright when the run
          // achieved nothing at all; if some clips were already sorted from names that
          // cost nothing, keep that work and report the reason alongside it.
          if (!sorted) return fail(env, "Connect an AI account in Settings first.", 400);
          failure = "no AI account is connected";
          break;
        }
        names = proposed;

        if (cleanTopicName(names.topic)) {
          // Stored on the shared analysis, so the next person to save this reel gets the
          // name for free (D10). Only the Worker writes this row (D18).
          await env.DB.prepare(
            `UPDATE analyses SET topic = ?1, sub_topic = ?2
             WHERE source_id = ?3 AND user_id = ?4`
          )
            .bind(
              cleanTopicName(names.topic),
              cleanTopicName(names.sub_topic) || null,
              row.source_id,
              SHARED
            )
            .run();
        }
      }

      if (await fileClipIntoTopic(env, userId, row.id, names, timestamp, newId)) {
        sorted += 1;
      } else {
        // Looked at, and there was no name to give it. Marked so it leaves the queue
        // instead of being asked about again on every press, and so the app can show it
        // as one the AI could not place rather than one still waiting.
        await env.DB.prepare(
          `UPDATE clips SET topic_set_by = 'ai', updated_at = ?1 WHERE id = ?2`
        )
          .bind(timestamp, row.id)
          .run();
      }
      attempted += 1;
    } catch (error) {
      // One clip's failure stops the run rather than burning the rest of the allowance on
      // what is almost certainly the same failure ten more times. What was already sorted
      // stays sorted, and the reason goes back to the person watching — never onto the
      // shared source row, which is not a fact about the reel.
      failure = error instanceof AnalysisError ? error.publicReason : "something went wrong";
      break;
    }
  }

  return json(env, { sorted, remaining: Math.max(queue.length - attempted, 0), error: failure });
}

/**
 * "Fill in my trackers" (D34), and since D38 also "read these again for the new table".
 *
 * A tracker holding four rows out of a notebook of eighty-six is a demonstration, not a
 * feature. This runs the analysis again over the transcript already stored, so a video
 * that showed three products at three prices ends up as three rows.
 *
 * Two conditions, and BOTH have to hold.
 *
 * `shapes_version` behind the current one — which is every analysis written before today,
 * because NULL means the first set of shapes. That is what makes the queue finite: a reel
 * asked under the current shapes never appears here again, even if it had nothing to
 * track. It is deliberately the only version test: an earlier draft also included
 * `kind IS NULL`, which never becomes false for a reel whose AI keeps answering with a
 * kind nobody recognises, so the offer would have come back for ever and spent an
 * allowance on every press.
 *
 * `items IS NULL` — nothing to lose. A reel that already carries rows already has its
 * table, and re-reading it would REPLACE those rows: `item_status` is keyed on the row's
 * flattened name (D34), so a re-run that renames a row leaves his "ordered" and "using
 * it" pointing at nothing, with no error and no way back. Gaining a speculative table is
 * not worth losing a decision he actually made. In his notebook this is the difference
 * between re-reading 210 reels and re-reading the ~120 that can only gain.
 *
 * It runs on the presser's own key, like "Summarise this one" does: they volunteered
 * their allowance by pressing, and quietly spending an earlier saver's would be wrong.
 * And it is a press rather than something automatic, because eighty-six calls that nobody
 * asked for look exactly like the app breaking. D39 makes that a rule rather than a
 * habit: the app must say how many reels it would re-read and wait to be told yes.
 *
 * A few at a time, and the app presses again while anything is left — one Worker request
 * has a hard ceiling on how many calls out it may make. It stops on the first failure
 * rather than spending the rest of the allowance on the same failure ten more times.
 */
async function fillInKinds(request, env, userId) {
  const pending = await env.DB.prepare(
    `SELECT c.id, c.source_id, t.text, s.duration_sec
     FROM clips c
     JOIN analyses a ON a.source_id = c.source_id AND a.user_id = ?2
     JOIN transcripts t ON t.source_id = c.source_id
     JOIN sources s ON s.id = c.source_id
     WHERE c.user_id = ?1
       AND c.deleted_at IS NULL
       AND ABS(COALESCE(a.shapes_version, 1)) < ?3
       AND a.items IS NULL
     ORDER BY c.created_at DESC`
  )
    .bind(userId, SHARED, ITEM_SHAPES_VERSION)
    .all();

  const queue = pending.results;
  let done = 0;
  let attempted = 0;
  let failure = null;

  for (const row of queue.slice(0, MAX_SORT_PER_REQUEST)) {
    try {
      const analysis = await analyzeSource(env, row.source_id, row.text, userId, row.duration_sec);
      if (!analysis) {
        if (!done) return fail(env, "Connect an AI account in Settings first.", 400);
        failure = "no AI account is connected";
        break;
      }

      const problems = await storeAnalysis(
        env,
        row.source_id,
        SHARED,
        analysis.payload,
        analysis.provider,
        analysis.model,
        row.duration_sec
      );
      if (problems.length) throw new AnalysisError(...malformed(problems));
      done += 1;
    } catch (error) {
      // Never onto sources.error: one person's key failing is not a fact about the reel,
      // and the person who pressed the button is watching.
      failure = error instanceof AnalysisError ? error.publicReason : "something went wrong";
      break;
    }
    attempted += 1;
  }

  return json(env, { done, remaining: Math.max(queue.length - attempted, 0), error: failure });
}

// ---------------------------------------------------------------- the re-look (D41)

/**
 * Every reel of this person's that has a summary and has never been in a re-look.
 *
 * Ordered oldest first, because the ones that have waited longest are the ones a re-look
 * is for. A batch bigger than MAX_RELOOK_CLIPS leaves the rest due, so nothing is dropped
 * — it simply comes round next time.
 */
// One clip, one line, and the summary it is due to be looked at through. Their own pasted
// analysis wins over the shared one where they have both, exactly as the learning prompt
// does — somebody on the copy-paste tier has no shared summary at all, and a re-look that
// silently skipped them would be a feature only key-holders get.
const RELOOK_ROWS = `
  SELECT * FROM (
    SELECT c.id AS id, c.created_at AS created_at, s.title AS title,
           COALESCE(
             (SELECT summary FROM analyses WHERE source_id = c.source_id AND user_id = ?1),
             (SELECT summary FROM analyses WHERE source_id = c.source_id AND user_id = ?2)
           ) AS summary
    FROM clips c
    JOIN sources s ON s.id = c.source_id
    WHERE c.user_id = ?1
      AND c.deleted_at IS NULL
      AND c.relooked_at IS NULL
  )
  WHERE summary IS NOT NULL`;

async function relookQueue(env, userId, limit) {
  const rows = await env.DB.prepare(`${RELOOK_ROWS} ORDER BY created_at LIMIT ?3`)
    .bind(userId, SHARED, limit)
    .all();
  return rows.results;
}

/** How many are due, and when the oldest of them was saved. The same set, counted. */
async function relookDue(env, userId) {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS due, MIN(created_at) AS oldest FROM (${RELOOK_ROWS})`
  )
    .bind(userId, SHARED)
    .first();
  return { due: Number(row?.due || 0), oldest: row?.oldest || null };
}

/** How often this person wants to be offered one, and whether one is offered now. */
async function relookFor(env, userId, timestamp) {
  const user = await env.DB.prepare(
    `SELECT relook_days, relooked_at FROM users WHERE id = ?1`
  )
    .bind(userId)
    .first();
  const { due, oldest } = await relookDue(env, userId);
  return relookState({
    everyDays: user?.relook_days ?? null,
    lastAt: user?.relooked_at ?? null,
    dueCount: due,
    oldestDueAt: oldest,
    at: timestamp
  });
}

/** How often to offer one. 0 is "stop asking me", and is stored rather than assumed. */
async function setRelookEvery(request, env, userId) {
  const body = await readJson(request);
  // A number and nothing else. `Number(null)` and `Number("")` are both 0, which is the
  // value that means "stop offering" — so a request that simply forgot the field would
  // quietly switch the feature off.
  const days = body.days;
  if (typeof days !== "number" || !RELOOK_CHOICES.includes(days)) {
    return fail(env, `That is not one of the choices: ${RELOOK_CHOICES.join(", ")}`);
  }
  await env.DB.prepare(`UPDATE users SET relook_days = ?1, last_seen_at = ?2 WHERE id = ?3`)
    .bind(days, now(), userId)
    .run();
  return json(env, { ok: true, every_days: days });
}

/**
 * Does one re-look, because he pressed the button that said how many it would cover.
 *
 * One call for the whole batch. The value of a re-look is what forty reels have in common,
 * which forty separate calls could not see and would cost forty times as much to miss.
 *
 * Nothing is marked until the round-up is safely stored. A failure therefore leaves every
 * reel exactly as due as it was, and the reason goes back to the person watching — never
 * onto a shared row, because one person's key failing is not a fact about anybody's reel.
 */
async function doRelook(request, env, userId) {
  const timestamp = now();

  // "Stop asking me" is an answer, and the server is where a rule like that has to live —
  // the app not drawing the banner is a courtesy, not an enforcement (D41).
  //
  // The GAP is deliberately NOT enforced here. It exists so he is not nagged, and the only
  // way to reach this is a button he pressed; refusing a deliberate press because it is
  // three days early would be the app arguing with him.
  const state = await relookFor(env, userId, timestamp);
  if (state.every_days <= 0) {
    return fail(env, "You have turned looking back off. Turn it on in Settings first.");
  }

  const batch = await relookQueue(env, userId, MAX_RELOOK_CLIPS);
  if (!batch.length) {
    return json(env, { ok: true, nothing_due: true });
  }

  let answer;
  try {
    answer = await askOnTheirOwnKeys(env, userId, RELOOK_PROMPT + relookLines(batch));
  } catch (error) {
    const reason = error instanceof AnalysisError ? error.publicReason : "something went wrong";
    return json(env, { error: `Could not look back over them: ${reason}` }, 400);
  }
  if (!answer) {
    return fail(env, "Connect an AI account in Settings first — a re-look needs one.", 400);
  }

  const problems = validateRelook(answer.payload);
  if (problems.length) {
    // Nothing half-stored and nothing marked, so pressing again is safe and covers exactly
    // the same reels.
    return fail(env, `The AI's reply was malformed: ${problems.join(", ")}. Nothing was saved.`);
  }

  const id = newId();
  const statements = [
    env.DB.prepare(
      `INSERT INTO relooks
         (id, user_id, themes, act_now, note, clip_count, covers_from, covers_to,
          provider, model, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11)`
    ).bind(
      id,
      userId,
      JSON.stringify(answer.payload.themes),
      JSON.stringify(answer.payload.act_now),
      answer.payload.note ? String(answer.payload.note) : null,
      batch.length,
      batch[0].created_at,
      batch[batch.length - 1].created_at,
      answer.provider,
      answer.model || null,
      timestamp
    ),
    env.DB.prepare(`UPDATE users SET relooked_at = ?1 WHERE id = ?2`).bind(timestamp, userId)
  ];

  // Only the reels this round-up actually covered are marked. Anything past the cap stays
  // due and comes round next time rather than being silently skipped.
  for (const row of batch) {
    statements.push(
      env.DB.prepare(
        `UPDATE clips SET relooked_at = ?1, updated_at = ?1 WHERE id = ?2 AND user_id = ?3`
      ).bind(timestamp, row.id, userId)
    );
  }

  await env.DB.batch(statements);

  const left = await relookDue(env, userId);
  return json(env, { ok: true, id, covered: batch.length, still_due: left.due }, 201);
}

/**
 * "Try this one again" — the way back from `failed`.
 *
 * Nothing could move a source out of `failed`. Three interruptions and it was gone for
 * good, for every saver of that link, recoverable only by hand-written SQL — which is
 * exactly the rescue D42 records performing on his three stuck videos. Raising the ceiling
 * to six hours made that far likelier, not less: his is a home PC that gets switched off,
 * and a long job that is interrupted three times is a long job he approved and paid for
 * and then lost.
 *
 * Costs nothing and calls nobody: it puts the video back in the queue with its attempts
 * reset. A video that genuinely cannot be downloaded simply fails again and says so.
 */
async function retryClip(env, userId, clipId) {
  const clip = await env.DB.prepare(
    `SELECT c.source_id, s.state FROM clips c
     JOIN sources s ON s.id = c.source_id
     WHERE c.id = ?1 AND c.user_id = ?2 AND c.deleted_at IS NULL`
  )
    .bind(clipId, userId)
    .first();
  if (!clip) return fail(env, "No such clip.", 404);
  if (clip.state !== "failed") return fail(env, "That video has not failed.");

  const timestamp = now();
  await env.DB.prepare(
    // `long_ok_at` is kept — the length was already agreed to and asking again would be
    // asking a question that has been answered. `long_ok_by` moves to whoever pressed
    // this: retrying is asking for the work, and asking for the work is what volunteers an
    // allowance (D42). Leaving it would spend the original approver's key because somebody
    // else pressed a button.
    `UPDATE sources
     SET state = 'pending', attempts = 0, error = NULL, error_detail = NULL,
         claimed_at = NULL,
         long_ok_by = CASE WHEN long_ok_at IS NULL THEN long_ok_by ELSE ?3 END,
         updated_at = ?1
     WHERE id = ?2 AND state = 'failed'`
  )
    .bind(timestamp, clip.source_id, userId)
    .run();

  return json(env, { ok: true });
}

/** Sets a clip's topic by hand. The user's choice is final (D27). */
async function setTopic(request, env, userId, clipId) {
  const body = await readJson(request);

  const clip = await env.DB.prepare(
    `SELECT id FROM clips WHERE id = ?1 AND user_id = ?2 AND deleted_at IS NULL`
  )
    .bind(clipId, userId)
    .first();
  // Someone else's clip and a clip that does not exist answer the same way, so this
  // cannot be used to find out whether a given clip id belongs to anybody.
  if (!clip) return fail(env, "No such clip.", 404);

  const topicId = await setClipTopicByHand(env, userId, clipId, body, now(), newId);
  return json(env, { ok: true, topic_id: topicId });
}

// ---------------------------------------------------------------- router

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    const segments = pathname.split("/").filter(Boolean);

    // A preflight is a browser asking permission, and only our own app's routes are for
    // browsers. Answering it for everything meant the connector — whose own front door
    // refuses any request carrying an Origin, on the grounds that no browser has business
    // there — was handing out the permission slip that lets one in. The secret still
    // stands in the way; this stops the contradiction rather than a specific attack.
    if (request.method === "OPTIONS") {
      return segments[0] === "v1"
        ? new Response(null, { headers: corsHeaders(env) })
        : new Response(null, { status: 405 });
    }

    // Staging serves the app from static assets alongside this API (D26). Assets are
    // matched by filename, and `html_handling = "none"` keeps /app.html literal — but that
    // also means the bare address matches no file and would fall through to the 404 below.
    // Somebody typing the address on a phone must land on the app, not on a JSON error.
    // Guarded on the binding: production has no assets and is unaffected.
    if (env.ASSETS && (pathname === "/" || pathname === "")) {
      return env.ASSETS.fetch(new Request(new URL("/index.html", request.url), request));
    }

    try {
      // The connector (D29). Outside /v1 and before the check below, because this is not
      // our app calling: it is the user's AI app, speaking MCP, authenticated by the
      // secret in the address itself rather than by a Firebase token.
      if (segments[0] === "mcp" && segments[1]) {
        return await handleMcp(request, env, segments[1]);
      }

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
      if (segments[1] === "creators" && request.method === "GET") {
        requireService(request, env);
        return await creatorQueue(request, env);
      }
      if (segments[1] === "sources" && segments[2]) {
        requireService(request, env);
        if (segments[3] === "transcript" && request.method === "POST") {
          return await storeTranscript(request, env, segments[2]);
        }
        if (segments[3] === "error" && request.method === "POST") {
          return await storeFailure(request, env, segments[2]);
        }
        if (segments[3] === "creator" && request.method === "POST") {
          return await storeCreator(request, env, segments[2]);
        }
        if (segments[3] === "too-long" && request.method === "POST") {
          return await reportTooLong(request, env, segments[2]);
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
      if (segments[1] === "keys" && !segments[2]) {
        if (request.method === "GET") return await listKeys(env, userId);
        if (request.method === "POST") return await addKey(request, env, userId);
      }
      if (segments[1] === "keys" && segments[2]) {
        if (request.method === "PATCH") {
          return await updateKey(request, env, userId, segments[2]);
        }
        if (request.method === "DELETE") return await removeKey(env, userId, segments[2]);
      }
      if (segments[1] === "clips" && segments[2]) {
        if (!segments[3] && request.method === "PATCH") {
          return await setStatus(request, env, userId, segments[2]);
        }
        if (segments[3] === "prompt" && request.method === "GET") {
          return await buildPrompt(env, userId, segments[2]);
        }
        if (segments[3] === "summarise" && request.method === "POST") {
          return await summariseOnDemand(request, env, userId, segments[2]);
        }
        if (segments[3] === "analysis" && request.method === "POST") {
          return await acceptPastedAnalysis(request, env, userId, segments[2]);
        }
        if (segments[3] === "topic" && request.method === "PUT") {
          return await setTopic(request, env, userId, segments[2]);
        }
        if (segments[3] === "learn-prompt" && request.method === "GET") {
          return await buildLearnPrompt(env, userId, segments[2]);
        }
        if (segments[3] === "learning" && request.method === "POST") {
          return await saveLearning(request, env, userId, segments[2]);
        }
        if (segments[3] === "item" && request.method === "PUT") {
          return await setItemStatus(request, env, userId, segments[2]);
        }
        if (segments[3] === "long-ok" && request.method === "POST") {
          return await approveLongVideo(env, userId, segments[2]);
        }
        if (segments[3] === "long-park" && request.method === "POST") {
          return await parkLongVideo(env, userId, segments[2]);
        }
        if (segments[3] === "retry" && request.method === "POST") {
          return await retryClip(env, userId, segments[2]);
        }
      }
      if (segments[1] === "connector" && !segments[2] && request.method === "POST") {
        return await createConnector(request, env, userId);
      }
      if (segments[1] === "connector" && segments[2] && request.method === "DELETE") {
        return await revokeConnector(env, userId, segments[2]);
      }
      if (segments[1] === "topics" && segments[2] === "sort" && request.method === "POST") {
        return await sortOldClips(request, env, userId);
      }
      if (segments[1] === "topics" && segments[2] === "tidy" && request.method === "POST") {
        return await tidyMyTopics(env, userId);
      }
      if (segments[1] === "kinds" && !segments[2] && request.method === "POST") {
        return await fillInKinds(request, env, userId);
      }
      if (segments[1] === "relook" && !segments[2] && request.method === "POST") {
        return await doRelook(request, env, userId);
      }
      if (segments[1] === "relook" && segments[2] === "every" && request.method === "PUT") {
        return await setRelookEvery(request, env, userId);
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
