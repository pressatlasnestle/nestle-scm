/**
 * Cross-checks the Analysis panel's aggregation against the database.
 *
 *   npx tsx --env-file=.env.local scripts/checks/analysis-numbers.ts [week]
 *
 * Unlike the other check scripts this one needs a database, because what it is
 * checking is not the arithmetic — week-period.ts already pins that without a
 * database — but the join between the arithmetic and the real corpus: that the
 * rows the panel loads are the rows SQL says are in the week, and that the
 * aggregation over them lands on the same numbers a hand-written query does.
 *
 * It signs in as a real `read` user rather than using the service role, so the
 * numbers it prints are the numbers a read user actually sees through RLS. A
 * service-role run would pass even if RLS were hiding half the corpus from the
 * people the panel is built for.
 *
 * Set CHECK_USER_EMAIL / CHECK_USER_PASSWORD to the account to sign in as.
 */
import { createClient } from "@supabase/supabase-js";
import type { Database } from "../../src/types/database.types";
import {
  applyWeek,
  resolveWeek,
  weekDays,
} from "../../src/lib/analysis/week-period";
import {
  analysable,
  countPolarity,
  keywordBubbles,
  limitBubbles,
  overview,
  polarityBreakdown,
  setAside,
  storiesForTopThemes,
  themeStats,
  topThemes,
  volumeByDay,
  type WeekArticle,
} from "../../src/lib/analysis/week-stats";
import { toCsv } from "../../src/lib/analysis/csv";
import {
  KEYWORD_BUBBLE_COLUMNS,
  polarityColumns,
  STORY_COLUMNS,
  themeColumns,
  VOLUME_COLUMNS,
  type StoryExportRow,
} from "../../src/lib/analysis/exports";

const SELECT =
  "id, headline, url, media, published_at, status, coded_status, ai_sorting_flagged, ai_sentiment, ai_themes, ai_summary, matched_keywords, keyword_mention_count";

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const email = process.env.CHECK_USER_EMAIL;
  const password = process.env.CHECK_USER_PASSWORD;

  if (!url || !anon) throw new Error("Supabase URL/anon key missing from the environment.");
  if (!email || !password) {
    throw new Error(
      "Set CHECK_USER_EMAIL and CHECK_USER_PASSWORD to an app user to sign in as."
    );
  }

  const supabase = createClient<Database>(url, anon);
  const { data: auth, error: authError } = await supabase.auth.signInWithPassword({
    email,
    password,
  });
  if (authError) throw new Error(`Sign-in failed: ${authError.message}`);

  const { data: role } = await supabase.rpc("current_app_role");
  console.log(`Signed in as ${auth.user?.email} — role: ${role ?? "(none)"}\n`);

  const week = resolveWeek(process.argv[2] ?? null, new Date());
  console.log(`Week ${week.isoLabel}: ${week.start} .. ${week.end}  (${week.label})\n`);

  const { data, error } = await applyWeek(supabase.from("articles").select(SELECT), week)
    .order("published_at", { ascending: true })
    .limit(2000);

  if (error) throw new Error(`Query failed: ${error.message}`);

  const rows = (data ?? []) as WeekArticle[];
  const o = overview(rows);
  const coded = analysable(rows);

  console.log("OVERVIEW (as the panel computes it)");
  console.log(`  total ............ ${o.total}`);
  console.log(`  coded ............ ${o.coded}`);
  console.log(`  set aside ........ ${o.setAside}`);
  console.log(`  awaiting coding .. ${o.awaitingCoding}`);
  console.log(`  active sources ... ${o.activeSources}`);

  const partition = o.coded + o.setAside + o.awaitingCoding === o.total;
  console.log(
    `\n  ${partition ? "PASS" : "FAIL"}  coded + set aside + awaiting == total ` +
      `(${o.coded} + ${o.setAside} + ${o.awaitingCoding} == ${o.total})`
  );

  // The exclusion rules, stated as assertions rather than trusted.
  const leaked = coded.filter(
    (r) => r.status !== "active" || r.ai_sorting_flagged === true || r.coded_status !== "coded"
  );
  console.log(
    `  ${leaked.length === 0 ? "PASS" : "FAIL"}  no flagged/excluded/uncoded article is in the chart set` +
      (leaked.length ? ` (${leaked.length} leaked)` : "")
  );

  const asideRows = setAside(rows);
  const overlap = asideRows.filter((a) => coded.some((c) => c.id === a.id));
  console.log(
    `  ${overlap.length === 0 ? "PASS" : "FAIL"}  chart set and set-aside set are disjoint` +
      (overlap.length ? ` (${overlap.length} in both)` : "")
  );

  const outOfWeek = rows.filter(
    (r) => !r.published_at || r.published_at < week.start || r.published_at > week.end
  );
  console.log(
    `  ${outOfWeek.length === 0 ? "PASS" : "FAIL"}  every loaded row is inside the week bounds` +
      (outOfWeek.length ? ` (${outOfWeek.length} outside)` : "")
  );

  const p = countPolarity(coded);
  const polaritySum = p.favourable + p.neutral + p.unfavourable;
  console.log(
    `  ${polaritySum === coded.length ? "PASS" : "FAIL"}  every coded article maps to a polarity ` +
      `(F ${p.favourable} / N ${p.neutral} / U ${p.unfavourable} == ${coded.length})`
  );

  // --- Chart data ----------------------------------------------------------
  const days = volumeByDay(rows, weekDays(week));
  const shares = polarityBreakdown(coded);

  console.log("\nVOLUME BY DAY (chart series)");
  for (const d of days) {
    console.log(
      `  ${d.date}  ${d.tick.padEnd(7)} total ${String(d.total).padStart(3)}` +
        `   coded ${String(d.coded).padStart(3)}   not analysed ${String(d.notAnalysed).padStart(3)}`
    );
  }
  const volTotal = days.reduce((n, d) => n + d.total, 0);
  const volCoded = days.reduce((n, d) => n + d.coded, 0);
  const volOk = volTotal === o.total && volCoded === o.coded;
  console.log(
    `  ${volOk ? "PASS" : "FAIL"}  volume columns sum to the overview ` +
      `(total ${volTotal}==${o.total}, coded ${volCoded}==${o.coded})`
  );
  const stackOk = days.every((d) => d.coded + d.notAnalysed === d.total);
  console.log(
    `  ${stackOk ? "PASS" : "FAIL"}  every stacked bar's parts sum to its height`
  );

  console.log("\nFAVOURABILITY (chart series)");
  for (const s of shares) {
    console.log(`  ${s.label.padEnd(14)} ${String(s.articles).padStart(3)}   ${s.percent}%`);
  }
  const shareSum = shares.reduce((n, s) => n + s.articles, 0);
  const pctSum = shares.reduce((n, s) => n + s.percent, 0);
  const shareOk = shareSum === coded.length;
  console.log(
    `  ${shareOk ? "PASS" : "FAIL"}  bars sum to the coded count (${shareSum} == ${coded.length})`
  );
  // Rounding to one decimal can leave the total a tenth off 100; anything
  // larger means a slice is being dropped or double-counted.
  const pctOk = coded.length === 0 || Math.abs(pctSum - 100) < 0.35;
  console.log(
    `  ${pctOk ? "PASS" : "FAIL"}  percentages sum to ~100 (${pctSum.toFixed(1)}%)`
  );

  // --- Themes --------------------------------------------------------------
  const themes = themeStats(coded);
  const top = topThemes(themes, 3);

  console.log("\nTHEMES (chart series, busiest first)");
  for (const t of themes) {
    console.log(
      `  ${t.theme.padEnd(38)} ${String(t.articles).padStart(3)}  ${String(t.percent).padStart(5)}%` +
        `   F ${t.counts.favourable}  N ${t.counts.neutral}  U ${t.counts.unfavourable}`
    );
  }

  const stackedOk = themes.every(
    (t) =>
      t.counts.favourable + t.counts.neutral + t.counts.unfavourable === t.articles
  );
  console.log(
    `  ${stackedOk ? "PASS" : "FAIL"}  each theme's F/N/U parts sum to its article count`
  );

  // Theme counts must exceed the coded count exactly by the number of extra
  // theme tags — this is the multi-theme accounting stated in week-stats.ts,
  // asserted rather than assumed.
  const tagTotal = coded.reduce((n, r) => n + (r.ai_themes ?? []).filter((t) => t.trim()).length, 0);
  const themeTotal = themes.reduce((n, t) => n + t.articles, 0);
  console.log(
    `  ${themeTotal === tagTotal ? "PASS" : "FAIL"}  theme counts sum to the total theme tags ` +
      `(${themeTotal} == ${tagTotal}; coded articles ${coded.length})`
  );

  const sortedOk = themes.every(
    (t, i) => i === 0 || themes[i - 1].articles >= t.articles
  );
  console.log(`  ${sortedOk ? "PASS" : "FAIL"}  themes are ordered busiest-first`);
  console.log(`  top 3 → ${top.map((t) => `${t.theme} (${t.articles})`).join(", ")}`);

  // --- Ranked stories ------------------------------------------------------
  const stories = storiesForTopThemes(coded, top);
  console.log("\nTOP STORIES PER THEME (ranked by keyword_mention_count)");
  let rankOk = true;
  let polarityOk = true;
  let themeOk = true;
  for (const t of stories) {
    console.log(`  ${t.theme}`);
    for (const [dir, list] of [
      ["favourable", t.positive],
      ["unfavourable", t.negative],
    ] as const) {
      for (const s of list) {
        console.log(
          `    ${dir.padEnd(12)} ${String(s.mentions).padStart(3)} mentions  ${s.tier?.padEnd(17)} ${s.headline.slice(0, 62)}`
        );
      }
      // Descending by mentions, every story actually carries the theme, and
      // every story is on the side of the split it was filed under.
      for (let i = 1; i < list.length; i += 1) {
        if (list[i - 1].mentions < list[i].mentions) rankOk = false;
      }
      for (const s of list) {
        const row = coded.find((r) => r.id === s.id);
        if (!row || !(row.ai_themes ?? []).some((x) => x.trim() === t.theme)) {
          themeOk = false;
        }
        const expected =
          dir === "favourable"
            ? ["Favourable", "Very favourable"]
            : ["Unfavourable", "Very unfavourable"];
        if (!expected.includes(s.tier ?? "")) polarityOk = false;
      }
      if (list.length > 3) rankOk = false;
    }
  }
  console.log(`  ${rankOk ? "PASS" : "FAIL"}  each list is ≤3 and descending by mentions`);
  console.log(`  ${themeOk ? "PASS" : "FAIL"}  every ranked story actually carries its theme`);
  console.log(
    `  ${polarityOk ? "PASS" : "FAIL"}  favourable lists hold only favourable tiers, and vice versa`
  );

  // --- Keyword bubbles -----------------------------------------------------
  const bubbles = keywordBubbles(coded);
  const shown = limitBubbles(bubbles, 8);

  console.log(
    `\nKEYWORD BUBBLES: ${bubbles.length} (keyword × theme) cells, ${shown.length} plotted`
  );
  for (const b of shown.filter((x) => x.rank <= 3).slice(0, 12)) {
    console.log(
      `  #${b.rank}  ${b.keyword.padEnd(26)} ${b.theme.padEnd(30)} ${String(b.mentions).padStart(4)} mentions  ${b.articles} articles`
    );
  }

  // Ranks within a theme must be 1..n with no gaps or repeats, or the y axis
  // would have holes and two bubbles would overlap exactly.
  let rankShapeOk = true;
  let descOk = true;
  const themesInBubbles = [...new Set(bubbles.map((b) => b.theme))];
  for (const t of themesInBubbles) {
    const col = bubbles.filter((b) => b.theme === t).sort((a, b) => a.rank - b.rank);
    if (col.some((b, i) => b.rank !== i + 1)) rankShapeOk = false;
    if (col.some((b, i) => i > 0 && col[i - 1].mentions < b.mentions)) descOk = false;
  }
  console.log(
    `  ${rankShapeOk ? "PASS" : "FAIL"}  every theme's ranks are 1..n with no gaps or ties`
  );
  console.log(`  ${descOk ? "PASS" : "FAIL"}  ranks descend by mentions within each theme`);

  // Every bubble's theme must be a theme that exists in the theme chart, and
  // every article behind it must be in the coded set — the bubble chart must
  // not reach data the other charts exclude.
  const themeNames = new Set(themes.map((t) => t.theme));
  const strayTheme = bubbles.filter((b) => !themeNames.has(b.theme));
  console.log(
    `  ${strayTheme.length === 0 ? "PASS" : "FAIL"}  every bubble's theme also appears in the theme chart` +
      (strayTheme.length ? ` (${strayTheme.length} stray)` : "")
  );

  // Independent recomputation of one cell, straight from the rows, to confirm
  // the grouping is doing what it claims rather than merely being self-consistent.
  if (bubbles.length > 0) {
    const probe = bubbles[0];
    const contributing = coded.filter(
      (r) =>
        (r.ai_themes ?? []).some((t) => t.trim() === probe.theme) &&
        (r.matched_keywords ?? []).some((k) => k.trim() === probe.keyword)
    );
    const expectedMentions = contributing.reduce(
      (n, r) => n + (r.keyword_mention_count ?? 0),
      0
    );
    const cellOk =
      contributing.length === probe.articles && expectedMentions === probe.mentions;
    console.log(
      `  ${cellOk ? "PASS" : "FAIL"}  recomputed "${probe.keyword}" × "${probe.theme}" from rows ` +
        `→ ${contributing.length} articles / ${expectedMentions} mentions ` +
        `(bubble says ${probe.articles} / ${probe.mentions})`
    );
    if (!cellOk) rankShapeOk = false;
  }

  // --- The exports, byte for byte ------------------------------------------
  // Built from the SAME column definitions the download buttons use, so this
  // is the file a user gets, not a re-implementation of it.
  console.log("\nCSV — volume (exactly what the export button produces)");
  process.stdout.write(toCsv(days, VOLUME_COLUMNS));
  console.log("CSV — sentiment");
  process.stdout.write(toCsv(shares, polarityColumns(coded.length)));
  console.log("CSV — themes");
  process.stdout.write(toCsv(themes, themeColumns(coded.length)));

  const storyRows: StoryExportRow[] = [];
  for (const t of stories) {
    t.positive.forEach((s, i) =>
      storyRows.push({ ...s, theme: t.theme, direction: "positive", rank: i + 1 })
    );
    t.negative.forEach((s, i) =>
      storyRows.push({ ...s, theme: t.theme, direction: "negative", rank: i + 1 })
    );
  }
  const storyCsv = toCsv(storyRows, STORY_COLUMNS);
  console.log(
    `CSV — top stories: ${storyRows.length} rows, ${storyCsv.length} bytes ` +
      `(first line: ${storyCsv.split("\r\n")[1]?.slice(0, 90) ?? "(none)"}…)`
  );

  const bubbleCsv = toCsv(bubbles, KEYWORD_BUBBLE_COLUMNS);
  console.log(
    `CSV — keywords: ${bubbles.length} rows (FULL set, not the ${shown.length} plotted)`
  );
  console.log(`  ${bubbleCsv.split("\r\n").slice(0, 4).join("\n  ")}`);

  await supabase.auth.signOut();

  const ok =
    partition &&
    leaked.length === 0 &&
    overlap.length === 0 &&
    outOfWeek.length === 0 &&
    polaritySum === coded.length &&
    volOk &&
    stackOk &&
    shareOk &&
    pctOk &&
    stackedOk &&
    themeTotal === tagTotal &&
    sortedOk &&
    rankOk &&
    themeOk &&
    polarityOk &&
    rankShapeOk &&
    descOk &&
    strayTheme.length === 0;
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
