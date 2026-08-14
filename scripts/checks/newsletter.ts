/**
 * The weekly edition: week boundaries, stock deltas, press grouping, the email
 * HTML's hard constraints, the role gates and the freeze.
 *
 *   CHECK_CURATE_EMAIL=... CHECK_CURATE_PASSWORD=... \
 *   CHECK_READ_EMAIL=...   CHECK_READ_PASSWORD=... \
 *   npx tsx --env-file=.env.local scripts/checks/newsletter.ts
 *
 * THREE TIERS, by what each one actually needs.
 *
 * The LOGIC half — week labels, deltas, section presence, press grouping, and
 * the email HTML's no-svg/no-class/no-link rules — is a property of pure
 * functions over fixture rows, so it runs on its own with no credentials and no
 * network. That matters for the HTML rules in particular: they are the
 * regression that breaks silently months from now, they are one string search
 * each, and gating them behind two sets of sign-in credentials would be the
 * surest way to stop them ever running.
 *
 * The CORPUS tier — is the week window really a bounded date range in the
 * QUERY — needs a database but no particular role, because the property under
 * test is the range on the query and not the policy above it. It runs under the
 * service role and writes NOTHING, reading the real corpus instead. That
 * separation is deliberate: the week boundary is the headline risk of the
 * monthly-to-weekly change, and gating it behind sign-in credentials would be
 * the surest way to leave it unproven.
 *
 * The ROLE tier — who may write, whether an audit row can be forged, and
 * whether a sent edition is really frozen — signs in as REAL users of each role
 * rather than using the service role, because the properties under test ARE the
 * RLS policy and the trigger.
 *
 * When a tier's inputs are absent it does not run, and the script says exactly
 * what went unproven and exits non-zero. A check that quietly skips its own
 * subject is worse than one that fails.
 *
 * Everything the database half writes uses year-2099 weeks that no real edition
 * will cover, and is removed again at the end — on success and on failure
 * alike. IT WRITES NO ARTICLES: the press rules are pure, so they are tested
 * against fixtures, and the week BOUNDARY is tested against the real corpus,
 * which happens to hold the perfect case — 3 articles on Sunday 9 August 2026
 * and 28 on Monday the 10th, either side of a week boundary.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../../src/types/database.types";
import type {
  CongestionRow,
  FleetStatusRow,
  PortCongestionRow,
  ScheduleReliabilityRow,
} from "../../src/lib/analysis/operational";
import { weekContainingDate } from "../../src/lib/analysis/week-period";
import {
  lastCompletedWeek,
  previousWeek,
  resolveEditionWeek,
  weekRangeLabel,
  weekRangeShort,
} from "../../src/lib/newsletter/week";
import {
  buildEdition,
  buildGenerated,
  deltaBetween,
  deltaBasis,
  formatDelta,
  isEmptyEdition,
  subjectLine,
  BLOCK_TITLES,
  type Edition,
  type EditionInput,
} from "../../src/lib/newsletter/edition";
import {
  applyEdit,
  findSection,
  mergeGenerated,
  parseSections,
  renderableSections,
  sectionsToJson,
  SECTION_SLOTS,
  type EditionSection,
} from "../../src/lib/newsletter/sections";
import { requestableSlots } from "../../src/lib/newsletter/generate";
import { loadEdition, loadWeekCounts } from "../../src/lib/newsletter/load";
import { renderEditionHtml } from "../../src/lib/newsletter/email";
import {
  buildSnapshot,
  parseSnapshot,
  snapshotToJson,
} from "../../src/lib/newsletter/snapshot";
import {
  outletName,
  selectPress,
  PRESS_ITEMS_PER_THEME,
  type PressCandidate,
} from "../../src/lib/newsletter/press";

// Year-2099 weeks. 2099-01-05 is a Monday, the same anchor check:operational
// uses. WEEK_A has data and nothing before it; WEEK_B has data and a prior
// week; WEEK_D has data with an EMPTY week in between, which is the third delta
// case and the one most easily collapsed into "first edition".
const WEEK_A = weekContainingDate("2099-01-05"); // 5–11 Jan
const WEEK_B = weekContainingDate("2099-01-12"); // 12–18 Jan
const WEEK_C = weekContainingDate("2099-01-19"); // 19–25 Jan, deliberately empty
const WEEK_D = weekContainingDate("2099-01-26"); // 26 Jan – 1 Feb
const SENT_WEEK = weekContainingDate("2099-06-01");
const ALL_WEEKS = [WEEK_A.start, WEEK_B.start, WEEK_C.start, WEEK_D.start, SENT_WEEK.start];

const A_SUNDAY = WEEK_A.end; // 2099-01-11
const B_MONDAY = WEEK_B.start; // 2099-01-12
const A_DAYS = ["2099-01-05", "2099-01-07", A_SUNDAY];
const B_DAY = "2099-01-14";
const D_DAY = "2099-01-28";
const OUTSIDE_DAY = "2099-05-11";
const ALL_DAYS = [...A_DAYS, B_MONDAY, B_DAY, D_DAY, OUTSIDE_DAY];

// The real corpus's week boundary. 2026-08-09 is a Sunday, 2026-08-10 a Monday.
const REAL_WEEK_EARLY = weekContainingDate("2026-08-09"); // 3–9 Aug
const REAL_WEEK_LATE = weekContainingDate("2026-08-10"); // 10–16 Aug

let failures = 0;
let ran = 0;
const check = (ok: boolean, msg: string) => {
  ran += 1;
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${msg}`);
};

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const STAMP = { entered_at: "2099-01-01T00:00:00.000Z", entered_by: null };

function congestion(day: string, teu: number, regions: Record<string, number>): CongestionRow {
  return {
    day_of: day,
    global_teu_waiting: teu,
    global_pct_fleet: 4,
    region_data: regions,
    ...STAMP,
  };
}

const FLEET: FleetStatusRow[] = [
  {
    day_of: B_DAY,
    status_data: {
      "Ships at port": { ships: 1165, teu: 7_000_000 },
      "Active Ships": { ships: 5426, teu: 31_000_000 },
      "Ships at anchorage": { ships: 1180, teu: 6_000_000 },
    },
    ...STAMP,
  },
];

const PORTS: PortCongestionRow[] = [
  {
    day_of: B_DAY,
    port_name: "Shanghai/Ningbo",
    ships_anchorage: 67,
    ships_port: 19,
    teu_anchorage: 500_000,
    teu_port: 250_000,
    // Published 3.50 where 67/19 computes 3.526 — the case the whole
    // stored-not-derived rule exists for.
    queue_berth_ratio: 3.5,
    ...STAMP,
  },
];

/** Reliability is MONTHLY and stays monthly, inside a weekly edition. */
const RELIABILITY: ScheduleReliabilityRow = {
  month_of: "2099-01-01",
  glp_issue_number: 999,
  global_reliability_pct: 61,
  avg_delay_days: 4.5,
  alliance_data: { "Gemini Cooperation": 90, "Ocean Alliance": 60 },
  ...STAMP,
};

/** The previous PUBLISHED month, which is what reliability compares against. */
const PRIOR_RELIABILITY: ScheduleReliabilityRow = {
  month_of: "2098-12-01",
  glp_issue_number: 998,
  global_reliability_pct: 58,
  avg_delay_days: 4.9,
  alliance_data: { "Gemini Cooperation": 87, "Ocean Alliance": 59 },
  ...STAMP,
};

const EMPTY_INPUT = {
  congestion: [] as CongestionRow[],
  priorCongestion: [] as CongestionRow[],
  fleet: [] as FleetStatusRow[],
  priorFleet: [] as FleetStatusRow[],
  ports: [] as PortCongestionRow[],
  priorPorts: [] as PortCongestionRow[],
  reliability: null as ScheduleReliabilityRow | null,
  priorReliability: null as ScheduleReliabilityRow | null,
  press: [] as PressCandidate[],
  includedArticleIds: null as string[] | null,
};

/** Three days entered in week A, the newest being the Sunday. */
const A_CONGESTION = [
  congestion(A_DAYS[0], 1000, { north_asia: 500, europe: 250 }),
  congestion(A_DAYS[1], 1200, { north_asia: 600, europe: 300 }),
  congestion(A_DAYS[2], 1500, { north_asia: 750, europe: 375 }),
];

const A_INPUT: EditionInput = {
  ...EMPTY_INPUT,
  week: WEEK_A,
  congestion: A_CONGESTION,
  hasHistoryBefore: false,
  partialWeek: false,
};

const B_INPUT: EditionInput = {
  ...EMPTY_INPUT,
  week: WEEK_B,
  congestion: [congestion(B_DAY, 1800, { north_asia: 900, europe: 450 })],
  priorCongestion: A_CONGESTION,
  fleet: FLEET,
  ports: PORTS,
  reliability: RELIABILITY,
  priorReliability: PRIOR_RELIABILITY,
  hasHistoryBefore: true,
  partialWeek: false,
};

/** Week D, with an empty week C between it and B. */
const D_INPUT: EditionInput = {
  ...EMPTY_INPUT,
  week: WEEK_D,
  congestion: [congestion(D_DAY, 2000, {})],
  hasHistoryBefore: true,
  partialWeek: false,
};

const GEN_AT = "2099-01-19T09:00:00.000Z";

/** Every section written by the model, none edited. The ordinary state. */
const SECTIONS: EditionSection[] = SECTION_SLOTS.map((slot) => ({
  key: slot.key,
  title: slot.title,
  body: `Test ${slot.title.toLowerCase()} for a year-2099 week. Not a real edition.`,
  generated_at: GEN_AT,
  edited_at: null,
}));

function editionFrom(input: EditionInput, sections = SECTIONS): Edition {
  return buildEdition(input, sections);
}

/** One-section fixtures for the role tier, where the text is only a marker. */
const oneSection = (body: string): EditionSection[] => [
  { key: "headline", title: "Headline read", body, generated_at: GEN_AT, edited_at: null },
];
const SEED_SECTION = oneSection("seed");
const TAMPERED_SECTION = oneSection("tampered");
const BEFORE_SEND_SECTION = oneSection("before send");

/** The headline body out of a raw `sections` column, for asserting on a row. */
function bodyOf(value: unknown): string {
  return findSection(parseSections(value as never), "headline")?.body ?? "";
}

/**
 * Whether the rendered email carries a section HEADING with this title.
 *
 * Matched against the heading's closing markup rather than the bare words,
 * because a caption may legitimately mention another section by name — the
 * glance caption says schedule reliability is the one monthly figure, which is
 * exactly the sentence a reader needs and exactly the string a naive search
 * mistakes for the section itself.
 */
function hasSectionHeading(html: string, title: string): boolean {
  return html.includes(`;">${title}</div>`);
}

// --- Press fixtures, never written to the database --------------------------

function article(
  id: string,
  headline: string,
  themes: string[],
  publishedAt: string
): PressCandidate {
  return {
    id,
    headline,
    ai_summary: `${headline} — one-line summary.`,
    url: `https://example.invalid/${id}`,
    media: "Fixture Wire",
    published_at: publishedAt,
    ai_themes: themes,
  };
}

const CHOKE = "Chokepoints & routing";
const DISRUPT = "Disruption & incidents";
const PORTS_THEME = "Port & terminal operations";

const FIXTURES: PressCandidate[] = [
  article("three-themes", "Carries three themes", [CHOKE, DISRUPT, PORTS_THEME], "2099-01-11"),
  article("choke-2", "Chokepoint two", [CHOKE], "2099-01-10"),
  article("choke-3", "Chokepoint three", [CHOKE], "2099-01-09"),
  article("choke-4", "Chokepoint four", [CHOKE], "2099-01-08"),
  article("choke-5", "Chokepoint five", [CHOKE], "2099-01-07"),
  article("choke-6", "Chokepoint six", [CHOKE], "2099-01-06"),
  article("disrupt-2", "Disruption two", [DISRUPT], "2099-01-05"),
];

const FIXTURE_IDS = FIXTURES.map((f) => f.id);
const WITHOUT_NEWEST = FIXTURE_IDS.filter((id) => id !== "three-themes");

// ===========================================================================
// The logic half — no database
// ===========================================================================

function logicChecks() {
  console.log("WEEKS, NOT MONTHS");
  check(
    WEEK_A.start === "2099-01-05" && WEEK_A.end === "2099-01-11",
    `an ISO week runs Monday to Sunday (${WEEK_A.start} → ${WEEK_A.end})`
  );
  check(
    previousWeek(WEEK_B).start === WEEK_A.start,
    "the prior week is the ISO week before, not seven days of arithmetic on a label"
  );
  check(
    weekContainingDate("2099-01-11").start === WEEK_A.start,
    "an article dated the SUNDAY belongs to that week"
  );
  check(
    weekContainingDate("2099-01-12").start === WEEK_B.start,
    "and one dated the MONDAY belongs to the next — the off-by-one that would lose or double-count an article every edition"
  );
  check(
    previousWeek(WEEK_A).start === "2098-12-29",
    `the week before 5 Jan 2099 starts on 29 Dec 2098 — the prior week crosses the year by ISO rules, not by calendar year (${previousWeek(WEEK_A).start})`
  );
  check(
    weekContainingDate("2099-01-04").start === "2098-12-29",
    "and Sunday 4 Jan 2099 belongs to the week that started in December"
  );

  console.log("\nTHE DEFAULT WEEK");
  // Monday 17 Aug 2026 → the week that just closed is 10–16 Aug.
  check(
    lastCompletedWeek(new Date("2026-08-17T09:00:00Z")).start === "2026-08-10",
    `composing on Monday 17 Aug lands on 10–16 Aug (${lastCompletedWeek(new Date("2026-08-17T09:00:00Z")).start})`
  );
  check(
    lastCompletedWeek(new Date("2026-08-16T23:00:00Z")).start === "2026-08-03",
    "and on Sunday the 16th the week 10–16 is still running, so the last CLOSED week is 3–9 Aug"
  );
  check(
    resolveEditionWeek(undefined, new Date("2026-08-17T09:00:00Z")).start === "2026-08-10",
    "an absent parameter resolves to the last completed week, never the in-progress one"
  );
  check(
    resolveEditionWeek("2026-08-13", new Date("2026-08-17T09:00:00Z")).start === "2026-08-10",
    "and a parameter naming any day snaps to that day's Monday"
  );

  console.log("\nLABELS AND SUBJECT");
  check(
    weekRangeLabel(WEEK_A) === "5–11 Jan 2099",
    `a within-month week reads compactly ("${weekRangeLabel(WEEK_A)}")`
  );
  check(
    weekRangeLabel(weekContainingDate("2026-09-30")) === "28 Sep – 4 Oct 2026",
    `a month-spanning week names both months ("${weekRangeLabel(weekContainingDate("2026-09-30"))}")`
  );
  check(
    weekRangeLabel(weekContainingDate("2026-12-30")) === "28 Dec 2026 – 3 Jan 2027",
    `a year-spanning week names both years, because one trailing year would attach to the wrong end ("${weekRangeLabel(weekContainingDate("2026-12-30"))}")`
  );
  check(
    subjectLine(weekContainingDate("2026-08-10")) ===
      "Ocean Freight Update — AOA | Week of 10–16 Aug 2026",
    `the subject carries the date range in the specified form ("${subjectLine(weekContainingDate("2026-08-10"))}")`
  );

  console.log("\nSTOCKS, NOT FLOWS");
  const a = editionFrom(A_INPUT);
  const teu = a.generated.glance.find((r) => r.key === "teu_waiting")!;
  check(
    teu.value === 1500 && teu.asAt === A_SUNDAY,
    `the week's figure is the LATEST entered day (${teu.value} as at ${teu.asAt})`
  );
  check(
    teu.value !== (1000 + 1200 + 1500) / 3 && teu.value !== 1000 + 1200 + 1500,
    "and is neither the mean nor the total of the three days, so this is not a coincidence"
  );

  console.log("\nDELTAS — THREE KINDS OF ANSWER");
  check(
    teu.delta.kind === "first-edition",
    `a week with nothing before it has no comparison (${teu.delta.kind})`
  );
  check(
    formatDelta(teu.delta) === "first edition",
    `and it reads "first edition" — never 0%, never a dash ("${formatDelta(teu.delta)}")`
  );

  const b = editionFrom(B_INPUT);
  const bTeu = b.generated.glance.find((r) => r.key === "teu_waiting")!;
  check(
    bTeu.delta.kind === "change" && bTeu.delta.prior.value === 1500,
    "a delta spanning a week boundary picks the prior week's LATEST day, not its first or its Sunday"
  );
  check(
    bTeu.delta.kind === "change" && bTeu.delta.prior.asAt === A_SUNDAY,
    `and carries the date it compared against (${
      bTeu.delta.kind === "change" ? bTeu.delta.prior.asAt : "none"
    })`
  );
  check(formatDelta(bTeu.delta) === "▲ 20%", `1500 → 1800 is +20% (${formatDelta(bTeu.delta)})`);
  check(
    deltaBasis(bTeu.delta) === "vs 11 Jan",
    `the basis names the day, not the week ("${deltaBasis(bTeu.delta)}")`
  );

  const d = editionFrom(D_INPUT);
  const dTeu = d.generated.glance.find((r) => r.key === "teu_waiting")!;
  check(
    dTeu.delta.kind === "no-prior",
    `an empty prior week is its own case, not "first edition" (${dTeu.delta.kind})`
  );
  check(
    formatDelta(dTeu.delta) === `no ${weekRangeShort(WEEK_C)} figure`,
    `and it names the week it could not find ("${formatDelta(dTeu.delta)}")`
  );
  check(
    !/0%/.test(formatDelta(dTeu.delta)) && !/0%/.test(formatDelta(teu.delta)),
    "neither absence is ever rendered as 0%, which would claim the level did not move"
  );

  const fromZero = deltaBetween(
    { value: 5, asAt: "2099-01-11" },
    { value: 0, asAt: "2099-01-04" },
    "the week before",
    true
  );
  check(
    fromZero.kind === "change" && fromZero.percent === null,
    "a rise from zero has no percentage, and says so rather than printing Infinity"
  );

  console.log("\nRELIABILITY IS MONTHLY INSIDE A WEEKLY EDITION");
  const rel = b.generated.reliability!;
  check(
    rel.monthLabel === "January 2099",
    `the block is labelled with the reliability row's OWN month, not the edition's (${rel.monthLabel})`
  );
  check(rel.glpIssue === 999, `and cites the GLP issue (${rel.glpIssue})`);
  check(
    rel.priorMonthLabel === "December 2098",
    `it compares against the previous PUBLISHED month (${rel.priorMonthLabel})`
  );
  const relRow = b.generated.glance.find((r) => r.key === "reliability")!;
  check(
    relRow.delta.kind === "change" && Math.abs(relRow.delta.absolute - 3) < 1e-9,
    "58% → 61% is a real change, not the 0% a week-on-week comparison of a carried-forward figure would print"
  );
  check(
    deltaBasis(relRow.delta) === "vs December 2098",
    `and the basis says which month ("${deltaBasis(relRow.delta)}")`
  );
  check(
    (relRow.note ?? "").includes("issue 999") &&
      (relRow.note ?? "").includes("January 2099") &&
      (relRow.note ?? "").includes("unchanged"),
    `the glance row states the issue, the month and that it is unchanged ("${relRow.note}")`
  );

  // Carried forward: a February week still showing January's issue.
  const febWeek = weekContainingDate("2099-02-09");
  const carried = editionFrom({ ...B_INPUT, week: febWeek });
  check(
    carried.generated.reliability!.carriedForward,
    "a February week carrying January's issue is flagged as carried forward"
  );
  check(
    carried.generated.reliability!.weekMonthLabel === "February 2099",
    "and knows which month it is NOT a figure for"
  );
  const carriedHtml = renderEditionHtml(carried, { baseUrl: null });
  check(
    carriedHtml.includes("January 2099") && carriedHtml.includes("issue 999"),
    "the email states the month it covers and the GLP issue"
  );
  check(
    carriedHtml.includes("unchanged since that issue"),
    "and says explicitly that it is unchanged since that issue"
  );
  check(
    carriedHtml.includes("not February 2099 figures"),
    "and that these are not the current month's figures"
  );
  check(
    carriedHtml.includes("Changes are against December 2098, not against last week"),
    "and that the percentages beside it are month-on-month, not week-on-week"
  );

  console.log("\nABSENT IS NOT ZERO");
  const bare = editionFrom(
    { ...EMPTY_INPUT, week: WEEK_A, hasHistoryBefore: false, partialWeek: false },
    SECTIONS
  );
  check(bare.generated.glance.length === 0, "a week with no figures produces no glance rows");
  check(
    bare.blocks.every((b) => !b.present),
    `every DATA block is dropped when there are no figures and no articles (${bare.blocks
      .filter((b) => b.present)
      .map((b) => b.key)
      .join(",") || "none present"})`
  );
  check(
    bare.blocks.every((b) => b.present || (b.reason?.length ?? 0) > 0),
    "and every dropped block says why, in plain words, for the composer"
  );
  check(
    bare.blocks.every((b) => !/undefined|null|\berror\b/i.test(b.reason ?? "")),
    "those reasons read as English, not as a debug string"
  );
  check(
    renderableSections(bare.sections).length === SECTION_SLOTS.length,
    "the written sections still render — they are text, not figures, and do not depend on the data being there"
  );
  check(
    !isEmptyEdition(bare) && isEmptyEdition({ ...bare, sections: [] }),
    "an edition is only empty when it has neither figures nor words"
  );

  console.log("\nSECTIONS PRESENT AND ABSENT IN THE RENDERED EMAIL");
  const aHtml = renderEditionHtml(a, { baseUrl: "https://example.invalid" });
  const bHtml = renderEditionHtml(b, { baseUrl: "https://example.invalid" });

  for (const key of ["ports", "fleet", "reliability"] as const) {
    check(
      !hasSectionHeading(aHtml, BLOCK_TITLES[key]),
      `week A entered no ${BLOCK_TITLES[key].toLowerCase()} data, so the "${BLOCK_TITLES[key]}" section is absent from the HTML entirely`
    );
  }
  check(
    hasSectionHeading(aHtml, BLOCK_TITLES.glance) &&
      hasSectionHeading(aHtml, BLOCK_TITLES.regional),
    "the sections week A DOES have are present, so the absences above are not a blank render"
  );
  check(aHtml.includes("as at 11 Jan"), "the partial week carries its reading date into the email");
  check(aHtml.includes("first edition"), 'and its delta cells read "first edition"');
  check(
    aHtml.includes("Week of 5–11 Jan 2099"),
    "the header carries the date range, so a forwarded copy needs no opening"
  );
  check(
    !/data not available|not available|n\/a/i.test(aHtml),
    "no section is padded with a placeholder row"
  );
  for (const key of ["ports", "fleet", "reliability"] as const) {
    check(
      hasSectionHeading(bHtml, BLOCK_TITLES[key]),
      `week B entered ${BLOCK_TITLES[key].toLowerCase()} data, so its heading IS present`
    );
  }
  check(
    bHtml.includes("3.5") && !bHtml.includes("3.526"),
    "the queue / berth ratio is printed as published (3.50), never as the 3.526 the ship counts would give"
  );
  check(
    bHtml.includes("OVERLAP"),
    "the fleet section says its categories overlap, so nobody totals them"
  );
  check(
    bHtml.includes("Monday to Sunday"),
    "and the edition says what its window is, rather than leaving it to be inferred"
  );

  console.log("\nEMAIL HTML CONSTRAINTS");
  for (const [html, label] of [
    [aHtml, "week A"],
    [bHtml, "week B"],
  ] as const) {
    check(!html.includes("<svg"), `${label}: no <svg — Gmail strips it and Outlook cannot render it`);
    check(
      !html.includes("class="),
      `${label}: no class= — Gmail strips <head> styles, so a class-based layout arrives unstyled`
    );
    check(!html.includes("<link"), `${label}: no <link — an external stylesheet never loads in a mail client`);
    check(!html.includes("<style"), `${label}: no <style> block`);
    check(!/display:\s*(flex|grid)/.test(html), `${label}: no flexbox and no grid`);
    check(!html.includes("var(--"), `${label}: no CSS variables`);
    check(!/@font-face|fonts\.googleapis/.test(html), `${label}: no webfonts`);
    // An ABSOLUTE cap on a fluid frame. `width:640px;max-width:100%` passes an
    // eyeball test and still forces a sideways scroll on a phone, because a
    // percentage max-width against an auto-width table cell computes to `none`.
    check(
      html.includes("width:100%;max-width:640px"),
      `${label}: the frame is fluid and capped at 640px, not fixed at 640px`
    );
    check(
      !/width:\s*640px;\s*max-width:\s*100%/.test(html),
      `${label}: and not the percentage cap that silently does nothing`
    );
    check(
      html.includes("[if mso]") && html.includes('width="640"'),
      `${label}: with an Outlook ghost table, since Word ignores max-width`
    );
  }
  check(
    aHtml.length > 2000,
    `the rendered email is a real document, not an empty shell (${aHtml.length} bytes)`
  );
  check(
    (bHtml.match(/<table/g) ?? []).length > 8,
    "the charts really are tables — a bar is a <td> with a background colour and a width"
  );

  console.log("\nPRESS SELECTION");
  const all = selectPress(FIXTURES, null);
  const appearances = all.themes
    .flatMap((t) => [...t.items, ...t.heldBack, ...t.excluded])
    .filter((i) => i.id === "three-themes").length;
  check(appearances === 1, `an article tagged with three themes appears exactly once (${appearances})`);
  check(
    all.themes.find((t) => t.items.some((i) => i.id === "three-themes"))?.theme === CHOKE,
    "and is filed under its highest-volume theme"
  );
  check(
    all.themes[0].theme === CHOKE && all.themes[1].theme === DISRUPT,
    `themes run busiest first (${all.themes.map((t) => t.theme).join(", ")})`
  );
  check(
    all.themes.every((t) => t.theme !== PORTS_THEME),
    "a theme whose only article was filed elsewhere renders no empty heading"
  );
  check(
    all.themes[0].items.length === PRESS_ITEMS_PER_THEME && all.themes[0].heldBack.length === 1,
    `the per-theme cap holds the surplus back rather than dropping it silently (${all.themes[0].items.length} shown, ${all.themes[0].heldBack.length} held)`
  );
  check(all.themes[0].items[0].id === "three-themes", "and stories run newest first within a theme");

  const pruned = selectPress(FIXTURES, WITHOUT_NEWEST);
  check(
    !pruned.themes.some((t) => t.items.some((i) => i.id === "three-themes")),
    "a toggled-out article is not rendered"
  );
  check(
    pruned.themes[0].items.some((i) => i.id === "choke-6"),
    "and the item the cap was holding back is promoted into its place"
  );
  const nothingKept = selectPress(FIXTURES, []);
  check(
    nothingKept.shown === 0,
    `an empty selection is a real selection — everything toggled out renders nothing (${nothingKept.shown})`
  );
  check(
    !hasSectionHeading(
      renderEditionHtml(
        editionFrom({ ...EMPTY_INPUT, week: WEEK_B, hasHistoryBefore: true, partialWeek: false, press: FIXTURES, includedArticleIds: [] }),
        { baseUrl: null }
      ),
      BLOCK_TITLES.press
    ),
    "and the press section is absent from the email entirely"
  );

  console.log("\nNEAR-DUPLICATE SUPPRESSION");
  const twice: PressCandidate[] = [
    article("cap-a", "Asian port congestion forcing container lines back to the Red Sea", [CHOKE], "2099-01-11"),
    article("cap-b", "Asian port congestion forcing container lines back to the Red Sea - Seatrade Maritime News", [CHOKE], "2099-01-11"),
    article("distinct", "Maersk and Hapag-Lloyd return more services to the Suez Canal", [CHOKE], "2099-01-10"),
  ];
  const deduped = selectPress(twice, null);
  check(
    deduped.themes[0].items.length === 2,
    `two captures of one story render once (${deduped.themes[0].items.length} of 3 shown)`
  );
  check(
    deduped.themes[0].nearDuplicates.length === 1,
    "and the suppressed capture is reported, not silently dropped"
  );
  check(
    deduped.themes[0].items.some((i) => i.id === "distinct"),
    "while a genuinely different story on the same theme survives"
  );

  const acrossThemes = selectPress(
    [
      article("x-a", "Hapag-Lloyd's $4.2B ZIM deal faces growing opposition in Israel", [CHOKE], "2099-01-11"),
      article("x-b", "Hapag-Lloyd's $4.2B ZIM deal faces growing opposition in Israel", [DISRUPT], "2099-01-11"),
      article("x-c", "Chokepoint filler", [CHOKE], "2099-01-10"),
      article("x-d", "Disruption filler", [DISRUPT], "2099-01-09"),
    ],
    null
  );
  const printed = acrossThemes.themes.flatMap((t) => t.items.map((i) => i.id));
  check(
    printed.filter((id) => id === "x-a" || id === "x-b").length === 1,
    `one story filed under two themes is printed once (${printed.join(",")})`
  );

  console.log("\nOUTLET ATTRIBUTION");
  const ALERT = 'Google Alert - "Red Sea" ("ocean freight" OR "container shipping")';
  check(outletName(ALERT) === null, "a Google Alert query is not an outlet, so it is never a byline");
  check(outletName("The Loadstar") === "The Loadstar", "a real outlet name survives untouched");
  const mixedOutlets = selectPress(
    [
      { ...FIXTURES[0], id: "m1", media: "The Loadstar" },
      { ...FIXTURES[1], id: "m2", media: ALERT },
      { ...FIXTURES[2], id: "m3", media: "The Loadstar" },
    ],
    null
  );
  check(
    mixedOutlets.outlets === 1,
    `the source count counts NAMED outlets only (${mixedOutlets.outlets})`
  );
  check(
    !renderEditionHtml(
      editionFrom({ ...EMPTY_INPUT, week: WEEK_B, hasHistoryBefore: true, partialWeek: false, press: [{ ...FIXTURES[0], media: ALERT }] }),
      { baseUrl: null }
    ).includes("Google Alert"),
    "and no alert query reaches the rendered email"
  );

  console.log("\nTHE SNAPSHOT");
  const html = renderEditionHtml(b, { baseUrl: null });
  const snapshot = buildSnapshot({
    edition: b,
    subject: subjectLine(WEEK_B),
    html,
    sentAt: "2099-01-19T09:00:00.000Z",
    sentByName: "Check fixture",
  });
  const restored = parseSnapshot(snapshotToJson(snapshot));
  check(restored !== null, "a snapshot round-trips through jsonb");
  check(restored?.html === html, "and renders byte-for-byte what was sent, from the snapshot alone");
  check(
    restored?.week.start === WEEK_B.start,
    "carrying the week it covers, not a month"
  );
  check(
    parseSnapshot({ version: 99, html: "x" }) === null,
    "an unrecognised snapshot is refused rather than silently recomputed"
  );
  check(parseSnapshot(null) === null, "and so is a missing one");

  // =========================================================================
  // SECTIONS — the shape everything now hangs off
  // =========================================================================
  console.log("\nSECTIONS ROUND-TRIP");
  const roundTripped = parseSections(sectionsToJson(SECTIONS));
  check(
    roundTripped.map((s) => s.key).join(",") === SECTIONS.map((s) => s.key).join(","),
    `sections survive a round trip through jsonb IN ORDER (${roundTripped.map((s) => s.key).join(",")})`
  );
  check(
    roundTripped.every(
      (s, i) =>
        s.body === SECTIONS[i].body &&
        s.title === SECTIONS[i].title &&
        s.generated_at === SECTIONS[i].generated_at &&
        s.edited_at === SECTIONS[i].edited_at
    ),
    "with every field intact, including who wrote it and when"
  );
  check(
    parseSections([{ key: "not_a_section", title: "x", body: "y" }] as never).length === 0,
    "an unrecognised key is dropped rather than kept as a section that renders nowhere"
  );
  check(
    parseSections(null).length === 0 && parseSections("nonsense" as never).length === 0,
    "and a malformed column reads as no sections rather than throwing"
  );

  console.log("\nGENERATE DOES NOT DESTROY EDITS");
  const edited = applyEdit(SECTIONS, "headline", "A human wrote this.", "2099-01-20T10:00:00.000Z");
  const editedHeadline = findSection(edited, "headline")!;
  check(
    editedHeadline.body === "A human wrote this." && editedHeadline.edited_at !== null,
    "saving an edit stamps edited_at, which is what protects it"
  );
  check(
    editedHeadline.generated_at === GEN_AT,
    "and keeps the record that the model wrote the previous version"
  );

  const regenerated = mergeGenerated(
    edited,
    { headline: "The model rewrote this.", watch_list: "New watch list." },
    "2099-01-21T09:00:00.000Z"
  );
  check(
    findSection(regenerated.sections, "headline")!.body === "A human wrote this.",
    "Generate newsletter LEAVES AN EDITED SECTION ALONE"
  );
  check(
    regenerated.keptEdited.join(",") === "headline",
    `and reports which it skipped, so the curator is not left thinking nothing happened (${regenerated.keptEdited.join(",")})`
  );
  check(
    findSection(regenerated.sections, "watch_list")!.body === "New watch list.",
    "while an unedited section IS filled"
  );
  check(
    regenerated.written.join(",") === "watch_list",
    `and is reported as written (${regenerated.written.join(",")})`
  );
  check(
    findSection(regenerated.sections, "regional")!.body === SECTIONS[1].body,
    "a section the model was not asked for is untouched"
  );

  console.log("\nREGENERATE TOUCHES ONLY ITS OWN SECTION");
  const forced = mergeGenerated(
    edited,
    { headline: "Rewritten on request." },
    "2099-01-21T09:00:00.000Z",
    "headline"
  );
  check(
    findSection(forced.sections, "headline")!.body === "Rewritten on request.",
    "asking for one section by name overrides the edit protection for that section"
  );
  check(
    findSection(forced.sections, "headline")!.edited_at === null,
    "and clears the edited mark, because a rewrite is giving up the edit"
  );
  check(
    findSection(forced.sections, "watch_list")!.body === SECTIONS[3].body &&
      findSection(forced.sections, "actions")!.body === SECTIONS[4].body,
    "and every other section is byte-identical"
  );

  console.log("\nEMPTY MEANS DROPPED, NOT BLANK");
  const emptied = mergeGenerated(SECTIONS, { watch_list: "   " }, GEN_AT);
  check(
    findSection(emptied.sections, "watch_list") === null,
    "a section the model returns empty is removed, not stored as a blank heading"
  );
  check(
    emptied.empty.join(",") === "watch_list",
    "and is reported as having had nothing to say"
  );
  check(
    applyEdit(SECTIONS, "actions", "", "2099-01-20T10:00:00.000Z").every(
      (s) => s.key !== "actions"
    ),
    "clearing the box by hand removes the section too — same instruction, same result"
  );

  console.log("\nA SAVED EDIT IS WHAT THE EMAIL RENDERS");
  const editedEdition = editionFrom(B_INPUT, edited);
  const editedHtml = renderEditionHtml(editedEdition, { baseUrl: null });
  check(
    editedHtml.includes("A human wrote this."),
    "the edited text is in the rendered email"
  );
  check(
    !editedHtml.includes(SECTIONS[0].body),
    "and the text it replaced is not"
  );

  console.log("\nTHE MODEL IS ONLY ASKED FOR WHAT THE DATA SUPPORTS");
  const rich = editionFrom({ ...B_INPUT, press: FIXTURES });
  const richKeys = requestableSlots(rich.generated).map((s) => s.key);
  check(
    richKeys.length === SECTION_SLOTS.length,
    `a week with figures AND articles supports every section (${richKeys.join(",")})`
  );
  // Week A has congestion but no reliability and no articles.
  const thinKeys = requestableSlots(a.generated).map((s) => s.key);
  check(
    !thinKeys.includes("reliability"),
    "a week with no reliability figures is never asked for a reliability note"
  );
  check(
    !thinKeys.includes("watch_list") && !thinKeys.includes("actions"),
    "and a week with no articles is never asked for a watch list or actions"
  );
  check(
    thinKeys.includes("headline") && thinKeys.includes("regional"),
    `while the sections its data DOES support are still asked for (${thinKeys.join(",")})`
  );
  check(
    requestableSlots(bare.generated).length === 0,
    "a week with nothing at all is asked for nothing, rather than being invited to invent an edition"
  );
}

// ===========================================================================
// The corpus tier — the window is a bounded date range, proved on real rows
//
// READ-ONLY. It writes nothing and therefore cleans nothing up, which is what
// lets it run under the service role without any of the caveats that would
// carry for a write.
//
// The corpus holds the perfect boundary case: 2026-08-09 is a Sunday with 3
// coded articles and 2026-08-10 a Monday with 28. If either end of the range is
// exclusive, or the window rolls, those 31 articles land in the wrong week or
// in both — and nobody notices for months.
// ===========================================================================

async function corpusChecks(admin: SupabaseClient<Database>) {
  console.log("\nWEEK BOUNDARY — REAL CORPUS, BOTH DIRECTIONS");
  const early = await loadEdition(admin, REAL_WEEK_EARLY, null);
  const late = await loadEdition(admin, REAL_WEEK_LATE, null);
  const earlyDates = early.input.press.map((p) => p.published_at!);
  const lateDates = late.input.press.map((p) => p.published_at!);

  check(
    earlyDates.includes("2026-08-09"),
    "an article dated the SUNDAY is in that week — the end of the range is inclusive"
  );
  check(!earlyDates.includes("2026-08-10"), "and one dated the following MONDAY is not");
  check(
    lateDates.includes("2026-08-10"),
    "an article dated the MONDAY is in the next week — the start of the range is inclusive"
  );
  check(!lateDates.includes("2026-08-09"), "and one dated the preceding SUNDAY is not");
  check(
    earlyDates.every((d) => d >= REAL_WEEK_EARLY.start && d <= REAL_WEEK_EARLY.end) &&
      lateDates.every((d) => d >= REAL_WEEK_LATE.start && d <= REAL_WEEK_LATE.end),
    "every article returned falls inside its own week's dates"
  );

  // The partition test. Two adjacent weeks must together equal the combined
  // range exactly: it fails if either end is exclusive (articles lost) or if
  // both weeks claim a shared boundary day (articles counted twice).
  const { count: combined } = await admin
    .from("articles")
    .select("id", { count: "exact", head: true })
    .eq("status", "active")
    .eq("coded_status", "coded")
    .not("published_at", "is", null)
    .gte("published_at", REAL_WEEK_EARLY.start)
    .lte("published_at", REAL_WEEK_LATE.end);
  check(
    earlyDates.length + lateDates.length === (combined ?? -1),
    `two adjacent weeks partition the range exactly — ${earlyDates.length} + ${lateDates.length} = ${combined}, nothing lost and nothing counted twice`
  );

  console.log("\nTHE WINDOW IS DATE-BOUNDED, NOT ROLLING");
  const firstIds = late.input.press.map((p) => p.id).sort().join(",");
  await new Promise((r) => setTimeout(r, 1200));
  const again = await loadEdition(admin, REAL_WEEK_LATE, null);
  check(
    again.input.press.map((p) => p.id).sort().join(",") === firstIds,
    "two calls separated in time return the identical set for the same week"
  );
  check(
    late.input.press.length > 0,
    `and it is a non-empty set, so the comparison means something (${late.input.press.length} articles)`
  );

  console.log("\nWEEK COUNTS FOR THE SELECTOR");
  const counts = await loadWeekCounts(admin, [REAL_WEEK_EARLY, REAL_WEEK_LATE]);
  check(
    counts[REAL_WEEK_LATE.start] === lateDates.length,
    `the selector's count matches what the edition would load (${counts[REAL_WEEK_LATE.start]} vs ${lateDates.length})`
  );
  check(
    counts[REAL_WEEK_EARLY.start] === earlyDates.length,
    `for the quiet week too (${counts[REAL_WEEK_EARLY.start]} vs ${earlyDates.length}) — which is the number the selector exists to show before the week is opened`
  );
}

// ===========================================================================
// The role tier — RLS, audit, and the freeze
// ===========================================================================

function anon(): SupabaseClient<Database> {
  return createClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
}

async function signIn(email: string, password: string) {
  const supabase = anon();
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`Sign-in failed for ${email}: ${error.message}`);
  const { data: role } = await supabase.rpc("current_app_role");
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return { supabase, role: role as string | null, id: user!.id };
}

async function databaseChecks() {
  const curate = await signIn(
    process.env.CHECK_CURATE_EMAIL!,
    process.env.CHECK_CURATE_PASSWORD!
  );
  const reader = await signIn(
    process.env.CHECK_READ_EMAIL!,
    process.env.CHECK_READ_PASSWORD!
  );
  console.log(`\ncurate role: ${curate.role}   read role: ${reader.role}`);
  check(curate.role === "curate", "curate fixture really has the curate role");
  check(
    reader.role === "read",
    `read fixture really has the read role (got ${reader.role}) — otherwise the write-gate results below prove nothing`
  );

  const stamp = () => ({ entered_by: curate.id, entered_at: new Date().toISOString() });
  const auditIds: string[] = [];

  try {
    console.log("\nWRITE GATE");
    const anonWrite = await anon().from("newsletter_editions").insert({ week_of: WEEK_A.start });
    check(anonWrite.error !== null, "a signed-out client cannot create an edition");

    const readInsert = await reader.supabase
      .from("newsletter_editions")
      .insert({ week_of: WEEK_A.start });
    check(readInsert.error !== null, "read role is refused an insert");

    const curateInsert = await curate.supabase.from("newsletter_editions").upsert(
      { week_of: WEEK_A.start, status: "draft", sections: sectionsToJson(SEED_SECTION), ...stamp() },
      { onConflict: "week_of" }
    );
    check(
      curateInsert.error === null,
      `curate role CAN create an edition${curateInsert.error ? ` — ${curateInsert.error.message}` : ""}`
    );

    await reader.supabase
      .from("newsletter_editions")
      .update({ sections: sectionsToJson(TAMPERED_SECTION) })
      .eq("week_of", WEEK_A.start);
    const { data: afterReadUpdate } = await reader.supabase
      .from("newsletter_editions")
      .select("sections")
      .eq("week_of", WEEK_A.start)
      .maybeSingle();
    check(
      bodyOf(afterReadUpdate?.sections) === "seed",
      "read role cannot rewrite a draft's authored text"
    );
    check(
      afterReadUpdate !== null,
      "read role CAN read an edition — the panel is readable by every role"
    );

    console.log("\nAUDIT");
    const audit = await curate.supabase
      .from("audit_log")
      .insert({
        actor_id: curate.id,
        action: "newsletter.update",
        target_type: "newsletter_edition",
        metadata: { week_of: WEEK_A.start, note: "check fixture" },
      })
      .select("id");
    check(audit.error === null, "curate CAN write the audit row the action writes");
    for (const row of audit.data ?? []) auditIds.push(row.id);

    const forged = await curate.supabase.from("audit_log").insert({
      actor_id: "00000000-0000-0000-0000-000000000000",
      action: "newsletter.update",
      target_type: "newsletter_edition",
    });
    check(forged.error !== null, "an audit row cannot be attributed to another user");

    console.log("\nOPERATIONAL ROWS RESPECT THE SAME BOUNDARY");
    // The Sunday of week A and the Monday of week B, one either side.
    for (const [day, teu] of [
      [A_DAYS[0], 1000],
      [A_DAYS[1], 1200],
      [A_SUNDAY, 1500],
      [B_MONDAY, 9999],
    ] as const) {
      await curate.supabase
        .from("operational_congestion")
        .upsert({ day_of: day, global_teu_waiting: teu, ...stamp() }, { onConflict: "day_of" });
    }
    await curate.supabase
      .from("operational_congestion")
      .upsert({ day_of: OUTSIDE_DAY, global_teu_waiting: 1, ...stamp() }, { onConflict: "day_of" });

    const loadedA = await loadEdition(curate.supabase, WEEK_A, null);
    check(
      loadedA.input.congestion.length === 3,
      `week A reads back its 3 entered days (${loadedA.input.congestion.length})`
    );
    check(
      loadedA.input.congestion.some((r) => r.day_of === A_SUNDAY),
      "including the Sunday"
    );
    check(
      !loadedA.input.congestion.some((r) => r.day_of === B_MONDAY),
      "and excluding the following Monday"
    );
    const liveA = buildGenerated(loadedA.input);
    check(
      liveA.glance.find((r) => r.key === "teu_waiting")?.asAt === A_SUNDAY,
      "so the live read picks the Sunday as the week's latest day"
    );

    const loadedB = await loadEdition(curate.supabase, WEEK_B, null);
    const liveB = buildGenerated(loadedB.input);
    const bDelta = liveB.glance.find((r) => r.key === "teu_waiting")!.delta;
    check(
      bDelta.kind === "change" && bDelta.prior.asAt === A_SUNDAY,
      `a delta spanning the boundary compares against the prior week's Sunday (${
        bDelta.kind === "change" ? bDelta.prior.asAt : bDelta.kind
      })`
    );

    console.log("\nPRESS EXCLUSIONS PERSIST");
    await curate.supabase
      .from("newsletter_editions")
      .update({ included_article_ids: WITHOUT_NEWEST })
      .eq("week_of", WEEK_A.start);
    const { data: reread } = await curate.supabase
      .from("newsletter_editions")
      .select("included_article_ids")
      .eq("week_of", WEEK_A.start)
      .maybeSingle();
    const recomputed = selectPress(FIXTURES, reread?.included_article_ids ?? null);
    check(
      !recomputed.themes.some((t) => t.items.some((i) => i.id === "three-themes")),
      "an exclusion survives a recompute, read back out of included_article_ids"
    );
    check(
      recomputed.shown === selectPress(FIXTURES, WITHOUT_NEWEST).shown,
      `and the recomputed selection matches the one the curator approved (${recomputed.shown} items)`
    );

    console.log("\nTHE FREEZE");
    const sent = editionFrom({ ...B_INPUT, week: SENT_WEEK });
    const sentHtml = renderEditionHtml(sent, { baseUrl: null });
    const snapshot = buildSnapshot({
      edition: sent,
      subject: subjectLine(SENT_WEEK),
      html: sentHtml,
      sentAt: new Date().toISOString(),
      sentByName: "Check fixture",
    });

    await curate.supabase.from("newsletter_editions").upsert(
      { week_of: SENT_WEEK.start, status: "draft", sections: sectionsToJson(BEFORE_SEND_SECTION), ...stamp() },
      { onConflict: "week_of" }
    );
    const flip = await curate.supabase
      .from("newsletter_editions")
      .update({
        status: "sent",
        snapshot: snapshotToJson(snapshot),
        sent_at: snapshot.sentAt,
        sent_by: curate.id,
      })
      .eq("week_of", SENT_WEEK.start)
      .eq("status", "draft")
      .select("id");
    check(
      flip.error === null && (flip.data?.length ?? 0) === 1,
      `curate can send a draft once${flip.error ? ` — ${flip.error.message}` : ""}`
    );

    const tamper = await curate.supabase
      .from("newsletter_editions")
      .update({ sections: sectionsToJson(TAMPERED_SECTION) })
      .eq("week_of", SENT_WEEK.start);
    check(
      tamper.error !== null,
      `an update to a SENT edition is refused by the DATABASE — ${
        tamper.error ? tamper.error.message : "IT SUCCEEDED, which is a hole"
      }`
    );
    check(
      tamper.error?.code === "42501",
      `and as a permission error the app can surface (${tamper.error?.code})`
    );

    const resend = await curate.supabase
      .from("newsletter_editions")
      .update({ status: "sent", sent_at: new Date().toISOString() })
      .eq("week_of", SENT_WEEK.start)
      .eq("status", "draft")
      .select("id");
    check(
      (resend.data?.length ?? 0) === 0,
      "a second send matches no row rather than overwriting the first snapshot"
    );

    await curate.supabase.from("newsletter_editions").delete().eq("week_of", SENT_WEEK.start);
    const { data: frozenRow } = await reader.supabase
      .from("newsletter_editions")
      .select("sections, snapshot, status")
      .eq("week_of", SENT_WEEK.start)
      .maybeSingle();
    check(
      frozenRow?.status === "sent",
      "a sent edition cannot be deleted and re-created either, which would rebuild the same false record"
    );
    check(
      bodyOf(frozenRow?.sections) === "before send",
      "and the authored text survived the refused rewrite intact"
    );
    check(
      parseSnapshot(frozenRow?.snapshot ?? null)?.html === sentHtml,
      "the stored snapshot still renders exactly what was sent"
    );
  } finally {
    // Cleanup, on success and on failure. The service role is the only caller
    // the freeze trigger exempts from DELETE, and only for that branch — see
    // migration 0028.
    const admin = createClient<Database>(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    );
    await admin.from("newsletter_editions").delete().in("week_of", ALL_WEEKS);
    await admin.from("operational_port_congestion").delete().in("day_of", ALL_DAYS);
    await admin.from("operational_fleet_status").delete().in("day_of", ALL_DAYS);
    await admin.from("operational_congestion").delete().in("day_of", ALL_DAYS);
    await admin
      .from("operational_schedule_reliability")
      .delete()
      .in("month_of", ["2098-12-01", "2099-01-01", "2099-06-01"]);
    // Only the rows this script inserted, by id. Deleting every
    // 'newsletter.update' row would take real history with it.
    if (auditIds.length > 0) await admin.from("audit_log").delete().in("id", auditIds);

    const { count: editions } = await admin
      .from("newsletter_editions")
      .select("id", { count: "exact", head: true })
      .in("week_of", ALL_WEEKS);
    const { count: days } = await admin
      .from("operational_congestion")
      .select("id", { count: "exact", head: true })
      .in("day_of", ALL_DAYS);
    console.log(`\nCleanup — 2099 editions left: ${editions ?? 0}   2099 congestion rows left: ${days ?? 0}`);
  }
}

// ===========================================================================

async function main() {
  logicChecks();

  const skipped: string[] = [];

  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (serviceKey) {
    await corpusChecks(
      createClient<Database>(process.env.NEXT_PUBLIC_SUPABASE_URL!, serviceKey)
    );
  } else {
    skipped.push(
      [
        "CORPUS TIER DID NOT RUN — no SUPABASE_SERVICE_ROLE_KEY.",
        "  * whether the week window is a bounded date range in the QUERY",
        "  * whether the Sunday and the Monday land in the right weeks",
        "  * whether two adjacent weeks partition the range without loss or overlap",
      ].join("\n")
    );
  }

  const haveFixtures =
    process.env.CHECK_CURATE_EMAIL &&
    process.env.CHECK_CURATE_PASSWORD &&
    process.env.CHECK_READ_EMAIL &&
    process.env.CHECK_READ_PASSWORD;
  if (haveFixtures) {
    await databaseChecks();
  } else {
    skipped.push(
      [
        "ROLE TIER DID NOT RUN — no role fixtures.",
        "  * a read user is refused every write to newsletter_editions",
        "  * a curate user is allowed one",
        "  * an audit row cannot be attributed to another user",
        "  * an update to a SENT edition is refused by the database itself",
        "  * a press exclusion survives a round trip through included_article_ids",
        "",
        "  Set CHECK_CURATE_EMAIL / CHECK_CURATE_PASSWORD and",
        "  CHECK_READ_EMAIL / CHECK_READ_PASSWORD and run again.",
      ].join("\n")
    );
  }

  if (skipped.length > 0) {
    console.log(`\n${skipped.join("\n\n")}`);
  }

  const ok = failures === 0 && skipped.length === 0;
  console.log(
    failures > 0
      ? `\n${failures} of ${ran} FAILED.`
      : ok
        ? `\nAll ${ran} newsletter checks passed.`
        : `\n${ran} checks passed, but ${skipped.length} tier${
            skipped.length === 1 ? "" : "s"
          } did not run — see above.`
  );
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
