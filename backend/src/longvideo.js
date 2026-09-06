// What a long video actually costs, and the numbers the warning is built out of (D42).
//
// The rule he set: past a certain length, nothing is downloaded until he has been told in
// plain words what it will cost and has said yes. Not a generic "are you sure" — the
// actual length, the actual time his PC will be tied up, that everything he shares in the
// meantime waits behind it, and that it can spend a whole day of an AI key.
//
// And the other half of the rule, which is easy to lose: **a "no" parks the video, it does
// not fail it.** He can come back and approve it a month later.

/**
 * Past this, he is asked first.
 *
 * The number that matters is the one it must stay ABOVE. The long videos he saves all the
 * time are 11 to 18 minutes, and being asked about those would make the warning furniture
 * — the first thing anybody does with a dialog that always appears is stop reading it. So
 * thirty minutes: comfortably clear of everything routine, and the point at which his PC
 * is tied up for a quarter of an hour or more and the text is getting genuinely expensive
 * to analyse.
 *
 * Under it, nothing changes at all. An 18-minute video is downloaded exactly as it is
 * today, gets the long prompt and its chapters (D33), and he is not asked anything.
 */
export const WARN_ABOVE_SEC = 30 * 60;

/**
 * The hard ceiling, with permission. Six hours, up from three (D33).
 *
 * It is still a ceiling and not a removal. Two things bound it, and both are real: his PC
 * is single-file, so six hours of video is most of an afternoon with everything queued
 * behind it; and the transcript has to fit in the column that holds it and in one prompt.
 * Six hours of speech is about 330,000 characters, which fits both with room to spare.
 */
export const MAX_VIDEO_SEC = 6 * 60 * 60;

/**
 * How much a transcript may be. Raised from 200,000 with the ceiling above.
 *
 * 200,000 is about four and a half hours of speech, so a six-hour video would have been
 * refused at the last step, after the machine had already spent three hours on it. That is
 * the failure this number exists to prevent — the guard belongs before the work, not after.
 */
export const MAX_TRANSCRIPT_CHARS = 400_000;

/**
 * Characters of transcript per second of speech.
 *
 * 150 words a minute at about six characters a word is 15 a second. It is an estimate and
 * is only ever used to say roughly how big something will be, never to accept or refuse
 * anything — the real transcript is measured when it exists.
 */
export const CHARS_PER_SEC = 15;

/** A normal reel, for "how many reels is this worth". His are around this length. */
const REEL_SEC = 45;

/**
 * The fraction of the ceiling at which he is warned about it.
 *
 * Seventy per cent and not ninety, because the estimate above is an AVERAGE speaker. A
 * fast one produces half as much again, and the point of saying this before the work is
 * that being refused after three hours of it is the failure worth avoiding. At 70% a
 * six-hour video warns and a four-hour one does not.
 */
export const NEAR_CEILING_FRACTION = 0.7;

/**
 * How long the PC takes, as a fraction of the video.
 *
 * From the one measurement there is: a 29-second reel took 16 seconds on the `small` model
 * on his machine (D28). That is a shade over half, and most of it on a clip that short is
 * start-up, so a long video is very likely faster per minute than this. Deliberately not
 * corrected for that: a warning that under-promises and then finishes early is a good
 * warning, and one that says "twenty minutes" and takes an hour is not.
 */
const PC_TIME_FACTOR = 0.6;

/** Whether this length has to be asked about before anything is downloaded. */
export function needsPermission(durationSec) {
  return Number(durationSec || 0) > WARN_ABOVE_SEC;
}

/** Whether this length is past the ceiling, permission or not. */
export function tooLongForAnyone(durationSec) {
  return Number(durationSec || 0) > MAX_VIDEO_SEC;
}

/**
 * The figures the warning is written from. Everything here is an estimate from the length
 * alone, because the length is all that is known before anything is downloaded.
 *
 * `near_ceiling` is the fourth thing he asked the warning to say: that this one's words
 * may come close to as much as the notebook will hold for a single video.
 */
export function whatItCosts(durationSec) {
  const seconds = Math.max(Number(durationSec || 0), 0);
  const characters = Math.round(seconds * CHARS_PER_SEC);

  return {
    seconds,
    minutes: Math.round(seconds / 60),
    pc_minutes: Math.max(Math.round((seconds * PC_TIME_FACTOR) / 60), 1),
    times_a_reel: Math.max(Math.round(seconds / REEL_SEC), 1),
    characters,
    // Said before the work rather than discovered after it.
    near_ceiling: characters > MAX_TRANSCRIPT_CHARS * NEAR_CEILING_FRACTION,
    over_ceiling: characters > MAX_TRANSCRIPT_CHARS
  };
}
