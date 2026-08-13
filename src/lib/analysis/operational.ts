/**
 * Manually-entered operational market data.
 *
 * Everything else the Analysis panel shows is derived from the article corpus.
 * These three series are transcribed by hand from Linerlytica and
 * Sea-Intelligence reports, which changes two things about how they behave:
 *
 *   * They are ABSENT, not zero, when nobody has typed them in. A congestion
 *     chart showing 0 TEU waiting because the analyst has not filled the form
 *     yet would be a false statement about the market, so the card is not
 *     rendered at all.
 *   * Their grain does not match the panel. Congestion and waiting time are
 *     weekly and line up with the week selector; schedule reliability is
 *     monthly, because that is how Sea-Intelligence publishes it.
 *
 * The shapes below describe what is stored. The jsonb breakdowns are read
 * defensively — they are hand-entered, so a key that is missing, null or a
 * string has to degrade to "no bar" rather than to NaN on an axis.
 */

import type { Json } from "@/types/database.types";

// ---------------------------------------------------------------------------
// Regions, ports and alliances
// ---------------------------------------------------------------------------

/**
 * The regions the congestion form offers, in the order Linerlytica prints
 * them. A fixed list drives the form; the STORED jsonb is not restricted to
 * it, so a row entered before this list changes still reads back whatever it
 * holds.
 */
export const CONGESTION_REGIONS = [
  { key: "europe", label: "Europe" },
  { key: "north_america", label: "North America" },
  { key: "north_asia", label: "North Asia" },
  { key: "southeast_asia", label: "Southeast Asia" },
  { key: "south_america", label: "South America" },
] as const;

export type CongestionRegionKey = (typeof CONGESTION_REGIONS)[number]["key"];

/**
 * Port clusters on the waiting-time watchlist. Grouped exactly as Linerlytica
 * groups them — "Antwerp-Rotterdam" is one row in their table, not two ports —
 * so a transcription is a copy rather than a reinterpretation.
 */
export const WAITING_TIME_PORTS = [
  "Antwerp-Rotterdam",
  "Shanghai-Ningbo",
  "Singapore-Port Klang",
  "Los Angeles-Long Beach",
  "New York-Savannah",
  "Jebel Ali-Jeddah",
] as const;

/**
 * Alliances the reliability form offers.
 *
 * 2M is listed even though it has dissolved into Gemini: the monthly series is
 * historical, and a February entry legitimately has a 2M figure. Dropping it
 * from the form would make old months un-editable.
 */
export const RELIABILITY_ALLIANCES = [
  "Gemini Cooperation",
  "Ocean Alliance",
  "Premier Alliance",
  "MSC standalone",
  "2M",
] as const;

// ---------------------------------------------------------------------------
// Stored shapes
// ---------------------------------------------------------------------------

export type CongestionRow = {
  week_of: string;
  global_teu_waiting: number | null;
  global_pct_fleet: number | null;
  region_data: Json | null;
  entered_at: string;
  entered_by: string | null;
};

export type WaitingTimeRow = {
  week_of: string;
  port_data: Json | null;
  entered_at: string;
  entered_by: string | null;
};

export type ScheduleReliabilityRow = {
  month_of: string;
  glp_issue_number: number | null;
  global_reliability_pct: number | null;
  avg_delay_days: number | null;
  alliance_data: Json | null;
  entered_at: string;
  entered_by: string | null;
};

// ---------------------------------------------------------------------------
// Reading hand-entered jsonb
// ---------------------------------------------------------------------------

/**
 * A number from a hand-entered jsonb value, or null.
 *
 * Accepts a numeric string as well as a number, because a form posts strings
 * and an older row may have stored one. Rejects NaN, Infinity and blank
 * strings, all of which would otherwise reach a chart axis and break it
 * silently — a bar of height NaN renders as nothing, which is
 * indistinguishable from a genuine zero.
 */
export function readNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** A jsonb object as a plain record, or an empty one. */
export function readObject(value: Json | null): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

export type NamedValue = { name: string; value: number };

/**
 * Turns a hand-entered jsonb map into chart rows.
 *
 * `order` fixes the sequence so bars do not reshuffle between renders as key
 * insertion order changes. Keys present in the data but absent from `order`
 * are appended rather than dropped — a row entered when the watchlist was
 * different still shows everything it holds, which is the point of storing a
 * blob rather than columns.
 *
 * Entries that are not readable numbers are omitted entirely. A port with no
 * figure this week has no bar; it does not have a zero-height one.
 */
export function namedValues(
  data: Json | null,
  order: readonly string[]
): NamedValue[] {
  const record = readObject(data);
  const seen = new Set<string>();
  const out: NamedValue[] = [];

  for (const name of order) {
    const value = readNumber(record[name]);
    seen.add(name);
    if (value !== null) out.push({ name, value });
  }
  for (const [name, raw] of Object.entries(record)) {
    if (seen.has(name)) continue;
    const value = readNumber(raw);
    if (value !== null) out.push({ name, value });
  }

  return out;
}

/** Region breakdown, using the form's labels rather than its storage keys. */
export function congestionRegions(data: Json | null): NamedValue[] {
  const record = readObject(data);
  const out: NamedValue[] = [];
  const seen = new Set<string>();

  for (const region of CONGESTION_REGIONS) {
    seen.add(region.key);
    const value = readNumber(record[region.key]);
    if (value !== null) out.push({ name: region.label, value });
  }
  // Anything stored under a key this build does not know about is still shown,
  // under its raw key, rather than silently dropped.
  for (const [key, raw] of Object.entries(record)) {
    if (seen.has(key)) continue;
    const value = readNumber(raw);
    if (value !== null) out.push({ name: key, value });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Months
// ---------------------------------------------------------------------------

/**
 * First day of the month containing `isoDate`, as YYYY-MM-DD.
 *
 * String surgery rather than Date arithmetic, deliberately: the input is
 * already a UTC calendar date and constructing a Date from it only creates an
 * opportunity for a local-timezone shift to move it into the previous month.
 * The same reasoning as week-period.ts.
 */
export function monthOf(isoDate: string): string {
  return `${isoDate.slice(0, 7)}-01`;
}

/** "March 2026" — how a monthly entry is labelled against a weekly panel. */
export function formatMonth(monthIso: string): string {
  const [year, month] = monthIso.split("-");
  const names = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];
  const index = Number(month) - 1;
  return `${names[index] ?? month} ${year}`;
}

/**
 * Whether a carried-forward reliability entry is from a month other than the
 * one the selected week sits in.
 *
 * Drives the "carried forward from …" note. Reliability is published monthly
 * and always in arrears, so a reader looking at an August week is normally
 * seeing July's figures — that is expected, not a fault, but it must be said
 * on the card rather than left to be inferred.
 */
export function isCarriedForward(
  entryMonth: string,
  selectedWeekStart: string
): boolean {
  return entryMonth !== monthOf(selectedWeekStart);
}
