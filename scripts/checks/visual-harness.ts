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
  overview,
  polarityBreakdown,
  storiesForTopThemes,
  themeStats,
  topThemes,
  volumeByDay,
  wordCloudWords,
  type WeekArticle,
} from "../../src/lib/analysis/week-stats";
import { parseStoredNarrative } from "../../src/lib/analysis/narrative";

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
  const themes = themeStats(coded);

  // The stored narrative, so the PDF export can be exercised with the same
  // text the panel shows rather than a placeholder.
  const { data: report } = await client
    .from("reports")
    .select("analysis_narrative")
    .eq("week_of", week.start)
    .maybeSingle();

  const payload = {
    week,
    overview: overview(rows),
    volume: volumeByDay(rows, weekDays(week)),
    polarity: polarityBreakdown(coded),
    themes,
    words,
    wordsShown: limitWords(words, WORDS_IN_CLOUD),
    stories: storiesForTopThemes(coded, topThemes(themes, 3)),
    narrative: parseStoredNarrative(report?.analysis_narrative),
    codedTotal: coded.length,

    // Representative values for the manually-entered cards, so their layout can
    // be looked at without writing anything to the real tables. Obviously
    // rounded rather than realistic — these must never be mistakable for
    // transcribed Linerlytica figures if a screenshot escapes.
    sampleCongestion: {
      week_of: week.start,
      global_teu_waiting: 1_500_000,
      global_pct_fleet: 4.8,
      region_data: {
        europe: 500_000,
        north_america: 300_000,
        north_asia: 400_000,
        southeast_asia: 200_000,
        south_america: 100_000,
      },
      entered_at: new Date(0).toISOString(),
      entered_by: null,
    },
    sampleWaiting: {
      week_of: week.start,
      port_data: {
        "Antwerp-Rotterdam": 1.8,
        "Shanghai-Ningbo": 1.2,
        "Singapore-Port Klang": 2.4,
        "Los Angeles-Long Beach": 0.9,
        "New York-Savannah": 1.5,
        "Jebel Ali-Jeddah": 3,
      },
      entered_at: new Date(0).toISOString(),
      entered_by: null,
    },
    // Deliberately a DIFFERENT month from the selected week, so the
    // carried-forward note renders and can be read.
    sampleReliability: {
      month_of: `${week.start.slice(0, 4)}-07-01`,
      glp_issue_number: 100,
      global_reliability_pct: 65,
      avg_delay_days: 4.5,
      alliance_data: {
        "Gemini Cooperation": 90,
        "Ocean Alliance": 60,
        "Premier Alliance": 55,
        "MSC standalone": 70,
        "2M": 50,
      },
      entered_at: new Date(0).toISOString(),
      entered_by: null,
    },
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
import {
  CongestionCard,
  MissingCard,
  ReliabilityCard,
  WaitingTimeCard,
} from "@/app/(admin)/analysis/OperationalCards";
import { buildAnalysisPdf } from "@/lib/analysis/pdf";
import data from "./data.json";

const d = data as any;
const noop = () => {};

createRoot(document.getElementById("root")!).render(
  <div className="content">
    {/* Manually-entered market cards, rendered from representative values so
        the layout can be looked at. OperationalCards imports no server action,
        which is what makes it bundleable here. */}
    <div className="operational-head">
      <div>
        <div className="eyebrow">Market data · entered manually</div>
        <p>Transcribed from Linerlytica and Sea-Intelligence, not derived from the article corpus below.</p>
      </div>
    </div>
    <div className="chart-grid">
      <CongestionCard week={d.week} row={d.sampleCongestion} onEdit={noop} />
      <WaitingTimeCard week={d.week} row={d.sampleWaiting} onEdit={noop} />
    </div>
    <div className="chart-grid" style={{ gridTemplateColumns: "1fr" }}>
      <ReliabilityCard week={d.week} row={d.sampleReliability} onEdit={noop} />
    </div>
    <div className="chart-grid">
      <MissingCard title="Port congestion" period={d.week.label} onAdd={noop} />
    </div>

    <div className="section-divider"><span>From the article corpus</span></div>

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

// Exposed so the verification step can build the REAL PDF — same function the
// button calls — and post the bytes back to disk to be opened and looked at.
// A fixed generatedAt keeps the output byte-comparable between runs.
(window as any).__buildPdf = async () => {
  const doc = await buildAnalysisPdf({
    week: d.week,
    overview: d.overview,
    narrative: d.narrative,
    stories: d.stories,
    generatedAt: new Date("2026-08-12T12:00:00Z"),
  });
  const blob = doc.output("blob");
  const res = await fetch("/save-pdf?name=analysis.pdf", { method: "POST", body: blob });
  (window as any).__pdfBytes = await blob.arrayBuffer();
  return (await res.text()) + " (" + blob.size + " bytes)";
};

/**
 * Renders the generated PDF's own pages back to PNGs.
 *
 * This is the only check that can distinguish a correct export from one that
 * wrote successfully and put blank rectangles where the charts should be —
 * which is exactly the failure worth guarding against, since every other
 * signal (no exception, plausible byte count, right page count) looks
 * identical in both cases.
 */
(window as any).__loadPdf = async () => {
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = "./pdf.worker.min.mjs";
  const pdf = await pdfjs.getDocument({ data: (window as any).__pdfBytes.slice(0) }).promise;
  (window as any).__pdf = pdf;
  return "pages=" + pdf.numPages;
};

/** One page at a time, so a slow render cannot exceed a tool call's budget. */
(window as any).__renderPdfPage = async (p: number, scale = 1.25) => {
  const pdf = (window as any).__pdf;
  const page = await pdf.getPage(p);
  const viewport = page.getViewport({ scale });
  const cv = document.createElement("canvas");
  cv.width = Math.ceil(viewport.width);
  cv.height = Math.ceil(viewport.height);
  const ctx = cv.getContext("2d")!;
  // White, because a PDF page is white and an unpainted canvas is not — and a
  // transparent canvas would hide exactly the blank-chart failure being
  // looked for.
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, cv.width, cv.height);
  await page.render({ canvas: cv, canvasContext: ctx, viewport }).promise;
  const r = await fetch("/save?name=pdf-page-" + p + ".png", {
    method: "POST",
    body: cv.toDataURL("image/png"),
  });
  return await r.text();
};
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

  // pdf.js renders on a worker; copy it next to the bundle so the harness page
  // can reach it as a plain static file.
  const worker = resolve(
    process.cwd(),
    "node_modules/pdfjs-dist/build/pdf.worker.min.mjs"
  );
  writeFileSync(join(outDir, "pdf.worker.min.mjs"), readFileSync(worker));

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
