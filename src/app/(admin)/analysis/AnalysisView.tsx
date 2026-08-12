"use client";

import { useTransition, type CSSProperties, type ReactNode } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import type { Week } from "@/lib/analysis/week-period";
import type {
  KeywordBubble,
  PolarityShare,
  ThemeStat,
  ThemeStories,
  VolumeDay,
  WeekOverview,
} from "@/lib/analysis/week-stats";
import type { WeekNarrative } from "@/lib/analysis/narrative";
import {
  KeywordBubbleChart,
  PolarityChart,
  ThemePieChart,
  ThemePolarityChart,
  VolumeChart,
} from "./charts";
import { NarrativePanel } from "./NarrativePanel";

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
  bubbles,
  bubblesShown,
  bubblesPerTheme,
  stories,
  narrative,
  narrativeGeneratedAt,
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
  bubbles: KeywordBubble[];
  bubblesShown: KeywordBubble[];
  bubblesPerTheme: number;
  stories: ThemeStories[];
  narrative: WeekNarrative | null;
  narrativeGeneratedAt: string | null;
  codedTotal: number;
  truncated: boolean;
  loadError: string | null;
  canCurate: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();

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
        <select
          style={selectStyle}
          aria-label="Week"
          value={week.start}
          disabled={pending}
          onChange={(e) => selectWeek(e.target.value)}
        >
          {weeks.map((w) => (
            <option key={w.start} value={w.start}>
              {w.label}
            </option>
          ))}
        </select>
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
          <div className="chart-grid">
            <VolumeChart week={week} days={volume} />
            <PolarityChart
              week={week}
              shares={polarity}
              codedTotal={codedTotal}
            />
            <ThemePieChart
              week={week}
              themes={themes}
              codedTotal={codedTotal}
            />
            <ThemePolarityChart
              week={week}
              themes={themes}
              codedTotal={codedTotal}
            />
          </div>

          {/* Full width: the bubble chart needs the horizontal room for one
              column per theme, so it sits outside the two-up grid. */}
          <div style={{ marginBottom: 18 }}>
            <KeywordBubbleChart
              week={week}
              bubbles={bubbles}
              shown={bubblesShown}
              perTheme={bubblesPerTheme}
            />
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
