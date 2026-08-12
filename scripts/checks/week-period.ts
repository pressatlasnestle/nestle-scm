/**
 * Week resolver checks.
 *
 *   npm run check:week
 *
 * The Analysis panel, the stored narrative and the CSV exports all identify a
 * week by its Monday, so if this resolver drifted by a day every one of them
 * would silently disagree about which articles belong to "week of X".
 *
 * Three things are worth pinning and are all covered here:
 *
 *   1. Boundaries — Monday is inclusive, Sunday is inclusive, and a Sunday
 *      resolves to the week that STARTED six days earlier, not to the next one.
 *      Sunday is the single most likely off-by-one, because getUTCDay() puts it
 *      at 0 and a naive shift sends it forward a week.
 *
 *   2. Year-boundary weeks — the week containing Dec 29 – Jan 4 spans two
 *      calendar years and belongs to exactly one ISO year (the one containing
 *      its Thursday). Both the 53-week years and the label format are checked.
 *
 *   3. Timezone independence — asserted for real, by re-executing this script
 *      under TZ offsets on both sides of UTC and comparing a fingerprint of
 *      every computed value. An in-process assertion cannot prove this: TZ is
 *      read once when the process starts, so a local-time bug would be
 *      invisible to a test running in the same process that defined the
 *      expectations.
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  applyWeek,
  dayTick,
  parseIsoDate,
  recentWeeks,
  resolveWeek,
  weekContaining,
  weekContainingDate,
  weekDays,
  weekRange,
  type Week,
} from "../../src/lib/analysis/week-period";

// Mid-week and mid-year on purpose, so an off-by-one at either end of the week
// cannot hide behind a Monday or a January.
const NOW = new Date("2026-08-12T09:30:00Z"); // a Wednesday

type BoundaryCase = {
  name: string;
  date: string;
  start: string;
  end: string;
  isoYear: number;
  isoWeek: number;
  label: string;
};

const BOUNDARY_CASES: BoundaryCase[] = [
  {
    name: "Monday resolves to its own week",
    date: "2026-08-10",
    start: "2026-08-10",
    end: "2026-08-16",
    isoYear: 2026,
    isoWeek: 33,
    label: "Aug 10 – Aug 16, 2026",
  },
  {
    name: "mid-week day resolves back to Monday",
    date: "2026-08-12",
    start: "2026-08-10",
    end: "2026-08-16",
    isoYear: 2026,
    isoWeek: 33,
    label: "Aug 10 – Aug 16, 2026",
  },
  // The off-by-one that matters most: Sunday is getUTCDay() === 0, and a shift
  // that forgets to remap it lands on the FOLLOWING Monday.
  {
    name: "Sunday belongs to the week that started 6 days earlier",
    date: "2026-08-16",
    start: "2026-08-10",
    end: "2026-08-16",
    isoYear: 2026,
    isoWeek: 33,
    label: "Aug 10 – Aug 16, 2026",
  },
  {
    name: "the day after Sunday starts a new week",
    date: "2026-08-17",
    start: "2026-08-17",
    end: "2026-08-23",
    isoYear: 2026,
    isoWeek: 34,
    label: "Aug 17 – Aug 23, 2026",
  },
  {
    name: "week spanning a month boundary labels both months",
    date: "2026-09-01",
    start: "2026-08-31",
    end: "2026-09-06",
    isoYear: 2026,
    isoWeek: 36,
    label: "Aug 31 – Sep 6, 2026",
  },

  // --- Year boundaries -----------------------------------------------------
  // 2026 is a 53-week ISO year (Jan 1 2026 is a Thursday). Its last week runs
  // Dec 28 2026 – Jan 3 2027 and is 2026-W53, because its Thursday (Dec 31)
  // is in 2026 — even though four of its days are in 2027.
  {
    name: "Dec 28 2026 → 2026-W53, spanning into 2027",
    date: "2026-12-28",
    start: "2026-12-28",
    end: "2027-01-03",
    isoYear: 2026,
    isoWeek: 53,
    label: "Dec 28, 2026 – Jan 3, 2027",
  },
  {
    name: "Jan 1 2027 falls in 2026-W53, not 2027-W01",
    date: "2027-01-01",
    start: "2026-12-28",
    end: "2027-01-03",
    isoYear: 2026,
    isoWeek: 53,
    label: "Dec 28, 2026 – Jan 3, 2027",
  },
  {
    name: "Jan 4 2027 starts 2027-W01",
    date: "2027-01-04",
    start: "2027-01-04",
    end: "2027-01-10",
    isoYear: 2027,
    isoWeek: 1,
    label: "Jan 4 – Jan 10, 2027",
  },
  // The prompt's exact example: a Dec 29 – Jan 4 week. 2025-12-29 is a Monday
  // and its Thursday (Jan 1 2026) is in 2026 — so this week is 2026-W01 even
  // though it BEGINS in 2025. The mirror image of the 2026-W53 case above, and
  // the pair together is what proves the Thursday rule rather than a guess.
  {
    name: "Dec 29 2025 – Jan 4 2026 → 2026-W01 (starts in the previous year)",
    date: "2025-12-29",
    start: "2025-12-29",
    end: "2026-01-04",
    isoYear: 2026,
    isoWeek: 1,
    label: "Dec 29, 2025 – Jan 4, 2026",
  },
  {
    name: "Dec 31 2025 resolves forward into 2026-W01",
    date: "2025-12-31",
    start: "2025-12-29",
    end: "2026-01-04",
    isoYear: 2026,
    isoWeek: 1,
    label: "Dec 29, 2025 – Jan 4, 2026",
  },
  {
    name: "Dec 28 2025 (Sunday) is still 2025-W52",
    date: "2025-12-28",
    start: "2025-12-22",
    end: "2025-12-28",
    isoYear: 2025,
    isoWeek: 52,
    label: "Dec 22 – Dec 28, 2025",
  },
  // A leap year, to be sure Feb 29 does not shift a week.
  {
    name: "leap day sits in its ordinary week",
    date: "2028-02-29",
    start: "2028-02-28",
    end: "2028-03-05",
    isoYear: 2028,
    isoWeek: 9,
    label: "Feb 28 – Mar 5, 2028",
  },
];

const RESOLVE_CASES: { input: string | undefined | null; start: string; why: string }[] = [
  { input: "2026-08-10", start: "2026-08-10", why: "a Monday is taken as-is" },
  { input: "2026-08-13", start: "2026-08-10", why: "a mid-week param snaps back to Monday" },
  { input: undefined, start: "2026-08-10", why: "no param → current week" },
  { input: null, start: "2026-08-10", why: "null param → current week" },
  { input: "", start: "2026-08-10", why: "empty param → current week" },
  { input: "not-a-date", start: "2026-08-10", why: "garbage → current week" },
  { input: "2026-13-45", start: "2026-08-10", why: "impossible date → current week" },
  { input: "2026-02-31", start: "2026-08-10", why: "no Feb-31 rollover" },
  { input: "'; drop table articles; --", start: "2026-08-10", why: "injection → current week" },
];

/** Records what applyWeek() would put on the query, without a database. */
function stubQuery(applied: string[]) {
  const q = {
    gte(col: string, v: string) {
      applied.push(`gte:${col}:${v}`);
      return q;
    },
    lte(col: string, v: string) {
      applied.push(`lte:${col}:${v}`);
      return q;
    },
    not(col: string, op: string, v: null) {
      applied.push(`not:${col}:${op}:${v}`);
      return q;
    },
  };
  return q;
}

/**
 * Every value this module can produce, flattened to one string.
 *
 * This is what the timezone check compares across processes. It must cover
 * every field — a fingerprint of just `start` would pass while a label
 * silently rendered the wrong day name under TZ=UTC+14.
 */
function fingerprint(): string {
  const parts: string[] = [];

  const probes = [
    ...BOUNDARY_CASES.map((c) => c.date),
    "2026-01-01", "2026-06-30", "2027-03-14", "2028-12-31",
  ];

  for (const date of probes) {
    const w = weekContainingDate(date);
    parts.push(
      [date, w.start, w.end, w.isoYear, w.isoWeek, w.isoLabel, w.label].join("|")
    );
    parts.push(weekDays(w).map(dayTick).join(","));
  }

  // recentWeeks/resolveWeek take a Date, so they exercise the UTC-accessor path
  // from a timestamp rather than from a YYYY-MM-DD string. A local-time read
  // would show up here first: 2026-08-12T23:30Z is Aug 13 in any positive
  // offset, and 2026-08-10T00:30Z is Aug 9 (a Sunday!) in any negative one.
  for (const iso of [
    "2026-08-12T09:30:00Z",
    "2026-08-12T23:30:00Z",
    "2026-08-10T00:30:00Z",
    "2026-12-31T22:00:00Z",
    "2027-01-01T01:00:00Z",
  ]) {
    const at = new Date(iso);
    parts.push(`${iso}=${recentWeeks(at, 4).map((w) => w.isoLabel).join(">")}`);
    parts.push(`${iso}~${resolveWeek(undefined, at).start}`);
  }

  return parts.join("\n");
}

function hash(s: string): string {
  // FNV-1a. Not cryptographic — this only needs to change when the text does.
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/**
 * Re-runs this script under a fixed TZ and returns its fingerprint.
 *
 * Both probes are on the far side of the date line from UTC — UTC+14 and
 * UTC-11 — so any surviving local-time read lands on a different calendar day
 * in at least one of them. (Etc/GMT+11 is UTC-11; the POSIX sign convention is
 * inverted, which is why the names look backwards.)
 */
function childFingerprint(tz: string): string | null {
  const self = fileURLToPath(import.meta.url);
  const res = spawnSync(
    process.execPath,
    [...process.execArgv, self],
    {
      env: { ...process.env, TZ: tz, WEEK_CHECK_FINGERPRINT_ONLY: "1" },
      encoding: "utf8",
    }
  );
  if (res.status !== 0) return null;
  const line = (res.stdout || "").trim().split("\n").pop() ?? "";
  return line.startsWith("FINGERPRINT ") ? line.slice("FINGERPRINT ".length) : null;
}

function main() {
  // Child mode: print nothing but the fingerprint, so the parent can compare.
  if (process.env.WEEK_CHECK_FINGERPRINT_ONLY === "1") {
    console.log(`FINGERPRINT ${hash(fingerprint())}`);
    return;
  }

  let failures = 0;
  const fail = (msg: string) => {
    failures += 1;
    console.log(`FAIL  ${msg}`);
  };
  const pass = (msg: string) => console.log(`PASS  ${msg}`);
  const check = (ok: boolean, msg: string) => (ok ? pass(msg) : fail(msg));

  // --- Boundaries & ISO numbering -----------------------------------------
  for (const c of BOUNDARY_CASES) {
    const w = weekContainingDate(c.date);
    const ok =
      w.start === c.start &&
      w.end === c.end &&
      w.isoYear === c.isoYear &&
      w.isoWeek === c.isoWeek &&
      w.label === c.label;
    check(
      ok,
      `${c.name} — ${c.date} → ${w.start}..${w.end} ${w.isoLabel} "${w.label}"` +
        (ok
          ? ""
          : ` (expected ${c.start}..${c.end} ${c.isoYear}-W${String(c.isoWeek).padStart(2, "0")} "${c.label}")`)
    );
  }

  // Every week is exactly 7 days, Monday to Sunday. Cheap, and it catches a
  // DST-style hour drift that per-case expectations might step over.
  const spanBad = BOUNDARY_CASES.filter((c) => {
    const w = weekContainingDate(c.date);
    const days = weekDays(w);
    return (
      days.length !== 7 ||
      days[0] !== w.start ||
      days[6] !== w.end ||
      new Date(`${w.end}T00:00:00Z`).getUTCDay() !== 0 ||
      new Date(`${w.start}T00:00:00Z`).getUTCDay() !== 1
    );
  });
  check(
    spanBad.length === 0,
    `every week is 7 days Mon→Sun (${BOUNDARY_CASES.length} checked${
      spanBad.length ? `, bad: ${spanBad.map((c) => c.date).join(", ")}` : ""
    })`
  );

  // --- resolveWeek ---------------------------------------------------------
  for (const c of RESOLVE_CASES) {
    const got = resolveWeek(c.input, NOW);
    check(
      got.start === c.start,
      `resolveWeek(${JSON.stringify(c.input)}) → ${got.start} — ${c.why}`
    );
  }

  // --- recentWeeks ---------------------------------------------------------
  const recent = recentWeeks(NOW, 5);
  check(
    recent[0].start === "2026-08-10",
    `recentWeeks starts with the current (in-progress) week → ${recent[0].start}`
  );
  check(
    recent.map((w) => w.start).join(",") ===
      "2026-08-10,2026-08-03,2026-07-27,2026-07-20,2026-07-13",
    `recentWeeks walks backwards 7 days at a time → ${recent.map((w) => w.start).join(",")}`
  );
  const descending = recent.every(
    (w, i) => i === 0 || w.start < recent[i - 1].start
  );
  check(descending, "recentWeeks is strictly newest-first");

  // Crossing a year boundary must not repeat or skip a week — the 53rd week of
  // 2026 has to appear exactly once between 2027-W01 and 2026-W52.
  const acrossYear = recentWeeks(new Date("2027-01-06T12:00:00Z"), 4);
  check(
    acrossYear.map((w) => w.isoLabel).join(",") ===
      "2027-W01,2026-W53,2026-W52,2026-W51",
    `recentWeeks crosses the year boundary without skipping W53 → ${acrossYear
      .map((w) => w.isoLabel)
      .join(",")}`
  );

  // --- weekRange / applyWeek ----------------------------------------------
  const week33 = weekContainingDate("2026-08-12");
  const range = weekRange(week33);
  check(
    range.from === "2026-08-10" && range.to === "2026-08-16",
    `weekRange → ${range.from}..${range.to}`
  );

  const applied: string[] = [];
  applyWeek(stubQuery(applied), week33);
  const applyOk =
    applied.includes("not:published_at:is:null") &&
    applied.includes("gte:published_at:2026-08-10") &&
    applied.includes("lte:published_at:2026-08-16");
  check(
    applyOk,
    `applyWeek excludes null dates and bounds both ends → ${applied.join(" ")}`
  );

  // --- Formatting helpers --------------------------------------------------
  check(
    weekDays(week33).join(",") ===
      "2026-08-10,2026-08-11,2026-08-12,2026-08-13,2026-08-14,2026-08-15,2026-08-16",
    `weekDays enumerates Mon→Sun → ${weekDays(week33).join(",")}`
  );
  check(
    weekDays(week33).map(dayTick).join(" ") ===
      "Mon 10 Tue 11 Wed 12 Thu 13 Fri 14 Sat 15 Sun 16",
    `dayTick labels → ${weekDays(week33).map(dayTick).join(" ")}`
  );
  check(
    parseIsoDate("2026-08-10") === "2026-08-10" &&
      parseIsoDate("10/08/2026") === null &&
      parseIsoDate("2026-02-31") === null,
    "parseIsoDate accepts ISO, rejects other formats and impossible dates"
  );

  // weekContaining() must read the Date in UTC, not locally. At 23:30Z the
  // local date is already tomorrow anywhere east of UTC.
  const lateSunday = weekContaining(new Date("2026-08-16T23:30:00Z"));
  check(
    lateSunday.start === "2026-08-10",
    `late-Sunday UTC timestamp stays in its own week → ${lateSunday.start}`
  );
  const earlyMonday = weekContaining(new Date("2026-08-10T00:30:00Z"));
  check(
    earlyMonday.start === "2026-08-10",
    `early-Monday UTC timestamp starts the new week → ${earlyMonday.start}`
  );

  // --- Timezone independence, for real ------------------------------------
  const local = hash(fingerprint());
  const probes: { tz: string; note: string }[] = [
    { tz: "Pacific/Kiritimati", note: "UTC+14" },
    { tz: "Etc/GMT+11", note: "UTC-11" },
  ];
  for (const p of probes) {
    const got = childFingerprint(p.tz);
    if (got === null) {
      fail(`TZ=${p.tz} (${p.note}) child run failed — could not verify`);
      continue;
    }
    check(
      got === local,
      `TZ=${p.tz} (${p.note}) produces identical results → ${got} vs ${local}`
    );
  }

  console.log(
    failures === 0
      ? "\nAll week-period checks passed."
      : `\n${failures} check(s) FAILED.`
  );
  process.exit(failures === 0 ? 0 : 1);
}

main();
