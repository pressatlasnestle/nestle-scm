/**
 * The newsletter's period: a calendar month.
 *
 * Deliberately NOT merged with lib/analysis/week-period.ts, for the same reason
 * that file is not merged with lib/articles/period.ts. The Analysis panel's
 * unit of analysis is an ISO week and every chart, narrative and export on it is
 * "week of X". The newsletter's unit is a calendar month and always was — the
 * eleven prior editions were monthly. A resolver that could produce either would
 * let an edition be composed for a period the edition format cannot describe.
 *
 * Everything here is UTC and handled as YYYY-MM-DD text or through UTC
 * accessors only, same discipline and same reason: published_at is a `date`,
 * Vercel runs UTC and a laptop does not, and "September" must not become
 * "August" for whoever is looking at it from the wrong side of midnight.
 */

/** Inclusive bounds as YYYY-MM-DD. A month is always bounded on both sides. */
export type Month = {
  /** First of the month, YYYY-MM-01. The canonical identity of an edition. */
  start: string;
  /** Last day of the month, YYYY-MM-DD. */
  end: string;
  /** "September 2026" — the subject line and every heading. */
  label: string;
  /** "Sep 2026" — where the full name does not fit. */
  shortLabel: string;
  /** "2026-09" — compact, for filenames and log lines. */
  isoLabel: string;
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_MONTH = /^\d{4}-\d{2}$/;

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
] as const;

const SHORT_NAMES = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
] as const;

/**
 * Null unless the value is a well-formed YYYY-MM-DD naming a real date, or a
 * bare YYYY-MM. Both forms appear: the composer writes YYYY-MM-01, and a deep
 * link built by hand is more likely to carry the month alone.
 */
export function parseMonthParam(value: string | undefined | null): string | null {
  if (!value) return null;
  if (ISO_MONTH.test(value)) {
    const month = Number(value.slice(5, 7));
    return month >= 1 && month <= 12 ? `${value}-01` : null;
  }
  if (!ISO_DATE.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  // Rejects 2026-02-31, which Date would silently roll into March.
  if (parsed.toISOString().slice(0, 10) !== value) return null;
  return `${value.slice(0, 7)}-01`;
}

/** The month containing a YYYY-MM-DD, or a YYYY-MM-01 as given. */
export function monthFromIso(isoMonthStart: string): Month {
  const year = Number(isoMonthStart.slice(0, 4));
  const index = Number(isoMonthStart.slice(5, 7)) - 1;

  // Day 0 of the NEXT month is the last day of this one — the only way to get
  // February right without a leap-year rule of our own.
  const end = new Date(Date.UTC(year, index + 1, 0)).toISOString().slice(0, 10);

  return {
    start: `${isoMonthStart.slice(0, 7)}-01`,
    end,
    label: `${MONTH_NAMES[index]} ${year}`,
    shortLabel: `${SHORT_NAMES[index]} ${year}`,
    isoLabel: isoMonthStart.slice(0, 7),
  };
}

/** The month containing `date`. */
export function monthContaining(date: Date): Month {
  return monthFromIso(
    `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-01`
  );
}

/** The month `count` months before `month` (negative moves forward). */
export function shiftMonth(month: Month, count: number): Month {
  const year = Number(month.start.slice(0, 4));
  const index = Number(month.start.slice(5, 7)) - 1 - count;
  const shifted = new Date(Date.UTC(year, index, 1));
  return monthContaining(shifted);
}

/** The month immediately before this one. What every delta compares against. */
export function previousMonth(month: Month): Month {
  return shiftMonth(month, 1);
}

/**
 * Resolves the `month` URL parameter.
 *
 * An unparseable or absent parameter falls back to the month BEFORE the current
 * one, not to the current month. An edition is written in arrears — it reports
 * on a month that has finished — so opening the composer on 3 October and
 * landing on a two-day-old October is landing on the wrong edition every time.
 */
export function resolveMonth(
  param: string | undefined | null,
  now: Date = new Date()
): Month {
  const parsed = parseMonthParam(param);
  return parsed ? monthFromIso(parsed) : previousMonth(monthContaining(now));
}

/**
 * The `count` months up to and including the default month, newest first.
 *
 * Starts at the previous month for the same reason resolveMonth does: the
 * in-progress month is not an edition anybody would send.
 */
export function recentMonths(now: Date = new Date(), count = 12): Month[] {
  const latest = previousMonth(monthContaining(now));
  return Array.from({ length: count }, (_, i) => shiftMonth(latest, i));
}

/** "14 Sep" — how a stock figure's reading date is labelled. */
export function dayLabel(isoDate: string): string {
  const day = Number(isoDate.slice(8, 10));
  const index = Number(isoDate.slice(5, 7)) - 1;
  return `${day} ${SHORT_NAMES[index]}`;
}

/** "14 September 2026" — the long form, for the source line. */
export function fullDayLabel(isoDate: string): string {
  const day = Number(isoDate.slice(8, 10));
  const index = Number(isoDate.slice(5, 7)) - 1;
  return `${day} ${MONTH_NAMES[index]} ${isoDate.slice(0, 4)}`;
}
