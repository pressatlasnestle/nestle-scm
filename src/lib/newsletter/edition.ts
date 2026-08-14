/**
 * The GENERATED half of an edition.
 *
 * Everything in this file is read out of the database and recomputed on every
 * view of a draft. Nothing here is ever written into newsletter_editions while
 * the edition is a draft — the table holds only the authored text — and the
 * whole of it is frozen into `snapshot` exactly once, at send.
 *
 * THE FIGURES ARE STOCKS, NOT FLOWS. TEU at anchorage is a level on a given
 * day. Summing a week of daily readings, or averaging them, and calling the
 * result "the week of 10 August" describes nothing that was ever true of the
 * port. So the week's headline figure is the MOST RECENTLY ENTERED DAY inside
 * it, and it carries that date wherever it appears — "as at 14 Aug". The delta
 * compares that day against the most recently entered day of the prior week,
 * and is labelled with both dates for the same reason.
 *
 * Deltas are always live on both sides, including when the prior week has a
 * sent edition. A sent edition is frozen so that what the client received
 * cannot change; it is not a frozen basis for future arithmetic. If the curator
 * back-fills two more days after sending, the next week should compare against
 * the fullest reading available — and the date label on the comparison is what
 * keeps that honest rather than surprising.
 *
 * ABSENT IS NOT ZERO, AND NOT-COMPARABLE IS NOT UNCHANGED. A metric nobody
 * entered has no row. A metric with nothing to compare against reads "first
 * edition", never "0%" and never a dash — a zero delta is a claim that nothing
 * moved, which is a different statement from having no basis for a claim.
 *
 * SCHEDULE RELIABILITY IS THE ONE MONTHLY THING AND STAYS MONTHLY.
 * Sea-Intelligence publishes it monthly and in arrears, so four consecutive
 * weekly editions legitimately carry the same figure and the same GLP issue.
 * It therefore does NOT get a week-on-week delta: comparing a carried-forward
 * figure against itself would print "0%" every week, which is precisely the
 * "nothing moved" claim this file exists to refuse. It compares against the
 * previous PUBLISHED month instead, and says so.
 */

import type { Json } from "@/types/database.types";
import {
  fleetStatusValues,
  monthOf,
  readNumber,
  readObject,
  type CongestionRow,
  type FleetStatusRow,
  type PortCongestionRow,
  type ScheduleReliabilityRow,
} from "@/lib/analysis/operational";
import {
  dayLabel,
  monthLabel,
  previousWeek,
  weekRangeLabel,
  weekRangeShort,
  type Week,
} from "./week";
import {
  selectPress,
  type PressCandidate,
  type PressSelection,
} from "./press";
import {
  findSection,
  hasBody,
  renderableSections,
  type EditionSection,
  type SectionKey,
} from "./sections";

// ---------------------------------------------------------------------------
// Readings and deltas
// ---------------------------------------------------------------------------

export type Reading = {
  value: number;
  /**
   * The day the level was read from, YYYY-MM-DD — or null for a figure that is
   * not read from a day at all. Schedule reliability has no "as at" day because
   * Sea-Intelligence does not publish one; inventing the last day of the month
   * would be a date nobody measured.
   */
  asAt: string | null;
  /**
   * How to name this reading when it has no day — "July 2026". Only used for
   * the monthly series, and only to keep "vs last month" from being the vaguest
   * thing on the page.
   */
  label?: string | null;
};

export type Delta =
  /** Nothing was ever recorded before this week. */
  | { kind: "first-edition" }
  /** Earlier data exists, but the immediately preceding period has none. */
  | { kind: "no-prior"; priorPeriodLabel: string }
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
 * a genuine first edition, and a gap where the previous week was simply never
 * entered. Both refuse to print a number; only one of them is "first edition".
 */
export function deltaBetween(
  current: Reading,
  prior: Reading | null,
  priorPeriodLabel: string,
  hasHistoryBefore: boolean
): Delta {
  if (!prior) {
    return hasHistoryBefore
      ? { kind: "no-prior", priorPeriodLabel }
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

/** The most recently dated row in a set already scoped to one week. */
export function latestInWeek<T extends { day_of: string }>(rows: T[]): T | null {
  if (rows.length === 0) return null;
  return rows.reduce((best, r) => (r.day_of > best.day_of ? r : best));
}

function reading(
  value: number | null,
  asAt: string | null,
  label?: string | null
): Reading | null {
  return value === null ? null : { value, asAt, label };
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
  /** The reading date, or null for a figure not read from a day. */
  asAt: string | null;
  /** Extra provenance, e.g. the GLP issue and the month it covers. */
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
  priorWeekLabel: string,
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
        priorWeekLabel,
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

/** The latest row per port inside a set already scoped to one week. */
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
  priorWeekLabel: string,
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
              priorWeekLabel,
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
              priorWeekLabel,
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
// Schedule reliability — monthly inside a weekly edition
// ---------------------------------------------------------------------------

export type ReliabilityBlock = {
  /** The month the figures describe — the reliability row's OWN month. */
  monthLabel: string;
  glpIssue: number | null;
  /**
   * True when the figures are from a month other than the one the week sits in.
   * In a weekly cadence this is the normal case, not an exception, and it has
   * to be said out loud: four consecutive editions carrying the same number
   * with no explanation read as a fresh weekly figure that mysteriously never
   * moves, and a reader will eventually act on it as if it were new.
   */
  carriedForward: boolean;
  /** The month the week itself sits in, for the "not X" half of that sentence. */
  weekMonthLabel: string;
  /** The published month the deltas compare against, or null if there is none. */
  priorMonthLabel: string | null;
  globalPct: number | null;
  globalDelta: Delta | null;
  avgDelayDays: number | null;
  alliances: { name: string; value: number; delta: Delta | null }[];
};

// ---------------------------------------------------------------------------
// Blocks — what the edition is made of
//
// An edition is an ordered run of BLOCKS. Some are data (a table or a bar
// chart built from the figures); some are prose written by the model and
// editable by hand, and those live in `sections`. The five prose keys here are
// exactly the SectionKeys in sections.ts, so "is this block present" is the
// same question as "does that section have a body".
// ---------------------------------------------------------------------------

export const BLOCK_TITLES = {
  glance: "At a glance",
  regional: "Regional congestion",
  ports: "Port watch",
  fleet: "Fleet status",
  reliability: "Schedule reliability",
  press: "What moved in the press",
} as const;

export type BlockKey = keyof typeof BLOCK_TITLES;

export type BlockState = {
  key: BlockKey;
  title: string;
  present: boolean;
  /**
   * Plain-English reason it was left out, for the composer only. It never
   * reaches the email — the email is simply shorter. The curator needs to know
   * a gap was a data gap and not a bug; the reader does not need to know there
   * was a gap at all.
   */
  reason: string | null;
};

// ---------------------------------------------------------------------------
// Assembling an edition
// ---------------------------------------------------------------------------

export type EditionInput = {
  week: Week;
  congestion: CongestionRow[];
  priorCongestion: CongestionRow[];
  fleet: FleetStatusRow[];
  priorFleet: FleetStatusRow[];
  ports: PortCongestionRow[];
  priorPorts: PortCongestionRow[];
  /** The most recent reliability month AT OR BEFORE the week — carried forward. */
  reliability: ScheduleReliabilityRow | null;
  /** The most recent published month STRICTLY BEFORE that one. */
  priorReliability: ScheduleReliabilityRow | null;
  press: PressCandidate[];
  includedArticleIds: string[] | null;
  /** Whether any operational row exists dated before this week. */
  hasHistoryBefore: boolean;
  /**
   * True when the week has not finished yet.
   *
   * Passed in rather than derived from a clock inside buildGenerated(), which
   * has to stay pure: the send action freezes what it computes, and a figure
   * that depends on the moment of rendering is the one thing a frozen record
   * cannot contain.
   */
  partialWeek: boolean;
};

export type Generated = {
  week: Week;
  /** The week is still running, so anything COUNTED across it is incomplete. */
  partialWeek: boolean;
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
  /** The written sections, as stored. Rendered by key into their blocks. */
  sections: EditionSection[];
  /** Which blocks the edition carries, and why the rest were left out. */
  blocks: BlockState[];
};

/**
 * Builds the generated half from raw rows.
 *
 * Every branch here answers the same question — is there anything to say — and
 * answers it by producing nothing rather than producing a zero.
 */
export function buildGenerated(input: EditionInput): Generated {
  const { week, hasHistoryBefore } = input;
  const priorWeekLabel = weekRangeShort(previousWeek(week));

  const congestionNow = latestInWeek(input.congestion);
  const congestionThen = latestInWeek(input.priorCongestion);
  const fleetNow = latestInWeek(input.fleet);
  const fleetThen = latestInWeek(input.priorFleet);

  const fleetValues = fleetStatusValues(fleetNow?.status_data ?? null);
  const fleetPrior = fleetStatusValues(fleetThen?.status_data ?? null);
  const fleetShips = (values: typeof fleetValues, status: string) =>
    values.find((v) => v.status === status)?.ships ?? null;

  // Reliability: monthly, and compared against the previous PUBLISHED month
  // rather than the previous week. See the header — a carried-forward figure
  // compared against itself prints 0% for three weeks out of four.
  const reliabilityMonth = input.reliability
    ? monthLabel(input.reliability.month_of)
    : null;
  const priorReliabilityMonth = input.priorReliability
    ? monthLabel(input.priorReliability.month_of)
    : null;
  const reliabilityNote = input.reliability
    ? [
        input.reliability.glp_issue_number
          ? `Global Liner Performance issue ${input.reliability.glp_issue_number}`
          : null,
        `${reliabilityMonth}, unchanged until the next issue`,
      ]
        .filter(Boolean)
        .join(" · ")
    : null;

  // --- At a glance --------------------------------------------------------
  const glanceSpecs: {
    key: string;
    label: string;
    unit: string;
    value: number | null;
    asAt: string | null;
    prior: Reading | null;
    priorPeriodLabel: string;
    note: string | null;
  }[] = [
    {
      key: "teu_waiting",
      label: "Capacity waiting at anchor",
      unit: "TEU",
      value: congestionNow?.global_teu_waiting ?? null,
      asAt: congestionNow?.day_of ?? null,
      prior: reading(congestionThen?.global_teu_waiting ?? null, congestionThen?.day_of ?? null),
      priorPeriodLabel: priorWeekLabel,
      note: null,
    },
    {
      key: "pct_fleet",
      label: "Share of the global fleet waiting",
      unit: "%",
      value: congestionNow?.global_pct_fleet ?? null,
      asAt: congestionNow?.day_of ?? null,
      prior: reading(congestionThen?.global_pct_fleet ?? null, congestionThen?.day_of ?? null),
      priorPeriodLabel: priorWeekLabel,
      note: null,
    },
    {
      key: "ships_anchorage",
      label: "Ships at anchorage",
      unit: "ships",
      value: fleetShips(fleetValues, "Ships at anchorage"),
      asAt: fleetNow?.day_of ?? null,
      prior: reading(fleetShips(fleetPrior, "Ships at anchorage"), fleetThen?.day_of ?? null),
      priorPeriodLabel: priorWeekLabel,
      note: null,
    },
    {
      key: "active_ships",
      label: "Active ships",
      unit: "ships",
      value: fleetShips(fleetValues, "Active Ships"),
      asAt: fleetNow?.day_of ?? null,
      prior: reading(fleetShips(fleetPrior, "Active Ships"), fleetThen?.day_of ?? null),
      priorPeriodLabel: priorWeekLabel,
      note: null,
    },
    {
      key: "reliability",
      label: "Schedule reliability, global",
      unit: "%",
      value: input.reliability?.global_reliability_pct ?? null,
      // Monthly by publication, so there is no reading day to name.
      asAt: null,
      prior: reading(
        input.priorReliability?.global_reliability_pct ?? null,
        null,
        priorReliabilityMonth
      ),
      priorPeriodLabel: priorReliabilityMonth ?? "the previous issue",
      note: reliabilityNote,
    },
    {
      key: "avg_delay",
      label: "Average delay, late arrivals",
      unit: "days",
      value: input.reliability?.avg_delay_days ?? null,
      asAt: null,
      prior: reading(
        input.priorReliability?.avg_delay_days ?? null,
        null,
        priorReliabilityMonth
      ),
      priorPeriodLabel: priorReliabilityMonth ?? "the previous issue",
      note: reliabilityNote,
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
        s.priorPeriodLabel,
        hasHistoryBefore
      ),
    }));

  // --- Reliability block ---------------------------------------------------
  let reliability: ReliabilityBlock | null = null;
  if (input.reliability) {
    const now = readObject(input.reliability.alliance_data);
    const then = readObject(input.priorReliability?.alliance_data ?? null);
    const priorLabel = priorReliabilityMonth ?? "the previous issue";
    const alliances = Object.entries(now)
      .map(([name, raw]) => ({ name, value: readNumber(raw) }))
      .filter((a): a is { name: string; value: number } => a.value !== null)
      .sort((a, b) => b.value - a.value)
      .map((a) => ({
        ...a,
        delta: input.priorReliability
          ? deltaBetween(
              { value: a.value, asAt: null },
              reading(readNumber(then[a.name]), null, priorReliabilityMonth),
              priorLabel,
              hasHistoryBefore
            )
          : null,
      }));

    const globalPct = input.reliability.global_reliability_pct;
    reliability = {
      monthLabel: reliabilityMonth!,
      glpIssue: input.reliability.glp_issue_number,
      // The week's own month is taken from its END, matching the bounded
      // carry-forward lookup in load.ts, so a week straddling a month boundary
      // is judged the same way in both places.
      carriedForward: input.reliability.month_of !== monthOf(week.end),
      weekMonthLabel: monthLabel(monthOf(week.end)),
      priorMonthLabel: priorReliabilityMonth,
      globalPct,
      globalDelta:
        globalPct === null
          ? null
          : deltaBetween(
              { value: globalPct, asAt: null },
              reading(
                input.priorReliability?.global_reliability_pct ?? null,
                null,
                priorReliabilityMonth
              ),
              priorLabel,
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
    week,
    partialWeek: input.partialWeek,
    glance,
    regions: regionBars(congestionNow, congestionThen, priorWeekLabel, hasHistoryBefore),
    regionsAsAt: congestionNow?.day_of ?? null,
    ports: portWatch(input.ports, input.priorPorts, priorWeekLabel, hasHistoryBefore),
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
export function dataBlocks(generated: Generated): BlockState[] {
  const state = (key: BlockKey, present: boolean, reason: string): BlockState => ({
    key,
    title: BLOCK_TITLES[key],
    present,
    reason: present ? null : reason,
  });

  return [
    state(
      "glance",
      generated.glance.length > 0,
      "No congestion, fleet or reliability figures entered for this week."
    ),
    state(
      "regional",
      generated.regions.length > 0,
      "No regional figures entered for this week."
    ),
    state("ports", generated.ports.length > 0, "No port figures entered for this week."),
    state("fleet", generated.fleet.length > 0, "No fleet figures entered for this week."),
    state(
      "reliability",
      generated.reliability !== null,
      "No schedule reliability figures entered for this month or any earlier one."
    ),
    state(
      "press",
      generated.press.shown > 0,
      generated.press.candidates === 0
        ? "No articles published in this week have been coded yet."
        : "Every article has been switched off."
    ),
  ];
}

export function blockPresent(blocks: BlockState[], key: BlockKey): boolean {
  return blocks.some((b) => b.key === key && b.present);
}

/** Assembles the three parts the renderer and the composer both work from. */
export function buildEdition(
  input: EditionInput,
  sections: EditionSection[]
): Edition {
  const generated = buildGenerated(input);
  return { generated, sections, blocks: dataBlocks(generated) };
}

/** True when the edition would render as a header and a sign-off and nothing else. */
export function isEmptyEdition(edition: Edition): boolean {
  return (
    edition.blocks.every((b) => !b.present) &&
    renderableSections(edition.sections).length === 0
  );
}

/**
 * The subject line.
 *
 * The date range is in it because a reader forwarding this six weeks later
 * should not have to open it to know which week it covers. "Week of" rather
 * than the bare range so it reads as a period and not as a publication date.
 */
export function subjectLine(week: Week): string {
  return `Ocean Freight Update — AOA | Week of ${weekRangeLabel(week)}`;
}

/**
 * The source line under the sign-off.
 *
 * Counts the whole candidate corpus rather than the items the curator kept: the
 * corpus is the evidence the read rests on, and the press section says
 * separately how many of it are shown. It restates the date range for the same
 * reason the subject does.
 */
export function sourceLine(generated: Generated): string {
  const { candidates, outlets } = generated.press;
  const range = weekRangeLabel(generated.week);
  // A running week's article count is five days against a completed week's
  // seven. Saying "so far" is the whole of the fix: the number is right, and it
  // stops being read as a finished total.
  const soFar = generated.partialWeek ? " so far" : "";

  if (candidates === 0) {
    return `No coded article was published in ${range}${soFar}.`;
  }
  // "named outlets", not "outlets". Articles captured through a keyword alert
  // carry no publisher in the corpus, so they are counted in the article total
  // and not in the outlet total — see outletName() in press.ts. Saying "named"
  // is what makes the smaller number true rather than an undercount.
  return (
    `Drawn from ${candidates} coded article${candidates === 1 ? "" : "s"} published ` +
    `${range}${soFar}, from ${outlets} named outlet${outlets === 1 ? "" : "s"}.` +
    (generated.partialWeek
      ? " This edition was put together before the week closed, so it covers part of the week only."
      : "")
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
 * "first edition" and "no 3–9 Aug figure" are TEXT, not numbers, and that is
 * the point — neither may be rendered as 0%, as a dash, or as blank. A reader
 * who sees "0%" has been told the level did not move.
 */
export function formatDelta(delta: Delta): string {
  if (delta.kind === "first-edition") return "first edition";
  if (delta.kind === "no-prior") return `no ${delta.priorPeriodLabel} figure`;

  const arrow = delta.direction === "up" ? "▲" : delta.direction === "down" ? "▼" : "±";
  if (delta.percent === null) {
    const sign = delta.absolute > 0 ? "+" : "";
    return `${arrow} ${sign}${round(delta.absolute, 2)} from zero`;
  }
  const pct = Math.abs(round(delta.percent, 1));
  return `${arrow} ${pct}%`;
}

/** "vs 8 Aug" / "vs July 2026" — the basis, always stated next to the change. */
export function deltaBasis(delta: Delta): string | null {
  if (delta.kind !== "change") return null;
  if (delta.prior.asAt) return `vs ${dayLabel(delta.prior.asAt)}`;
  return delta.prior.label ? `vs ${delta.prior.label}` : "vs the previous reading";
}

/** "as at 14 Aug", or null for a figure with no reading day. */
export function asAtLabel(asAt: string | null): string | null {
  return asAt ? `as at ${dayLabel(asAt)}` : null;
}
