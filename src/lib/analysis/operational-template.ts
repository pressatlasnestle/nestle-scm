/**
 * The CSV template for a week of operational figures, and the parser that
 * reads it back.
 *
 * THE DESIGN DECISION EVERYTHING ELSE FOLLOWS FROM: the user never constructs
 * a CSV. They download a template for the selected week with every row already
 * written — every date, every region, every status, every port, every measure —
 * and fill in one column. A hand-built file would get a port spelled
 * differently, a date as DD/MM/YYYY, a stray column or a trailing blank row,
 * and the usual failure mode is silently skipped rows, which is worse than a
 * rejected file because nobody notices.
 *
 * GENERATOR AND PARSER SHARE ONE DEFINITION. templateRows() below is the only
 * place that knows what a row means; the parser resolves an uploaded row by
 * looking it up in the same list. Adding a region or a measure changes this
 * file and nothing else, and the two halves cannot drift into disagreement —
 * which is the failure that would produce silently skipped rows.
 *
 * LONG FORMAT, one value per row. Verbose to read and that does not matter,
 * because nobody reads it — they type into the last column in Excel. It is
 * worth it because one shape covers three tables with different arities.
 */

import {
  CONGESTION_REGIONS,
  FLEET_STATUSES,
  readNumber,
  readObject,
  type CongestionRow,
  type FleetStatusRow,
  type PortCongestionRow,
  type PortMetricKey,
} from "./operational";
import { headlineSimilarity } from "./similarity";

export const TEMPLATE_HEADERS = ["Date", "Section", "Item", "Measure", "Value"] as const;

export const SECTION = {
  total: "Port congestion total",
  region: "Port congestion by region",
  fleet: "Fleet status",
  port: "Port congestion",
} as const;

/** Where a template row's value belongs in the schema. */
export type Target =
  | { kind: "congestion.global"; field: "global_teu_waiting" | "global_pct_fleet" }
  | { kind: "congestion.region"; regionKey: string }
  | { kind: "fleet"; status: string; field: "ships" | "teu" }
  | { kind: "port"; port: string; field: PortMetricKey };

export type TemplateRow = {
  date: string;
  section: string;
  item: string;
  measure: string;
  target: Target;
};

/** Human-facing measure labels. The parser matches on these exact strings. */
const GLOBAL_MEASURES = [
  { measure: "TEU at anchorage", field: "global_teu_waiting" as const },
  { measure: "Share of fleet %", field: "global_pct_fleet" as const },
];

const FLEET_MEASURES = [
  { measure: "Ships", field: "ships" as const },
  { measure: "TEU", field: "teu" as const },
];

/**
 * Port measure labels.
 *
 * "Queue to berth ratio" is spelled out rather than shortened because the
 * person filling this in is reading it off a Linerlytica screenshot and needs
 * to recognise which figure it wants. It is STORED as given and never
 * recomputed from the two ship counts — they disagree, deliberately.
 */
const PORT_MEASURES: { measure: string; field: PortMetricKey }[] = [
  { measure: "Ships at anchorage", field: "ships_anchorage" },
  { measure: "Ships at port", field: "ships_port" },
  { measure: "TEU at anchorage", field: "teu_anchorage" },
  { measure: "TEU at port", field: "teu_port" },
  { measure: "Queue to berth ratio", field: "queue_berth_ratio" },
];

/**
 * Every row the template contains, in the order it is written.
 *
 * `ports` is the tracked five, carried forward from the most recent entered
 * day so the user never types a port name. If nothing has been entered yet the
 * port section is still emitted with whatever names the caller supplies, and
 * is simply empty when there are none — a template with no port rows is honest
 * about there being no watchlist yet.
 */
export function templateRows(days: string[], ports: string[]): TemplateRow[] {
  const rows: TemplateRow[] = [];

  for (const date of days) {
    for (const { measure, field } of GLOBAL_MEASURES) {
      rows.push({
        date,
        section: SECTION.total,
        item: "All regions",
        measure,
        target: { kind: "congestion.global", field },
      });
    }
    for (const region of CONGESTION_REGIONS) {
      rows.push({
        date,
        section: SECTION.region,
        item: region.label,
        measure: "TEU at anchorage",
        target: { kind: "congestion.region", regionKey: region.key },
      });
    }
    for (const status of FLEET_STATUSES) {
      for (const { measure, field } of FLEET_MEASURES) {
        rows.push({
          date,
          section: SECTION.fleet,
          item: status,
          measure,
          target: { kind: "fleet", status, field },
        });
      }
    }
    for (const port of ports) {
      for (const { measure, field } of PORT_MEASURES) {
        rows.push({
          date,
          section: SECTION.port,
          item: port,
          measure,
          target: { kind: "port", port, field },
        });
      }
    }
  }

  return rows;
}

// ---------------------------------------------------------------------------
// Pre-filling
// ---------------------------------------------------------------------------

export type ExistingData = {
  congestion: CongestionRow[];
  fleet: FleetStatusRow[];
  ports: PortCongestionRow[];
};

/**
 * The value already stored for a template row, as text, or "".
 *
 * A template for a week that already has data comes back pre-filled, so the
 * same file serves as an edit rather than forcing blind re-entry. Absent stays
 * blank — never "0", which the parser would then write as a real zero.
 */
export function existingValue(row: TemplateRow, data: ExistingData): string {
  const t = row.target;

  if (t.kind === "congestion.global") {
    const day = data.congestion.find((c) => c.day_of === row.date);
    const v = day?.[t.field];
    return v === null || v === undefined ? "" : String(v);
  }
  if (t.kind === "congestion.region") {
    const day = data.congestion.find((c) => c.day_of === row.date);
    const v = readNumber(readObject(day?.region_data ?? null)[t.regionKey]);
    return v === null ? "" : String(v);
  }
  if (t.kind === "fleet") {
    const day = data.fleet.find((f) => f.day_of === row.date);
    const entry = readObject(readObject(day?.status_data ?? null)[t.status] as never);
    const v = readNumber(entry[t.field]);
    return v === null ? "" : String(v);
  }
  const portRow = data.ports.find(
    (p) => p.day_of === row.date && p.port_name === t.port
  );
  const v = portRow?.[t.field];
  return v === null || v === undefined ? "" : String(v);
}

/** The template as CSV text, pre-filled from whatever already exists. */
export function buildTemplateCsv(
  days: string[],
  ports: string[],
  data: ExistingData
): string {
  const lines = [TEMPLATE_HEADERS.join(",")];
  for (const row of templateRows(days, ports)) {
    lines.push(
      [row.date, row.section, row.item, row.measure, existingValue(row, data)]
        .map(escapeCell)
        .join(",")
    );
  }
  // CRLF and a trailing newline: this file is going straight into Excel.
  return `${lines.join("\r\n")}\r\n`;
}

function escapeCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

// ---------------------------------------------------------------------------
// Parsing an uploaded file
// ---------------------------------------------------------------------------

export type ParsedValue = {
  /** 1-based line number in the file, counting the header, so it matches Excel. */
  line: number;
  date: string;
  section: string;
  item: string;
  measure: string;
  target: Target;
  value: number;
};

/**
 * A row that could not be used.
 *
 * `message` carries NO row number. One mistake made once — a port renamed in
 * the spreadsheet — lands on every row that mentions it, and the same sentence
 * printed forty times reads as forty problems. Keeping the number separate lets
 * groupProblems() below say it once, against the rows it applies to.
 */
export type RowProblem = { line: number; message: string };

export type UploadPlan = {
  /** Values ready to write. */
  values: ParsedValue[];
  /** Rows recognised but left blank — not written, existing value untouched. */
  blank: number;
  /** Rows that could not be used, each with a row number and what to do. */
  problems: RowProblem[];
  /** Set when the FILE is wrong rather than its rows. Stop and show only this. */
  structuralError: string | null;
  /** Days the file carries values for, ascending. */
  days: string[];
};

/**
 * Suggests the closest known port for a misspelling.
 *
 * Reuses the headline similarity built for near-duplicate story detection:
 * both are "these two strings are the same thing written differently", and it
 * already normalises away the punctuation that causes this — "Shanghai Ningbo"
 * and "Shanghai/Ningbo" normalise to the same tokens and score 1.0.
 */
export function suggestPort(name: string, ports: string[]): string | null {
  let best: { port: string; score: number } | null = null;
  for (const port of ports) {
    const score = headlineSimilarity(name, port);
    if (!best || score > best.score) best = { port, score };
  }
  return best && best.score >= 0.6 ? best.port : null;
}

/**
 * Parses an uploaded template into a plan, without touching the database.
 *
 * VALIDATES, NEVER WRITES. The caller shows the result and waits for a Save.
 *
 * Structural mistakes stop immediately with one message. Forty row failures
 * caused by a single wrong header is not a report anyone can act on — it hides
 * the one thing that needs fixing behind its consequences.
 */
export type ParseOptions = {
  /** The seven days this template covers. */
  days: string[];
  /** The five tracked ports the template was generated with. */
  ports: string[];
  /**
   * The full 180-name vocabulary. Port rows resolve against this rather than
   * the tracked five, because swapping a port in the file is legitimate — the
   * database will accept any name that exists.
   */
  portVocabulary?: string[];
};

export function parseUpload(
  rows: string[][],
  options: ParseOptions
): UploadPlan {
  const plan: UploadPlan = {
    values: [],
    blank: 0,
    problems: [],
    structuralError: null,
    days: [],
  };

  if (rows.length === 0) {
    plan.structuralError = "That file is empty. Download the template and fill in the Value column.";
    return plan;
  }

  const header = rows[0].map((h) => h.trim());
  const expected = TEMPLATE_HEADERS as readonly string[];
  const headerMatches =
    header.length >= expected.length &&
    expected.every((h, i) => header[i]?.toLowerCase() === h.toLowerCase());

  if (!headerMatches) {
    plan.structuralError =
      `This does not look like the template. Its first row should read ` +
      `${expected.join(", ")} — this file reads ${header.join(", ") || "(nothing)"}. ` +
      `Download the template again and fill in the Value column without moving or renaming the others.`;
    return plan;
  }

  // Every row the template WOULD contain, keyed for lookup. Built from the
  // same function that writes the template, so a row that was generated can
  // always be resolved.
  const index = new Map<string, TemplateRow>();
  for (const row of templateRows(options.days, options.ports)) {
    index.set(key(row.date, row.section, row.item, row.measure), row);
  }
  // Ports beyond the tracked five are legitimate — someone may swap one in the
  // file — so port rows resolve against the whole vocabulary, not the five.
  const allPorts = new Set(options.portVocabulary ?? options.ports);
  for (const port of allPorts) {
    if (options.ports.includes(port)) continue;
    for (const date of options.days) {
      for (const { measure, field } of PORT_MEASURES) {
        index.set(key(date, SECTION.port, port, measure), {
          date,
          section: SECTION.port,
          item: port,
          measure,
          target: { kind: "port", port, field },
        });
      }
    }
  }

  const daysSeen = new Set<string>();

  for (let r = 1; r < rows.length; r += 1) {
    const line = r + 1; // 1-based, header counted — matches Excel's row numbers
    const cells = rows[r];

    if (cells.every((c) => c.trim() === "")) continue; // stray blank line

    if (cells.length < 5) {
      plan.problems.push({
        line,
        message: `this row has ${cells.length} column(s) instead of 5. It may have been split or edited — download the template again rather than retyping the row.`,
      });
      continue;
    }

    const [rawDate, section, item, measure, rawValue] = cells.map((c) => c.trim());

    // A blank value is not an error and not a zero: it is "leave this alone".
    if (rawValue === "") {
      plan.blank += 1;
      continue;
    }

    const lookup = index.get(key(rawDate, section, item, measure));

    if (!lookup) {
      plan.problems.push({
        line,
        message: describeMiss(rawDate, section, item, measure, options, allPorts),
      });
      continue;
    }

    const value = Number(rawValue.replace(/,/g, ""));
    if (!Number.isFinite(value)) {
      plan.problems.push({
        line,
        message: `“${rawValue}” is not a number. Leave the cell empty if there is no figure — an empty cell keeps whatever is already saved.`,
      });
      continue;
    }

    daysSeen.add(lookup.date);
    plan.values.push({
      line,
      date: lookup.date,
      section: lookup.section,
      item: lookup.item,
      measure: lookup.measure,
      target: lookup.target,
      value,
    });
  }

  plan.days = [...daysSeen].sort();
  return plan;
}

function key(date: string, section: string, item: string, measure: string) {
  return `${date}|${section}|${item}|${measure}`.toLowerCase();
}

/**
 * Says what is wrong with an unrecognised row, in the terms of the person
 * looking at it — never "parse error at line 34".
 *
 * Diagnoses the most likely cause in order: a retyped date, a port that is not
 * in the vocabulary, then anything else.
 */
function describeMiss(
  date: string,
  section: string,
  item: string,
  measure: string,
  options: ParseOptions,
  allPorts: Set<string>
): string {
  if (!options.days.includes(date)) {
    return (
      `the date reads ${date || "(blank)"} — this template covers ` +
      `${options.days[0]} to ${options.days[options.days.length - 1]}. ` +
      `Please use the dates already in the template rather than retyping them.`
    );
  }

  if (section.toLowerCase() === SECTION.port.toLowerCase() && !allPorts.has(item)) {
    const suggestion = suggestPort(item, [...allPorts]);
    return (
      `“${item}” is not a known port` +
      (suggestion
        ? ` — did you mean “${suggestion}”? Please pick the port in the panel rather than typing its name.`
        : ". Please pick the port in the panel rather than typing its name.")
    );
  }

  return (
    `“${section} / ${item} / ${measure}” is not a row from this template. ` +
    `Download the template again and fill in the Value column without adding or renaming rows.`
  );
}

/**
 * Collapses repeated problems into one line each, against the rows they hit.
 *
 * A port renamed once in the spreadsheet appears on 35 rows — five measures
 * across seven days — and printing the same sentence 35 times buries the four
 * OTHER things wrong with the file. This says it once: "Rows 39–43, 81–85,
 * 123–127: 'LA / Long Beach' is not a known port".
 *
 * Consecutive rows collapse to a range because that is how they occur: a
 * template writes a port's five measures together, so the runs are the shape of
 * the file rather than a formatting flourish.
 */
export function groupProblems(
  problems: RowProblem[]
): { label: string; message: string }[] {
  const byMessage = new Map<string, number[]>();
  for (const p of problems) {
    const lines = byMessage.get(p.message) ?? [];
    lines.push(p.line);
    byMessage.set(p.message, lines);
  }

  return [...byMessage.entries()].map(([message, lines]) => {
    const sorted = [...lines].sort((a, b) => a - b);
    const ranges: string[] = [];
    let start = sorted[0];
    let prev = sorted[0];
    const flush = () => ranges.push(start === prev ? `${start}` : `${start}–${prev}`);
    for (const line of sorted.slice(1)) {
      if (line === prev + 1) prev = line;
      else {
        flush();
        start = line;
        prev = line;
      }
    }
    flush();

    // Past a handful the exact rows stop being actionable — the fix is one
    // edit in the spreadsheet, not a hunt down a list.
    const shown = ranges.slice(0, 4).join(", ");
    const label =
      (sorted.length === 1 ? "Row " : "Rows ") +
      (ranges.length > 4 ? `${shown} and ${ranges.length - 4} more` : shown);
    return { label, message };
  });
}

// ---------------------------------------------------------------------------
// The payload
// ---------------------------------------------------------------------------

export type UploadPayload = {
  congestion: {
    day_of: string;
    global_teu_waiting: number | null;
    global_pct_fleet: number | null;
    region_data: Record<string, number>;
  }[];
  fleet: {
    day_of: string;
    status_data: Record<string, { ships?: number; teu?: number }>;
  }[];
  ports: ({ day_of: string; port_name: string } & Partial<
    Record<PortMetricKey, number>
  >)[];
};

/**
 * Groups the parsed values into one payload per day (or day+port).
 *
 * ONLY VALUES THE FILE ACTUALLY CARRIED APPEAR HERE. A measure left blank is
 * absent from the payload entirely — not present as null — because null and
 * absent mean opposite things downstream: the apply function coalesces, so an
 * absent field leaves the stored figure alone while a null would clear it.
 *
 * A day that carried nothing produces no entry at all, so an empty template
 * uploaded unchanged writes nothing rather than creating rows of nulls that
 * would later read back as "this day was entered".
 */
export function buildUploadPayload(values: ParsedValue[]): UploadPayload {
  const congestion = new Map<string, UploadPayload["congestion"][number]>();
  const fleet = new Map<string, UploadPayload["fleet"][number]>();
  const ports = new Map<string, UploadPayload["ports"][number]>();

  for (const v of values) {
    const t = v.target;

    if (t.kind === "congestion.global" || t.kind === "congestion.region") {
      let day = congestion.get(v.date);
      if (!day) {
        day = {
          day_of: v.date,
          global_teu_waiting: null,
          global_pct_fleet: null,
          region_data: {},
        };
        congestion.set(v.date, day);
      }
      if (t.kind === "congestion.global") day[t.field] = v.value;
      else day.region_data[t.regionKey] = v.value;
      continue;
    }

    if (t.kind === "fleet") {
      let day = fleet.get(v.date);
      if (!day) {
        day = { day_of: v.date, status_data: {} };
        fleet.set(v.date, day);
      }
      const entry = (day.status_data[t.status] ??= {});
      entry[t.field] = v.value;
      continue;
    }

    const id = `${v.date}|${t.port}`;
    let row = ports.get(id);
    if (!row) {
      row = { day_of: v.date, port_name: t.port };
      ports.set(id, row);
    }
    row[t.field] = v.value;
  }

  const byDay = <T extends { day_of: string }>(a: T, b: T) =>
    a.day_of.localeCompare(b.day_of);

  return {
    congestion: [...congestion.values()].sort(byDay),
    fleet: [...fleet.values()].sort(byDay),
    ports: [...ports.values()].sort(
      (a, b) => byDay(a, b) || a.port_name.localeCompare(b.port_name)
    ),
  };
}

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

export type Change = {
  date: string;
  label: string;
  /** What is stored now, or null if nothing is. */
  from: number | null;
  to: number;
};

/**
 * What the file would change, for the confirmation step.
 *
 * A value that already exists and DIFFERS is shown with both numbers. An edit
 * that silently overwrites last Tuesday's transcription is how trust in the
 * tool goes; the person saving needs to see that they are about to do it.
 */
export function planChanges(plan: UploadPlan, data: ExistingData): {
  changed: Change[];
  unchanged: number;
  added: number;
} {
  const changed: Change[] = [];
  let unchanged = 0;
  let added = 0;

  for (const v of plan.values) {
    const current = existingValue(
      { date: v.date, section: v.section, item: v.item, measure: v.measure, target: v.target },
      data
    );
    const from = current === "" ? null : Number(current);

    if (from === null) {
      added += 1;
      continue;
    }
    if (from === v.value) {
      unchanged += 1;
      continue;
    }
    changed.push({
      date: v.date,
      label: `${v.item} · ${v.measure}`,
      from,
      to: v.value,
    });
  }

  return { changed, unchanged, added };
}
