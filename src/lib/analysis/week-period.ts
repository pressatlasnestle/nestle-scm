/**
 * The Analysis panel's week selector.
 *
 * Deliberately NOT merged with src/lib/articles/period.ts. That resolver serves
 * the Articles panel, where an analyst is browsing a corpus and wants
 * "last 30 days" or a custom range. This one serves a weekly report, where the
 * unit of analysis is a *week* and nothing else: every chart, the stored
 * narrative and the newsletter that follows are all "week of X". A resolver
 * that could also produce "last 30 days" would let a report be generated for a
 * period the report format cannot describe.
 *
 * Weeks are ISO-8601: Monday 00:00 through Sunday 23:59, and the ISO year of a
 * week is the year containing its Thursday. That last rule is why 2026-12-28
 * (a Monday) belongs to ISO week 2026-W53 while 2027-01-01 falls inside it too
 * — the week spans two calendar years and belongs to exactly one ISO year.
 *
 * Everything here is UTC, same discipline as the Articles resolver and for the
 * same reason: articles.published_at is a `date`, a Vercel deploy runs UTC and
 * a developer's laptop does not, and "week of Aug 10" must not shift by a day
 * depending on who is looking. Every date is handled as YYYY-MM-DD text or as a
 * Date read exclusively through its UTC accessors — a single getDay() or
 * getFullYear() in this file would reintroduce the local zone.
 */

/** Inclusive bounds as YYYY-MM-DD. A week is always bounded on both sides. */
export type WeekRange = { from: string; to: string };

export type Week = {
  /** Monday, YYYY-MM-DD. The canonical identity of a week everywhere else. */
  start: string;
  /** Sunday, YYYY-MM-DD. */
  end: string;
  /** ISO year — the year of the week's Thursday, not of its Monday. */
  isoYear: number;
  /** ISO week number, 1-53. */
  isoWeek: number;
  /** "Aug 4 – Aug 10, 2026" — what the dropdown shows. */
  label: string;
  /** "2026-W33" — compact, for CSV filenames and log lines. */
  isoLabel: string;
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
] as const;

function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** A UTC-midnight Date from YYYY-MM-DD. */
function fromIsoDate(value: string): Date {
  return new Date(`${value}T00:00:00Z`);
}

function addDaysUtc(d: Date, days: number): Date {
  return new Date(d.getTime() + days * DAY_MS);
}

/**
 * Null unless the value is a well-formed YYYY-MM-DD that is also a real date.
 * Mirrors parseIsoDate() in the Articles resolver — duplicated rather than
 * imported so the two panels' date handling can never be coupled by accident,
 * which is the whole reason these files are separate.
 */
export function parseIsoDate(value: string | undefined | null): string | null {
  if (!value || !ISO_DATE.test(value)) return null;
  const parsed = fromIsoDate(value);
  if (Number.isNaN(parsed.getTime())) return null;
  // Rejects 2026-02-31, which Date would silently roll into March.
  return toIsoDate(parsed) === value ? value : null;
}

/** Monday of the week containing `d`, at UTC midnight. */
function startOfIsoWeek(d: Date): Date {
  const utcMidnight = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
  );
  // getUTCDay() is Sunday-first (0..6); shift so Monday is 0.
  const dayIndex = (utcMidnight.getUTCDay() + 6) % 7;
  return addDaysUtc(utcMidnight, -dayIndex);
}

/**
 * ISO year and week number.
 *
 * Both are derived from the week's THURSDAY, which is the definition: the ISO
 * year of a week is whichever calendar year contains its Thursday, and week 1
 * is the week whose Thursday falls in January. Working from the Thursday rather
 * than from the Monday is what makes the December/January weeks come out right
 * without any special-casing.
 */
function isoWeekParts(monday: Date): { isoYear: number; isoWeek: number } {
  const thursday = addDaysUtc(monday, 3);
  const isoYear = thursday.getUTCFullYear();

  // Jan 4 is always in ISO week 1, so the Monday of its week is week 1's start.
  const jan4 = new Date(Date.UTC(isoYear, 0, 4));
  const week1Monday = startOfIsoWeek(jan4);

  const isoWeek =
    1 + Math.round((monday.getTime() - week1Monday.getTime()) / (7 * DAY_MS));

  return { isoYear, isoWeek };
}

/**
 * "Aug 4 – Aug 10, 2026", or "Dec 28, 2026 – Jan 3, 2027" when the week spans
 * two calendar years.
 *
 * The year is stated once at the end for the common case and twice when the
 * week straddles a year boundary — a single trailing year on a cross-year week
 * would be actively wrong, because it would attach to the wrong end.
 */
function formatWeekLabel(start: Date, end: Date): string {
  const sM = MONTHS[start.getUTCMonth()];
  const eM = MONTHS[end.getUTCMonth()];
  const sD = start.getUTCDate();
  const eD = end.getUTCDate();
  const sY = start.getUTCFullYear();
  const eY = end.getUTCFullYear();

  if (sY !== eY) return `${sM} ${sD}, ${sY} – ${eM} ${eD}, ${eY}`;
  return `${sM} ${sD} – ${eM} ${eD}, ${eY}`;
}

/** The ISO week containing `date`. */
export function weekContaining(date: Date): Week {
  const start = startOfIsoWeek(date);
  const end = addDaysUtc(start, 6);
  const { isoYear, isoWeek } = isoWeekParts(start);

  return {
    start: toIsoDate(start),
    end: toIsoDate(end),
    isoYear,
    isoWeek,
    label: formatWeekLabel(start, end),
    isoLabel: `${isoYear}-W${String(isoWeek).padStart(2, "0")}`,
  };
}

/** The ISO week containing the given YYYY-MM-DD. */
export function weekContainingDate(isoDate: string): Week {
  return weekContaining(fromIsoDate(isoDate));
}

/**
 * Resolves the `week` URL parameter to a concrete week.
 *
 * A parameter naming any day is snapped to that day's week rather than
 * rejected. The panel only ever writes Mondays, so a non-Monday value means
 * someone hand-edited the URL or followed a link built from a published_at —
 * and "the week containing that day" is unambiguously what they meant.
 * Anything unparseable falls back to the current week, which is what an
 * analyst opening the panel with no parameter gets.
 */
export function resolveWeek(
  param: string | undefined | null,
  now: Date = new Date()
): Week {
  const parsed = parseIsoDate(param);
  return parsed ? weekContainingDate(parsed) : weekContaining(now);
}

/**
 * The most recent `count` weeks, newest first, starting with the week
 * containing `now`.
 *
 * The current (in-progress) week is included on purpose: an analyst checking
 * mid-week on how coverage is running is a normal use, and excluding it would
 * make the panel show stale data by default every Monday.
 */
export function recentWeeks(now: Date = new Date(), count = 12): Week[] {
  const current = startOfIsoWeek(now);
  return Array.from({ length: count }, (_, i) =>
    weekContaining(addDaysUtc(current, -7 * i))
  );
}

/** Inclusive published_at bounds for a week. */
export function weekRange(week: Week): WeekRange {
  return { from: week.start, to: week.end };
}

/**
 * Applies a week to a PostgREST query builder.
 *
 * Rows with a null published_at are excluded, for the same reason the Articles
 * resolver excludes them: a story whose date is unknown cannot be shown to fall
 * inside a given week, and letting it appear in every week would put it in
 * every weekly report. A week is always bounded, so unlike applyRange() there
 * is no unbounded case where this rule could be skipped.
 */
export function applyWeek<T extends {
  gte: (col: string, v: string) => T;
  lte: (col: string, v: string) => T;
  not: (col: string, op: string, v: null) => T;
}>(query: T, week: Week): T {
  return query
    .not("published_at", "is", null)
    .gte("published_at", week.start)
    .lte("published_at", week.end);
}

/** The seven YYYY-MM-DD days of a week, Monday first. Drives the volume chart. */
export function weekDays(week: Week): string[] {
  const start = fromIsoDate(week.start);
  return Array.from({ length: 7 }, (_, i) => toIsoDate(addDaysUtc(start, i)));
}

/** "Mon 10" — the x-axis tick for a day in the volume chart. */
export function dayTick(isoDate: string): string {
  const d = fromIsoDate(isoDate);
  const names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return `${names[d.getUTCDay()]} ${d.getUTCDate()}`;
}
