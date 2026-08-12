/**
 * Generates (and optionally stores) a week's narrative from the CLI.
 *
 *   npx tsx --env-file=.env.local scripts/narrative.ts 2026-08-10
 *   npx tsx --env-file=.env.local scripts/narrative.ts 2026-08-10 --write
 *
 * Same relationship to the panel's Regenerate action that scripts/code.ts has
 * to the AI Analysis button: the engine can be exercised against the real
 * corpus without a browser, and — because it defaults to NOT writing — the
 * prompt can be iterated on without leaving rows behind or overwriting a
 * narrative someone is reading.
 *
 * Service role, because get_integration_secret() (the Vault decrypt for the
 * Gemini key) is granted to service_role alone, and because `reports` has no
 * insert/update policy at all.
 */
import { createAdminClient } from "../src/lib/supabase/admin";
import { applyWeek, resolveWeek } from "../src/lib/analysis/week-period";
import { analysable, type WeekArticle } from "../src/lib/analysis/week-stats";
import {
  generateWeekNarrative,
  parseStoredNarrative,
} from "../src/lib/analysis/narrative";

const SELECT =
  "id, headline, url, media, published_at, status, coded_status, ai_sorting_flagged, ai_sentiment, ai_themes, ai_summary, matched_keywords, keyword_mention_count";

async function main() {
  const weekArg = process.argv[2] ?? null;
  const write = process.argv.includes("--write");

  const admin = createAdminClient();
  const week = resolveWeek(weekArg, new Date());

  console.log(`Week ${week.isoLabel}: ${week.label}  (${week.start}..${week.end})`);
  console.log(write ? "Mode: GENERATE AND STORE\n" : "Mode: generate only (no write)\n");

  const { data, error } = await applyWeek(
    admin.from("articles").select(SELECT),
    week
  ).limit(2000);
  if (error) throw new Error(error.message);

  const coded = analysable((data ?? []) as WeekArticle[]);
  console.log(`Coded articles available: ${coded.length}`);

  const started = Date.now();
  const narrative = await generateWeekNarrative(admin, week, coded);
  console.log(`Gemini call completed in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  console.log(`Summaries used: ${narrative.source_article_count}\n`);

  console.log("PERIOD SUMMARY");
  console.log(`  ${narrative.period_summary}\n`);
  for (const t of narrative.themes) {
    console.log(`${t.theme}  (${t.article_count} articles)`);
    console.log(`  ${t.narrative}\n`);
  }

  if (!write) {
    console.log("Not stored. Re-run with --write to persist.");
    return;
  }

  const { error: upsertError } = await admin.from("reports").upsert(
    {
      week_of: week.start,
      analysis_narrative: narrative,
      analysis_generated_at: new Date().toISOString(),
    },
    { onConflict: "week_of" }
  );
  if (upsertError) throw new Error(`Store failed: ${upsertError.message}`);

  // Read it back through the panel's own parser, so what is verified is the
  // round trip the page performs — not just that the write returned no error.
  const { data: row } = await admin
    .from("reports")
    .select("analysis_narrative, analysis_generated_at")
    .eq("week_of", week.start)
    .maybeSingle();

  const parsed = parseStoredNarrative(row?.analysis_narrative);
  if (!parsed) {
    throw new Error("Stored, but the panel's parser rejected it on read-back.");
  }

  const identical =
    parsed.period_summary === narrative.period_summary &&
    parsed.themes.length === narrative.themes.length &&
    parsed.themes.every(
      (t, i) =>
        t.theme === narrative.themes[i].theme &&
        t.narrative === narrative.themes[i].narrative
    );

  console.log(
    `Stored and read back${identical ? " identically" : " BUT THE TEXT DIFFERS"}.`
  );
  console.log(`  generated_at: ${row?.analysis_generated_at}`);
  if (!identical) process.exit(1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
