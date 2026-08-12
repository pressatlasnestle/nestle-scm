/**
 * The Analysis panel's PDF export.
 *
 * WHY THIS RUNS IN THE BROWSER AND NOT ON A SERVERLESS FUNCTION.
 *
 * The obvious approach is headless Chromium on the server — puppeteer-core
 * plus @sparticuz/chromium, the slimmed build made for exactly this. It was
 * researched against this project's real target rather than assumed, and it
 * would work: 69.7MB unpacked plus 5.8MB of puppeteer-core is roughly 76MB
 * against Vercel's 250MB function limit, and its Node requirement
 * (^22.17 || >=24) is satisfied by this project's 24.x.
 *
 * It was still the wrong choice here, for four reasons that are specific to
 * this panel rather than general objections:
 *
 *   * The charts are already rendered. When the button is pressed the donut,
 *     the theme bars and the word cloud are laid out in front of the user, and
 *     the brief asks for "what's actually on screen". A server render throws
 *     that away and reproduces it from scratch.
 *   * It would need the user's session. /analysis is behind auth, so the
 *     function would have to forward the caller's cookie into a headless
 *     browser and hold a live session while it worked. That is a real security
 *     surface for a convenience feature.
 *   * The 60s function ceiling is already tight here. A scheduled ingestion
 *     run measured 53s against it earlier in this project's life. Chromium
 *     cold start, page load, React hydration, d3-cloud layout and web-font
 *     loading all land in the same budget.
 *   * Blank-chart risk is HIGHER, not lower. Fonts missing from the Lambda
 *     image, hydration finishing after the screenshot, CSS variables not yet
 *     applied — these are the classic headless failure modes, and they produce
 *     a PDF that generated without erroring and renders nothing.
 *
 * Client-side has one real cost, stated plainly: the export cannot be
 * triggered by anything other than a person looking at the page. If the Monday
 * digest ever needs to attach a PDF unattended, that job needs the server-side
 * path, and this module will not serve it.
 *
 * WHY jsPDF. It is browser-first, has no React coupling, takes PNG data URLs
 * directly (addImage) and does the two text jobs this needs — wrapping prose
 * to a column and paginating. pdf-lib is the other mature option and is better
 * at editing existing PDFs, which is not the job here. jsPDF is imported
 * dynamically at click time so none of its ~30MB reaches the page bundle for
 * the readers who never press the button.
 */

import type { Week } from "./week-period";
import type { WeekNarrative } from "./narrative";
import type { ThemeStories, WeekOverview } from "./week-stats";
import { rasterizeCard, type Raster } from "./rasterize";

/** A4 portrait, in points. */
const PAGE_W = 595.28;
const PAGE_H = 841.89;
const MARGIN = 40;
const CONTENT_W = PAGE_W - MARGIN * 2;

/** Print palette. Dark chart images sit on a white page, so text is dark. */
const INK = "#1a2740";
const MUTED = "#5b6c89";
const RULE = "#dbe2ec";

/**
 * Charts captured, in the order they appear on the page.
 *
 * `width` is the fraction of the text column the chart is drawn at. A donut is
 * a shape with a fixed aspect ratio, so stretching it to the full column makes
 * it tall without making it any more legible, and pushed the next chart onto a
 * page of its own — the export came out with two pages that were mostly white.
 * The bar and cloud charts genuinely use their width, so they keep all of it.
 */
const CHARTS: { title: string; width: number }[] = [
  { title: "Volume, day on day", width: 1 },
  { title: "Favourability breakdown", width: 0.62 },
  { title: "Themes", width: 1 },
  { title: "Keywords this week", width: 1 },
];

export type PdfInputs = {
  week: Week;
  overview: WeekOverview;
  narrative: WeekNarrative | null;
  stories: ThemeStories[];
  /** Stamped on the cover. Passed in so the caller owns the clock. */
  generatedAt: Date;
};

/** Filename used for the download and by the verification harness. */
export function pdfFilename(week: Week): string {
  return `scm-analysis-${week.isoLabel}.pdf`;
}

/**
 * Builds the document and hands it back rather than saving it.
 *
 * Split out from exportAnalysisPdf so the verification harness can obtain the
 * actual bytes and open them. A "did it download" check cannot tell a correct
 * PDF from one whose charts came out blank, which is the failure mode that
 * matters here.
 */
export async function buildAnalysisPdf(inputs: PdfInputs) {
  const { jsPDF } = await import("jspdf");

  // Captured BEFORE the document is built, so a chart that fails to rasterise
  // is a caught error rather than a half-written PDF.
  const charts: { title: string; width: number; raster: Raster | null }[] = [];
  for (const chart of CHARTS) {
    charts.push({
      ...chart,
      raster: await rasterizeCard(chart.title, { scale: 2 }),
    });
  }

  const doc = new jsPDF({ unit: "pt", format: "a4", orientation: "portrait" });
  let y = MARGIN;

  /** Starts a new page when `needed` points will not fit below the cursor. */
  const ensure = (needed: number) => {
    if (y + needed <= PAGE_H - MARGIN) return;
    doc.addPage();
    y = MARGIN;
  };

  const heading = (text: string, size: number, color = INK) => {
    doc.setFont("helvetica", "bold");
    doc.setFontSize(size);
    doc.setTextColor(color);
    doc.text(text, MARGIN, y);
    y += size + 6;
  };

  /**
   * Wrapped body text. Paginates per line rather than per block, so a long
   * narrative splits across pages instead of overflowing the last one.
   */
  const paragraph = (text: string, size = 10, color = MUTED, width = CONTENT_W) => {
    doc.setFont("helvetica", "normal");
    doc.setFontSize(size);
    doc.setTextColor(color);
    const lines = doc.splitTextToSize(text, width) as string[];
    const lineHeight = size * 1.45;
    for (const line of lines) {
      ensure(lineHeight);
      doc.text(line, MARGIN, y);
      y += lineHeight;
    }
    y += 4;
  };

  const rule = () => {
    ensure(12);
    doc.setDrawColor(RULE);
    doc.setLineWidth(0.7);
    doc.line(MARGIN, y, PAGE_W - MARGIN, y);
    y += 14;
  };

  // --- Cover block ---------------------------------------------------------
  doc.setFont("helvetica", "bold");
  doc.setFontSize(9);
  doc.setTextColor("#12a394");
  doc.text("SCM MEDIA MONITOR", MARGIN, y);
  // jsPDF positions text by its BASELINE, so the following 22pt heading
  // extends roughly 16pt ABOVE the y it is drawn at. Advancing by only the
  // eyebrow's own height let the title's ascenders climb back over it, and the
  // two lines rendered on top of each other.
  y += 30;

  heading("Weekly Analysis", 22);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(12);
  doc.setTextColor(MUTED);
  doc.text(`${inputs.week.label}  ·  ${inputs.week.isoLabel}`, MARGIN, y);
  y += 16;
  doc.setFontSize(9);
  doc.text(
    `Generated ${inputs.generatedAt.toISOString().slice(0, 16).replace("T", " ")} UTC`,
    MARGIN,
    y
  );
  y += 18;
  rule();

  // --- Overview ------------------------------------------------------------
  const stats: [string, number][] = [
    ["Articles", inputs.overview.total],
    ["Coded", inputs.overview.coded],
    ["Flagged / excluded", inputs.overview.setAside],
    ["Active sources", inputs.overview.activeSources],
  ];
  const colW = CONTENT_W / stats.length;
  ensure(52);
  stats.forEach(([label, value], i) => {
    const x = MARGIN + i * colW;
    doc.setFont("helvetica", "bold");
    doc.setFontSize(20);
    doc.setTextColor(INK);
    doc.text(String(value), x, y + 18);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8);
    doc.setTextColor(MUTED);
    doc.text(label.toUpperCase(), x, y + 32);
  });
  y += 48;
  paragraph(
    "Charts are built from the week's coded, active articles. Articles excluded by hand or flagged off-topic are counted above but never plotted.",
    8.5
  );
  rule();

  // --- Narrative -----------------------------------------------------------
  if (inputs.narrative) {
    heading("The week in brief", 13);
    paragraph(inputs.narrative.period_summary, 10.5, INK);
    y += 2;
  }

  // --- Charts --------------------------------------------------------------
  // Started on a fresh page rather than continuing under the narrative.
  //
  // Charts are tall and indivisible, so wherever one does not fit it moves
  // whole to the next page and leaves the remainder of the current one blank.
  // Letting the first chart trail the narrative meant it half-filled page one
  // and then orphaned the next two charts onto pages of their own, each mostly
  // white. Giving the run of charts its own page lets them pack against each
  // other instead.
  //
  // The alternative — scaling charts down until they fit the gap — is the
  // trade this panel has already rejected once: a chart shrunk to fit is a
  // chart nobody can read.
  if (charts.some((c) => c.raster)) {
    doc.addPage();
    y = MARGIN;
  }

  for (const { title, width, raster } of charts) {
    if (!raster) continue;
    const drawW = CONTENT_W * width;
    const drawH = (raster.height / raster.width) * drawW;
    // Narrower charts sit centred rather than ragged against the left margin.
    const x = MARGIN + (CONTENT_W - drawW) / 2;

    // Heading and image kept together: a title stranded at the foot of a page
    // above a chart on the next one is worse than a slightly short page.
    ensure(drawH + 30);
    heading(title, 12);
    doc.addImage(raster.dataUrl, "PNG", x, y, drawW, drawH, undefined, "FAST");
    y += drawH + 18;
  }

  // --- Themes in detail ----------------------------------------------------
  if (inputs.stories.length > 0) {
    ensure(40);
    rule();
    heading("Top themes in detail", 13);
    paragraph(
      "Stories are ranked by keyword mentions, the same prominence measure the Articles panel sorts on.",
      8.5
    );

    for (const theme of inputs.stories) {
      ensure(46);
      heading(`${theme.theme}  (${theme.articles})`, 11);

      const written = inputs.narrative?.themes.find((t) => t.theme === theme.theme);
      if (written) paragraph(written.narrative, 9.5, MUTED);

      for (const [label, list] of [
        ["Most prominent favourable", theme.positive],
        ["Most prominent unfavourable", theme.negative],
      ] as const) {
        ensure(24);
        doc.setFont("helvetica", "bold");
        doc.setFontSize(8.5);
        doc.setTextColor(label.includes("unfavourable") ? "#d9503f" : "#12a394");
        doc.text(label.toUpperCase(), MARGIN, y);
        y += 12;

        if (list.length === 0) {
          paragraph("None this week.", 9);
          continue;
        }
        for (const story of list) {
          const meta = [story.media, story.published_at, `${story.mentions} mentions`]
            .filter(Boolean)
            .join("  ·  ");
          paragraph(`• ${story.headline}`, 9.5, INK, CONTENT_W - 10);
          paragraph(`   ${meta}`, 8, MUTED, CONTENT_W - 10);
        }
      }
      y += 6;
    }
  }

  // --- Page numbers --------------------------------------------------------
  // Added last, when the total is finally known.
  const pages = doc.getNumberOfPages();
  for (let p = 1; p <= pages; p += 1) {
    doc.setPage(p);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8);
    doc.setTextColor(MUTED);
    doc.text(
      `${inputs.week.isoLabel}  ·  page ${p} of ${pages}`,
      PAGE_W / 2,
      PAGE_H - 22,
      { align: "center" }
    );
  }

  return doc;
}

/** Builds the PDF and hands it to the browser as a download. */
export async function exportAnalysisPdf(inputs: PdfInputs): Promise<void> {
  const doc = await buildAnalysisPdf(inputs);
  doc.save(pdfFilename(inputs.week));
}
