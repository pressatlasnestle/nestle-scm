/**
 * Builds standalone pages that render the REAL newsletter components against
 * REAL press data, so they can be looked at.
 *
 *   npx tsx --env-file=.env.local scripts/checks/newsletter-visual.ts [YYYY-MM]
 *   → three plain file:// pages; no auth, no dev server, no Next.js
 *
 * WHY THIS EXISTS.
 *
 * check:newsletter answers "are the numbers right" and "does the HTML break the
 * email rules". Neither question can see a container that measures zero width
 * and draws nothing, a modal that loses its max-width on source order, or a
 * dropdown clipped by an overflow ancestor — and each of those shipped in a
 * previous round of this project. Numeric correctness and visual correctness
 * are different properties and need different tests.
 *
 * THREE PAGES, because there are three things to look at:
 *
 *   email.html         the rendered edition on its own, resizable
 *   email-widths.html  the same edition at 640px and at 375px, side by side —
 *                      375 is where a table-based layout actually breaks, and
 *                      checking only the design width is how a column collapses
 *                      in the client and nowhere else
 *   index.html         the composer, every authored field filled, so the two
 *                      columns can be read at full length rather than as the
 *                      empty boxes a fresh edition shows
 *
 * The press section uses REAL coded articles for the month, because the thing
 * most likely to break the layout is a real headline: they run long, they carry
 * punctuation, and no invented fixture is as hostile as the corpus. The
 * OPERATIONAL figures are invented and obviously rounded — they must never be
 * mistakable for transcribed Linerlytica numbers if a screenshot escapes.
 *
 * Output goes to .harness/newsletter, not into the repo's source.
 */

import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createAdminClient } from "../../src/lib/supabase/admin";
import { monthFromIso, previousMonth } from "../../src/lib/newsletter/month";
import {
  buildGenerated,
  sectionStates,
  subjectLine,
  type Authored,
  type EditionInput,
} from "../../src/lib/newsletter/edition";
import { renderEditionHtml } from "../../src/lib/newsletter/email";
import type { PressCandidate } from "../../src/lib/newsletter/press";
import type {
  CongestionRow,
  FleetStatusRow,
  PortCongestionRow,
  ScheduleReliabilityRow,
} from "../../src/lib/analysis/operational";

const PRESS_SELECT = "id, headline, ai_summary, url, media, published_at, ai_themes";

const STAMP = { entered_at: new Date(0).toISOString(), entered_by: null };

/**
 * Authored text at realistic length.
 *
 * Long enough to wrap, and explicitly labelled as harness copy so a screenshot
 * of it can never be mistaken for a real edition's commentary.
 */
const AUTHORED: Authored = {
  headlineRead:
    "HARNESS COPY, NOT A REAL EDITION. Congestion eased across North Asia through the month while the Gulf remained the binding constraint on our westbound lanes. The practical effect for us is narrow: transit variance, not capacity, is what moved.\n\nNothing this month changes the standing booking posture. The watch list below is where the risk actually sits.",
  regionalCommentary:
    "HARNESS COPY. North Asia carried the largest absolute reduction, though from the highest base, and the improvement is concentrated in the two ports we do not use heavily. SE Asia is flat within noise. Nothing in the regional picture argues for re-routing.",
  reliabilityNote:
    "HARNESS COPY. Reliability improved a little on the headline number, but the average delay on late arrivals did not, which is the figure that actually sets our buffer. Read the two together before drawing a conclusion from the first alone.",
  watchList: [
    {
      risk: "Red Sea routing stays committed to the Cape, keeping Asia–Europe transit at the longer profile",
      lanes: "Asia–North Europe, Asia–Mediterranean",
      window: "Next two quarters",
      direction: "Stable — no carrier has signalled a return",
    },
    {
      risk: "Equipment repositioning lags demand into the year-end peak",
      lanes: "ISC exports, SE Asia exports",
      window: "6–10 weeks",
      direction: "Worsening — watch box availability at origin",
    },
  ],
  recommendedActions: [
    "HARNESS COPY. Hold the current buffer on Asia–North Europe; the delay figure has not moved with the reliability figure.",
    "Confirm equipment availability with origin offices in ISC before committing to the peak-season volumes.",
    "No action on SE Asia — the change is inside the noise band and does not justify a re-tender.",
  ],
};

/**
 * Invented operational figures. Deliberately round, and deliberately not the
 * reference Linerlytica values, so they cannot be confused with transcription.
 * The queue/berth ratios still disagree with their ship counts, because that
 * disagreement is the thing the port table must render faithfully.
 */
function operationalFixtures(monthStart: string, priorStart: string) {
  const latest = `${monthStart.slice(0, 7)}-24`;
  const earlier = `${monthStart.slice(0, 7)}-11`;
  const priorLatest = `${priorStart.slice(0, 7)}-27`;

  const congestion: CongestionRow[] = [
    {
      day_of: earlier,
      global_teu_waiting: 1_900_000,
      global_pct_fleet: 5.4,
      region_data: { north_asia: 800_000, southeast_asia: 400_000, europe: 500_000, north_america: 150_000, south_america: 50_000 },
      ...STAMP,
    },
    {
      day_of: latest,
      global_teu_waiting: 1_750_000,
      global_pct_fleet: 5.0,
      region_data: { north_asia: 700_000, southeast_asia: 420_000, europe: 480_000, north_america: 100_000, south_america: 50_000 },
      ...STAMP,
    },
  ];

  const priorCongestion: CongestionRow[] = [
    {
      day_of: priorLatest,
      global_teu_waiting: 2_100_000,
      global_pct_fleet: 6.0,
      region_data: { north_asia: 900_000, southeast_asia: 400_000, europe: 600_000, north_america: 150_000, south_america: 50_000 },
      ...STAMP,
    },
  ];

  const fleet: FleetStatusRow[] = [
    {
      day_of: latest,
      // Overlapping on purpose: at port + at anchorage is far below active.
      status_data: {
        "Ships at port": { ships: 1200, teu: 7_000_000 },
        "Active Ships": { ships: 5400, teu: 31_000_000 },
        "Inactive Ships": { ships: 700, teu: 1_500_000 },
        "Ships at anchorage": { ships: 1100, teu: 6_000_000 },
        "Ships in shipyard": { ships: 300, teu: 900_000 },
      },
      ...STAMP,
    },
  ];
  const priorFleet: FleetStatusRow[] = [
    {
      day_of: priorLatest,
      status_data: {
        "Ships at port": { ships: 1150, teu: 6_800_000 },
        "Active Ships": { ships: 5300, teu: 30_000_000 },
        "Ships at anchorage": { ships: 1250, teu: 6_600_000 },
      },
      ...STAMP,
    },
  ];

  // Five ports, including the longest and most punctuated names in the seed —
  // the port column is the one most likely to blow out a 375px table.
  const portRow = (
    day: string,
    port: string,
    anchorage: number,
    atPort: number,
    teuAnchorage: number,
    ratio: number
  ): PortCongestionRow => ({
    day_of: day,
    port_name: port,
    ships_anchorage: anchorage,
    ships_port: atPort,
    teu_anchorage: teuAnchorage,
    teu_port: Math.round(teuAnchorage / 2),
    queue_berth_ratio: ratio,
    ...STAMP,
  });

  const ports: PortCongestionRow[] = [
    portRow(latest, "Shanghai/Ningbo", 67, 19, 500_000, 3.5),
    portRow(latest, "Gibraltar (Algeciras/Tanger Med)", 21, 8, 190_000, 2.8),
    portRow(latest, "Singapore", 44, 30, 320_000, 1.4),
    portRow(latest, "Busan", 122, 48, 240_000, 2.54),
    portRow(latest, "LA/LB", 9, 14, 60_000, 0.64),
  ];
  const priorPorts: PortCongestionRow[] = [
    portRow(priorLatest, "Shanghai/Ningbo", 72, 19, 560_000, 3.8),
    portRow(priorLatest, "Gibraltar (Algeciras/Tanger Med)", 18, 8, 150_000, 2.3),
    portRow(priorLatest, "Singapore", 40, 30, 300_000, 1.3),
    // Busan has no prior row on purpose, so one line of the table has to render
    // an absence rather than a number.
    portRow(priorLatest, "LA/LB", 11, 14, 75_000, 0.8),
  ];

  const reliability: ScheduleReliabilityRow = {
    month_of: monthStart,
    glp_issue_number: 100,
    global_reliability_pct: 65,
    avg_delay_days: 4.5,
    alliance_data: {
      "Gemini Cooperation": 90,
      "Ocean Alliance": 60,
      "Premier Alliance": 55,
      "MSC standalone": 70,
    },
    ...STAMP,
  };
  const priorReliability: ScheduleReliabilityRow = {
    month_of: priorStart,
    glp_issue_number: 99,
    global_reliability_pct: 62,
    avg_delay_days: 4.9,
    alliance_data: {
      "Gemini Cooperation": 88,
      "Ocean Alliance": 58,
      "Premier Alliance": 57,
      "MSC standalone": 66,
    },
    ...STAMP,
  };

  return { congestion, priorCongestion, fleet, priorFleet, ports, priorPorts, reliability, priorReliability };
}

async function main() {
  const outDir = process.env.HARNESS_OUT ?? join(process.cwd(), ".harness", "newsletter");
  mkdirSync(outDir, { recursive: true });

  const monthArg = process.argv[2] ?? "2026-08";
  const month = monthFromIso(`${monthArg}-01`);
  const prior = previousMonth(month);

  const client = createAdminClient();
  const { data, error } = await client
    .from("articles")
    .select(PRESS_SELECT)
    .eq("status", "active")
    .eq("coded_status", "coded")
    .not("published_at", "is", null)
    .gte("published_at", month.start)
    .lte("published_at", month.end)
    .order("published_at", { ascending: false })
    .limit(2000);
  if (error) throw new Error(error.message);

  const press = (data ?? []) as PressCandidate[];

  const input: EditionInput = {
    month,
    ...operationalFixtures(month.start, prior.start),
    press,
    includedArticleIds: null,
    hasHistoryBefore: true,
  };

  const generated = buildGenerated(input);
  const edition = {
    generated,
    authored: AUTHORED,
    sections: sectionStates(generated, AUTHORED),
  };
  const html = renderEditionHtml(edition, { baseUrl: "https://nestle-scm.vercel.app" });

  console.log(
    `${month.label}: ${press.length} coded articles, ${generated.press.themes.length} themes, ` +
      `${generated.press.shown} shown, ${generated.glance.length} glance rows, ` +
      `${generated.ports.length} ports, ${generated.regions.length} regions`
  );
  console.log(
    `Sections dropped: ${
      edition.sections.filter((s) => !s.present).map((s) => s.title).join(", ") || "none"
    }`
  );

  // --- 1. The email, standalone -------------------------------------------
  writeFileSync(join(outDir, "email.html"), html);

  // --- 2. Both widths, side by side ---------------------------------------
  // srcdoc rather than src="./email.html", so the page is self-contained and
  // opens straight off the filesystem. An iframe with a relative src needs an
  // http origin to resolve against; served as a file it renders two empty grey
  // rectangles, which looks exactly like a layout bug and is not one.
  const srcdoc = html.replace(/&/g, "&amp;").replace(/"/g, "&quot;");

  writeFileSync(
    join(outDir, "email-widths.html"),
    `<!doctype html><html><head><meta charset="utf-8"><title>Edition — 640px and 375px</title>
<style>
  body { margin:0; background:#0a121f; color:#e7edf6; font-family:"Segoe UI",system-ui,sans-serif; }
  h1 { font-size:15px; font-weight:600; padding:14px 18px 0; margin:0; }
  p { font-size:12px; color:#8494af; padding:4px 18px 12px; margin:0; }
  .row { display:flex; gap:20px; padding:0 18px 20px; align-items:flex-start; }
  .col { flex:0 0 auto; }
  .cap { font-family:"Cascadia Mono",Consolas,monospace; font-size:11px; color:#2fd9c7; padding:0 0 6px; }
  iframe { border:1px solid #223252; border-radius:8px; background:#eef2f7; height:1400px; display:block; }
</style></head><body>
<h1>${subjectLine(month)}</h1>
<p>Left: the 640px design width. Right: 375px, where a table-based layout actually breaks — check that no column is clipped, no figure wraps mid-number, and the page itself never scrolls sideways.</p>
<div class="row">
  <div class="col"><div class="cap">640px &middot; desktop</div><iframe width="640" srcdoc="${srcdoc}"></iframe></div>
  <div class="col"><div class="cap">375px &middot; phone</div><iframe width="375" srcdoc="${srcdoc}"></iframe></div>
</div>
</body></html>`
  );

  // --- 3. The composer -----------------------------------------------------
  writeFileSync(
    join(outDir, "data.json"),
    JSON.stringify({ month, input, authored: AUTHORED, baseUrl: "https://nestle-scm.vercel.app" }, null, 2)
  );

  writeFileSync(
    join(outDir, "entry.tsx"),
    `import { createRoot } from "react-dom/client";
import { NewsletterComposer } from "@/app/(admin)/newsletter/NewsletterComposer";
import { ToastProvider } from "@/components/Toast";
import { recentMonths } from "@/lib/newsletter/month";
import data from "./data.json";

const d = data as any;

createRoot(document.getElementById("root")!).render(
  <ToastProvider>
    <div className="content">
      <NewsletterComposer
        month={d.month}
        months={[d.month, ...recentMonths(new Date("2026-08-14"), 6)].filter(
          (m, i, all) => all.findIndex((x) => x.start === m.start) === i
        )}
        editions={[{ monthStart: d.month.start, status: "draft", sentAt: null }]}
        status="draft"
        exists
        sentAt={null}
        savedAt={"2026-08-14T09:00:00.000Z"}
        authored={d.authored}
        includedArticleIds={null}
        input={d.input}
        truncated={false}
        loadError={null}
        snapshot={null}
        snapshotUnreadable={false}
        baseUrl={d.baseUrl}
        canCurate
      />
    </div>
  </ToastProvider>
);
`
  );

  /**
   * Stand-ins for the two modules a browser bundle cannot have.
   *
   * actions.ts is "use server" and cannot be bundled at all; next/navigation's
   * hooks need a Next router in context. Both are aliased to inert versions so
   * the REAL composer renders with the REAL data shapes — only Save, Send and
   * the month selector are dead, and those are covered by check:newsletter.
   */
  writeFileSync(
    join(outDir, "action-stub.ts"),
    `export async function saveEdition() { return { ok: true as const }; }
export async function sendEdition() { return { ok: true as const }; }
`
  );
  writeFileSync(
    join(outDir, "navigation-stub.ts"),
    `export function useRouter() { return { push() {}, replace() {}, refresh() {}, back() {}, forward() {}, prefetch() {} }; }
export function usePathname() { return "/newsletter"; }
export function useSearchParams() { return new URLSearchParams(); }
`
  );

  const bundlePath = join(outDir, "bundle.js");
  const esbuild = await import("esbuild");
  await esbuild.build({
    entryPoints: [join(outDir, "entry.tsx")],
    bundle: true,
    outfile: bundlePath,
    jsx: "automatic",
    // Minified because the bundle is inlined into index.html: unminified it
    // pushes the page past 780KB, which is large enough that some viewers
    // refuse to open it at all.
    minify: true,
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    alias: {
      "@": resolve(process.cwd(), "src"),
      "next/navigation": join(outDir, "navigation-stub.ts"),
    },
    plugins: [
      {
        // The composer imports the actions as "./actions", and esbuild's alias
        // map matches the specifier exactly as written, so a path alias never
        // fires for a relative import. A resolve plugin matches the specifier
        // AS WRITTEN — not the resolved file path, which is the mistake that
        // let actions.ts into the bundle and dragged Next's server tracer in
        // behind it.
        name: "stub-server-actions",
        setup(build) {
          build.onResolve({ filter: /^\.\/actions$/ }, () => ({
            path: join(outDir, "action-stub.ts"),
          }));
        },
      },
    ],
    logLevel: "warning",
  });

  // The panel's real stylesheet, minus the Next font-variable declarations it
  // cannot resolve outside the app — substituted with the same families so text
  // metrics stay representative.
  const css = readFileSync(join(process.cwd(), "src/app/globals.css"), "utf8");

  /**
   * The bundle is INLINED rather than referenced.
   *
   * A `<script src="./bundle.js">` needs an http origin to resolve against; off
   * the filesystem it silently fetches nothing and the page renders an empty
   * <div id="root"> — a blank dark rectangle that looks exactly like a
   * component crashing and is not. Inlining makes the harness a single file
   * that opens by double-click, with no server to start first.
   *
   * `</script` is escaped because it can legally appear inside a string literal
   * in the bundle and would otherwise close this tag early, truncating the app.
   */
  const bundle = readFileSync(bundlePath, "utf8").replace(/<\/script/gi, "<\\/script");

  writeFileSync(
    join(outDir, "index.html"),
    `<!doctype html>
<html><head><meta charset="utf-8"><title>Newsletter composer</title>
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
<body><div id="root"></div><script>${bundle}</script></body></html>`
  );

  console.log(`\nOpen:\n  ${join(outDir, "email-widths.html")}\n  ${join(outDir, "index.html")}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
