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
  // Anything that is not a string is not a name. `String({})` is "[object Object]", which
  // is a perfectly good-looking folder until you read it — and this is the one place every
  // path that names a topic passes through.
  if (typeof raw !== "string") return "";
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

// Two spellings of one subject that no amount of case-and-plural flattening will ever
// bring together, because they are different words. Kept deliberately tiny: this is a
// list of spellings, not a thesaurus. A synonym list would never end, and every entry in
// it is a decision made on somebody else's behalf about what their notebook means.
const PHRASE_FOLDS = [
  [/\bartificial intelligence\b/g, "ai"],
  [/\be commerce\b/g, "ecommerce"],
  [/\becom\b/g, "ecommerce"]
];

// Head words that name no subject, so two topics sharing one are not the same topic.
// "Content creation" and "content marketing" are two subjects; "AI tools" and "AI agents"
// are one.
const GENERIC_HEADS = new Set([
  "best", "top", "new", "free", "how", "online", "digital", "small", "my", "complete",
  "ultimate", "simple", "easy", "quick", "modern", "advanced", "basic", "general",
  "business", "content", "product", "tool", "tip", "guide", "tutorial", "strategy",
  "idea", "hack", "trick", "thing", "way", "step"
]);

/**
 * The one word a top-level topic is about, or "" when it has no such word.
 *
 * This is what stops a notebook growing a folder per video. Left to itself the AI names
 * the subject afresh every time — "AI tools", "AI development", "AI development tools",
 * "AI coding assistants", "AI agents" and "artificial intelligence" all arrived as
 * separate top-level folders in one real notebook, which is the same as having no folders
 * at all.
 *
 * Deliberately the FIRST word and nothing cleverer. A top-level topic is the broad
 * subject by D27's own definition, and the broad subject is what the name leads with:
 * everything after it narrows. Matching on shared words instead would put "product
 * listings" and "product research" in one place, which is wrong — but those are
 * sub-topics, and this is never applied to a sub-topic.
 */
export function headKey(nameKey) {
  let text = String(nameKey ?? "");
  for (const [pattern, replacement] of PHRASE_FOLDS) text = text.replace(pattern, replacement);
  const head = text.trim().split(" ")[0] || "";
  return GENERIC_HEADS.has(head) ? "" : head;
}

/**
 * This user's existing top-level topic about the same broad subject, or null.
 *
 * Reads their top-level topics and compares in JS rather than in SQL, for the same reason
 * name_key is computed in JS: two implementations of these rules would drift apart, and
 * SQLite cannot express them anyway. A person has tens of top-level topics, not thousands.
 *
 * The oldest wins, so the answer does not change from one call to the next, and a topic
 * the user deleted is not resurrected by this route — only an exact name match does that,
 * which is the existing rule.
 */
async function findByHead(env, userId, nameKey) {
  const head = headKey(nameKey);
  if (!head) return null;

  const rows = await env.DB.prepare(
    `SELECT id, name_key FROM topics
     WHERE user_id = ?1 AND parent_id = '' AND deleted_at IS NULL
     ORDER BY created_at`
  )
    .bind(userId)
    .all();

  return rows.results.find((row) => headKey(row.name_key) === head) || null;
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

  // Only at the top level. Sub-topics are meant to be narrow and are left alone — see
  // headKey above.
  if (parentId === "") {
    const sameSubject = await findByHead(env, userId, key);
    if (sameSubject) return sameSubject.id;
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
 * Merges the top-level topics this notebook already has, using the same rule new ones are
 * filed by. For a notebook that filled up before that rule existed — 86 videos across 45
 * folders, seven of them different names for "AI".
 *
 * User-triggered, never automatic. It moves clips between folders, and a notebook
 * rearranging itself while nobody asked would be alarming rather than helpful.
 *
 * Nothing is deleted outright: an emptied topic is soft-deleted like any other, so it
 * travels through delta sync and is recoverable in the database. Clips the user filed by
 * hand move too — their topic is going away — but keep `topic_set_by = 'user'`, so the
 * sort button still will not touch them afterwards (D27).
 *
 * Returns { merged, moved }: how many topics were folded away, and how many clips moved.
 */
// How much work one press may do, counted in CALLS TO THE DATABASE and not in folders.
//
// Not a preference — a hard limit of the platform. A Worker on the free plan may make 50
// calls to the database in ONE request, and every binding call counts one. Tidying his real
// 34 folders took a hundred, so the fifty-first threw with half the merges already
// committed: some folders joined, some not, and nothing anywhere recording which — on the
// one operation that moves his clips between folders.
//
// Counting FOLDERS was the wrong unit and it did not bound anything. A folder costs three
// calls plus three for every sub-folder under it, and sub-folders are the normal case —
// every filed clip creates a parent and a child. Five folders with four sub-folders each
// measured at 57, straight back over the line.
//
// So the loop stops when the work it has done reaches the budget, whatever shape the
// folders were. Thirty leaves room for the handful of calls around the loop. It costs no AI
// and the app presses again while anything is left, so the whole tidy still happens — in
// bites that each finish.
const CALL_BUDGET_PER_REQUEST = 30;

export async function tidyTopics(env, userId, timestamp) {
  const tops = await env.DB.prepare(
    `SELECT id, name_key FROM topics
     WHERE user_id = ?1 AND parent_id = '' AND deleted_at IS NULL
     ORDER BY created_at`
  )
    .bind(userId)
    .all();

  const groups = new Map();
  for (const topic of tops.results) {
    const head = headKey(topic.name_key);
    if (!head) continue;
    if (!groups.has(head)) groups.set(head, []);
    groups.get(head).push(topic);
  }

  let merged = 0;
  let moved = 0;
  // What is left for the next press. The app keeps pressing while this is above zero.
  let remaining = 0;
  // What this request has already spent. Every statement below adds to it.
  let spent = 0;

  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const [keeper, ...rest] = group;

    for (const doomed of rest) {
      if (spent >= CALL_BUDGET_PER_REQUEST) {
        remaining += 1;
        continue;
      }
      spent += 1;
      const children = await env.DB.prepare(
        `SELECT id, name_key FROM topics
         WHERE user_id = ?1 AND parent_id = ?2 AND deleted_at IS NULL`
      )
        .bind(userId, doomed.id)
        .all();

      // Checked INSIDE this loop, not only between folders. Checking only between them
      // bounded nothing: once a folder was entered its whole cost landed however many
      // sub-folders it had, and one folder with forty children measured 85 calls against a
      // ceiling of 50. A folder left half-done keeps its remaining children and is finished
      // by the next press — this loop re-reads them, so it picks up exactly where it left.
      let ranOut = false;

      for (const child of children.results) {
        if (spent >= CALL_BUDGET_PER_REQUEST) {
          ranOut = true;
          break;
        }

        // The keeper may already have a sub-topic of that name, and the unique index on
        // (user_id, parent_id, name_key) would refuse the move. Where it does, the two
        // sub-topics are the same subject: the clips go to the one that stays.
        spent += 1;
        // Deleted ones count. The unique index does not care that a row is soft-deleted,
        // so filtering them out here meant the move below hit `UNIQUE constraint failed`
        // and threw — a 500, with the merges before it already committed and nothing
        // recording which. A deleted sub-folder of the same name is the same subject: the
        // clips go into it and it comes back, which is what findOrCreateTopic already does
        // with one everywhere else.
        const clash = await env.DB.prepare(
          `SELECT id, deleted_at FROM topics
           WHERE user_id = ?1 AND parent_id = ?2 AND name_key = ?3`
        )
          .bind(userId, keeper.id, child.name_key)
          .first();

        if (clash?.deleted_at) {
          spent += 1;
          await env.DB.prepare(
            `UPDATE topics SET deleted_at = NULL, updated_at = ?1 WHERE id = ?2`
          )
            .bind(timestamp, clash.id)
            .run();
        }

        if (clash) {
          // Three statements, not two. Charging two was how the count drifted under: a
          // clash is the NORMAL case — merging "AI" and "AI tools", both of which have a
          // "prompts" child, is the exact job this button exists for.
          spent += 2;
          moved += await moveClips(env, userId, child.id, clash.id, timestamp);
          await env.DB.prepare(
            `UPDATE topics SET deleted_at = ?1, updated_at = ?1 WHERE id = ?2`
          )
            .bind(timestamp, child.id)
            .run();
          merged += 1;
        } else {
          spent += 1;
          await env.DB.prepare(
            `UPDATE topics SET parent_id = ?1, updated_at = ?2 WHERE id = ?3`
          )
            .bind(keeper.id, timestamp, child.id)
            .run();
        }
      }

      // Its children are not all moved yet, so the folder itself stays. Deleting it here
      // would orphan whatever is still under it.
      if (ranOut) {
        remaining += 1;
        continue;
      }

      spent += 2;
      moved += await moveClips(env, userId, doomed.id, keeper.id, timestamp);
      await env.DB.prepare(`UPDATE topics SET deleted_at = ?1, updated_at = ?1 WHERE id = ?2`)
        .bind(timestamp, doomed.id)
        .run();
      merged += 1;
    }
  }

  return { merged, moved, remaining };
}

/** Points every clip filed under `fromId` at `toId`. Returns how many moved. */
async function moveClips(env, userId, fromId, toId, timestamp) {
  const result = await env.DB.prepare(
    `UPDATE clips SET topic_id = ?1, updated_at = ?2
     WHERE user_id = ?3 AND topic_id = ?4 AND deleted_at IS NULL`
  )
    .bind(toId, timestamp, userId, fromId)
    .run();
  return result.meta.changes || 0;
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
