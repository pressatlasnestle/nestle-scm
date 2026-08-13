/**
 * Manually-entered operational market data.
 *
 * Everything else the Analysis panel shows is derived from the article corpus.
 * These series are transcribed by hand from Linerlytica and Sea-Intelligence,
 * which changes two things about how they behave:
 *
 *   * They are ABSENT, not zero, when nobody has typed them in. A congestion
 *     chart reading 0 TEU because the form has not been filled would be a
 *     false statement about the market, so nothing is rendered for that day.
 *   * Their grain does not match the panel. Congestion, fleet status and port
 *     congestion are DAILY and a week is a 7-day range; schedule reliability
 *     is monthly, because that is how Sea-Intelligence publishes it.
 *
 * The jsonb breakdowns are read defensively throughout — they are hand-entered,
 * so a key that is missing, null, blank or a string has to degrade to "no bar"
 * rather than to NaN on an axis. A NaN bar renders as nothing, which is
 * indistinguishable from a real zero.
 */

import type { Json } from "@/types/database.types";

// ---------------------------------------------------------------------------
// Vocabularies
// ---------------------------------------------------------------------------

/**
 * Congestion regions, in the order Linerlytica prints them. A fixed list drives
 * the form; the STORED jsonb is not restricted to it, so a row written under an
 * older list still reads back everything it holds.
 */
export const CONGESTION_REGIONS = [
  { key: "europe", label: "Europe" },
  { key: "north_america", label: "North America" },
  { key: "north_asia", label: "North Asia" },
  { key: "southeast_asia", label: "Southeast Asia" },
  { key: "south_america", label: "South America" },
] as const;

/**
 * Fleet statuses.
 *
 * THESE OVERLAP. "Ships at port" and "Ships at anchorage" are both subsets of
 * "Active Ships" — on the reference figures 1,165 and 1,180 against 5,426,
 * summing to 2,345 — so they must never be stacked, totalled, or drawn as a
 * 100% bar. Each of those would state something false about the fleet.
 * Ordered as Linerlytica prints them.
 */
export const FLEET_STATUSES = [
  "Ships at port",
  "Active Ships",
  "Inactive Ships",
  "Ships at anchorage",
  "Ships in shipyard",
] as const;

export type FleetStatus = (typeof FLEET_STATUSES)[number];

/** The five transcribed per-port metrics, in entry order. */
export const PORT_METRICS = [
  { key: "ships_anchorage", label: "Ships at anchorage", unit: "" },
  { key: "ships_port", label: "Ships at port", unit: "" },
  { key: "teu_anchorage", label: "TEU at anchorage", unit: "TEU" },
  { key: "teu_port", label: "TEU at port", unit: "TEU" },
  { key: "queue_berth_ratio", label: "Queue / berth ratio", unit: "" },
] as const;

export type PortMetricKey = (typeof PORT_METRICS)[number]["key"];

/**
 * Alliances the reliability form offers. 2M is listed even though it has
 * dissolved into Gemini: the series is historical, and an old month
 * legitimately has a 2M figure. Dropping it would make old months un-editable.
 */
export const RELIABILITY_ALLIANCES = [
  "Gemini Cooperation",
  "Ocean Alliance",
  "Premier Alliance",
  "MSC standalone",
  "2M",
] as const;

/** How many ports the entry grid offers. A UI convention, not a DB constraint. */
export const PORTS_PER_DAY = 5;

// ---------------------------------------------------------------------------
// Stored shapes
// ---------------------------------------------------------------------------

export type CongestionRow = {
  day_of: string;
  global_teu_waiting: number | null;
  global_pct_fleet: number | null;
  region_data: Json | null;
  entered_at: string;
  entered_by: string | null;
};

export type FleetStatusRow = {
  day_of: string;
  status_data: Json | null;
  entered_at: string;
  entered_by: string | null;
};

export type PortCongestionRow = {
  day_of: string;
  port_name: string;
  ships_anchorage: number | null;
  ships_port: number | null;
  teu_anchorage: number | null;
  teu_port: number | null;
  /**
   * As published, never derived. Close to ships_anchorage / ships_port but not
   * equal: Shanghai/Ningbo publishes 3.50 where the division gives 3.53.
   */
  queue_berth_ratio: number | null;
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
// Reading hand-entered values
// ---------------------------------------------------------------------------

/**
 * A number from a hand-entered value, or null.
 *
 * Accepts a numeric string as well as a number, because a form posts strings
 * and an older row may have stored one. Rejects NaN, Infinity and blanks, all
 * of which would otherwise reach a chart axis and break it silently.
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
 * A hand-entered jsonb map as chart rows.
 *
 * `order` fixes the sequence so bars do not reshuffle between renders. Keys
 * present in the data but absent from `order` are appended rather than dropped
 * — a row entered when the vocabulary was different still shows everything it
 * holds, which is the point of a blob. Unreadable entries are omitted: a
 * region with no figure has no bar, not a zero-height one.
 */
export function namedValues(
  data: Json | null,
  order: readonly string[]
): NamedValue[] {
  const record = readObject(data);
  const seen = new Set<string>();
  const out: NamedValue[] = [];

  for (const name of order) {
    seen.add(name);
    const value = readNumber(record[name]);
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
  for (const [key, raw] of Object.entries(record)) {
    if (seen.has(key)) continue;
    const value = readNumber(raw);
    if (value !== null) out.push({ name: key, value });
  }
  return out;
}

export type FleetStatusValue = {
  status: string;
  ships: number | null;
  teu: number | null;
};

/**
 * Fleet statuses as chart rows.
 *
 * Each status carries two independent measures on very different scales —
 * thousands of ships against tens of millions of TEU — so they are returned
 * separately and the chart plots them on their own axes rather than pretending
 * they share one. A status with neither figure is omitted entirely.
 */
export function fleetStatusValues(data: Json | null): FleetStatusValue[] {
  const record = readObject(data);
  const out: FleetStatusValue[] = [];
  const seen = new Set<string>();

  const push = (status: string, raw: unknown) => {
    const entry = readObject(raw as Json);
    const ships = readNumber(entry.ships);
    const teu = readNumber(entry.teu);
    if (ships === null && teu === null) return;
    out.push({ status, ships, teu });
  };

  for (const status of FLEET_STATUSES) {
    seen.add(status);
    if (status in record) push(status, record[status]);
  }
  for (const [status, raw] of Object.entries(record)) {
    if (seen.has(status)) continue;
    push(status, raw);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Days
// ---------------------------------------------------------------------------

/** "Mon 10" — the day tick, matching the volume chart's convention. */
export function dayTick(isoDate: string): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  const names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return `${names[d.getUTCDay()]} ${d.getUTCDate()}`;
}

export type DailyPoint = { day: string; tick: string; value: number };

/**
 * A daily series from whichever days were entered.
 *
 * PARTIAL WEEKS ARE FIRST CLASS. A week with Monday, Wednesday and Friday
 * entered yields three points, in order. It does not yield seven with zeros or
 * nulls in the gaps — a zero would assert that nothing was waiting on Tuesday,
 * which is a claim nobody made.
 */
export function dailySeries<T extends { day_of: string }>(
  rows: T[],
  value: (row: T) => number | null
): DailyPoint[] {
  return rows
    .slice()
    .sort((a, b) => a.day_of.localeCompare(b.day_of))
    .map((row) => ({ day: row.day_of, tick: dayTick(row.day_of), value: value(row) }))
    .filter((p): p is DailyPoint => p.value !== null);
}

/** The most recently dated row, or null. Drives "latest day" breakdowns. */
export function latestByDay<T extends { day_of: string }>(rows: T[]): T | null {
  if (rows.length === 0) return null;
  return rows.reduce((best, r) => (r.day_of > best.day_of ? r : best));
}

// ---------------------------------------------------------------------------
// Months (schedule reliability — unchanged)
// ---------------------------------------------------------------------------

/**
 * First day of the month containing `isoDate`.
 *
 * String surgery rather than Date arithmetic: the input is already a UTC
 * calendar date, and constructing a Date only creates an opportunity for a
 * local-timezone shift to move it into the previous month.
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
  return `${names[Number(month) - 1] ?? month} ${year}`;
}

/**
 * Whether a carried-forward reliability entry is from a month other than the
 * one the selected week sits in. Reliability is published monthly and in
 * arrears, so an August week normally shows July — expected, but it must be
 * said on the card rather than left to be inferred.
 */
export function isCarriedForward(
  entryMonth: string,
  selectedWeekStart: string
): boolean {
  return entryMonth !== monthOf(selectedWeekStart);
}
