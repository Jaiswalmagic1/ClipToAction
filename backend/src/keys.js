// The AI keys a person has connected, and the order they get spent in (D35).
//
// One key became a list because a free allowance runs out. The rules are deliberately
// narrow, and the narrowness is the feature:
//
//   * Only a spent allowance moves to the next key. Every other refusal stops, with the
//     reason recorded against the key that gave it. A key that has gone bad has to be
//     visible, and a rotation that quietly stepped past it would hide it for ever.
//   * Whose keys, and in what order, is unchanged from D10 — the first person to save the
//     reel pays, and now their whole list is spent before it moves to the next saver.
//     Everybody it reaches saved that reel and receives the analysis their key paid for.
//   * Keys never leave the Worker (D11). Nothing here returns a key or a ciphertext to a
//     caller; `forDisplay` is the only shape the app ever sees.

/**
 * A key marked out of allowance is tried again after this long.
 *
 * Free tiers give the same 429 for "too many this minute" and "too many today", and the
 * two want opposite waits. An hour is chosen against the worse mistake: a day-long lockout
 * after a momentary rate limit leaves a perfectly good key idle and the person watching
 * reels go unanalysed for no reason. Retrying an actually-spent daily quota costs one
 * refused call an hour, and it heals itself when the day rolls over.
 */
export const RETRY_AFTER_MS = 60 * 60 * 1000;

/** 'ready' is usable now; the other two are not, and differ in whether they self-heal. */
export const KEY_STATES = ["ready", "exhausted", "rejected"];

/**
 * The keys that may be spent on this source, best first.
 *
 * `payerId` restricts it to that one person — set when they pressed "Summarise this one",
 * where they are volunteering their own allowance. Left null (the automatic run when a
 * transcript lands) it walks every saver of the reel, oldest save first, and each saver's
 * own list in the order they put it in.
 */
export async function usableKeys(env, sourceId, payerId = null, at = Date.now()) {
  const readyAgainBefore = at - RETRY_AFTER_MS;

  const rows = payerId
    ? await env.DB.prepare(
        `SELECT id, user_id, provider, key_cipher
         FROM ai_keys
         WHERE user_id = ?1
           AND (state = 'ready' OR (state = 'exhausted' AND exhausted_at <= ?2))
         ORDER BY position, created_at`
      )
        .bind(payerId, readyAgainBefore)
        .all()
    : await env.DB.prepare(
        // c.created_at first is D10's rule, unchanged: the earliest saver's list is spent
        // before anybody else's is touched.
        `SELECT k.id, k.user_id, k.provider, k.key_cipher
         FROM ai_keys k
         JOIN clips c ON c.user_id = k.user_id
         WHERE c.source_id = ?1
           AND c.deleted_at IS NULL
           AND (k.state = 'ready' OR (k.state = 'exhausted' AND k.exhausted_at <= ?2))
         ORDER BY c.created_at, k.position, k.created_at`
      )
        .bind(sourceId, readyAgainBefore)
        .all();

  return rows.results;
}

/**
 * Records that a key was refused, and why.
 *
 * `reason` is the same sentence the person is shown against the reel, and `detail` is the
 * status-plus-known-name that `safeDetail` produced — neither can carry a provider's own
 * words, so neither can carry a fragment of the key that failed.
 */
export async function markKeyFailed(env, keyId, category, reason, detail, at = Date.now()) {
  const state = category === "exhausted" ? "exhausted" : "rejected";
  await env.DB.prepare(
    `UPDATE ai_keys
     SET state = ?1,
         last_error = ?2,
         last_error_detail = ?3,
         last_error_at = ?4,
         exhausted_at = ?5,
         updated_at = ?4
     WHERE id = ?6`
  )
    .bind(
      state,
      reason,
      detail || null,
      at,
      // Only an exhaustion has a clock on it. A rejected key stays rejected until the
      // person fixes it, because nothing about waiting makes a wrong key right.
      state === "exhausted" ? at : null,
      keyId
    )
    .run();
}

/**
 * Records that a key worked, which is also what clears an old failure off it.
 *
 * Without this an exhausted key that came back to life would keep showing yesterday's
 * "out of allowance" in Settings while quietly doing all the work.
 */
export async function markKeyWorked(env, keyId, at = Date.now()) {
  await env.DB.prepare(
    `UPDATE ai_keys
     SET state = 'ready',
         last_error = NULL,
         last_error_detail = NULL,
         last_error_at = NULL,
         exhausted_at = NULL,
         last_used_at = ?1,
         updated_at = ?1
     WHERE id = ?2`
  )
    .bind(at, keyId)
    .run();
}

/**
 * One key as the app is allowed to see it: what it is called, whose provider it is, what
 * state it is in and why. Never the key, and never the ciphertext (D11).
 */
export function forDisplay(row, at = Date.now()) {
  const sleeping = row.state === "exhausted" && row.exhausted_at > at - RETRY_AFTER_MS;
  return {
    id: row.id,
    label: row.label || null,
    provider: row.provider,
    position: row.position,
    // What the person actually needs to know, rather than the stored word: an exhausted
    // key whose hour is up is going to be tried again, so calling it "out of allowance"
    // would be a lie by the time they read it.
    state: sleeping ? "exhausted" : row.state === "exhausted" ? "ready" : row.state,
    last_error: row.last_error || null,
    last_error_detail: row.last_error_detail || null,
    last_error_at: row.last_error_at || null,
    ready_again_at: sleeping ? row.exhausted_at + RETRY_AFTER_MS : null,
    last_used_at: row.last_used_at || null
  };
}
