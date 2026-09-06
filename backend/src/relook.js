// The fortnightly re-look (D41).
//
// Saving is not the same as using — that is the whole complaint this product exists to
// answer, and it does not stop being true once a reel is summarised and filed. A notebook
// of two hundred videos nobody returns to is the same dead end in a tidier shape.
//
// So every so often the app offers to look back over what has been saved and not yet been
// looked at again, and hand back the few things actually worth doing. Three rules decide
// its shape, and all three come from him:
//
//   * It is OFFERED, never taken. A banner with a number on it, and a button. Nothing is
//     spent until he presses — the same rule as summarising one clip on demand and as the
//     backfill offer (D39). There is no timer, no cron, and no background call anywhere.
//   * The gap between offers is a SETTING. Two weeks by default, and he can make it a
//     week, a month, or never.
//   * Only reels that have not been in one are included, so the same twenty are not
//     handed back every fortnight.
//
// One call for the whole batch, not one per reel. Forty separate calls would be forty
// times the allowance for a worse answer: the value of a re-look is in seeing what forty
// reels have in common, which no single-reel call can see.

/** Two weeks. What he asked for, and what a person gets if they never touch the setting. */
export const DEFAULT_RELOOK_DAYS = 14;

/** The gaps the app offers. 0 is off — the honest way to say "stop asking me". */
export const RELOOK_CHOICES = [0, 7, 14, 30];

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How many reels one re-look may cover.
 *
 * A Worker request has a hard ceiling on how long it may run, and a provider has one on
 * how much text it will read. Sixty summaries is comfortably inside both. Anything past
 * that stays due and comes back in the next re-look rather than being dropped.
 */
export const MAX_RELOOK_CLIPS = 60;

/** How much of one summary is carried in. Enough to recognise the video by. */
const SUMMARY_CHARS = 400;

export const RELOOK_LIMITS = {
  theme: 600,
  themes: 12,
  action: 600,
  actions: 12,
  note: 2000
};

export const RELOOK_PROMPT = `Below is a list of short videos one person saved and has not looked at again. Each line has when it was saved, what it was called, and what it said.

You are helping them come back to what they saved. You are NOT summarising the videos again — they already have that. Look across the whole list and say what it adds up to.

Reply with ONE fenced json code block and nothing else — no preamble, no explanation.

\`\`\`json
{
  "themes": [{"name": "the subject, in the plainest words", "why": "one or two sentences on what they kept saving about it and what it adds up to"}],
  "act_now": [{"do": "one concrete thing worth doing, in plain words", "because": "one sentence on why, from what these videos said", "from": "the title of the video it came from"}],
  "note": "two or three sentences to them about this batch as a whole, or null"
}
\`\`\`

Rules:
- Between 2 and 6 themes. Group the videos by what they are actually about, not by their titles.
- Between 2 and 5 things in "act_now". Fewer is better. Each one must be something a person could start this week, not advice.
- "from" is copied from a title in the list. Never invent one, and never name a video that is not there.
- Say nothing the list does not support. If the batch is thin, say so in the note and give fewer things.
- Plain words. No jargon, no headings, no bullet characters inside the text.

THE VIDEOS:
`;

/**
 * The lines the AI is shown. Deliberately the summary and not the transcript: the point of
 * a re-look is the shape of a batch, and forty transcripts would cost twenty times as much
 * to say the same thing worse.
 */
export function relookLines(rows) {
  return rows
    .map((row) => {
      const when = new Date(Number(row.created_at || 0)).toISOString().slice(0, 10);
      const title = String(row.title || "Saved video").replace(/\s+/g, " ").slice(0, 120);
      const summary = String(row.summary || "").replace(/\s+/g, " ").slice(0, SUMMARY_CHARS);
      return `- [${when}] ${title} :: ${summary}`;
    })
    .join("\n");
}

/**
 * Checks a re-look reply the same way an analysis is checked: a list of problems, empty
 * meaning it is worth storing. Nothing is half-stored — a malformed reply is shown to the
 * person who pressed and the reels stay due, so nothing is quietly lost.
 */
export function validateRelook(payload) {
  const problems = [];

  for (const [field, cap, size] of [
    ["themes", RELOOK_LIMITS.themes, RELOOK_LIMITS.theme],
    ["act_now", RELOOK_LIMITS.actions, RELOOK_LIMITS.action]
  ]) {
    const value = payload?.[field];
    if (!Array.isArray(value)) problems.push(field);
    else if (!value.length) problems.push(`${field} is empty`);
    else if (value.length > cap) problems.push(`${field} has too many items`);
    else if (value.some((item) => JSON.stringify(item ?? "").length > size)) {
      problems.push(`${field} has an item that is too long`);
    }
  }

  const note = payload?.note;
  if (note !== null && note !== undefined) {
    if (typeof note !== "string") problems.push("note");
    else if (note.length > RELOOK_LIMITS.note) problems.push("note is too long");
  }

  return problems;
}

/**
 * Whether a re-look should be offered, and over how many reels.
 *
 * `dueCount` is every reel with a summary that has never been in one. `oldestDueAt` is
 * when the oldest of them was saved, and it is what stops the offer appearing on somebody's
 * first afternoon: a re-look is about coming back after time has passed, so nothing is
 * offered until something has actually been sitting there for the length of the gap.
 */
export function relookState({ everyDays, lastAt, dueCount, oldestDueAt, at }) {
  const days = Number.isFinite(everyDays) && everyDays !== null ? Number(everyDays) : DEFAULT_RELOOK_DAYS;
  const gap = days * DAY_MS;

  if (days <= 0) return { every_days: days, last_at: lastAt || null, due: dueCount, ready: false };

  const somethingHasWaited = Boolean(dueCount) && at - Number(oldestDueAt || at) >= gap;
  const longEnoughSinceTheLast = !lastAt || at - Number(lastAt) >= gap;

  return {
    every_days: days,
    last_at: lastAt || null,
    due: dueCount,
    ready: somethingHasWaited && longEnoughSinceTheLast
  };
}
