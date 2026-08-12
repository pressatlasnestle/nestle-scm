"use client";

import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
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
              analysable share stays readable as a proportion of it.

              isAnimationActive={false} matters beyond taste, and this chart
              was the only one missing it. Recharts defers creating the bar
              rectangles to an animation frame, so until that frame runs the
              bars do not exist in the DOM at all — not zero-height, absent.
              The PDF export rasterises whatever is on screen at the moment it
              is asked, so an export taken in the first moments after load, or
              from a backgrounded tab where requestAnimationFrame is throttled,
              captured a volume chart with axes, gridlines and no data. It was
              found exactly that way: the generated PDF had an empty plot area
              while every other chart was correct. */}
          <Bar
            dataKey="coded"
            name="Coded"
            stackId="v"
            fill="var(--teal)"
            radius={[0, 0, 0, 0]}
            isAnimationActive={false}
          />
          <Bar
            dataKey="notAnalysed"
            name="Not analysed"
            stackId="v"
            fill="var(--line)"
            radius={[3, 3, 0, 0]}
            isAnimationActive={false}
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
          slice, both unfavourable into the other. Each slice is labelled with
          its share and its article count.
        </>
      }
      onExport={exportCsv}
      empty={
        codedTotal === 0
          ? "Nothing in this week has been coded yet, so there is no favourability to show."
          : undefined
      }
    >
      <ResponsiveContainer width="100%" height={300}>
        <PieChart>
          <Pie
            data={shares}
            dataKey="percent"
            nameKey="label"
            cx="50%"
            cy="50%"
            outerRadius={78}
            innerRadius={44}
            paddingAngle={1}
            stroke="var(--panel)"
            strokeWidth={2}
            isAnimationActive={false}
            // Labelled on the slice itself, not left to the legend: a legend
            // makes the reader match colour to name and then guess magnitude
            // from arc length, which is the one thing a pie is bad at. The
            // number removes the guess.
            label={renderPolarityLabel}
            labelLine={false}
          >
            {shares.map((s) => (
              <Cell key={s.polarity} fill={POLARITY_COLOR[s.polarity]} />
            ))}
          </Pie>
          <Tooltip
            contentStyle={TOOLTIP_STYLE}
            formatter={(value, name, item) => {
              const share = (item as { payload?: PolarityShare } | undefined)
                ?.payload;
              return [
                `${value}%  (${share?.articles ?? 0} articles)`,
                String(name),
              ];
            }}
          />
          <Legend
            wrapperStyle={{ fontSize: 12, fontFamily: "var(--font-body)" }}
          />
        </PieChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}

/**
 * Slice label: the percentage, with the article count beneath it.
 *
 * Both, because a percentage alone over a small week is easy to over-read —
 * "40%" of five articles is two — and the count is what stops that. The count
 * used to sit above the bars this chart replaced, so keeping it here loses
 * nothing.
 *
 * DRAWN OUTSIDE THE RING, not on it. The first version put labels at the arc
 * midpoint in the panel's background colour, which looked right on the two
 * wide slices and failed on the narrow one: "21.2%" is wider than a 21% slice
 * is thick, so it spilled over the donut hole and became dark text on a dark
 * background. Outside placement makes legibility independent of how narrow the
 * slice is, which is the only version that stays correct for every week's
 * data rather than for the week it was designed against.
 *
 * Coloured to match its slice, so the label still reads as belonging to it
 * without a leader line doing that work.
 */
function renderPolarityLabel(props: {
  cx?: number;
  cy?: number;
  midAngle?: number;
  outerRadius?: number;
  payload?: PolarityShare;
}) {
  const { cx = 0, cy = 0, midAngle = 0, outerRadius = 0 } = props;
  const share = props.payload;
  // A zero slice has no arc to point at, so it gets no label; the legend and
  // the CSV still carry it.
  if (!share || share.articles === 0) return null;

  const rad = -midAngle * (Math.PI / 180);
  const radius = outerRadius + 26;
  const x = cx + radius * Math.cos(rad);
  const y = cy + radius * Math.sin(rad);
  // Anchor away from the centre so long labels grow outward rather than back
  // across the ring.
  const anchor = Math.cos(rad) >= 0 ? "start" : "end";
  const dx = Math.cos(rad) >= 0 ? -6 : 6;

  return (
    <g>
      <text
        x={x + dx}
        y={y - 6}
        textAnchor={anchor}
        dominantBaseline="central"
        fill={POLARITY_COLOR[share.polarity]}
        fontSize={15}
        fontWeight={700}
        fontFamily="var(--font-display)"
      >
        {share.percent}%
      </text>
      <text
        x={x + dx}
        y={y + 10}
        textAnchor={anchor}
        dominantBaseline="central"
        fill="var(--text-muted)"
        fontSize={11}
        fontFamily="var(--font-mono)"
      >
        {share.articles} article{share.articles === 1 ? "" : "s"}
      </text>
    </g>
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
    // The total is appended to the axis label — "Chokepoints & routing (25)".
    // This chart used to sit next to a theme-distribution pie whose only job
    // was to show that total; the pie is gone, and putting the number on the
    // label keeps it without spending a second chart on it. It is also more
    // precise than the pie was: a count is exact where a slice is estimated.
    //
    // Truncation applies to the NAME only, never to the count — a label that
    // dropped its number would defeat the point of moving it here.
    short:
      (t.theme.length > 27 ? `${t.theme.slice(0, 26)}…` : t.theme) +
      ` (${t.articles})`,
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
      title="Themes"
      hint={
        <>
          Every theme in the week, busiest first, split by direction. The number
          after each name is that theme&apos;s article total. An article can
          carry up to three themes and is counted under each, so the totals add
          up to more than the {codedTotal} coded article
          {codedTotal === 1 ? "" : "s"}.
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
            // Widened from 150 to fit the appended count. Without this the
            // gutter clips the very thing the theme pie was removed in favour
            // of showing.
            width={214}
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
