/**
 * The GENERATED half of an edition.
 *
 * Everything in this file is read out of the database and recomputed on every
 * view of a draft. Nothing here is ever written into newsletter_editions while
 * the edition is a draft — the table holds only the authored text — and the
 * whole of it is frozen into `snapshot` exactly once, at send.
 *
 * THE FIGURES ARE STOCKS, NOT FLOWS. TEU at anchorage is a level on a given
 * day. Summing a month of daily readings, or averaging them, and calling the
 * result "September" describes nothing that was ever true of the port. So the
 * month's headline figure is the MOST RECENTLY ENTERED DAY inside it, and it
 * carries that date wherever it appears — "as at 14 Sep". The delta compares
 * that day against the most recently entered day of the prior month, and is
 * labelled with both dates for the same reason.
 *
 * Deltas are always live on both sides, including when the prior month has a
 * sent edition. A sent edition is frozen so that what the client received
 * cannot change; it is not a frozen basis for future arithmetic. If the curator
 * back-fills two more days of September after sending, October should compare
 * against the fullest September reading available — and the date label on the
 * comparison is what keeps that honest rather than surprising.
 *
 * ABSENT IS NOT ZERO, AND NOT-COMPARABLE IS NOT UNCHANGED. A metric nobody
 * entered has no row. A metric with nothing to compare against reads "first
 * edition", never "0%" and never a dash — a zero delta is a claim that nothing
 * moved, which is a different statement from having no basis for a claim.
 */

import type { Json } from "@/types/database.types";
import {
  fleetStatusValues,
  readNumber,
  readObject,
  type CongestionRow,
  type FleetStatusRow,
  type PortCongestionRow,
  type ScheduleReliabilityRow,
} from "@/lib/analysis/operational";
import { dayLabel, previousMonth, type Month } from "./month";
import {
  selectPress,
  type PressCandidate,
  type PressSelection,
} from "./press";

// ---------------------------------------------------------------------------
// Readings and deltas
// ---------------------------------------------------------------------------

export type Reading = {
  value: number;
  /**
   * The day the level was read from, YYYY-MM-DD — or null for a figure that is
   * published monthly in the first place. Schedule reliability has no "as at"
   * day because Sea-Intelligence does not publish one; inventing the last day
   * of the month would be a date nobody measured.
   */
  asAt: string | null;
};

export type Delta =
  /** Nothing was ever recorded before this month. */
  | { kind: "first-edition" }
  /** Earlier data exists, but the immediately preceding month has none. */
  | { kind: "no-prior"; priorMonthLabel: string }
  | {
      kind: "change";
      absolute: number;
      /** Null when the prior reading is zero — a share of zero is not a number. */
      percent: number | null;
      direction: "up" | "down" | "flat";
      prior: Reading;
    };

/**
 * Builds the comparison for one metric.
 *
 * `hasHistoryBefore` separates the two absences that must never be collapsed:
 * a genuine first edition, and a gap where the previous month simply was not
 * entered. Both refuse to print a number; only one of them is "first edition".
 */
export function deltaBetween(
  current: Reading,
  prior: Reading | null,
  month: Month,
  hasHistoryBefore: boolean
): Delta {
  if (!prior) {
    return hasHistoryBefore
      ? { kind: "no-prior", priorMonthLabel: previousMonth(month).label }
      : { kind: "first-edition" };
  }
  const absolute = current.value - prior.value;
  return {
    kind: "change",
    absolute,
    percent: prior.value === 0 ? null : (absolute / Math.abs(prior.value)) * 100,
    direction: absolute > 0 ? "up" : absolute < 0 ? "down" : "flat",
    prior,
  };
}

/** The most recently dated row in a set already scoped to one month. */
export function latestInMonth<T extends { day_of: string }>(rows: T[]): T | null {
  if (rows.length === 0) return null;
  return rows.reduce((best, r) => (r.day_of > best.day_of ? r : best));
}

function reading(value: number | null, asAt: string | null): Reading | null {
  return value === null ? null : { value, asAt };
}

// ---------------------------------------------------------------------------
// At a glance
// ---------------------------------------------------------------------------

export type GlanceRow = {
  key: string;
  label: string;
  value: number;
  /** "TEU", "%", "ships", "days" — rendered after the figure. */
  unit: string;
  /** The reading date, or null for a monthly-published figure. */
  asAt: string | null;
  /** Extra provenance, e.g. "Global Liner Performance issue 158". */
  note: string | null;
  delta: Delta;
};

// ---------------------------------------------------------------------------
// Regional congestion
// ---------------------------------------------------------------------------

/**
 * AOA regions first, then the rest.
 *
 * The edition goes to the Asia/Oceania/Africa desk, so its own waters lead and
 * Europe and the Americas follow as context. That is an editorial order, not a
 * data one, which is why it lives here rather than in lib/analysis/operational.
 *
 * THREE OF THESE HAVE NO SOURCE YET. Linerlytica's regional table — and
 * therefore CONGESTION_REGIONS, which drives the entry form — carries Europe,
 * North America, North Asia, Southeast Asia and South America and nothing else.
 * ISC / Middle East, Oceania and Africa are listed here because they are the
 * order the edition wants; they will render the moment the transcription
 * carries them and stay absent until it does. Absent, not zero: a bar reading
 * zero TEU for Africa would be a claim about Africa.
 */
export const AOA_REGIONS = [
  { key: "north_asia", label: "North Asia" },
  { key: "southeast_asia", label: "SE Asia" },
  { key: "isc_middle_east", label: "ISC / Middle East" },
  { key: "oceania", label: "Oceania" },
  { key: "africa", label: "Africa" },
] as const;

export const OTHER_REGIONS = [
  { key: "europe", label: "Europe" },
  { key: "north_america", label: "North America" },
  { key: "south_america", label: "South America" },
] as const;

export type RegionBar = {
  key: string;
  label: string;
  value: number;
  /** True for the AOA block, so the render can keep the two groups apart. */
  home: boolean;
  delta: Delta;
};

function regionBars(
  current: CongestionRow | null,
  prior: CongestionRow | null,
  month: Month,
  hasHistoryBefore: boolean
): RegionBar[] {
  if (!current) return [];
  const now = readObject(current.region_data);
  const then = readObject(prior?.region_data ?? null);

  const ordered: { key: string; label: string; home: boolean }[] = [
    ...AOA_REGIONS.map((r) => ({ key: r.key, label: r.label, home: true })),
    ...OTHER_REGIONS.map((r) => ({ key: r.key, label: r.label, home: false })),
  ];
  const known = new Set(ordered.map((r) => r.key));
  // A row written under a different region vocabulary still shows everything it
  // holds — the same reason region_data is a blob in the first place.
  for (const key of Object.keys(now)) {
    if (!known.has(key)) ordered.push({ key, label: key, home: false });
  }

  const bars: RegionBar[] = [];
  for (const region of ordered) {
    const value = readNumber(now[region.key]);
    if (value === null) continue;
    bars.push({
      ...region,
      value,
      delta: deltaBetween(
        { value, asAt: current.day_of },
        reading(prior ? readNumber(then[region.key]) : null, prior?.day_of ?? null),
        month,
        hasHistoryBefore
      ),
    });
  }
  return bars;
}

// ---------------------------------------------------------------------------
// Port watch
// ---------------------------------------------------------------------------

export type PortWatchRow = {
  port: string;
  asAt: string;
  teuAnchorage: number | null;
  teuDelta: Delta | null;
  shipsAnchorage: number | null;
  shipsPort: number | null;
  /**
   * As published by Linerlytica, never computed from the two ship counts.
   * Shanghai/Ningbo publishes 3.50 where the division gives 3.53 — printing the
   * derived figure would disagree with the document the client is reading.
   */
  queueBerthRatio: number | null;
  ratioDelta: Delta | null;
};

/** The latest row per port inside a set already scoped to one month. */
function latestPerPort(rows: PortCongestionRow[]): Map<string, PortCongestionRow> {
  const out = new Map<string, PortCongestionRow>();
  for (const row of rows) {
    const held = out.get(row.port_name);
    if (!held || row.day_of > held.day_of) out.set(row.port_name, row);
  }
  return out;
}

function portWatch(
  current: PortCongestionRow[],
  prior: PortCongestionRow[],
  month: Month,
  hasHistoryBefore: boolean
): PortWatchRow[] {
  const now = latestPerPort(current);
  const then = latestPerPort(prior);

  const rows: PortWatchRow[] = [];
  for (const [port, row] of now) {
    const was = then.get(port) ?? null;
    const teu = row.teu_anchorage;
    const ratio = row.queue_berth_ratio;

    rows.push({
      port,
      asAt: row.day_of,
      teuAnchorage: teu,
      teuDelta:
        teu === null
          ? null
          : deltaBetween(
              { value: teu, asAt: row.day_of },
              reading(was?.teu_anchorage ?? null, was?.day_of ?? null),
              month,
              hasHistoryBefore
            ),
      shipsAnchorage: row.ships_anchorage,
      shipsPort: row.ships_port,
      queueBerthRatio: ratio,
      ratioDelta:
        ratio === null
          ? null
          : deltaBetween(
              { value: ratio, asAt: row.day_of },
              reading(was?.queue_berth_ratio ?? null, was?.day_of ?? null),
              month,
              hasHistoryBefore
            ),
    });
  }

  // Busiest first by the figure the table leads with, so the eye lands on the
  // port that matters. Ports with no TEU figure sort last rather than as zero.
  return rows.sort((a, b) => {
    const av = a.teuAnchorage ?? -1;
    const bv = b.teuAnchorage ?? -1;
    if (av !== bv) return bv - av;
    return a.port.localeCompare(b.port);
  });
}

// ---------------------------------------------------------------------------
// Fleet status
// ---------------------------------------------------------------------------

export type FleetBar = {
  status: string;
  ships: number | null;
  teu: number | null;
};

// ---------------------------------------------------------------------------
// Schedule reliability
// ---------------------------------------------------------------------------

export type ReliabilityBlock = {
  monthLabel: string;
  glpIssue: number | null;
  globalPct: number | null;
  globalDelta: Delta | null;
  avgDelayDays: number | null;
  alliances: { name: string; value: number; delta: Delta | null }[];
};

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

export const SECTION_TITLES = {
  headline: "Headline read",
  glance: "At a glance",
  regional: "Regional congestion",
  ports: "Port watch",
  fleet: "Fleet status",
  reliability: "Schedule reliability",
  press: "What moved in the press",
  watchList: "Watch list",
  actions: "Recommended actions",
} as const;

export type SectionKey = keyof typeof SECTION_TITLES;

export type SectionState = {
  key: SectionKey;
  title: string;
  present: boolean;
  /** Why it was dropped. Shown in the draft view; never in the email. */
  reason: string | null;
};

// ---------------------------------------------------------------------------
// The authored half
// ---------------------------------------------------------------------------

export type WatchListEntry = {
  risk: string;
  lanes: string;
  window: string;
  direction: string;
};

export type Authored = {
  headlineRead: string;
  regionalCommentary: string;
  reliabilityNote: string;
  watchList: WatchListEntry[];
  recommendedActions: string[];
};

export const EMPTY_AUTHORED: Authored = {
  headlineRead: "",
  regionalCommentary: "",
  reliabilityNote: "",
  watchList: [],
  recommendedActions: [],
};

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** Reads the authored columns back out of a row, defensively. */
export function readAuthored(row: {
  headline_read: string | null;
  regional_commentary: string | null;
  reliability_note: string | null;
  watch_list: Json | null;
  recommended_actions: Json | null;
}): Authored {
  const watch = Array.isArray(row.watch_list) ? row.watch_list : [];
  const actions = Array.isArray(row.recommended_actions)
    ? row.recommended_actions
    : [];

  return {
    headlineRead: text(row.headline_read),
    regionalCommentary: text(row.regional_commentary),
    reliabilityNote: text(row.reliability_note),
    watchList: watch
      .map((entry) => {
        const e = readObject(entry as Json);
        return {
          risk: text(e.risk),
          lanes: text(e.lanes),
          window: text(e.window),
          direction: text(e.direction),
        };
      })
      // A row with nothing in it is not a watch-list entry.
      .filter((e) => e.risk || e.lanes || e.window || e.direction),
    recommendedActions: actions.map(text).filter(Boolean),
  };
}

// ---------------------------------------------------------------------------
// Assembling an edition
// ---------------------------------------------------------------------------

export type EditionInput = {
  month: Month;
  congestion: CongestionRow[];
  priorCongestion: CongestionRow[];
  fleet: FleetStatusRow[];
  priorFleet: FleetStatusRow[];
  ports: PortCongestionRow[];
  priorPorts: PortCongestionRow[];
  reliability: ScheduleReliabilityRow | null;
  priorReliability: ScheduleReliabilityRow | null;
  press: PressCandidate[];
  includedArticleIds: string[] | null;
  /** Whether any operational row exists dated before this month. */
  hasHistoryBefore: boolean;
};

export type Generated = {
  month: Month;
  glance: GlanceRow[];
  regions: RegionBar[];
  /** The day the regional breakdown was read from. */
  regionsAsAt: string | null;
  ports: PortWatchRow[];
  fleet: FleetBar[];
  fleetAsAt: string | null;
  reliability: ReliabilityBlock | null;
  press: PressSelection;
  sourceCount: number;
};

export type Edition = {
  generated: Generated;
  authored: Authored;
  sections: SectionState[];
};

/**
 * Builds the generated half from raw rows.
 *
 * Every branch here answers the same question — is there anything to say — and
 * answers it by producing nothing rather than producing a zero.
 */
export function buildGenerated(input: EditionInput): Generated {
  const { month, hasHistoryBefore } = input;

  const congestionNow = latestInMonth(input.congestion);
  const congestionThen = latestInMonth(input.priorCongestion);
  const fleetNow = latestInMonth(input.fleet);
  const fleetThen = latestInMonth(input.priorFleet);

  const fleetValues = fleetStatusValues(fleetNow?.status_data ?? null);
  const fleetPrior = fleetStatusValues(fleetThen?.status_data ?? null);
  const fleetShips = (values: typeof fleetValues, status: string) =>
    values.find((v) => v.status === status)?.ships ?? null;

  // --- At a glance --------------------------------------------------------
  const glanceSpecs: {
    key: string;
    label: string;
    unit: string;
    value: number | null;
    asAt: string | null;
    prior: Reading | null;
    note: string | null;
  }[] = [
    {
      key: "teu_waiting",
      label: "Capacity waiting at anchor",
      unit: "TEU",
      value: congestionNow?.global_teu_waiting ?? null,
      asAt: congestionNow?.day_of ?? null,
      prior: reading(congestionThen?.global_teu_waiting ?? null, congestionThen?.day_of ?? null),
      note: null,
    },
    {
      key: "pct_fleet",
      label: "Share of the global fleet waiting",
      unit: "%",
      value: congestionNow?.global_pct_fleet ?? null,
      asAt: congestionNow?.day_of ?? null,
      prior: reading(congestionThen?.global_pct_fleet ?? null, congestionThen?.day_of ?? null),
      note: null,
    },
    {
      key: "ships_anchorage",
      label: "Ships at anchorage",
      unit: "ships",
      value: fleetShips(fleetValues, "Ships at anchorage"),
      asAt: fleetNow?.day_of ?? null,
      prior: reading(fleetShips(fleetPrior, "Ships at anchorage"), fleetThen?.day_of ?? null),
      note: null,
    },
    {
      key: "active_ships",
      label: "Active ships",
      unit: "ships",
      value: fleetShips(fleetValues, "Active Ships"),
      asAt: fleetNow?.day_of ?? null,
      prior: reading(fleetShips(fleetPrior, "Active Ships"), fleetThen?.day_of ?? null),
      note: null,
    },
    {
      key: "reliability",
      label: "Schedule reliability, global",
      unit: "%",
      value: input.reliability?.global_reliability_pct ?? null,
      // Monthly by publication, so no reading day exists to name.
      asAt: null,
      prior: reading(input.priorReliability?.global_reliability_pct ?? null, null),
      note: input.reliability?.glp_issue_number
        ? `Global Liner Performance issue ${input.reliability.glp_issue_number}`
        : null,
    },
    {
      key: "avg_delay",
      label: "Average delay, late arrivals",
      unit: "days",
      value: input.reliability?.avg_delay_days ?? null,
      asAt: null,
      prior: reading(input.priorReliability?.avg_delay_days ?? null, null),
      note: null,
    },
  ];

  const glance: GlanceRow[] = glanceSpecs
    .filter((s) => s.value !== null)
    .map((s) => ({
      key: s.key,
      label: s.label,
      value: s.value!,
      unit: s.unit,
      asAt: s.asAt,
      note: s.note,
      delta: deltaBetween(
        { value: s.value!, asAt: s.asAt },
        s.prior,
        month,
        hasHistoryBefore
      ),
    }));

  // --- Reliability block ---------------------------------------------------
  let reliability: ReliabilityBlock | null = null;
  if (input.reliability) {
    const now = readObject(input.reliability.alliance_data);
    const then = readObject(input.priorReliability?.alliance_data ?? null);
    const alliances = Object.entries(now)
      .map(([name, raw]) => ({ name, value: readNumber(raw) }))
      .filter((a): a is { name: string; value: number } => a.value !== null)
      .sort((a, b) => b.value - a.value)
      .map((a) => ({
        ...a,
        delta: input.priorReliability
          ? deltaBetween(
              { value: a.value, asAt: null },
              reading(readNumber(then[a.name]), null),
              month,
              hasHistoryBefore
            )
          : null,
      }));

    const globalPct = input.reliability.global_reliability_pct;
    reliability = {
      monthLabel: month.label,
      glpIssue: input.reliability.glp_issue_number,
      globalPct,
      globalDelta:
        globalPct === null
          ? null
          : deltaBetween(
              { value: globalPct, asAt: null },
              reading(input.priorReliability?.global_reliability_pct ?? null, null),
              month,
              hasHistoryBefore
            ),
      avgDelayDays: input.reliability.avg_delay_days,
      alliances,
    };
    // A reliability row carrying no figure at all is not a section.
    if (
      globalPct === null &&
      reliability.avgDelayDays === null &&
      alliances.length === 0
    ) {
      reliability = null;
    }
  }

  const press = selectPress(input.press, input.includedArticleIds);

  return {
    month,
    glance,
    regions: regionBars(congestionNow, congestionThen, month, hasHistoryBefore),
    regionsAsAt: congestionNow?.day_of ?? null,
    ports: portWatch(input.ports, input.priorPorts, month, hasHistoryBefore),
    fleet: fleetValues,
    fleetAsAt: fleetNow?.day_of ?? null,
    reliability,
    press,
    sourceCount: press.outlets,
  };
}

/**
 * Which sections the edition carries, and why the rest were dropped.
 *
 * A section with no data is omitted ENTIRELY — no heading over an empty table,
 * no zero-fill, no "data not available" row. The draft view reads this list so
 * the curator knows what is missing and can go and enter it; the email is
 * simply shorter.
 */
export function sectionStates(
  generated: Generated,
  authored: Authored
): SectionState[] {
  const state = (
    key: SectionKey,
    present: boolean,
    reason: string
  ): SectionState => ({
    key,
    title: SECTION_TITLES[key],
    present,
    reason: present ? null : reason,
  });

  return [
    state(
      "headline",
      authored.headlineRead.length > 0,
      "Nothing written yet. This is the read the edition is sent for."
    ),
    state(
      "glance",
      generated.glance.length > 0,
      "No congestion, fleet or reliability figure has been entered for this month."
    ),
    state(
      "regional",
      generated.regions.length > 0,
      "No regional breakdown was entered on any day of this month."
    ),
    state(
      "ports",
      generated.ports.length > 0,
      "No per-port figures were entered on any day of this month."
    ),
    state(
      "fleet",
      generated.fleet.length > 0,
      "No fleet status was entered on any day of this month."
    ),
    state(
      "reliability",
      generated.reliability !== null,
      "No Global Liner Performance figures were entered for this month."
    ),
    state(
      "press",
      generated.press.shown > 0,
      generated.press.candidates === 0
        ? "No coded article was published in this month."
        : "Every candidate article has been toggled out."
    ),
    state("watchList", authored.watchList.length > 0, "Nothing written yet."),
    state(
      "actions",
      authored.recommendedActions.length > 0,
      "Nothing written yet."
    ),
  ];
}

/** The subject line. Fixed shape — eleven prior editions used it. */
export function subjectLine(month: Month): string {
  return `Ocean Freight Update — AOA | ${month.label}`;
}

/**
 * The source line under the sign-off.
 *
 * Counts the whole candidate corpus rather than the items the curator kept: the
 * corpus is the evidence the read rests on, and the press section says
 * separately how many of it are shown.
 */
export function sourceLine(generated: Generated): string {
  const { candidates, outlets } = generated.press;
  if (candidates === 0) {
    return `No coded article was published in ${generated.month.label}.`;
  }
  // "named outlets", not "outlets". Articles captured through a keyword alert
  // carry no publisher in the corpus, so they are counted in the article total
  // and not in the outlet total — see outletName() in press.ts. Saying "named"
  // is what makes the smaller number true rather than an undercount.
  return (
    `Drawn from ${candidates} coded article${candidates === 1 ? "" : "s"} published in ` +
    `${generated.month.label}, from ${outlets} named outlet${outlets === 1 ? "" : "s"}.`
  );
}

// ---------------------------------------------------------------------------
// Formatting — shared by the composer and the email so they cannot disagree
// ---------------------------------------------------------------------------

/** "1,847,000". Thousands separated; never abbreviated in a table cell. */
export function formatValue(value: number, unit: string): string {
  if (unit === "%") return `${round(value, 1)}%`;
  if (unit === "days") return `${round(value, 1)}`;
  return Math.abs(value) >= 1000
    ? Math.round(value).toLocaleString("en-US")
    : String(round(value, 2));
}

function round(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

/**
 * The delta cell.
 *
 * "first edition" and "no September figure" are TEXT, not numbers, and that is
 * the point — neither may be rendered as 0%, as a dash, or as blank. A reader
 * who sees "0%" has been told the level did not move.
 */
export function formatDelta(delta: Delta): string {
  if (delta.kind === "first-edition") return "first edition";
  if (delta.kind === "no-prior") return `no ${delta.priorMonthLabel} figure`;

  const arrow = delta.direction === "up" ? "▲" : delta.direction === "down" ? "▼" : "±";
  if (delta.percent === null) {
    const sign = delta.absolute > 0 ? "+" : "";
    return `${arrow} ${sign}${round(delta.absolute, 2)} from zero`;
  }
  const pct = Math.abs(round(delta.percent, 1));
  return `${arrow} ${pct}%`;
}

/** "vs 28 Aug" — the basis of the comparison, always stated next to it. */
export function deltaBasis(delta: Delta): string | null {
  if (delta.kind !== "change") return null;
  return delta.prior.asAt ? `vs ${dayLabel(delta.prior.asAt)}` : "vs last month";
}

/** "as at 14 Sep", or null for a figure with no reading day. */
export function asAtLabel(asAt: string | null): string | null {
  return asAt ? `as at ${dayLabel(asAt)}` : null;
}
