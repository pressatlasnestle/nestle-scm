/**
 * The monthly edition: stock deltas, press grouping, the email HTML's hard
 * constraints, the role gates and the freeze.
 *
 *   CHECK_CURATE_EMAIL=... CHECK_CURATE_PASSWORD=... \
 *   CHECK_READ_EMAIL=...   CHECK_READ_PASSWORD=... \
 *   npx tsx --env-file=.env.local scripts/checks/newsletter.ts
 *
 * TWO HALVES, and only one of them needs a database.
 *
 * The LOGIC half — deltas, section presence, press grouping, and the email
 * HTML's no-svg/no-class/no-link rules — is a property of pure functions over
 * fixture rows, so it runs on its own with no credentials and no network. That
 * matters for the HTML rules in particular: they are the regression that breaks
 * silently months from now, they are one string search each, and gating them
 * behind two sets of sign-in credentials would be the surest way to stop them
 * ever running.
 *
 * The DATABASE half — who may write, whether an audit row can be forged, and
 * whether a sent edition is really frozen — signs in as REAL users of each role
 * rather than using the service role, because the properties under test are the
 * RLS policy and the trigger themselves. A service-role run would pass whether
 * or not either existed.
 *
 * When the fixtures are absent the database half does not run, and the script
 * says exactly what went unproven and exits non-zero. A check that quietly
 * skips its own subject is worse than one that fails.
 *
 * Everything the database half writes uses year-2099 months that no real
 * edition will cover, and is removed again at the end — on success and on
 * failure alike. IT WRITES NO ARTICLES: the press rules are pure, so they are
 * tested against fixtures rather than by pushing invented stories into the live
 * corpus, where a cleanup failure would leave fake coverage in a client-facing
 * report.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../../src/types/database.types";
import type {
  CongestionRow,
  FleetStatusRow,
  PortCongestionRow,
  ScheduleReliabilityRow,
} from "../../src/lib/analysis/operational";
import { monthFromIso, previousMonth, type Month } from "../../src/lib/newsletter/month";
import {
  buildGenerated,
  deltaBetween,
  formatDelta,
  readAuthored,
  sectionStates,
  subjectLine,
  SECTION_TITLES,
  type Authored,
  type Edition,
  type EditionInput,
} from "../../src/lib/newsletter/edition";
import { loadEdition } from "../../src/lib/newsletter/load";
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

// Year-2099 months. JAN has data and no history before it; FEB has data and a
// prior month; APR has data with an EMPTY March in between, which is the third
// delta case and the one most easily collapsed into "first edition".
const JAN = monthFromIso("2099-01-01");
const FEB = monthFromIso("2099-02-01");
const APR = monthFromIso("2099-04-01");
const SENT_MONTH = monthFromIso("2099-06-01");
const ALL_MONTHS = [JAN.start, FEB.start, "2099-03-01", APR.start, SENT_MONTH.start];

const JAN_DAYS = ["2099-01-05", "2099-01-12", "2099-01-20"];
const FEB_DAY = "2099-02-03";
const OUTSIDE_DAY = "2099-05-11"; // proves the month query is bounded
const ALL_DAYS = [...JAN_DAYS, FEB_DAY, "2099-04-09", OUTSIDE_DAY];

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
    day_of: FEB_DAY,
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
    day_of: FEB_DAY,
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

const RELIABILITY: ScheduleReliabilityRow = {
  month_of: FEB.start,
  glp_issue_number: 999,
  global_reliability_pct: 61,
  avg_delay_days: 4.5,
  alliance_data: { "Gemini Cooperation": 90, "Ocean Alliance": 60 },
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

/** Three days entered in January, the newest being the 20th — not month-end. */
const JAN_CONGESTION = [
  congestion(JAN_DAYS[0], 1000, { north_asia: 500, europe: 250 }),
  congestion(JAN_DAYS[1], 1200, { north_asia: 600, europe: 300 }),
  congestion(JAN_DAYS[2], 1500, { north_asia: 750, europe: 375 }),
];

const JAN_INPUT: EditionInput = {
  ...EMPTY_INPUT,
  month: JAN,
  congestion: JAN_CONGESTION,
  hasHistoryBefore: false,
};

const FEB_INPUT: EditionInput = {
  ...EMPTY_INPUT,
  month: FEB,
  congestion: [congestion(FEB_DAY, 1800, { north_asia: 900, europe: 450 })],
  priorCongestion: JAN_CONGESTION,
  fleet: FLEET,
  ports: PORTS,
  reliability: RELIABILITY,
  hasHistoryBefore: true,
};

/** April, with an empty March between it and February. */
const APR_INPUT: EditionInput = {
  ...EMPTY_INPUT,
  month: APR,
  congestion: [congestion("2099-04-09", 2000, {})],
  hasHistoryBefore: true,
};

const AUTHORED: Authored = {
  headlineRead: "Test read for a year-2099 month. Not a real edition.",
  regionalCommentary: "Test regional commentary.",
  reliabilityNote: "Test reliability note.",
  watchList: [
    { risk: "Test risk", lanes: "Test lane", window: "Q1", direction: "Widening" },
  ],
  recommendedActions: ["Test action one", "Test action two"],
};

function editionFrom(input: EditionInput, authored = AUTHORED): Edition {
  const generated = buildGenerated(input);
  return { generated, authored, sections: sectionStates(generated, authored) };
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

/**
 * `three-themes` carries all three and must appear exactly once, filed under
 * the busiest. Chokepoints gets six articles so the per-theme cap has something
 * to hold back.
 */
const FIXTURES: PressCandidate[] = [
  article("three-themes", "Carries three themes", [CHOKE, DISRUPT, PORTS_THEME], "2099-01-20"),
  article("choke-2", "Chokepoint two", [CHOKE], "2099-01-19"),
  article("choke-3", "Chokepoint three", [CHOKE], "2099-01-18"),
  article("choke-4", "Chokepoint four", [CHOKE], "2099-01-17"),
  article("choke-5", "Chokepoint five", [CHOKE], "2099-01-16"),
  article("choke-6", "Chokepoint six", [CHOKE], "2099-01-15"),
  article("disrupt-2", "Disruption two", [DISRUPT], "2099-01-14"),
];

const FIXTURE_IDS = FIXTURES.map((f) => f.id);
const WITHOUT_NEWEST = FIXTURE_IDS.filter((id) => id !== "three-themes");

// ===========================================================================
// The logic half — no database
// ===========================================================================

function logicChecks() {
  console.log("MONTHS");
  check(previousMonth(JAN).start === "2098-12-01", "January's prior month crosses the year");
  check(monthFromIso("2099-02-01").end === "2099-02-28", "February 2099 ends on the 28th");
  check(monthFromIso("2096-02-01").end === "2096-02-29", "and a leap February ends on the 29th");
  check(
    subjectLine(FEB) === "Ocean Freight Update — AOA | February 2099",
    `the subject line keeps the series' shape ("${subjectLine(FEB)}")`
  );

  console.log("\nSTOCKS, NOT FLOWS");
  const jan = editionFrom(JAN_INPUT);
  const teu = jan.generated.glance.find((r) => r.key === "teu_waiting")!;
  check(
    teu.value === 1500 && teu.asAt === JAN_DAYS[2],
    `the month's figure is the LATEST entered day (${teu.value} as at ${teu.asAt})`
  );
  check(
    teu.value !== (1000 + 1200 + 1500) / 3 && teu.value !== 1000 + 1200 + 1500,
    "and is neither the mean nor the total of the three days, so this is not a coincidence"
  );

  console.log("\nDELTAS — THREE KINDS OF ANSWER");
  check(
    teu.delta.kind === "first-edition",
    `a month with nothing before it has no comparison (${teu.delta.kind})`
  );
  check(
    formatDelta(teu.delta) === "first edition",
    `and it reads "first edition" — never 0%, never a dash ("${formatDelta(teu.delta)}")`
  );

  const feb = editionFrom(FEB_INPUT);
  const febTeu = feb.generated.glance.find((r) => r.key === "teu_waiting")!;
  check(
    febTeu.delta.kind === "change" && febTeu.delta.prior.value === 1500,
    "February compares against January's LATEST day, not its first or its last calendar day"
  );
  check(
    febTeu.delta.kind === "change" && febTeu.delta.prior.asAt === JAN_DAYS[2],
    `and carries the date it compared against (${
      febTeu.delta.kind === "change" ? febTeu.delta.prior.asAt : "none"
    })`
  );
  check(formatDelta(febTeu.delta) === "▲ 20%", `1500 → 1800 is +20% (${formatDelta(febTeu.delta)})`);

  const apr = editionFrom(APR_INPUT);
  const aprTeu = apr.generated.glance.find((r) => r.key === "teu_waiting")!;
  check(
    aprTeu.delta.kind === "no-prior",
    `an empty prior month is its own case, not "first edition" (${aprTeu.delta.kind})`
  );
  check(
    formatDelta(aprTeu.delta) === "no March 2099 figure",
    `and it names the month it could not find ("${formatDelta(aprTeu.delta)}")`
  );

  const fromZero = deltaBetween(
    { value: 5, asAt: "2099-01-20" },
    { value: 0, asAt: "2098-12-20" },
    JAN,
    true
  );
  check(
    fromZero.kind === "change" && fromZero.percent === null,
    "a rise from zero has no percentage, and says so rather than printing Infinity"
  );

  console.log("\nABSENT IS NOT ZERO");
  const bare = editionFrom({ ...EMPTY_INPUT, month: JAN, hasHistoryBefore: false }, AUTHORED);
  check(bare.generated.glance.length === 0, "a month with no figures produces no glance rows");
  check(
    bare.sections.filter((s) => s.present).map((s) => s.key).join(",") ===
      "headline,watchList,actions",
    `only the authored sections survive an empty month (${bare.sections
      .filter((s) => s.present)
      .map((s) => s.key)
      .join(",")})`
  );
  check(
    bare.sections.every((s) => s.present || (s.reason?.length ?? 0) > 0),
    "and every dropped section says why, for the draft view"
  );

  console.log("\nSECTIONS PRESENT AND ABSENT IN THE RENDERED EMAIL");
  const janHtml = renderEditionHtml(jan, { baseUrl: "https://example.invalid" });
  const febHtml = renderEditionHtml(feb, { baseUrl: "https://example.invalid" });

  for (const key of ["ports", "fleet", "reliability"] as const) {
    check(
      !janHtml.includes(SECTION_TITLES[key]),
      `January entered no ${SECTION_TITLES[key].toLowerCase()} data, so "${SECTION_TITLES[key]}" is absent from the HTML entirely`
    );
  }
  check(
    janHtml.includes(SECTION_TITLES.glance) && janHtml.includes(SECTION_TITLES.regional),
    "the sections January DOES have are present, so the absences above are not a blank render"
  );
  check(
    janHtml.includes("as at 20 Jan"),
    "the partial month carries its reading date into the email"
  );
  check(janHtml.includes("first edition"), 'and its delta cells read "first edition"');
  check(
    !/data not available|not available|n\/a/i.test(janHtml),
    "no section is padded with a placeholder row"
  );
  for (const key of ["ports", "fleet", "reliability"] as const) {
    check(
      febHtml.includes(SECTION_TITLES[key]),
      `February entered ${SECTION_TITLES[key].toLowerCase()} data, so its heading IS present`
    );
  }
  check(
    febHtml.includes("3.5") && !febHtml.includes("3.526"),
    "the queue / berth ratio is printed as published (3.50), never as the 3.526 the ship counts would give"
  );
  check(
    febHtml.includes("OVERLAP"),
    "the fleet section says its categories overlap, so nobody totals them"
  );

  console.log("\nEMAIL HTML CONSTRAINTS");
  for (const [html, label] of [
    [janHtml, "January"],
    [febHtml, "February"],
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
    janHtml.length > 2000,
    `the rendered email is a real document, not an empty shell (${janHtml.length} bytes)`
  );
  check(
    (febHtml.match(/<table/g) ?? []).length > 8,
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
    nothingKept.themes.every((t) => t.items.length === 0),
    "the themes survive for the composer's toggles, but carry no rendered item"
  );
  check(
    !renderEditionHtml(editionFrom({ ...EMPTY_INPUT, month: FEB, hasHistoryBefore: true, press: FIXTURES, includedArticleIds: [] }), {
      baseUrl: null,
    }).includes(SECTION_TITLES.press),
    "and the press section is absent from the email entirely"
  );

  console.log("\nNEAR-DUPLICATE SUPPRESSION");
  // The real failure: one story captured twice because two standing Google
  // Alert queries each returned it. Ingestion is right to keep both — different
  // provenance — but rendering both reads as padding.
  const twice: PressCandidate[] = [
    article("cap-a", "Asian port congestion forcing container lines back to the Red Sea", [CHOKE], "2099-01-20"),
    article("cap-b", "Asian port congestion forcing container lines back to the Red Sea - Seatrade Maritime News", [CHOKE], "2099-01-20"),
    article("distinct", "Maersk and Hapag-Lloyd return more services to the Suez Canal", [CHOKE], "2099-01-19"),
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

  // The cross-theme case, which is where the repeats actually turn up: the two
  // captures often carry different ai_themes and are filed apart, so a
  // within-theme pass alone never sees them.
  const acrossThemes = selectPress(
    [
      article("x-a", "Hapag-Lloyd's $4.2B ZIM deal faces growing opposition in Israel", [CHOKE], "2099-01-20"),
      article("x-b", "Hapag-Lloyd's $4.2B ZIM deal faces growing opposition in Israel", [DISRUPT], "2099-01-20"),
      article("x-c", "Chokepoint filler", [CHOKE], "2099-01-19"),
      article("x-d", "Disruption filler", [DISRUPT], "2099-01-18"),
    ],
    null
  );
  const printed = acrossThemes.themes.flatMap((t) => t.items.map((i) => i.id));
  check(
    printed.filter((id) => id === "x-a" || id === "x-b").length === 1,
    `one story filed under two themes is printed once (${printed.join(",")})`
  );
  check(
    acrossThemes.themes
      .flatMap((t) => t.nearDuplicates.map((i) => i.id))
      .includes("x-b"),
    "and the copy in the quieter theme is the one suppressed, so the reader meets it in the busier one"
  );
  check(
    acrossThemes.themes.every((t) => t.items.length > 0 || t.nearDuplicates.length > 0),
    "no theme is left as a heading over nothing"
  );
  // Counted on the link, not the headline text: the fixtures build each summary
  // out of its own headline, so a naive text count sees every item twice.
  const crossHtml = renderEditionHtml(
    editionFrom({
      ...EMPTY_INPUT,
      month: FEB,
      hasHistoryBefore: true,
      press: [
        article("y-a", "One story filed under two different themes entirely", [CHOKE], "2099-01-20"),
        article("y-b", "One story filed under two different themes entirely", [DISRUPT], "2099-01-20"),
      ],
    }),
    { baseUrl: null }
  );
  check(
    (crossHtml.match(/example\.invalid\/y-/g) ?? []).length === 1,
    `and the rendered email links that story exactly once (${
      (crossHtml.match(/example\.invalid\/y-/g) ?? []).length
    })`
  );

  console.log("\nOUTLET ATTRIBUTION");
  const ALERT = 'Google Alert - "Red Sea" ("ocean freight" OR "container shipping")';
  check(
    outletName(ALERT) === null,
    "a Google Alert query is not an outlet, so it is never printed as a byline"
  );
  check(outletName("The Loadstar") === "The Loadstar", "a real outlet name survives untouched");
  check(outletName("  ") === null && outletName(null) === null, "and a blank one is an absence");

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
    `the source count counts NAMED outlets only, so a search query is not a publication (${mixedOutlets.outlets})`
  );
  const alertItem = mixedOutlets.themes
    .flatMap((t) => t.items)
    .find((i) => i.id === "m2");
  check(
    alertItem?.media === null,
    "and the item it belongs to renders with no byline rather than an invented one"
  );
  const alertHtml = renderEditionHtml(
    editionFrom({ ...EMPTY_INPUT, month: FEB, hasHistoryBefore: true, press: [{ ...FIXTURES[0], media: ALERT }] }),
    { baseUrl: null }
  );
  check(
    !alertHtml.includes("Google Alert"),
    "and no alert query reaches the rendered email"
  );

  console.log("\nTHE SNAPSHOT");
  const html = renderEditionHtml(feb, { baseUrl: null });
  const snapshot = buildSnapshot({
    edition: feb,
    subject: subjectLine(FEB),
    html,
    sentAt: "2099-03-01T09:00:00.000Z",
    sentByName: "Check fixture",
  });
  const restored = parseSnapshot(snapshotToJson(snapshot));
  check(restored !== null, "a snapshot round-trips through jsonb");
  check(
    restored?.html === html,
    "and renders byte-for-byte what was sent, from the snapshot alone"
  );
  check(
    restored?.generated.glance.length === feb.generated.glance.length,
    "carrying the figures as structure, not only as markup"
  );
  check(
    parseSnapshot({ version: 99, html: "x" }) === null,
    "an unrecognised snapshot is refused rather than silently recomputed"
  );
  check(parseSnapshot(null) === null, "and so is a missing one");
  check(
    readAuthored({
      headline_read: "kept",
      regional_commentary: null,
      reliability_note: null,
      watch_list: null,
      recommended_actions: null,
    }).watchList.length === 0,
    "a null watch_list degrades to no entries rather than to a blank card"
  );
  check(
    readAuthored({
      headline_read: null,
      regional_commentary: null,
      reliability_note: null,
      watch_list: [{ risk: "", lanes: "", window: "", direction: "" }],
      recommended_actions: ["", "  ", "real"],
    }).recommendedActions.join("|") === "real",
    "and blank authored rows are dropped rather than sent as empty cards"
  );
}

// ===========================================================================
// The database half — RLS, audit, and the freeze
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
    const anonWrite = await anon().from("newsletter_editions").insert({ month_of: JAN.start });
    check(anonWrite.error !== null, "a signed-out client cannot create an edition");

    const readInsert = await reader.supabase
      .from("newsletter_editions")
      .insert({ month_of: JAN.start });
    check(readInsert.error !== null, "read role is refused an insert");

    const curateInsert = await curate.supabase.from("newsletter_editions").upsert(
      { month_of: JAN.start, status: "draft", headline_read: "seed", ...stamp() },
      { onConflict: "month_of" }
    );
    check(
      curateInsert.error === null,
      `curate role CAN create an edition${curateInsert.error ? ` — ${curateInsert.error.message}` : ""}`
    );

    await reader.supabase
      .from("newsletter_editions")
      .update({ headline_read: "tampered" })
      .eq("month_of", JAN.start);
    const { data: afterReadUpdate } = await reader.supabase
      .from("newsletter_editions")
      .select("headline_read")
      .eq("month_of", JAN.start)
      .maybeSingle();
    check(
      afterReadUpdate?.headline_read === "seed",
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
        metadata: { month_of: JAN.start, note: "check fixture" },
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

    console.log("\nTHE MONTH QUERY IS BOUNDED");
    for (const [day, teu] of [
      [JAN_DAYS[0], 1000],
      [JAN_DAYS[1], 1200],
      [JAN_DAYS[2], 1500],
    ] as const) {
      await curate.supabase
        .from("operational_congestion")
        .upsert({ day_of: day, global_teu_waiting: teu, ...stamp() }, { onConflict: "day_of" });
    }
    // A day in a different month, which the January read must not pick up.
    await curate.supabase
      .from("operational_congestion")
      .upsert({ day_of: OUTSIDE_DAY, global_teu_waiting: 9999, ...stamp() }, { onConflict: "day_of" });

    const loaded = await loadEdition(curate.supabase, JAN, null);
    check(
      loaded.input.congestion.length === 3,
      `January reads back the 3 days entered, not 31 and not the whole table (${loaded.input.congestion.length})`
    );
    check(
      !loaded.input.congestion.some((r) => r.day_of === OUTSIDE_DAY),
      "and a day outside the month is not in it"
    );
    const live = buildGenerated(loaded.input);
    check(
      live.glance.find((r) => r.key === "teu_waiting")?.asAt === JAN_DAYS[2],
      "the live read picks the same latest day the fixtures do"
    );

    console.log("\nPRESS EXCLUSIONS PERSIST");
    await curate.supabase
      .from("newsletter_editions")
      .update({ included_article_ids: WITHOUT_NEWEST })
      .eq("month_of", JAN.start);
    const { data: reread } = await curate.supabase
      .from("newsletter_editions")
      .select("included_article_ids")
      .eq("month_of", JAN.start)
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
    const sent = editionFrom({ ...FEB_INPUT, month: SENT_MONTH });
    const sentHtml = renderEditionHtml(sent, { baseUrl: null });
    const snapshot = buildSnapshot({
      edition: sent,
      subject: subjectLine(SENT_MONTH),
      html: sentHtml,
      sentAt: new Date().toISOString(),
      sentByName: "Check fixture",
    });

    await curate.supabase.from("newsletter_editions").upsert(
      { month_of: SENT_MONTH.start, status: "draft", headline_read: "before send", ...stamp() },
      { onConflict: "month_of" }
    );
    const flip = await curate.supabase
      .from("newsletter_editions")
      .update({
        status: "sent",
        snapshot: snapshotToJson(snapshot),
        sent_at: snapshot.sentAt,
        sent_by: curate.id,
      })
      .eq("month_of", SENT_MONTH.start)
      .eq("status", "draft")
      .select("id");
    check(
      flip.error === null && (flip.data?.length ?? 0) === 1,
      `curate can send a draft once${flip.error ? ` — ${flip.error.message}` : ""}`
    );

    const tamper = await curate.supabase
      .from("newsletter_editions")
      .update({ headline_read: "rewritten after sending" })
      .eq("month_of", SENT_MONTH.start);
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
      .eq("month_of", SENT_MONTH.start)
      .eq("status", "draft")
      .select("id");
    check(
      (resend.data?.length ?? 0) === 0,
      "a second send matches no row rather than overwriting the first snapshot"
    );

    await curate.supabase.from("newsletter_editions").delete().eq("month_of", SENT_MONTH.start);
    const { data: frozenRow } = await reader.supabase
      .from("newsletter_editions")
      .select("headline_read, snapshot, status")
      .eq("month_of", SENT_MONTH.start)
      .maybeSingle();
    check(
      frozenRow?.status === "sent",
      "a sent edition cannot be deleted and re-created either, which would rebuild the same false record"
    );
    check(
      frozenRow?.headline_read === "before send",
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
    await admin.from("newsletter_editions").delete().in("month_of", ALL_MONTHS);
    await admin.from("operational_port_congestion").delete().in("day_of", ALL_DAYS);
    await admin.from("operational_fleet_status").delete().in("day_of", ALL_DAYS);
    await admin.from("operational_congestion").delete().in("day_of", ALL_DAYS);
    await admin.from("operational_schedule_reliability").delete().in("month_of", ALL_MONTHS);
    // Only the rows this script inserted, by id. Deleting every
    // 'newsletter.update' row would take real history with it.
    if (auditIds.length > 0) await admin.from("audit_log").delete().in("id", auditIds);

    const { count: editions } = await admin
      .from("newsletter_editions")
      .select("id", { count: "exact", head: true })
      .in("month_of", ALL_MONTHS);
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

  const haveFixtures =
    process.env.CHECK_CURATE_EMAIL &&
    process.env.CHECK_CURATE_PASSWORD &&
    process.env.CHECK_READ_EMAIL &&
    process.env.CHECK_READ_PASSWORD;

  if (haveFixtures) {
    await databaseChecks();
  } else {
    console.log(
      [
        "",
        "DATABASE HALF DID NOT RUN — no role fixtures.",
        "",
        "Unproven, and only provable by signing in as real users:",
        "  * a read user is refused every write to newsletter_editions",
        "  * a curate user is allowed one",
        "  * an audit row cannot be attributed to another user",
        "  * an update to a SENT edition is refused by the database itself",
        "  * a press exclusion survives a round trip through included_article_ids",
        "",
        "Set CHECK_CURATE_EMAIL / CHECK_CURATE_PASSWORD and",
        "CHECK_READ_EMAIL / CHECK_READ_PASSWORD and run again.",
      ].join("\n")
    );
  }

  const ok = failures === 0 && Boolean(haveFixtures);
  console.log(
    failures > 0
      ? `\n${failures} of ${ran} FAILED.`
      : haveFixtures
        ? `\nAll ${ran} newsletter checks passed.`
        : `\n${ran} logic checks passed, but the database half did not run — see above.`
  );
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
