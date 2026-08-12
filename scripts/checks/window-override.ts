/**
 * Window override checks.
 *
 *   npm run check:window
 *
 * The property that matters is the boring one: OMITTING --hours must leave
 * every run type on exactly the window it had before the flag existed. A
 * regression there would silently change what the 12-hourly cron fetches, and
 * nothing downstream would look wrong — the run would still succeed, still
 * report, and just cover the wrong period.
 *
 * The second property is that a malformed --hours is rejected rather than
 * quietly falling back. A catch-up run that ignores its window and reports
 * success is worse than one that refuses to start, because the gap it was run
 * to close stays open and nobody is told.
 */
import {
  resolveWindowMs,
  WINDOW_BACKFILL_MS,
  WINDOW_SCHEDULED_MS,
} from "../../src/lib/ingestion/run";

const HOUR = 60 * 60 * 1000;

type Case = {
  name: string;
  fallback: number;
  override: { hours?: number | null } | undefined;
  expect: number;
};

const CASES: Case[] = [
  {
    name: "omitted → backfill keeps its 7 days",
    fallback: WINDOW_BACKFILL_MS,
    override: undefined,
    expect: 7 * 24 * HOUR,
  },
  {
    name: "omitted → scheduled keeps its 24 hours",
    fallback: WINDOW_SCHEDULED_MS,
    override: undefined,
    expect: 24 * HOUR,
  },
  {
    name: "empty object → still the default",
    fallback: WINDOW_SCHEDULED_MS,
    override: {},
    expect: 24 * HOUR,
  },
  {
    name: "null → still the default",
    fallback: WINDOW_SCHEDULED_MS,
    override: { hours: null },
    expect: 24 * HOUR,
  },
  {
    name: "48 → the catch-up window this was built for",
    fallback: WINDOW_SCHEDULED_MS,
    override: { hours: 48 },
    expect: 48 * HOUR,
  },
  {
    name: "48 overrides the LONGER backfill default too, not just the shorter one",
    fallback: WINDOW_BACKFILL_MS,
    override: { hours: 48 },
    expect: 48 * HOUR,
  },
  {
    name: "fractional hours are honoured",
    fallback: WINDOW_SCHEDULED_MS,
    override: { hours: 1.5 },
    expect: 1.5 * HOUR,
  },
  // Garbage falls back rather than producing an empty or inverted window.
  {
    name: "zero → falls back (far likelier a slip than 'fetch nothing')",
    fallback: WINDOW_SCHEDULED_MS,
    override: { hours: 0 },
    expect: 24 * HOUR,
  },
  {
    name: "negative → falls back, never an inverted window",
    fallback: WINDOW_SCHEDULED_MS,
    override: { hours: -12 },
    expect: 24 * HOUR,
  },
  {
    name: "NaN → falls back",
    fallback: WINDOW_SCHEDULED_MS,
    override: { hours: Number.NaN },
    expect: 24 * HOUR,
  },
  {
    name: "Infinity → falls back, never an unbounded fetch",
    fallback: WINDOW_SCHEDULED_MS,
    override: { hours: Number.POSITIVE_INFINITY },
    expect: 24 * HOUR,
  },
];

/** Mirrors takeHours() in scripts/ingest.ts. */
function takeHours(argv: string[]): { hours: number | null; rest: string[] } {
  const i = argv.indexOf("--hours");
  if (i === -1) return { hours: null, rest: argv };
  const raw = argv[i + 1];
  const hours = Number(raw);
  if (!raw || !Number.isFinite(hours) || hours <= 0) {
    throw new Error(`--hours needs a positive number of hours, got ${JSON.stringify(raw ?? null)}.`);
  }
  const rest = [...argv];
  rest.splice(i, 2);
  return { hours, rest };
}

function main() {
  let failures = 0;
  const check = (ok: boolean, msg: string) => {
    if (!ok) failures += 1;
    console.log(`${ok ? "PASS" : "FAIL"}  ${msg}`);
  };

  for (const c of CASES) {
    const got = resolveWindowMs(c.fallback, c.override);
    check(
      got === c.expect,
      `${c.name} → ${(got / HOUR).toFixed(2)}h` +
        (got === c.expect ? "" : ` (expected ${(c.expect / HOUR).toFixed(2)}h)`)
    );
  }

  // --- argv parsing --------------------------------------------------------
  const plain = takeHours(["manual"]);
  check(
    plain.hours === null && plain.rest.join(" ") === "manual",
    `no flag → hours null, argv untouched (${plain.rest.join(" ")})`
  );

  const trailing = takeHours(["manual", "--hours", "48"]);
  check(
    trailing.hours === 48 && trailing.rest.join(" ") === "manual",
    `flag after the command → 48h, command preserved (${trailing.rest.join(" ")})`
  );

  // The flag must be positional-safe: removing it must not eat the command or
  // shift a following positional argument.
  const leading = takeHours(["--hours", "48", "manual"]);
  check(
    leading.hours === 48 && leading.rest.join(" ") === "manual",
    `flag before the command → 48h, command preserved (${leading.rest.join(" ")})`
  );

  const withPositional = takeHours(["source", "abc-123", "--hours", "6"]);
  check(
    withPositional.hours === 6 &&
      withPositional.rest.join(" ") === "source abc-123",
    `flag alongside a positional → positional intact (${withPositional.rest.join(" ")})`
  );

  const middle = takeHours(["source", "--hours", "6", "abc-123"]);
  check(
    middle.hours === 6 && middle.rest.join(" ") === "source abc-123",
    `flag BETWEEN positionals → both preserved in order (${middle.rest.join(" ")})`
  );

  for (const bad of [
    ["manual", "--hours"],
    ["manual", "--hours", "abc"],
    ["manual", "--hours", "0"],
    ["manual", "--hours", "-5"],
  ]) {
    let threw = false;
    try {
      takeHours(bad);
    } catch {
      threw = true;
    }
    check(threw, `rejects ${JSON.stringify(bad.slice(1))} instead of silently defaulting`);
  }

  const total = CASES.length + 9;
  console.log(`\n${total - failures}/${total} passed`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
