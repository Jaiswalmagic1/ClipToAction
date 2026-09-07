// How much one person may write in a day, and the one function that answers it.
//
// It lives here rather than in worker.js because the two writers that need it sit on
// opposite sides of the product: the app's own routes, and the connector, which is the one
// writer an AI drives in a loop. The first round that added these caps put them only on the
// app's routes — so the connector, reachable with a secret sitting in a URL in somebody's
// AI-app config, wrote 300 learnings and 30MB into the shared database in under half a
// second without being refused once, and the only thing the cap actually did was hand the
// owner a 429 on his own button for the rest of the day.
//
// D1 is ONE free database behind every notebook. The cost of an unbounded writer does not
// fall on the person doing it — it falls on everybody else's notebook, and an empty
// notebook reads exactly like lost data.

/** Far above any real day's work. These exist so one account cannot end the day for the rest. */
export const MAX_NOTES_PER_DAY = 500;
export const MAX_LEARNINGS_PER_DAY = 200;

/**
 * And the connector's own share of that, which is deliberately smaller.
 *
 * One number for both meant an AI in a loop could spend the whole day's allowance and then
 * his own "save what you learned" button answered 429 for the rest of it — the cap
 * protecting nobody and blaming him. With headroom reserved, whatever happens out there,
 * the button in front of him still works.
 */
export const MAX_LEARNINGS_PER_DAY_VIA_CONNECTOR = 150;

// A rolling twenty-four hours, not a calendar day — which is why nothing here says "try
// again tomorrow". Hitting the cap at eleven at night and being refused all next morning
// is a sentence that lies about when the allowance comes back.
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Whether this person has already written their day's worth into one table.
 *
 * `table` is never user input — the two callers pass a literal each.
 *
 * Deleted rows do not count. A note written and then deleted is not something anybody is
 * carrying, and charging him for it would mean a day of tidying up locks him out.
 */
export async function pastTheDayFor(env, table, userId, cap) {
  const written = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM ${table}
     WHERE user_id = ?1 AND created_at > ?2 AND deleted_at IS NULL`
  )
    .bind(userId, Date.now() - DAY_MS)
    .first();
  return (written?.n || 0) >= cap;
}
