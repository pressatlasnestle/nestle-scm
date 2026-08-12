/**
 * The Articles panel's date-range filter.
 *
 * Lives outside the panel because two callers must agree on it exactly: the
 * page query that shows the analyst what they are about to review, and the
 * Phase 3 coding action that runs Gemini over "the articles in this date
 * range". If those two resolved a period differently, the confirm modal would
 * quote a count the batch did not actually process.
 *
 * Ranges are resolved in UTC. articles.published_at is a `date`, not a
 * timestamp, and the server's local zone is not something to depend on — a
 * Vercel deploy runs UTC while a developer's machine does not, and "last 7
 * days" must not mean different things in the two places.
 */

export type PeriodKey = "all" | "today" | "7d" | "30d" | "month" | "custom";

export const PERIOD_KEYS: readonly PeriodKey[] = [
  "all",
  "today",
  "7d",
  "30d",
  "month",
  "custom",
];

export const PERIOD_LABEL: Record<PeriodKey, string> = {
  all: "All time",
  today: "Today",
  "7d": "Last 7 days",
  "30d": "Last 30 days",
  month: "This month",
  custom: "Custom range",
};

/** Inclusive bounds as YYYY-MM-DD, or null for unbounded. */
export type DateRange = { from: string | null; to: string | null };

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDaysUtc(d: Date, days: number): Date {
  const next = new Date(d);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

/** Null unless the value is a well-formed YYYY-MM-DD that is also a real date. */
export function parseIsoDate(value: string | undefined | null): string | null {
  if (!value || !ISO_DATE.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  // Rejects 2026-02-31, which Date would silently roll into March.
  return toIsoDate(parsed) === value ? value : null;
}

export function parsePeriodKey(value: string | undefined | null): PeriodKey {
  return (PERIOD_KEYS as readonly string[]).includes(value ?? "")
    ? (value as PeriodKey)
    : "all";
}

/**
 * Resolves a period selection to concrete inclusive bounds.
 *
 * `now` is injectable so the resolution is testable without freezing the
 * clock, and so a caller that already has a run timestamp can pass it.
 *
 * A 'custom' period with neither bound supplied resolves to unbounded rather
 * than to an error — a half-filled custom range is a normal intermediate state
 * while the analyst is still typing, and it should show everything, not
 * nothing.
 */
export function resolvePeriod(
  period: PeriodKey,
  custom: { from?: string | null; to?: string | null } = {},
  now: Date = new Date()
): DateRange {
  const today = toIsoDate(now);

  switch (period) {
    case "today":
      return { from: today, to: today };
    case "7d":
      // Inclusive of today, so "last 7 days" spans 7 calendar days, not 8.
      return { from: toIsoDate(addDaysUtc(now, -6)), to: today };
    case "30d":
      return { from: toIsoDate(addDaysUtc(now, -29)), to: today };
    case "month":
      return { from: `${today.slice(0, 7)}-01`, to: today };
    case "custom": {
      const from = parseIsoDate(custom.from);
      const to = parseIsoDate(custom.to);
      // Swap rather than return an empty set if the analyst enters them
      // backwards — the intent is unambiguous.
      if (from && to && from > to) return { from: to, to: from };
      return { from, to };
    }
    case "all":
    default:
      return { from: null, to: null };
  }
}

/** True when the range actually constrains anything. */
export function isBounded(range: DateRange): boolean {
  return range.from !== null || range.to !== null;
}

/** Human-readable range, for confirm copy and the filter summary. */
export function describeRange(period: PeriodKey, range: DateRange): string {
  if (!isBounded(range)) return "all time";
  if (period !== "custom") return PERIOD_LABEL[period].toLowerCase();
  if (range.from && range.to) return `${range.from} to ${range.to}`;
  if (range.from) return `from ${range.from}`;
  return `up to ${range.to}`;
}

/**
 * Applies the range to a PostgREST query builder.
 *
 * Rows with a null published_at are excluded whenever the range is bounded.
 * A story whose date is unknown cannot be shown to fall inside a window, and
 * the alternative — letting it appear in every window — would put it in every
 * coding batch too. Nothing in the corpus has a null published_at today; this
 * is here so a future feed that omits dates fails visibly rather than quietly
 * inflating every period.
 */
export function applyRange<T extends {
  gte: (col: string, v: string) => T;
  lte: (col: string, v: string) => T;
  not: (col: string, op: string, v: null) => T;
}>(query: T, range: DateRange): T {
  if (!isBounded(range)) return query;
  let next = query.not("published_at", "is", null);
  if (range.from) next = next.gte("published_at", range.from);
  if (range.to) next = next.lte("published_at", range.to);
  return next;
}
