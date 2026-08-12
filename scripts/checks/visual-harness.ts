/**
 * Builds a standalone page that renders the REAL Analysis chart components
 * with REAL data from the database, so they can be looked at.
 *
 *   npx tsx --env-file=.env.local scripts/checks/visual-harness.ts [week]
 *   → opens as a plain file:// page; no auth, no dev server, no Next.js
 *
 * WHY THIS EXISTS.
 *
 * Every other check in this directory answers "are the numbers right". None of
 * them answers "can a person read this", and that gap shipped a word cloud
 * whose aggregation was verified exact against SQL and whose output was
 * illegible. Numeric correctness and visual correctness are different
 * properties and need different tests.
 *
 * It imports the actual components rather than reimplementing them, so what is
 * on screen is what the panel renders — not a mock-up that could agree with
 * the code while the code disagrees with reality. The only thing it fakes is
 * the surrounding app shell.
 *
 * Output goes to the scratchpad, not the repo.
 */

import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createAdminClient } from "../../src/lib/supabase/admin";
import { applyWeek, resolveWeek, weekDays } from "../../src/lib/analysis/week-period";
import {
  analysable,
  limitWords,
  polarityBreakdown,
  themeStats,
  volumeByDay,
  wordCloudWords,
  type WeekArticle,
} from "../../src/lib/analysis/week-stats";

const SELECT =
  "id, headline, url, media, published_at, status, coded_status, ai_sorting_flagged, ai_sentiment, ai_themes, ai_summary, matched_keywords, keyword_mention_count";

/** Must match WORDS_IN_CLOUD in the Analysis page, or this proves nothing. */
const WORDS_IN_CLOUD = 40;

async function main() {
  const outDir =
    process.env.HARNESS_OUT ??
    join(process.cwd(), ".harness");
  mkdirSync(outDir, { recursive: true });

  const client = createAdminClient();
  const week = resolveWeek(process.argv[2] ?? "2026-08-10", new Date());

  const { data, error } = await applyWeek(
    client.from("articles").select(SELECT),
    week
  ).limit(2000);
  if (error) throw new Error(error.message);

  const rows = (data ?? []) as WeekArticle[];
  const coded = analysable(rows);
  const words = wordCloudWords(coded);

  const payload = {
    week,
    volume: volumeByDay(rows, weekDays(week)),
    polarity: polarityBreakdown(coded),
    themes: themeStats(coded),
    words,
    wordsShown: limitWords(words, WORDS_IN_CLOUD),
    codedTotal: coded.length,
  };

  writeFileSync(join(outDir, "data.json"), JSON.stringify(payload, null, 2));
  console.log(
    `Week ${week.isoLabel}: ${coded.length} coded, ${payload.themes.length} themes, ` +
      `${words.length} keywords (${payload.wordsShown.length} drawn)`
  );

  // Entry point. Written rather than kept in the repo, because it only makes
  // sense next to its generated data.
  const entry = join(outDir, "entry.tsx");
  writeFileSync(
    entry,
    `import { createRoot } from "react-dom/client";
import { PolarityChart, ThemePolarityChart, VolumeChart } from "@/app/(admin)/analysis/charts";
import { WordCloud } from "@/app/(admin)/analysis/WordCloud";
import data from "./data.json";

const d = data as any;

createRoot(document.getElementById("root")!).render(
  <div className="content">
    <div className="chart-grid">
      <VolumeChart week={d.week} days={d.volume} />
      <PolarityChart week={d.week} shares={d.polarity} codedTotal={d.codedTotal} />
      <ThemePolarityChart week={d.week} themes={d.themes} codedTotal={d.codedTotal} />
    </div>
    <div style={{ marginTop: 18 }}>
      <WordCloud week={d.week} words={d.words} shown={d.wordsShown} />
    </div>
  </div>
);
`
  );

  const bundle = join(outDir, "bundle.js");

  // esbuild's JS API rather than its CLI. The CLI needs
  // --define:process.env.NODE_ENV="production", and on Windows the shell eats
  // the inner quotes, so the define lands as a bare identifier and React dies
  // at runtime with `production is not defined`. Passing the value as a string
  // through the API removes the shell from the problem entirely.
  const esbuild = await import("esbuild");
  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    outfile: bundle,
    jsx: "automatic",
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    alias: { "@": resolve(process.cwd(), "src") },
    logLevel: "warning",
  });

  // The panel's real stylesheet, minus the Next font-variable declarations it
  // cannot resolve outside the app — substituted with the same families so
  // text metrics stay representative.
  const css = readFileSync(join(process.cwd(), "src/app/globals.css"), "utf8");

  writeFileSync(
    join(outDir, "index.html"),
    `<!doctype html>
<html><head><meta charset="utf-8">
<style>
${css}
:root {
  --font-space-grotesk: "Segoe UI", system-ui, sans-serif;
  --font-inter: "Segoe UI", system-ui, sans-serif;
  --font-plex-mono: "Cascadia Mono", Consolas, monospace;
}
body { background: var(--bg); color: var(--text); font-family: var(--font-body); }
.content { max-width: 1180px; margin: 0 auto; padding: 24px; }
</style></head>
<body><div id="root"></div><script src="./bundle.js"></script></body></html>`
  );

  console.log(`\nOpen: ${join(outDir, "index.html")}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
