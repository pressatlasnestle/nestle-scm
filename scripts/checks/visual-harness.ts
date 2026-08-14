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
import { parseCsv as parseCsvText } from "../../src/lib/analysis/csv";
import {
  buildTemplateCsv,
  type ExistingData,
} from "../../src/lib/analysis/operational-template";

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
    weekDays: weekDays(week),
    ports: (await client.from("ports").select("name").order("name")).data?.map((p) => p.name) ?? [],

    // Representative values for the manually-entered cards, so their layout can
    // be looked at without writing anything to the real tables. Obviously
    // rounded rather than realistic — these must never be mistakable for
    // transcribed Linerlytica figures if a screenshot escapes.
    // A PARTIAL week — Monday, Wednesday, Friday only — so the daily chart can
    // be checked for the thing that matters: three bars, not seven with zeros.
    sampleCongestion: [0, 2, 4].map((offset) => ({
      day_of: weekDays(week)[offset],
      global_teu_waiting: 1_500_000 + offset * 100_000,
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
    })),
    // Overlapping on purpose: at port + at anchorage is far below active, which
    // is exactly why these must be grouped and never stacked.
    sampleFleet: [
      {
        day_of: weekDays(week)[4],
        status_data: {
          "Ships at port": { ships: 1165, teu: 7_000_000 },
          "Active Ships": { ships: 5426, teu: 31_000_000 },
          "Inactive Ships": { ships: 700, teu: 1_500_000 },
          "Ships at anchorage": { ships: 1180, teu: 6_000_000 },
          "Ships in shipyard": { ships: 300, teu: 900_000 },
        },
        entered_at: new Date(0).toISOString(),
        entered_by: null,
      },
    ],
    // Five ports including the longest and most punctuated names in the seed,
    // and a ratio that deliberately disagrees with the two ship counts.
    samplePorts: [
      { port_name: "Shanghai/Ningbo", ships_anchorage: 67, ships_port: 19, teu_anchorage: 500_000, teu_port: 250_000, queue_berth_ratio: 3.5 },
      { port_name: "Busan", ships_anchorage: 122, ships_port: 48, teu_anchorage: 400_000, teu_port: 200_000, queue_berth_ratio: 2.54 },
      { port_name: "Antwerp", ships_anchorage: 17, ships_port: 21, teu_anchorage: 90_000, teu_port: 120_000, queue_berth_ratio: 0.81 },
      { port_name: "Gibraltar (Algeciras/Tanger Med)", ships_anchorage: 21, ships_port: 8, teu_anchorage: 70_000, teu_port: 40_000, queue_berth_ratio: 2.8 },
      { port_name: "LA/LB", ships_anchorage: 9, ships_port: 14, teu_anchorage: 60_000, teu_port: 110_000, queue_berth_ratio: 0.64 },
    ].map((p) => ({
      ...p,
      day_of: weekDays(week)[4],
      entered_at: new Date(0).toISOString(),
      entered_by: null,
    })),
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

  /**
   * Two sample uploads for the upload panel, built from the REAL template
   * generator against the sample data above.
   *
   * The panel's whole job is to report what a file will do before it does it,
   * so it cannot be looked at without a file. One of these carries all three
   * outcomes at once — values ready, cells left blank, rows not recognised —
   * and the other is clean, so the from → to preview can be read.
   */
  const existing: ExistingData = {
    congestion: payload.sampleCongestion as never,
    fleet: payload.sampleFleet as never,
    ports: payload.samplePorts as never,
  };
  const samplePortNames = payload.samplePorts.map((p) => p.port_name);
  const prefilled = buildTemplateCsv(payload.weekDays, samplePortNames, existing);

  /** Rewrites the Value column, and optionally the Item, row by row. */
  const rewrite = (
    csv: string,
    edit: (cells: string[]) => string[] | null
  ): string =>
    parseCsvText(csv)
      .map((cells, i) => (i === 0 ? cells : (edit(cells) ?? cells)))
      .map((r) =>
        r.map((c) => (/[",\r\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(",")
      )
      .join("\r\n") + "\r\n";

  const tue = payload.weekDays[1]; // a day with nothing stored
  const fri = payload.weekDays[4]; // the day the sample ports live on

  const clean = rewrite(prefilled, (c) => {
    // An overwrite, so the preview has a from → to to show.
    if (c[0] === payload.weekDays[0] && c[1] === "Port congestion total" && c[3] === "TEU at anchorage")
      return [...c.slice(0, 4), "1650000"];
    if (c[0] === fri && c[1] === "Port congestion" && c[3] === "Ships at anchorage")
      return [...c.slice(0, 4), String(Number(c[4] || 0) + 5)];
    // New figures on a day that has none.
    if (c[0] === tue && c[1] === "Port congestion by region")
      return [...c.slice(0, 4), "250000"];
    return null;
  });

  const messy = rewrite(clean, (c) => {
    // A port typed by hand instead of left as the template wrote it.
    if (c[1] === "Port congestion" && c[2] === "LA/LB")
      return [c[0], c[1], "LA / Long Beach", c[3], c[4] || "12"];
    // A cell someone typed words into.
    if (c[0] === fri && c[1] === "Fleet status" && c[3] === "Ships") return [...c.slice(0, 4), "n/a"];
    return null;
  });

  const withPayload = {
    ...payload,
    samplePortNames,
    // As it would arrive from Excel on Windows.
    sampleUploadClean: `﻿${clean}`,
    sampleUploadMessy: `﻿${messy}`,
  };

  writeFileSync(join(outDir, "data.json"), JSON.stringify(withPayload, null, 2));
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
  FleetStatusCard,
  MissingCard,
  PortCongestionCard,
  ReliabilityCard,
} from "@/app/(admin)/analysis/OperationalCards";
import { OperationalGrid } from "@/app/(admin)/analysis/OperationalGrid";
import { OperationalUpload } from "@/app/(admin)/analysis/OperationalUpload";
import { ToastProvider } from "@/components/Toast";
import { buildAnalysisPdf } from "@/lib/analysis/pdf";
import data from "./data.json";

const d = data as any;
const noop = () => {};

createRoot(document.getElementById("root")!).render(
  <ToastProvider>
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
      <CongestionCard week={d.week} rows={d.sampleCongestion} onEdit={noop} />
      <FleetStatusCard week={d.week} rows={d.sampleFleet} onEdit={noop} />
    </div>
    <div className="chart-grid" style={{ gridTemplateColumns: "1fr" }}>
      <PortCongestionCard week={d.week} rows={d.samplePorts} onEdit={noop} />
    </div>
    <div className="chart-grid" style={{ gridTemplateColumns: "1fr" }}>
      <ReliabilityCard week={d.week} row={d.sampleReliability} onEdit={noop} />
    </div>
    <div className="chart-grid">
      <MissingCard title="Port congestion" period={d.week.label} onAdd={noop} />
    </div>

    {/* The upload panel, twice: once holding a file with all three outcomes at
        once, and once holding a clean one so the from → to preview is legible.
        __dropFile below puts a file into each. */}
    <OperationalUpload
      week={d.week}
      portVocabulary={d.ports}
      congestion={d.sampleCongestion}
      fleet={d.sampleFleet}
      portCongestion={d.samplePorts}
    />
    <OperationalUpload
      week={d.week}
      portVocabulary={d.ports}
      congestion={d.sampleCongestion}
      fleet={d.sampleFleet}
      portCongestion={d.samplePorts}
    />

    {/* The entry grid, open, at full width with all five ports and seven days. */}
    <OperationalGrid
      week={d.week}
      days={d.weekDays}
      ports={d.ports}
      congestion={d.sampleCongestion}
      fleet={d.sampleFleet}
      portCongestion={d.samplePorts}
      onClose={noop}
    />

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
  </ToastProvider>
);

/**
 * Hands a file to an upload panel, the way the browser's own file picker
 * would. A file dialog cannot be driven from a test, and adding a test-only
 * prop to the component would mean the thing on screen is not the thing that
 * ships. A synthetic DataTransfer is the real input event, so React's onChange
 * fires exactly as it does for a person choosing a file.
 */
(window as any).__dropFile = (index: number, name: string, text: string) => {
  const input = document.querySelectorAll<HTMLInputElement>(".upload-input")[index];
  const dt = new DataTransfer();
  dt.items.add(new File([text], name, { type: "text/csv" }));
  input.files = dt.files;
  input.dispatchEvent(new Event("change", { bubbles: true }));
  return name;
};

(window as any).__dropSamples = () => {
  (window as any).__dropFile(0, "operational-" + d.week.label + ".csv", d.sampleUploadMessy);
  (window as any).__dropFile(1, "operational-" + d.week.label + ".csv", d.sampleUploadClean);
  return "dropped";
};

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

  /**
   * A stand-in for the server actions.
   *
   * OperationalGrid imports them, and a "use server" module cannot be bundled
   * for a browser — but the grid is exactly the surface that most needs
   * looking at, being 300 hand-typed values wide. Aliasing the actions to
   * no-ops lets the REAL grid render with the REAL data shapes; only Save is
   * inert, and Save is covered by check:operational instead.
   */
  writeFileSync(
    join(outDir, "action-stub.ts"),
    `export async function saveOperationalWeek() { return { ok: true, daysWritten: 0, portRowsWritten: 0 }; }
export async function saveScheduleReliability() { return { ok: true }; }
export async function applyOperationalUpload() { return { ok: true, valuesWritten: 0, daysWritten: 0 }; }
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
    plugins: [
      {
        // OperationalGrid imports the actions as "./operational-actions", and
        // esbuild aliases match the specifier exactly as written, so a path
        // alias never fires. A resolve plugin matches on the resolved name
        // instead, whichever way it was imported.
        name: "stub-server-actions",
        setup(build) {
          build.onResolve({ filter: /operational-actions$/ }, () => ({
            path: join(outDir, "action-stub.ts"),
          }));
        },
      },
    ],
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
<!-- Without this a narrowed browser reports an 785px viewport and every
     max-width media query keeps matching, so the mobile layout is never the
     thing being looked at. -->
<meta name="viewport" content="width=device-width, initial-scale=1">
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
