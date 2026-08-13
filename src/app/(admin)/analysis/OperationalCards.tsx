"use client";

import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { Week } from "@/lib/analysis/week-period";
import { csvFilename, downloadCsv } from "@/lib/analysis/csv";
import {
  congestionRegions,
  formatMonth,
  isCarriedForward,
  namedValues,
  RELIABILITY_ALLIANCES,
  WAITING_TIME_PORTS,
  type CongestionRow,
  type NamedValue,
  type ScheduleReliabilityRow,
  type WaitingTimeRow,
} from "@/lib/analysis/operational";
import { ChartCard } from "./ChartCard";

/**
 * Presentation for the three manually-entered market charts.
 *
 * Deliberately separate from OperationalCharts.tsx, which owns the dialogs and
 * the server actions. Two reasons:
 *
 *   * A "use server" module cannot be bundled for a browser, so anything
 *     importing the actions cannot be rendered by the visual harness. Keeping
 *     the cards free of that import is what makes them checkable by eye
 *     against real-shaped data — which is how the empty volume chart was
 *     caught, and these cards have never been looked at.
 *   * Rendering and data entry are genuinely different jobs. These components
 *     take values and an optional onEdit; they decide nothing about who may
 *     press it.
 */

const AXIS = {
  stroke: "var(--text-dim)",
  fontSize: 11,
  fontFamily: "var(--font-mono)",
} as const;

const TOOLTIP_STYLE = {
  background: "var(--panel-raised)",
  border: "1px solid var(--line)",
  borderRadius: 8,
  fontSize: 12.5,
  fontFamily: "var(--font-body)",
  color: "var(--text)",
} as const;

/**
 * Indigo throughout. These are measured market quantities with no direction —
 * more TEU waiting is not "unfavourable" in the sense the sentiment charts
 * mean — so reusing the teal/amber/coral scale would assert a judgement the
 * data does not carry.
 */
const OPERATIONAL_COLOR = "var(--indigo)";

function EditButton({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button type="button" className="btn btn-sm" onClick={onClick} title={label}>
      ✎ Edit
    </button>
  );
}

function Figure({
  value,
  unit,
  label,
}: {
  value: number | null;
  unit: string;
  label: string;
}) {
  return (
    <div>
      <div className="stat-value" style={{ fontSize: 22 }}>
        {value === null ? "—" : value.toLocaleString("en-US")}
        <span style={{ fontSize: 12, color: "var(--text-muted)", marginLeft: 4 }}>
          {unit}
        </span>
      </div>
      <div className="stat-label" style={{ marginTop: 5 }}>
        {label}
      </div>
    </div>
  );
}

/**
 * Compacts large axis ticks: 600000 → "600k".
 *
 * TEU figures run to seven digits, and a raw tick both crowds the axis and
 * gets clipped at the right edge — the last label on the congestion chart was
 * running off the card. Days and percentages are small and are left alone, so
 * "1.8" does not become "1.8" via a formatter that might round it.
 */
function formatTick(value: number): string {
  if (Math.abs(value) >= 1_000_000) return `${value / 1_000_000}m`;
  if (Math.abs(value) >= 1_000) return `${value / 1_000}k`;
  return String(value);
}

function BreakdownChart({ data, unit }: { data: NamedValue[]; unit: string }) {
  if (data.length === 0) {
    return (
      <div className="cell-sub" style={{ padding: "16px 2px", fontSize: 12 }}>
        No breakdown entered for this period.
      </div>
    );
  }
  return (
    <ResponsiveContainer width="100%" height={34 * data.length + 44}>
      <BarChart
        data={data}
        layout="vertical"
        margin={{ top: 4, right: 30, bottom: 4, left: 8 }}
      >
        <CartesianGrid stroke="var(--line-soft)" horizontal={false} />
        <XAxis
          type="number"
          tick={AXIS}
          tickLine={false}
          axisLine={false}
          tickFormatter={formatTick}
        />
        <YAxis
          type="category"
          dataKey="name"
          tick={{ ...AXIS, fontFamily: "var(--font-body)", fontSize: 11.5 }}
          tickLine={false}
          axisLine={false}
          width={150}
        />
        <Tooltip
          contentStyle={TOOLTIP_STYLE}
          cursor={{ fill: "var(--line-soft)" }}
          formatter={(value) => [`${value} ${unit}`, ""]}
        />
        <Bar
          dataKey="value"
          fill={OPERATIONAL_COLOR}
          radius={[0, 3, 3, 0]}
          // Without this the bars are not in the DOM until an animation frame
          // runs, and the PDF export rasterises whatever is on screen when
          // asked. That is exactly how the volume chart shipped empty.
          isAnimationActive={false}
        />
      </BarChart>
    </ResponsiveContainer>
  );
}

/** Shown to curate users in place of an absent card, never to read users. */
export function MissingCard({
  title,
  period,
  onAdd,
}: {
  title: string;
  period: string;
  onAdd: () => void;
}) {
  return (
    <div className="chart-card operational-missing">
      <div className="chart-head">
        <div>
          <h3>{title}</h3>
          <p>Nothing entered for {period}.</p>
        </div>
        <button type="button" className="btn btn-sm" onClick={onAdd}>
          ✎ Enter data
        </button>
      </div>
    </div>
  );
}

export function CongestionCard({
  week,
  row,
  onEdit,
}: {
  week: Week;
  row: CongestionRow;
  onEdit?: () => void;
}) {
  const regions = congestionRegions(row.region_data);
  return (
    <ChartCard
      title="Port congestion"
      hint={<>Capacity waiting at anchor, {week.label}. Source: Linerlytica.</>}
      action={onEdit ? <EditButton onClick={onEdit} label="Edit congestion figures" /> : undefined}
      onExport={() =>
        downloadCsv(
          csvFilename("port-congestion", week.isoLabel),
          [
            { name: "Global waiting", value: row.global_teu_waiting ?? null },
            { name: "Global share of fleet", value: row.global_pct_fleet ?? null },
            ...regions,
          ],
          [
            { header: "week_of", value: () => row.week_of },
            { header: "measure", value: (r) => r.name },
            { header: "value", value: (r) => r.value },
          ]
        )
      }
    >
      <div className="operational-figures">
        <Figure value={row.global_teu_waiting} unit="TEU" label="Waiting globally" />
        <Figure value={row.global_pct_fleet} unit="%" label="Of total fleet" />
      </div>
      <BreakdownChart data={regions} unit="TEU" />
    </ChartCard>
  );
}

export function WaitingTimeCard({
  week,
  row,
  onEdit,
}: {
  week: Week;
  row: WaitingTimeRow;
  onEdit?: () => void;
}) {
  const ports = namedValues(row.port_data, WAITING_TIME_PORTS);
  return (
    <ChartCard
      title="Vessel waiting time"
      hint={
        <>
          Average days at anchor by port cluster, {week.label}. Source:
          Linerlytica.
        </>
      }
      action={onEdit ? <EditButton onClick={onEdit} label="Edit waiting times" /> : undefined}
      onExport={() =>
        downloadCsv(csvFilename("waiting-time", week.isoLabel), ports, [
          { header: "week_of", value: () => row.week_of },
          { header: "port_cluster", value: (r) => r.name },
          { header: "days_waiting", value: (r) => r.value },
        ])
      }
    >
      <BreakdownChart data={ports} unit="days" />
    </ChartCard>
  );
}

export function ReliabilityCard({
  week,
  row,
  onEdit,
}: {
  week: Week;
  row: ScheduleReliabilityRow;
  onEdit?: () => void;
}) {
  const alliances = namedValues(row.alliance_data, RELIABILITY_ALLIANCES);
  const carried = isCarriedForward(row.month_of, week.start);

  return (
    <ChartCard
      title="Schedule reliability"
      hint={
        <>
          {formatMonth(row.month_of)}
          {row.glp_issue_number
            ? ` · Global Liner Performance issue ${row.glp_issue_number}`
            : ""}
          . Source: Sea-Intelligence.
          {carried && (
            <>
              {" "}
              <strong style={{ color: "var(--amber)" }}>Carried forward</strong>{" "}
              — the most recent month published, not{" "}
              {formatMonth(`${week.start.slice(0, 7)}-01`)}. Reliability is
              monthly and always in arrears.
            </>
          )}
        </>
      }
      action={onEdit ? <EditButton onClick={onEdit} label="Edit reliability figures" /> : undefined}
      onExport={() =>
        downloadCsv(
          csvFilename("schedule-reliability", row.month_of.slice(0, 7)),
          alliances,
          [
            { header: "month_of", value: () => row.month_of },
            { header: "glp_issue", value: () => row.glp_issue_number },
            { header: "alliance", value: (r) => r.name },
            { header: "reliability_pct", value: (r) => r.value },
            { header: "global_reliability_pct", value: () => row.global_reliability_pct },
            { header: "avg_delay_days", value: () => row.avg_delay_days },
          ]
        )
      }
    >
      <div className="operational-figures">
        <Figure value={row.global_reliability_pct} unit="%" label="On-time globally" />
        <Figure value={row.avg_delay_days} unit="days" label="Average delay, late arrivals" />
      </div>
      <BreakdownChart data={alliances} unit="%" />
    </ChartCard>
  );
}
