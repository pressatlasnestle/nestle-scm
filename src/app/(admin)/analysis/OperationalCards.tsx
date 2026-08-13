"use client";

import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { Week } from "@/lib/analysis/week-period";
import { csvFilename, downloadCsv } from "@/lib/analysis/csv";
import {
  congestionRegions,
  dailySeries,
  dayTick,
  fleetStatusValues,
  formatMonth,
  isCarriedForward,
  latestByDay,
  namedValues,
  RELIABILITY_ALLIANCES,
  type CongestionRow,
  type FleetStatusRow,
  type NamedValue,
  type PortCongestionRow,
  type ScheduleReliabilityRow,
} from "@/lib/analysis/operational";
import { ChartCard } from "./ChartCard";

/**
 * Presentation for the manually-entered market charts.
 *
 * Deliberately free of any server-action import, which is what lets the visual
 * harness bundle and render them. That is not incidental: the last round found
 * a chart that drew no <svg> at all and an axis clipped off the card edge, and
 * neither was visible to any assertion.
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
 * Indigo for measured market quantities. Reusing the teal/amber/coral
 * favourability scale would assert a direction the data does not carry — more
 * TEU waiting is not "unfavourable" in the sense the sentiment charts mean.
 */
const OPERATIONAL_COLOR = "var(--indigo)";
const SECONDARY_COLOR = "#5ec8e5";

/**
 * Compacts large ticks: 600000 → "600k".
 *
 * TEU figures run to eight digits here. Left raw they crowd the axis and the
 * last label is clipped off the card — which is exactly what happened to the
 * congestion chart before this existed.
 */
function formatTick(value: number): string {
  if (Math.abs(value) >= 1_000_000) return `${Math.round(value / 100_000) / 10}m`;
  if (Math.abs(value) >= 1_000) return `${Math.round(value / 100) / 10}k`;
  return String(value);
}

function EditButton({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" className="btn btn-sm" onClick={onClick} title="Enter or edit this week's figures">
      ✎ Edit week
    </button>
  );
}

function Figure({ value, unit, label }: { value: number | null; unit: string; label: string }) {
  return (
    <div>
      <div className="stat-value" style={{ fontSize: 22 }}>
        {value === null ? "—" : value.toLocaleString("en-US")}
        <span style={{ fontSize: 12, color: "var(--text-muted)", marginLeft: 4 }}>{unit}</span>
      </div>
      <div className="stat-label" style={{ marginTop: 5 }}>{label}</div>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="cell-sub" style={{ padding: "16px 2px", fontSize: 12 }}>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Port congestion — daily across the week
// ---------------------------------------------------------------------------

export function CongestionCard({
  week,
  rows,
  onEdit,
}: {
  week: Week;
  rows: CongestionRow[];
  onEdit?: () => void;
}) {
  // Only the days actually entered. A partial week plots the days it has and
  // nothing for the rest — a zero would assert that nothing was waiting.
  const series = dailySeries(rows, (r) => r.global_teu_waiting);
  const latest = latestByDay(rows);
  const regions = congestionRegions(latest?.region_data ?? null);

  return (
    <ChartCard
      title="Port congestion"
      hint={
        <>
          Capacity waiting at anchor, by day, {week.label}. Days with no entry
          are omitted rather than shown as zero. Source: Linerlytica.
        </>
      }
      action={onEdit ? <EditButton onClick={onEdit} /> : undefined}
      onExport={() =>
        downloadCsv(
          csvFilename("port-congestion", week.isoLabel),
          rows.slice().sort((a, b) => a.day_of.localeCompare(b.day_of)),
          [
            { header: "day_of", value: (r) => r.day_of },
            { header: "global_teu_waiting", value: (r) => r.global_teu_waiting },
            { header: "global_pct_fleet", value: (r) => r.global_pct_fleet },
            ...congestionRegionColumns(),
          ]
        )
      }
    >
      <div className="operational-figures">
        <Figure value={latest?.global_teu_waiting ?? null} unit="TEU" label={latest ? `Waiting, ${dayTick(latest.day_of)}` : "Waiting"} />
        <Figure value={latest?.global_pct_fleet ?? null} unit="%" label="Of total fleet" />
      </div>

      {series.length === 0 ? (
        <Empty>No day in this week has congestion figures entered.</Empty>
      ) : (
        <ResponsiveContainer width="100%" height={200}>
          <BarChart data={series} margin={{ top: 4, right: 28, bottom: 4, left: -6 }}>
            <CartesianGrid stroke="var(--line-soft)" vertical={false} />
            <XAxis dataKey="tick" tick={AXIS} tickLine={false} axisLine={false} />
            <YAxis tick={AXIS} tickLine={false} axisLine={false} tickFormatter={formatTick} />
            <Tooltip
              contentStyle={TOOLTIP_STYLE}
              cursor={{ fill: "var(--line-soft)" }}
              formatter={(v) => [`${Number(v).toLocaleString("en-US")} TEU`, "Waiting"]}
            />
            <Bar dataKey="value" fill={OPERATIONAL_COLOR} radius={[3, 3, 0, 0]} isAnimationActive={false} />
          </BarChart>
        </ResponsiveContainer>
      )}

      {regions.length > 0 && latest && (
        <>
          <div className="stat-label" style={{ marginTop: 12, marginBottom: 2 }}>
            By region · {dayTick(latest.day_of)}
          </div>
          <RegionBars data={regions} />
        </>
      )}
    </ChartCard>
  );
}

function congestionRegionColumns() {
  return [
    { header: "europe", value: (r: CongestionRow) => readRegion(r, "europe") },
    { header: "north_america", value: (r: CongestionRow) => readRegion(r, "north_america") },
    { header: "north_asia", value: (r: CongestionRow) => readRegion(r, "north_asia") },
    { header: "southeast_asia", value: (r: CongestionRow) => readRegion(r, "southeast_asia") },
    { header: "south_america", value: (r: CongestionRow) => readRegion(r, "south_america") },
  ];
}

function readRegion(row: CongestionRow, key: string): number | null {
  const data = (row.region_data ?? {}) as Record<string, unknown>;
  const v = data[key];
  return typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : null;
}

function RegionBars({ data }: { data: NamedValue[] }) {
  return (
    <ResponsiveContainer width="100%" height={34 * data.length + 40}>
      <BarChart data={data} layout="vertical" margin={{ top: 4, right: 30, bottom: 4, left: 8 }}>
        <CartesianGrid stroke="var(--line-soft)" horizontal={false} />
        <XAxis type="number" tick={AXIS} tickLine={false} axisLine={false} tickFormatter={formatTick} />
        <YAxis
          type="category"
          dataKey="name"
          tick={{ ...AXIS, fontFamily: "var(--font-body)", fontSize: 11.5 }}
          tickLine={false}
          axisLine={false}
          width={130}
        />
        <Tooltip
          contentStyle={TOOLTIP_STYLE}
          cursor={{ fill: "var(--line-soft)" }}
          formatter={(v) => [`${Number(v).toLocaleString("en-US")} TEU`, ""]}
        />
        <Bar dataKey="value" fill={OPERATIONAL_COLOR} radius={[0, 3, 3, 0]} isAnimationActive={false} />
      </BarChart>
    </ResponsiveContainer>
  );
}

// ---------------------------------------------------------------------------
// Fleet status — grouped, never stacked
// ---------------------------------------------------------------------------

export function FleetStatusCard({
  week,
  rows,
  onEdit,
}: {
  week: Week;
  rows: FleetStatusRow[];
  onEdit?: () => void;
}) {
  const latest = latestByDay(rows);
  const values = fleetStatusValues(latest?.status_data ?? null);

  return (
    <ChartCard
      title="Fleet status"
      hint={
        <>
          {latest ? `${dayTick(latest.day_of)}, ${week.label}` : week.label}.{" "}
          <strong style={{ color: "var(--amber)" }}>
            These categories overlap
          </strong>{" "}
          — ships at port and ships at anchorage are both subsets of active
          ships — so the bars are grouped side by side and never stacked or
          totalled. Ships and TEU are on separate axes. Source: Linerlytica.
        </>
      }
      action={onEdit ? <EditButton onClick={onEdit} /> : undefined}
      onExport={() =>
        downloadCsv(
          csvFilename("fleet-status", week.isoLabel),
          rows
            .slice()
            .sort((a, b) => a.day_of.localeCompare(b.day_of))
            .flatMap((row) =>
              fleetStatusValues(row.status_data).map((v) => ({ day: row.day_of, ...v }))
            ),
          [
            { header: "day_of", value: (r) => r.day },
            { header: "status", value: (r) => r.status },
            { header: "ships", value: (r) => r.ships },
            { header: "teu", value: (r) => r.teu },
          ]
        )
      }
    >
      {values.length === 0 ? (
        <Empty>No day in this week has fleet figures entered.</Empty>
      ) : (
        <ResponsiveContainer width="100%" height={260}>
          <BarChart data={values} margin={{ top: 8, right: 8, bottom: 46, left: -8 }}>
            <CartesianGrid stroke="var(--line-soft)" vertical={false} />
            <XAxis
              dataKey="status"
              tick={{ ...AXIS, fontFamily: "var(--font-body)", fontSize: 10.5 }}
              tickLine={false}
              axisLine={false}
              angle={-20}
              textAnchor="end"
              interval={0}
              height={54}
            />
            {/* Two axes because the measures differ by four orders of
                magnitude — thousands of ships against tens of millions of TEU.
                One shared axis would flatten the ship bars to invisibility. */}
            <YAxis yAxisId="ships" tick={AXIS} tickLine={false} axisLine={false} tickFormatter={formatTick} />
            <YAxis yAxisId="teu" orientation="right" tick={AXIS} tickLine={false} axisLine={false} tickFormatter={formatTick} />
            <Tooltip
              contentStyle={TOOLTIP_STYLE}
              cursor={{ fill: "var(--line-soft)" }}
              formatter={(v, name) => [Number(v).toLocaleString("en-US"), String(name)]}
            />
            <Legend wrapperStyle={{ fontSize: 12, fontFamily: "var(--font-body)" }} />
            {/* No stackId anywhere: these are grouped bars by construction. */}
            <Bar yAxisId="ships" dataKey="ships" name="Ships" fill={OPERATIONAL_COLOR} radius={[3, 3, 0, 0]} isAnimationActive={false} />
            <Bar yAxisId="teu" dataKey="teu" name="TEU" fill={SECONDARY_COLOR} radius={[3, 3, 0, 0]} isAnimationActive={false} />
          </BarChart>
        </ResponsiveContainer>
      )}
    </ChartCard>
  );
}

// ---------------------------------------------------------------------------
// Per-port congestion
// ---------------------------------------------------------------------------

export function PortCongestionCard({
  week,
  rows,
  onEdit,
}: {
  week: Week;
  rows: PortCongestionRow[];
  onEdit?: () => void;
}) {
  const latestDay = rows.length
    ? rows.reduce((best, r) => (r.day_of > best ? r.day_of : best), rows[0].day_of)
    : null;
  const latest = rows.filter((r) => r.day_of === latestDay);

  const data = latest.map((r) => ({
    port: r.port_name,
    // Truncated for the axis only; the full name is in the tooltip and CSV.
    short: r.port_name.length > 20 ? `${r.port_name.slice(0, 19)}…` : r.port_name,
    anchorage: r.ships_anchorage,
    atPort: r.ships_port,
    ratio: r.queue_berth_ratio,
  }));

  return (
    <ChartCard
      title="Congestion by port"
      hint={
        <>
          Ships at anchorage against ships at port
          {latestDay ? `, ${dayTick(latestDay)}` : ""}. The queue/berth ratio is
          shown as published by Linerlytica, not computed from these two counts
          — the source smooths it, and the figures differ. Source: Linerlytica.
        </>
      }
      action={onEdit ? <EditButton onClick={onEdit} /> : undefined}
      onExport={() =>
        downloadCsv(
          csvFilename("port-congestion-by-port", week.isoLabel),
          rows
            .slice()
            .sort((a, b) => a.day_of.localeCompare(b.day_of) || a.port_name.localeCompare(b.port_name)),
          [
            { header: "day_of", value: (r) => r.day_of },
            { header: "port_name", value: (r) => r.port_name },
            { header: "ships_anchorage", value: (r) => r.ships_anchorage },
            { header: "ships_port", value: (r) => r.ships_port },
            { header: "teu_anchorage", value: (r) => r.teu_anchorage },
            { header: "teu_port", value: (r) => r.teu_port },
            { header: "queue_berth_ratio", value: (r) => r.queue_berth_ratio },
          ]
        )
      }
    >
      {data.length === 0 ? (
        <Empty>No day in this week has per-port figures entered.</Empty>
      ) : (
        <>
          <ResponsiveContainer width="100%" height={44 * data.length + 60}>
            <BarChart data={data} layout="vertical" margin={{ top: 4, right: 30, bottom: 4, left: 8 }}>
              <CartesianGrid stroke="var(--line-soft)" horizontal={false} />
              <XAxis type="number" tick={AXIS} tickLine={false} axisLine={false} allowDecimals={false} />
              <YAxis
                type="category"
                dataKey="short"
                tick={{ ...AXIS, fontFamily: "var(--font-body)", fontSize: 11.5 }}
                tickLine={false}
                axisLine={false}
                width={140}
              />
              <Tooltip
                contentStyle={TOOLTIP_STYLE}
                cursor={{ fill: "var(--line-soft)" }}
                labelFormatter={(short) => data.find((d) => d.short === short)?.port ?? String(short)}
              />
              <Legend wrapperStyle={{ fontSize: 12, fontFamily: "var(--font-body)" }} />
              <Bar dataKey="anchorage" name="At anchorage" fill={OPERATIONAL_COLOR} radius={[0, 3, 3, 0]} isAnimationActive={false} />
              <Bar dataKey="atPort" name="At port" fill={SECONDARY_COLOR} radius={[0, 3, 3, 0]} isAnimationActive={false} />
            </BarChart>
          </ResponsiveContainer>

          <div className="port-ratios">
            {data.map((d) => (
              <div key={d.port}>
                <span className="ratio-value">{d.ratio ?? "—"}</span>
                <span className="ratio-port">{d.port}</span>
              </div>
            ))}
          </div>
          <div className="cell-sub" style={{ fontSize: 11 }}>
            Queue / berth ratio, as published.
          </div>
        </>
      )}
    </ChartCard>
  );
}

// ---------------------------------------------------------------------------
// Schedule reliability — monthly, unchanged
// ---------------------------------------------------------------------------

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
          {row.glp_issue_number ? ` · Global Liner Performance issue ${row.glp_issue_number}` : ""}
          . Source: Sea-Intelligence.
          {carried && (
            <>
              {" "}
              <strong style={{ color: "var(--amber)" }}>Carried forward</strong> — the
              most recent month published, not {formatMonth(`${week.start.slice(0, 7)}-01`)}.
              Reliability is monthly and always in arrears.
            </>
          )}
        </>
      }
      action={onEdit ? <button type="button" className="btn btn-sm" onClick={onEdit}>✎ Edit month</button> : undefined}
      onExport={() =>
        downloadCsv(csvFilename("schedule-reliability", row.month_of.slice(0, 7)), alliances, [
          { header: "month_of", value: () => row.month_of },
          { header: "glp_issue", value: () => row.glp_issue_number },
          { header: "alliance", value: (r) => r.name },
          { header: "reliability_pct", value: (r) => r.value },
          { header: "global_reliability_pct", value: () => row.global_reliability_pct },
          { header: "avg_delay_days", value: () => row.avg_delay_days },
        ])
      }
    >
      <div className="operational-figures">
        <Figure value={row.global_reliability_pct} unit="%" label="On-time globally" />
        <Figure value={row.avg_delay_days} unit="days" label="Average delay, late arrivals" />
      </div>
      {alliances.length === 0 ? (
        <Empty>No alliance breakdown entered for this month.</Empty>
      ) : (
        <RegionBars data={alliances} />
      )}
    </ChartCard>
  );
}

/** Shown to curate users in place of an absent card, never to read users. */
export function MissingCard({
  title,
  period,
  onAdd,
  label = "✎ Enter data",
}: {
  title: string;
  period: string;
  onAdd: () => void;
  label?: string;
}) {
  return (
    <div className="chart-card operational-missing">
      <div className="chart-head">
        <div>
          <h3>{title}</h3>
          <p>Nothing entered for {period}.</p>
        </div>
        <button type="button" className="btn btn-sm" onClick={onAdd}>
          {label}
        </button>
      </div>
    </div>
  );
}
