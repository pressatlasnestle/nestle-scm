"use client";

import { useState, useTransition, type CSSProperties, type ReactNode } from "react";
import dynamic from "next/dynamic";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { useToast } from "@/components/Toast";
import { WeekSelect } from "@/components/WeekSelect";
import type { Week } from "@/lib/analysis/week-period";
import type {
  WordCloudWord,
  PolarityShare,
  ThemeStat,
  ThemeStories,
  VolumeDay,
  WeekOverview,
} from "@/lib/analysis/week-stats";
import type { WeekNarrative } from "@/lib/analysis/narrative";
import type {
  CongestionRow,
  FleetStatusRow,
  PortCongestionRow,
  ScheduleReliabilityRow,
} from "@/lib/analysis/operational";
import { OperationalSection } from "./OperationalCharts";
import {
  PolarityChart,
  ThemePolarityChart,
  VolumeChart,
} from "./charts";
import { NarrativePanel } from "./NarrativePanel";

/**
 * Client-only, and that is load-bearing rather than an optimisation.
 *
 * The cloud's layout comes from d3-cloud, which measures glyph widths by
 * writing to a <canvas>. "use client" does not mean client-ONLY — Next.js
 * still server-renders client components to produce the initial HTML — so a
 * plain import crashes the server render with `document is not defined`.
 * ssr:false keeps it out of that pass entirely.
 *
 * Legal here only because AnalysisView is itself a client component; Next 15
 * rejects ssr:false inside a Server Component.
 */
const WordCloud = dynamic(
  () => import("./WordCloud").then((m) => m.WordCloud),
  {
    ssr: false,
    loading: () => (
      <div className="chart-card">
        <div className="chart-body">
          <div className="empty-state">
            <div className="empty-sub">Laying out keywords…</div>
          </div>
        </div>
      </div>
    ),
  }
);

const selectStyle: CSSProperties = {
  background: "var(--panel-raised)",
  border: "1px solid var(--line)",
  borderRadius: 7,
  padding: "8px 11px",
  fontSize: 12.5,
  color: "var(--text)",
  fontFamily: "var(--font-body)",
};

function StatCard({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: number;
  sub: ReactNode;
  tone?: string;
}) {
  return (
    <div className="stat-card">
      <div className="stat-label">{label}</div>
      <div className="stat-value" style={tone ? { color: tone } : undefined}>
        {value}
      </div>
      <div className="stat-sub">{sub}</div>
    </div>
  );
}

export function AnalysisView({
  week,
  weeks,
  overview,
  volume,
  polarity,
  themes,
  words,
  wordsShown,
  stories,
  narrative,
  narrativeGeneratedAt,
  congestion,
  fleet,
  portCongestion,
  reliability,
  ports,
  codedTotal,
  truncated,
  loadError,
  canCurate,
}: {
  week: Week;
  weeks: Week[];
  overview: WeekOverview;
  volume: VolumeDay[];
  polarity: PolarityShare[];
  themes: ThemeStat[];
  words: WordCloudWord[];
  wordsShown: WordCloudWord[];
  stories: ThemeStories[];
  narrative: WeekNarrative | null;
  narrativeGeneratedAt: string | null;
  congestion: CongestionRow[];
  fleet: FleetStatusRow[];
  portCongestion: PortCongestionRow[];
  reliability: ScheduleReliabilityRow | null;
  ports: string[];
  codedTotal: number;
  truncated: boolean;
  loadError: string | null;
  canCurate: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();
  const toast = useToast();
  const [exporting, setExporting] = useState(false);

  /**
   * Captures the charts as they are currently drawn and assembles the PDF in
   * the browser — see lib/analysis/pdf.ts for why it is not a server render.
   * The module is imported here rather than at the top of the file so its
   * weight only loads for someone who actually presses the button.
   */
  async function downloadPdf() {
    setExporting(true);
    try {
      const { exportAnalysisPdf } = await import("@/lib/analysis/pdf");
      await exportAnalysisPdf({
        week,
        overview,
        narrative,
        stories,
        generatedAt: new Date(),
      });
    } catch (err) {
      // Never fails silently: a download that simply does not happen is
      // indistinguishable from a slow one, and the user would just keep
      // clicking.
      toast.error(
        err instanceof Error ? err.message : "Could not build the PDF."
      );
    } finally {
      setExporting(false);
    }
  }

  function selectWeek(start: string) {
    const params = new URLSearchParams(searchParams.toString());
    params.set("week", start);
    startTransition(() => router.push(`${pathname}?${params.toString()}`));
  }

  return (
    <>
      <div className="panel-head">
        <div>
          <h1>Analysis</h1>
          <p>
            One ISO week at a time — Monday to Sunday, UTC. Charts are built
            from the week&apos;s <strong>coded, active</strong> articles;
            anything excluded by hand or flagged off-topic is counted below but
            never plotted.
          </p>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {/* Same "↓ Export …" convention as every chart's CSV button, so the
              page has one download idiom rather than two. */}
          <button
            type="button"
            className="btn btn-sm"
            onClick={downloadPdf}
            disabled={exporting || overview.total === 0}
            title={
              overview.total === 0
                ? "Nothing published in this week to export."
                : "Download this week's charts and narrative as a PDF."
            }
          >
            {exporting ? "Building…" : "↓ Export PDF"}
          </button>
          {/* The same control the Newsletter composer uses. Two screens
              addressed by week should phrase a week identically — see
              components/WeekSelect. */}
          <WeekSelect
            options={weeks.map((w) => ({ week: w }))}
            value={week.start}
            disabled={pending}
            onChange={selectWeek}
          />
        </div>
      </div>

      {loadError && (
        <div
          className="mode-card"
          style={{ borderColor: "rgba(240,112,95,0.4)", background: "var(--coral-dim)" }}
        >
          <div className="mode-card-left">
            <div className="eyebrow" style={{ color: "var(--coral)" }}>
              Could not load the week
            </div>
            <p style={{ color: "var(--text)" }}>{loadError}</p>
          </div>
        </div>
      )}

      <div className="stat-row">
        <StatCard
          label="Articles"
          value={overview.total}
          sub={<>Published {week.label} · {week.isoLabel}</>}
        />
        <StatCard
          label="Coded"
          value={overview.coded}
          tone="var(--teal)"
          sub={
            overview.awaitingCoding > 0 ? (
              <>
                Behind every chart. {overview.awaitingCoding} more active
                article{overview.awaitingCoding === 1 ? "" : "s"} still awaiting
                coding.
              </>
            ) : (
              <>Behind every chart. Nothing left to code this week.</>
            )
          }
        />
        <StatCard
          label="Flagged / excluded"
          value={overview.setAside}
          tone={overview.setAside > 0 ? "var(--amber)" : undefined}
          sub={<>Set aside: excluded or deleted by hand, or flagged off-topic.</>}
        />
        <StatCard
          label="Active sources"
          value={overview.activeSources}
          sub={<>Distinct outlets that produced an active article this week.</>}
        />
      </div>

      {truncated && (
        <div className="panel-foot-note" style={{ color: "var(--amber)" }}>
          This week hit the per-week row ceiling — the figures above are a
          partial count.
        </div>
      )}

      {overview.total === 0 ? (
        <div className="table-card">
          <div className="empty-state">
            <div className="empty-title">Nothing published in this week</div>
            <div className="empty-sub">
              No article in the corpus has a published date between{" "}
              {week.start} and {week.end}. Pick another week.
            </div>
          </div>
        </div>
      ) : (
        <>
          {/* Market data first, and visually fenced off. These figures are
              typed in from a subscription report; everything below the divider
              is derived from the article corpus. Mixing them in one grid would
              make a reader assume one provenance for both. */}
          <OperationalSection
            week={week}
            ports={ports}
            congestion={congestion}
            fleet={fleet}
            portCongestion={portCongestion}
            reliability={reliability}
            canCurate={canCurate}
          />

          <div className="section-divider">
            <span>From the article corpus</span>
          </div>

          <div className="chart-grid">
            <VolumeChart week={week} days={volume} />
            <PolarityChart
              week={week}
              shares={polarity}
              codedTotal={codedTotal}
            />
            <ThemePolarityChart
              week={week}
              themes={themes}
              codedTotal={codedTotal}
            />
          </div>

          {/* Full width: a cloud needs the horizontal room to pack around its
              centre, so it sits outside the two-up grid. */}
          <div style={{ marginBottom: 18 }}>
            <WordCloud week={week} words={words} shown={wordsShown} />
          </div>

          <NarrativePanel
            week={week}
            narrative={narrative}
            generatedAt={narrativeGeneratedAt}
            stories={stories}
            canCurate={canCurate}
            codedTotal={codedTotal}
          />
        </>
      )}

      {!canCurate && (
        <div className="panel-foot-note">
          You have read access. Every chart and export on this page is available
          to you; only regenerating the AI narrative needs the curate or admin
          role.
        </div>
      )}
    </>
  );
}
