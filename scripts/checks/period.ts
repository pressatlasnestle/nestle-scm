/**
 * Period resolver checks.
 *
 *   npm run check:period
 *
 * resolvePeriod() is pure and injectable, so every preset boundary can be
 * pinned against a frozen clock without a database. Worth pinning because the
 * Phase 3 coding action resolves the period through this same function: if
 * "last 7 days" here and "last 7 days" there ever disagreed, the confirm modal
 * would quote a count the batch did not process.
 *
 * The clock is deliberately mid-month and mid-year so an off-by-one in the
 * month boundary cannot hide behind the 1st.
 */
import {
  applyRange,
  describeRange,
  isBounded,
  parseIsoDate,
  parsePeriodKey,
  resolvePeriod,
  type DateRange,
  type PeriodKey,
} from "@/lib/articles/period";

const NOW = new Date("2026-08-12T09:30:00Z");

type Case = {
  name: string;
  period: PeriodKey;
  custom?: { from?: string | null; to?: string | null };
  expect: DateRange;
};

const CASES: Case[] = [
  { name: "all → unbounded", period: "all", expect: { from: null, to: null } },
  { name: "today → single day", period: "today", expect: { from: "2026-08-12", to: "2026-08-12" } },
  // 7 calendar days INCLUSIVE of today: 06..12, not 05..12.
  { name: "7d → 7 days inclusive", period: "7d", expect: { from: "2026-08-06", to: "2026-08-12" } },
  { name: "30d → 30 days inclusive", period: "30d", expect: { from: "2026-07-14", to: "2026-08-12" } },
  { name: "month → 1st to today", period: "month", expect: { from: "2026-08-01", to: "2026-08-12" } },
  {
    name: "custom → both bounds",
    period: "custom",
    custom: { from: "2026-03-01", to: "2026-03-31" },
    expect: { from: "2026-03-01", to: "2026-03-31" },
  },
  {
    name: "custom reversed → swapped, not empty",
    period: "custom",
    custom: { from: "2026-03-31", to: "2026-03-01" },
    expect: { from: "2026-03-01", to: "2026-03-31" },
  },
  {
    name: "custom half-filled → open-ended, not empty",
    period: "custom",
    custom: { from: "2026-03-01" },
    expect: { from: "2026-03-01", to: null },
  },
  {
    name: "custom empty → unbounded (mid-typing state)",
    period: "custom",
    expect: { from: null, to: null },
  },
  {
    name: "custom garbage → rejected, not passed to SQL",
    period: "custom",
    custom: { from: "not-a-date", to: "2026-13-45" },
    expect: { from: null, to: null },
  },
  {
    name: "custom impossible date → rejected (no Feb-31 rollover)",
    period: "custom",
    custom: { from: "2026-02-31", to: null },
    expect: { from: null, to: null },
  },
];

const PARSE_CASES: { input: string | undefined; expect: PeriodKey }[] = [
  { input: "7d", expect: "7d" },
  { input: "custom", expect: "custom" },
  { input: undefined, expect: "all" },
  { input: "'; drop table articles; --", expect: "all" },
  { input: "90d", expect: "all" },
];

/** Records what applyRange() would put on the query, without a database. */
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

function main() {
  let failures = 0;

  for (const c of CASES) {
    const got = resolvePeriod(c.period, c.custom ?? {}, NOW);
    const ok = got.from === c.expect.from && got.to === c.expect.to;
    if (!ok) failures += 1;
    console.log(
      `${ok ? "PASS" : "FAIL"}  ${c.name} → ${got.from ?? "∅"}..${got.to ?? "∅"}` +
        (ok ? "" : ` (expected ${c.expect.from ?? "∅"}..${c.expect.to ?? "∅"})`)
    );
  }

  for (const c of PARSE_CASES) {
    const got = parsePeriodKey(c.input);
    const ok = got === c.expect;
    if (!ok) failures += 1;
    console.log(
      `${ok ? "PASS" : "FAIL"}  parsePeriodKey(${JSON.stringify(c.input)}) → ${got}`
    );
  }

  // An unbounded range must not touch the query at all — otherwise "All time"
  // would silently drop rows with a null published_at.
  const noop: string[] = [];
  applyRange(stubQuery(noop), { from: null, to: null });
  const noopOk = noop.length === 0;
  if (!noopOk) failures += 1;
  console.log(`${noopOk ? "PASS" : "FAIL"}  unbounded range applies nothing (${noop.length} calls)`);

  // A bounded range must exclude null published_at, or a dateless row would
  // appear in every window and therefore in every coding batch.
  const bounded: string[] = [];
  applyRange(stubQuery(bounded), { from: "2026-08-01", to: "2026-08-12" });
  const boundedOk =
    bounded.includes("not:published_at:is:null") &&
    bounded.includes("gte:published_at:2026-08-01") &&
    bounded.includes("lte:published_at:2026-08-12");
  if (!boundedOk) failures += 1;
  console.log(
    `${boundedOk ? "PASS" : "FAIL"}  bounded range excludes nulls + both bounds → ${bounded.join(" ")}`
  );

  // Open-ended still excludes nulls: an unknown date cannot be shown to fall
  // after a known start.
  const openEnded: string[] = [];
  applyRange(stubQuery(openEnded), { from: "2026-08-01", to: null });
  const openOk =
    openEnded.includes("not:published_at:is:null") &&
    openEnded.includes("gte:published_at:2026-08-01") &&
    !openEnded.some((a) => a.startsWith("lte:"));
  if (!openOk) failures += 1;
  console.log(`${openOk ? "PASS" : "FAIL"}  open-ended range → ${openEnded.join(" ")}`);

  const boundedFlag = isBounded({ from: null, to: "2026-08-12" });
  if (!boundedFlag) failures += 1;
  console.log(`${boundedFlag ? "PASS" : "FAIL"}  isBounded(to-only) is true`);

  const desc = describeRange("custom", { from: "2026-03-01", to: "2026-03-31" });
  const descOk = desc === "2026-03-01 to 2026-03-31";
  if (!descOk) failures += 1;
  console.log(`${descOk ? "PASS" : "FAIL"}  describeRange(custom) → "${desc}"`);

  const descAll = describeRange("all", { from: null, to: null });
  const descAllOk = descAll === "all time";
  if (!descAllOk) failures += 1;
  console.log(`${descAllOk ? "PASS" : "FAIL"}  describeRange(all) → "${descAll}"`);

  const isoOk = parseIsoDate("2026-08-12") === "2026-08-12" && parseIsoDate("12/08/2026") === null;
  if (!isoOk) failures += 1;
  console.log(`${isoOk ? "PASS" : "FAIL"}  parseIsoDate accepts ISO, rejects other formats`);

  const total = CASES.length + PARSE_CASES.length + 7;
  console.log(`\n${total - failures}/${total} passed`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
