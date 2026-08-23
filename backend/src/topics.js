// Filing a clip into a topic (D27).
//
// The AI names a topic and a sub-topic from the reel alone, and those names live in the
// SHARED analysis — one analysis per reel, reused by everyone who saved it, which is the
// whole cost model (D10). Showing the AI somebody's topic list would make the analysis
// personal to them and destroy that reuse.
//
// So the matching happens here instead: per user, after the analysis exists. The same
// proposed name lands in one person's "Amazon listings" and creates another person's,
// and neither notebook can touch the other (D18).

const MAX_NAME = 60;

// How many notebooks one analysis may file into inside a single request. A reel that sat
// un-analysed while hundreds of people saved it would otherwise mean hundreds of database
// round trips in the one request the PC worker is waiting on, and that request has a hard
// time limit. Everyone past the cap is filed for free by the sort button instead — their
// clip is unfiled, the name is already on the shared analysis, and no AI call is needed.
const MAX_SAVERS_FILED_AT_ONCE = 50;

// Names the AI reaches for when it has nothing to say. Filing a clip under "None" is
// worse than leaving it unfiled, where the app can visibly offer to sort it.
const EMPTY_NAMES = new Set(["", "null", "none", "n/a", "na", "unknown", "other", "general"]);

/**
 * Trims a proposed name down to something worth storing, or "" if there is nothing there.
 * Models like to wrap a name in quotes and to pad it out; neither should reach a row that
 * a person will read.
 *
 * A name longer than a topic name has any business being is dropped whole rather than cut
 * short — half a sentence with the end sawn off is worse than an unfiled clip, which the
 * app can visibly offer to sort.
 */
export function cleanTopicName(raw) {
  const text = String(raw ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^["'`“‘]+|["'`”’]+$/g, "")
    .trim();

  if (text.length > MAX_NAME) return "";
  return EMPTY_NAMES.has(text.toLowerCase()) ? "" : text;
}

/** "Strategies" -> "strategy", "listings" -> "listing", "business" -> "business". */
function singular(word) {
  if (word.length > 4 && word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  if (word.length > 4 && /(?:s|x|z|ch|sh)es$/.test(word)) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith("s") && !/(?:ss|us|is)$/.test(word)) {
    return word.slice(0, -1);
  }
  return word;
}

/**
 * The comparison form of a name: case, punctuation, filler words and plurals all
 * flattened, so "Amazon Listings" and "amazon listing" meet on one row instead of
 * splitting a subject in two.
 *
 * This is stored in topics.name_key. SQLite never recomputes it — these rules are past
 * what SQL can express, and two implementations would drift apart.
 */
export function normaliseTopicName(raw) {
  return String(raw ?? "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter((word) => word && !["the", "a", "an", "of", "for"].includes(word))
    .map(singular)
    .join(" ");
}

/**
 * Finds this user's topic of that name, or makes it. `parentId` is "" for a top-level
 * topic — never null, because SQLite treats NULLs as distinct in the unique index and two
 * NULL parents would let the same name be created twice over.
 *
 * A topic the user deleted comes back rather than being duplicated alongside its own
 * ghost. That is visible — the topic reappears with the new clip inside it — and it is
 * the same rule saveClip already applies to a re-saved reel.
 */
async function findOrCreateTopic(env, userId, parentId, rawName, timestamp, newId) {
  const name = cleanTopicName(rawName);
  const key = normaliseTopicName(name);
  if (!name || !key) return null;

  const lookup = env.DB.prepare(
    `SELECT id, deleted_at FROM topics WHERE user_id = ?1 AND parent_id = ?2 AND name_key = ?3`
  ).bind(userId, parentId, key);

  const existing = await lookup.first();
  if (existing) {
    if (existing.deleted_at) {
      await env.DB.prepare(
        `UPDATE topics SET deleted_at = NULL, updated_at = ?1 WHERE id = ?2`
      )
        .bind(timestamp, existing.id)
        .run();
    }
    return existing.id;
  }

  await env.DB.prepare(
    `INSERT INTO topics (id, user_id, name, parent_id, name_key, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
     ON CONFLICT (user_id, parent_id, name_key) DO NOTHING`
  )
    .bind(newId(), userId, name, parentId, key, timestamp)
    .run();

  // Read back rather than trusting the insert: two saves of the same reel arriving at
  // once both miss the lookup, and the one that loses the race must use the row the
  // winner made instead of returning nothing.
  const stored = await lookup.first();
  return stored?.id || null;
}

/**
 * Files one user's clip under the topic proposed for that reel.
 *
 * Does nothing when the user set the topic themselves — their choice is final (D27) —
 * and nothing when no name was proposed, which leaves the clip visibly unfiled for the
 * app to offer to sort.
 *
 * Returns true when the clip moved.
 */
export async function fileClipIntoTopic(env, userId, clipId, proposed, timestamp, newId) {
  if (!clipId) return false;

  const clip = await env.DB.prepare(
    `SELECT topic_id, topic_set_by FROM clips WHERE id = ?1 AND user_id = ?2`
  )
    .bind(clipId, userId)
    .first();
  if (!clip || clip.topic_set_by === "user") return false;

  const parentId = await findOrCreateTopic(env, userId, "", proposed?.topic, timestamp, newId);
  if (!parentId) return false;

  // The clip is filed at the deepest level that was named, so it sits in exactly one
  // place. The parent is still reachable through topics.parent_id.
  const childId = await findOrCreateTopic(
    env,
    userId,
    parentId,
    proposed?.sub_topic,
    timestamp,
    newId
  );
  const topicId = childId || parentId;

  if (clip.topic_id === topicId) return false;

  await env.DB.prepare(
    `UPDATE clips SET topic_id = ?1, topic_set_by = 'ai', updated_at = ?2 WHERE id = ?3`
  )
    .bind(topicId, timestamp, clipId)
    .run();
  return true;
}

/**
 * Files the reel's proposed topic into the notebook of everyone who saved it. Called when
 * a shared analysis lands, because by then several people may already be holding a clip
 * of that reel with nowhere to file it.
 */
export async function fileSourceForAllSavers(env, sourceId, proposed, timestamp, newId) {
  if (!cleanTopicName(proposed?.topic)) return 0;

  const clips = await env.DB.prepare(
    `SELECT id, user_id FROM clips
     WHERE source_id = ?1 AND deleted_at IS NULL
     ORDER BY created_at
     LIMIT ?2`
  )
    .bind(sourceId, MAX_SAVERS_FILED_AT_ONCE)
    .all();

  let filed = 0;
  for (const clip of clips.results) {
    if (await fileClipIntoTopic(env, clip.user_id, clip.id, proposed, timestamp, newId)) {
      filed += 1;
    }
  }
  return filed;
}

/**
 * Files a clip where the user says it goes, and marks the choice as theirs so nothing
 * automatic moves it again (D27).
 *
 * An empty name clears the topic. That is still recorded as the user's choice — deciding
 * a clip belongs nowhere is a decision, and the sort button must not quietly undo it.
 *
 * Returns the topic the clip now sits in, or null when it was cleared. Throws when the
 * clip is not this user's.
 */
export async function setClipTopicByHand(env, userId, clipId, names, timestamp, newId) {
  const clip = await env.DB.prepare(
    `SELECT id FROM clips WHERE id = ?1 AND user_id = ?2 AND deleted_at IS NULL`
  )
    .bind(clipId, userId)
    .first();
  if (!clip) throw new Error("no such clip");

  const parentId = await findOrCreateTopic(env, userId, "", names?.topic, timestamp, newId);
  const childId = parentId
    ? await findOrCreateTopic(env, userId, parentId, names?.sub_topic, timestamp, newId)
    : null;
  const topicId = childId || parentId;

  await env.DB.prepare(
    `UPDATE clips SET topic_id = ?1, topic_set_by = 'user', updated_at = ?2 WHERE id = ?3`
  )
    .bind(topicId, timestamp, clipId)
    .run();

  return topicId;
}
