"use client";

import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  LabelList,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { Week } from "@/lib/analysis/week-period";
import type {
  PolarityShare,
  ThemeStat,
  VolumeDay,
} from "@/lib/analysis/week-stats";
import { csvFilename, downloadCsv } from "@/lib/analysis/csv";
import {
  polarityColumns,
  themeColumns,
  VOLUME_COLUMNS,
} from "@/lib/analysis/exports";
import { ChartCard } from "./ChartCard";

/**
 * Chart colours.
 *
 * Favourable/Neutral/Unfavourable are teal/amber/coral, the panel's three
 * accent colours, used here in that fixed order so a reader who learns the
 * mapping on one chart carries it to every other one.
 *
 * The word cloud is the one deliberate exception: it uses the same teal and
 * coral but swaps amber for a muted grey, because there neutral means "no
 * dominant direction" rather than "a neutral reading", and amber on a dense
 * field of words reads as a third opinion rather than as an absence of one.
 */
export const POLARITY_COLOR = {
  favourable: "var(--teal)",
  neutral: "var(--amber)",
  unfavourable: "var(--coral)",
} as const;

const AXIS = {
  stroke: "var(--text-dim)",
  fontSize: 11,
  fontFamily: "var(--font-mono)",
} as const;

/** Recharts renders tooltips into the page, so they need explicit panel styling. */
const TOOLTIP_STYLE = {
  background: "var(--panel-raised)",
  border: "1px solid var(--line)",
  borderRadius: 8,
  fontSize: 12.5,
  fontFamily: "var(--font-body)",
  color: "var(--text)",
} as const;

// ---------------------------------------------------------------------------
// Day-on-day volume
// ---------------------------------------------------------------------------

export function VolumeChart({ week, days }: { week: Week; days: VolumeDay[] }) {
  const total = days.reduce((n, d) => n + d.total, 0);

  function exportCsv() {
    downloadCsv(csvFilename("volume", week.isoLabel), days, VOLUME_COLUMNS);
  }

  return (
    <ChartCard
      title="Volume, day on day"
      hint={
        <>
          Every article published in the week, by day. The teal portion is what
          is coded and therefore feeds every other chart on this page; the grey
          portion is flagged, excluded or not yet coded.
        </>
      }
      onExport={exportCsv}
      empty={
        total === 0 ? "No articles were published in this week." : undefined
      }
    >
      <ResponsiveContainer width="100%" height={260}>
        <BarChart data={days} margin={{ top: 8, right: 8, bottom: 0, left: -18 }}>
          <CartesianGrid stroke="var(--line-soft)" vertical={false} />
          <XAxis dataKey="tick" tickLine={false} axisLine={false} tick={AXIS} />
          <YAxis
            tickLine={false}
            axisLine={false}
            tick={AXIS}
            allowDecimals={false}
          />
          <Tooltip
            contentStyle={TOOLTIP_STYLE}
            cursor={{ fill: "var(--line-soft)" }}
            // Recharts types the label as ReactNode; the value is our own
            // `tick` string, so resolve it back to the calendar date.
            labelFormatter={(tick) =>
              days.find((d) => d.tick === tick)?.date ?? String(tick ?? "")
            }
          />
          <Legend
            wrapperStyle={{ fontSize: 12, fontFamily: "var(--font-body)" }}
          />
          {/* Stacked, so the bar height is the day's true volume while the
              analysable share stays readable as a proportion of it. */}
          <Bar
            dataKey="coded"
            name="Coded"
            stackId="v"
            fill="var(--teal)"
            radius={[0, 0, 0, 0]}
          />
          <Bar
            dataKey="notAnalysed"
            name="Not analysed"
            stackId="v"
            fill="var(--line)"
            radius={[3, 3, 0, 0]}
          />
        </BarChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}

// ---------------------------------------------------------------------------
// Favourable / Neutral / Unfavourable
// ---------------------------------------------------------------------------

export function PolarityChart({
  week,
  shares,
  codedTotal,
}: {
  week: Week;
  shares: PolarityShare[];
  codedTotal: number;
}) {
  function exportCsv() {
    downloadCsv(
      csvFilename("sentiment", week.isoLabel),
      shares,
      polarityColumns(codedTotal)
    );
  }

  return (
    <ChartCard
      title="Favourability breakdown"
      hint={
        <>
          Share of the week&apos;s {codedTotal} coded article
          {codedTotal === 1 ? "" : "s"}, judged from a cargo owner&apos;s seat.
          The stored 5-point tiers roll up here: both favourable tiers into one
          bar, both unfavourable into the other.
        </>
      }
      onExport={exportCsv}
      empty={
        codedTotal === 0
          ? "Nothing in this week has been coded yet, so there is no favourability to show."
          : undefined
      }
    >
      <ResponsiveContainer width="100%" height={260}>
        <BarChart data={shares} margin={{ top: 22, right: 8, bottom: 0, left: -18 }}>
          <CartesianGrid stroke="var(--line-soft)" vertical={false} />
          <XAxis dataKey="label" tickLine={false} axisLine={false} tick={AXIS} />
          <YAxis
            tickLine={false}
            axisLine={false}
            tick={AXIS}
            unit="%"
            domain={[0, 100]}
          />
          <Tooltip
            contentStyle={TOOLTIP_STYLE}
            cursor={{ fill: "var(--line-soft)" }}
            formatter={(value, _name, item) => {
              const share = (item as { payload?: PolarityShare } | undefined)
                ?.payload;
              return [
                `${value}%  (${share?.articles ?? 0} articles)`,
                "Share",
              ];
            }}
          />
          <Bar dataKey="percent" radius={[4, 4, 0, 0]} isAnimationActive={false}>
            {shares.map((s) => (
              <Cell key={s.polarity} fill={POLARITY_COLOR[s.polarity]} />
            ))}
            {/* The count is printed on the bar because a percentage over a
                small week is easy to over-read — "40%" of five articles is
                two, and the reader should be able to see that without
                hovering. */}
            <LabelList
              dataKey="articles"
              position="top"
              style={{
                fill: "var(--text-muted)",
                fontSize: 11,
                fontFamily: "var(--font-mono)",
              }}
            />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}

// ---------------------------------------------------------------------------
// Theme distribution
// ---------------------------------------------------------------------------

/**
 * Slice colours.
 *
 * Themes have no inherent direction, so this is a categorical ramp rather than
 * the F/N/U scale — reusing teal/amber/coral here would imply a theme was
 * "good" or "bad", which is exactly the reading to avoid. It cycles if the
 * vocabulary ever outgrows it; the pie is ordered by size, so a repeat can only
 * happen between the two smallest, least-read slices.
 */
const THEME_COLORS = [
  "#2fd9c7",
  "#7c93f0",
  "#f0ae4e",
  "#f0705f",
  "#5ec8e5",
  "#b58ce0",
  "#8fd47a",
  "#e88fb4",
  "#d9c25e",
  "#6fa8dc",
];

export function ThemePieChart({
  week,
  themes,
  codedTotal,
}: {
  week: Week;
  themes: ThemeStat[];
  codedTotal: number;
}) {
  function exportCsv() {
    downloadCsv(
      csvFilename("themes", week.isoLabel),
      themes,
      themeColumns(codedTotal)
    );
  }

  return (
    <ChartCard
      title="Theme distribution"
      hint={
        <>
          Coded articles per theme. An article can carry up to three themes and
          is counted under each, so the slices describe{" "}
          <strong>coverage</strong>, not a split of the {codedTotal} articles —
          they add up to more.
        </>
      }
      onExport={exportCsv}
      empty={
        themes.length === 0
          ? "No coded article in this week carries a theme yet."
          : undefined
      }
    >
      <ResponsiveContainer width="100%" height={300}>
        <PieChart>
          <Pie
            data={themes}
            dataKey="articles"
            nameKey="theme"
            cx="50%"
            cy="50%"
            outerRadius={100}
            innerRadius={48}
            paddingAngle={1}
            stroke="var(--panel)"
            strokeWidth={2}
            isAnimationActive={false}
          >
            {themes.map((t, i) => (
              <Cell key={t.theme} fill={THEME_COLORS[i % THEME_COLORS.length]} />
            ))}
          </Pie>
          <Tooltip
            contentStyle={TOOLTIP_STYLE}
            formatter={(value, name) => [`${value} articles`, String(name)]}
          />
          <Legend
            layout="vertical"
            align="right"
            verticalAlign="middle"
            wrapperStyle={{
              fontSize: 11.5,
              fontFamily: "var(--font-body)",
              maxWidth: 190,
            }}
          />
        </PieChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}

// ---------------------------------------------------------------------------
// Favourability per theme
// ---------------------------------------------------------------------------

export function ThemePolarityChart({
  week,
  themes,
  codedTotal,
}: {
  week: Week;
  themes: ThemeStat[];
  codedTotal: number;
}) {
  // Flattened for Recharts, which wants the stack keys at the top level.
  const data = themes.map((t) => ({
    theme: t.theme,
    // Long theme names would otherwise be truncated to ambiguity on the axis.
    short: t.theme.length > 22 ? `${t.theme.slice(0, 21)}…` : t.theme,
    favourable: t.counts.favourable,
    neutral: t.counts.neutral,
    unfavourable: t.counts.unfavourable,
  }));

  function exportCsv() {
    downloadCsv(
      csvFilename("theme-sentiment", week.isoLabel),
      themes,
      themeColumns(codedTotal)
    );
  }

  return (
    <ChartCard
      title="Favourability by theme"
      hint={
        <>
          The same articles as the pie, split by direction. Horizontal because
          theme names are long — bar length is the article count, and the same
          multi-theme counting applies.
        </>
      }
      onExport={exportCsv}
      empty={
        themes.length === 0
          ? "No coded article in this week carries a theme yet."
          : undefined
      }
    >
      <ResponsiveContainer
        width="100%"
        height={Math.max(220, 46 * data.length + 60)}
      >
        <BarChart
          data={data}
          layout="vertical"
          margin={{ top: 8, right: 16, bottom: 0, left: 10 }}
        >
          <CartesianGrid stroke="var(--line-soft)" horizontal={false} />
          <XAxis
            type="number"
            tickLine={false}
            axisLine={false}
            tick={AXIS}
            allowDecimals={false}
          />
          <YAxis
            type="category"
            dataKey="short"
            tickLine={false}
            axisLine={false}
            tick={{ ...AXIS, fontFamily: "var(--font-body)", fontSize: 11.5 }}
            width={150}
          />
          <Tooltip
            contentStyle={TOOLTIP_STYLE}
            cursor={{ fill: "var(--line-soft)" }}
            labelFormatter={(short) =>
              data.find((d) => d.short === short)?.theme ?? String(short ?? "")
            }
          />
          <Legend
            wrapperStyle={{ fontSize: 12, fontFamily: "var(--font-body)" }}
          />
          <Bar
            dataKey="favourable"
            name="Favourable"
            stackId="t"
            fill={POLARITY_COLOR.favourable}
            isAnimationActive={false}
          />
          <Bar
            dataKey="neutral"
            name="Neutral"
            stackId="t"
            fill={POLARITY_COLOR.neutral}
            isAnimationActive={false}
          />
          <Bar
            dataKey="unfavourable"
            name="Unfavourable"
            stackId="t"
            fill={POLARITY_COLOR.unfavourable}
            radius={[0, 3, 3, 0]}
            isAnimationActive={false}
          />
        </BarChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}
