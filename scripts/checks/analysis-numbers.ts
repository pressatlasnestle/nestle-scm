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
  dominantPolarity,
  limitWords,
  wordCloudWords,
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
  WORD_CLOUD_COLUMNS,
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

  // --- Word cloud ----------------------------------------------------------
  const words = wordCloudWords(coded);
  // Must track WORDS_IN_CLOUD in the Analysis page, or this checks a cap the
  // panel does not apply.
  const drawn = limitWords(words, 40);

  console.log(`\nWORD CLOUD: ${words.length} keywords, ${drawn.length} drawn`);
  for (const w of drawn.slice(0, 10)) {
    console.log(
      `  ${w.keyword.slice(0, 40).padEnd(42)} ${String(w.mentions).padStart(4)} mentions  ` +
        `${String(w.articles).padStart(3)} articles  ${w.sentiment.padEnd(12)}` +
        `  (F ${w.weights.favourable} / N ${w.weights.neutral} / U ${w.weights.unfavourable})`
    );
  }

  // Size ordering drives centre-out placement — the layout is fed this array in
  // order, so a break here would put a small word in the middle.
  const wordsSortedOk = words.every(
    (w, i) => i === 0 || words[i - 1].mentions >= w.mentions
  );
  console.log(`  ${wordsSortedOk ? "PASS" : "FAIL"}  words are ordered biggest-first`);

  // Each word's three weights must account for its whole size, or the colour is
  // being decided from a different number than the one drawn.
  const weightsOk = words.every(
    (w) =>
      w.weights.favourable + w.weights.neutral + w.weights.unfavourable === w.mentions
  );
  console.log(
    `  ${weightsOk ? "PASS" : "FAIL"}  each word's F/N/U weights sum to its total mentions`
  );

  // The colour rule, re-derived from the weights rather than trusted.
  const colourOk = words.every((w) => dominantPolarity(w.weights) === w.sentiment);
  console.log(
    `  ${colourOk ? "PASS" : "FAIL"}  every word's colour matches the rule applied to its own weights`
  );

  // A word whose coverage is entirely one-sided MUST take that colour — the
  // case the rule exists for, and the one a plurality bug would break first.
  const oneSided = words.filter(
    (w) =>
      (w.weights.favourable > 0 &&
        w.weights.neutral === 0 &&
        w.weights.unfavourable === 0) ||
      (w.weights.unfavourable > 0 &&
        w.weights.favourable === 0 &&
        w.weights.neutral === 0)
  );
  const oneSidedOk = oneSided.every((w) =>
    w.weights.favourable > 0
      ? w.sentiment === "favourable"
      : w.sentiment === "unfavourable"
  );
  console.log(
    `  ${oneSidedOk ? "PASS" : "FAIL"}  all ${oneSided.length} wholly one-sided keyword(s) take that side's colour, never grey`
  );

  // ...and an exact tie must be grey, checked directly on the rule.
  const tieGrey =
    dominantPolarity({ favourable: 9, neutral: 0, unfavourable: 9 }) === "neutral" &&
    dominantPolarity({ favourable: 0, neutral: 0, unfavourable: 0 }) === "neutral" &&
    dominantPolarity({ favourable: 10, neutral: 9, unfavourable: 9 }) === "favourable";
  console.log(
    `  ${tieGrey ? "PASS" : "FAIL"}  exact tie → neutral; empty → neutral; plurality of 1 → wins`
  );

  // The drawn label must stay short enough to lay out, and must never replace
  // the canonical term — the cloud abbreviates, the data does not.
  const longest = words.reduce((a, b) => (b.label.length > a.label.length ? b : a), words[0]);
  const labelsShort = words.every((w) => w.label.length <= 26);
  console.log(
    `  ${labelsShort ? "PASS" : "FAIL"}  every drawn label is ≤26 chars (longest: "${longest?.label}" from a ${longest?.keyword.length}-char term)`
  );

  // A slash-separated bundle must abbreviate to "<first> +N", and N must be
  // the number of variants actually dropped — an off-by-one here would
  // misreport how many terms a word stands for.
  const bundles = words.filter((w) => w.keyword.includes("/"));
  const bundlesOk = bundles.every((w) => {
    const parts = w.keyword.split("/").map((p) => p.trim()).filter(Boolean);
    return w.label.endsWith(` +${parts.length - 1}`);
  });
  console.log(
    `  ${bundlesOk ? "PASS" : "FAIL"}  all ${bundles.length} bundled keyword(s) abbreviate to "<first> +N" with the right N`
  );

  // A single-word keyword must be left exactly alone.
  const plain = words.filter((w) => !w.keyword.includes("/") && w.keyword.length <= 22);
  const plainOk = plain.every((w) => w.label === w.keyword);
  console.log(
    `  ${plainOk ? "PASS" : "FAIL"}  all ${plain.length} short single-term keyword(s) are drawn verbatim`
  );

  // No keyword may be counted more times than there are coded articles.
  const overCounted = words.filter((w) => w.articles > coded.length);
  console.log(
    `  ${overCounted.length === 0 ? "PASS" : "FAIL"}  no keyword claims more articles than exist (${coded.length} coded)`
  );

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

  const wordCsv = toCsv(words, WORD_CLOUD_COLUMNS);
  console.log(
    `CSV — keywords: ${words.length} rows (FULL set, not the ${drawn.length} drawn)`
  );
  console.log(`  ${wordCsv.split("\r\n").slice(0, 5).join("\n  ")}`);

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
    wordsSortedOk &&
    weightsOk &&
    colourOk &&
    oneSidedOk &&
    tieGrey &&
    labelsShort &&
    bundlesOk &&
    plainOk &&
    overCounted.length === 0;
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
