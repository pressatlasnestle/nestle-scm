/**
 * The newsletter's period: an ISO week, Monday to Sunday INCLUSIVE.
 *
 * WHY THIS BUILDS ON lib/analysis/week-period RATHER THAN REIMPLEMENTING IT.
 * That module's own header says it serves "every chart, the stored narrative
 * and the newsletter that follows" — the newsletter was always meant to share
 * it. A second ISO-week implementation would be two places for the year
 * boundary to be got right, and the two would eventually disagree about which
 * week 2026-12-28 belongs to. What lives here is only what the EDITION needs on
 * top: which week it defaults to, and how a week is written out for a reader.
 *
 * BOTH ENDS ARE INCLUSIVE, and that is the whole of the boundary rule. An
 * article published on the Sunday belongs to that week; one published on the
 * Monday belongs to the next. Getting it wrong loses or double-counts an
 * article every single edition and nobody notices for months, which is why
 * check:newsletter asserts both directions rather than one.
 *
 * A ROLLING 7 DAYS IS NOT AN ISO WEEK. `published_at > now() - interval '7
 * days'` produces a different set every hour and silently disagrees with the
 * date range the edition prints on itself. published_at is a `date` column, so
 * the window is a plain inclusive range between the Monday and the Sunday — no
 * now(), no timezone arithmetic. See loadEdition().
 */

import {
  parseIsoDate,
  weekContaining,
  weekContainingDate,
  type Week,
} from "@/lib/analysis/week-period";

export type { Week };

const DAY_MS = 86_400_000;

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
] as const;

const SHORT_NAMES = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
] as const;

/**
 * The week `count` weeks before `week` (negative moves forward).
 *
 * Routed back through weekContaining() rather than adding 7 days to the start
 * string, so the ISO year and week number are recomputed rather than carried —
 * they do not simply decrement across a year boundary.
 */
export function shiftWeek(week: Week, count: number): Week {
  const start = new Date(`${week.start}T00:00:00Z`);
  return weekContaining(new Date(start.getTime() - count * 7 * DAY_MS));
}

/** The week immediately before this one. What every delta compares against. */
export function previousWeek(week: Week): Week {
  return shiftWeek(week, 1);
}

/**
 * The most recently COMPLETED ISO week.
 *
 * On Monday 17 August this is 10–16 August. That is the Monday-digest cadence:
 * you compose on Monday for the week that has just closed. It holds on every
 * other day too — on Sunday 16 August the week 10–16 is still running, so the
 * last closed week is 3–9, which is what this returns.
 */
export function lastCompletedWeek(now: Date = new Date()): Week {
  return previousWeek(weekContaining(now));
}

/**
 * Whether `week` is the one currently running.
 *
 * The running week is offered in the selector on purpose — it is often the week
 * someone actually wants, and while the corpus is young it is the only one with
 * much in it. But anything COUNTED across a running week (article volume, items
 * per theme) is five days measured against a completed week's seven, so
 * everywhere a count is shown it has to say "so far". Operational figures are
 * unaffected: they are the most recently entered day, a level rather than a
 * total, and a level is complete whenever it was read.
 */
export function isRunningWeek(week: Week, now: Date = new Date()): boolean {
  return weekContaining(now).start === week.start;
}

/**
 * Resolves the `week` URL parameter to a concrete edition week.
 *
 * A parameter naming any day is snapped to that day's week rather than
 * rejected — the composer only ever writes Mondays, so a non-Monday value means
 * a hand-edited URL or a link built from a published_at, and "the week
 * containing that day" is unambiguously what was meant. Anything unparseable
 * falls back to the last completed week, not the current one: an edition
 * reports on a week that has finished, so landing on a two-day-old in-progress
 * week would be landing on the wrong edition every Monday.
 */
export function resolveEditionWeek(
  param: string | undefined | null,
  now: Date = new Date()
): Week {
  const parsed = parseIsoDate(param);
  return parsed ? weekContainingDate(parsed) : lastCompletedWeek(now);
}

/**
 * The `count` weeks up to and including the default one, newest first.
 *
 * Starts at the last completed week for the same reason resolveEditionWeek
 * does. The in-progress week is deliberately not offered: it is not an edition
 * anybody would send, and offering it invites composing against a week that
 * will still be gaining articles after the draft is written.
 */
export function recentEditionWeeks(now: Date = new Date(), count = 12): Week[] {
  const latest = lastCompletedWeek(now);
  return Array.from({ length: count }, (_, i) => shiftWeek(latest, i));
}

/**
 * What the selector offers: the RUNNING week, then the completed ones.
 *
 * The running week is listed because it is frequently the one wanted — as of
 * writing, the completed week before it holds 10 coded articles against 96 in
 * the running one. It is labelled "in progress" and its count "so far" so that
 * choosing it is a deliberate act rather than a surprise.
 *
 * It is NOT the default. The product is a Monday digest for the week that just
 * closed, and a default that means something different depending on which day
 * you open the page is exactly the kind of surprise this team should not have
 * to reason about.
 */
export function editionWeekChoices(now: Date = new Date(), count = 12): Week[] {
  return [weekContaining(now), ...recentEditionWeeks(now, count)];
}

// ---------------------------------------------------------------------------
// Labels
//
// A reader forwarding the email six weeks later should not have to open it to
// know which week it covers, so the range goes in the subject, the header and
// the source line. These are deliberately NOT week.label from week-period,
// which reads "Aug 10 – Aug 16, 2026" — fine on a dropdown, long and
// month-repeating in a subject line.
// ---------------------------------------------------------------------------

/**
 * "10–16 Aug 2026", "28 Sep – 4 Oct 2026", "28 Dec 2026 – 3 Jan 2027".
 *
 * The month is stated once when both ends share it and twice when they do not;
 * the year likewise. A single trailing year on a week straddling New Year would
 * attach to the wrong end, which is the one case where the compact form is not
 * merely terse but wrong.
 *
 * The separator tightens to an unspaced en dash only in the compact case, where
 * "10–16" reads as one range token. Spaced elsewhere, so "28 Sep – 4 Oct" does
 * not read as a single date.
 */
export function weekRangeLabel(week: Week): string {
  const [sy, sm, sd] = splitIso(week.start);
  const [ey, em, ed] = splitIso(week.end);

  if (sy !== ey) {
    return `${sd} ${SHORT_NAMES[sm]} ${sy} – ${ed} ${SHORT_NAMES[em]} ${ey}`;
  }
  if (sm !== em) {
    return `${sd} ${SHORT_NAMES[sm]} – ${ed} ${SHORT_NAMES[em]} ${ey}`;
  }
  return `${sd}–${ed} ${SHORT_NAMES[sm]} ${sy}`;
}

/** "10–16 Aug" — the same range without the year, for cramped cells. */
export function weekRangeShort(week: Week): string {
  const [sy, sm, sd] = splitIso(week.start);
  const [ey, em, ed] = splitIso(week.end);

  if (sy !== ey) return `${sd} ${SHORT_NAMES[sm]} – ${ed} ${SHORT_NAMES[em]}`;
  if (sm !== em) return `${sd} ${SHORT_NAMES[sm]} – ${ed} ${SHORT_NAMES[em]}`;
  return `${sd}–${ed} ${SHORT_NAMES[sm]}`;
}

/** "14 Aug" — how a stock figure's reading date is labelled. */
export function dayLabel(isoDate: string): string {
  const [, month, day] = splitIso(isoDate);
  return `${day} ${SHORT_NAMES[month]}`;
}

/** "14 August 2026" — the long form, for a sent-on date. */
export function fullDayLabel(isoDate: string): string {
  const [year, month, day] = splitIso(isoDate);
  return `${day} ${MONTH_NAMES[month]} ${year}`;
}

/** "August 2026" — for the genuinely monthly figures, which stay monthly. */
export function monthLabel(isoMonthStart: string): string {
  const [year, month] = splitIso(isoMonthStart);
  return `${MONTH_NAMES[month]} ${year}`;
}

/**
 * [year, monthIndex, day] from YYYY-MM-DD.
 *
 * String surgery rather than Date accessors: the input is already a UTC
 * calendar date, and constructing a Date only creates an opportunity for a
 * local-timezone shift to move it a day.
 */
function splitIso(isoDate: string): [number, number, number] {
  return [
    Number(isoDate.slice(0, 4)),
    Number(isoDate.slice(5, 7)) - 1,
    Number(isoDate.slice(8, 10)),
  ];
}
