"use client";

import { useState, useTransition } from "react";
import { useToast } from "@/components/Toast";
import { weekDays, type Week } from "@/lib/analysis/week-period";
import {
  formatMonth,
  monthOf,
  readNumber,
  readObject,
  RELIABILITY_ALLIANCES,
  type CongestionRow,
  type FleetStatusRow,
  type PortCongestionRow,
  type ScheduleReliabilityRow,
} from "@/lib/analysis/operational";
import {
  CongestionCard,
  FleetStatusCard,
  MissingCard,
  PortCongestionCard,
  ReliabilityCard,
} from "./OperationalCards";
import { OperationalGrid } from "./OperationalGrid";
import { OperationalUpload } from "./OperationalUpload";
import { OperationalEditModal, type FieldGroup } from "./OperationalEditModal";
import { saveScheduleReliability } from "./operational-actions";

/**
 * The manually-entered market section: which cards exist, and the two entry
 * surfaces behind them.
 *
 * ONE GRID for everything daily — congestion, fleet status and per-port
 * figures are all read off the same Linerlytica screenshots on the same visit,
 * so they are entered together. Schedule reliability keeps its own dialog: it
 * is monthly, from a different report, and folding it into a weekly grid would
 * invite entering it seven times.
 *
 * ABSENT, NOT EMPTY. A card appears only when its period has data. There is no
 * such thing as a week with zero congestion, so a card of zeros because nobody
 * has typed the figures would be a false statement about the market. Curate
 * users get a placeholder offering entry; read users see nothing at all and no
 * entry affordance anywhere.
 */

export function OperationalSection({
  week,
  ports,
  congestion,
  fleet,
  portCongestion,
  reliability,
  canCurate,
}: {
  week: Week;
  ports: string[];
  congestion: CongestionRow[];
  fleet: FleetStatusRow[];
  portCongestion: PortCongestionRow[];
  reliability: ScheduleReliabilityRow | null;
  canCurate: boolean;
}) {
  const toast = useToast();
  const [, startTransition] = useTransition();
  const [gridOpen, setGridOpen] = useState(false);
  const [monthOpen, setMonthOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const openGrid = () => setGridOpen(true);

  const reliabilityMonth = reliability?.month_of ?? monthOf(week.start);

  const asText = (v: number | null | undefined) =>
    v === null || v === undefined ? "" : String(v);

  const reliabilityInitial: Record<string, string> = {
    glp_issue_number: asText(reliability?.glp_issue_number),
    global_reliability_pct: asText(reliability?.global_reliability_pct),
    avg_delay_days: asText(reliability?.avg_delay_days),
  };
  for (const a of RELIABILITY_ALLIANCES) {
    reliabilityInitial[a] = asText(
      readNumber(readObject(reliability?.alliance_data ?? null)[a])
    );
  }

  return (
    <>
      <div className="operational-head">
        <div>
          <div className="eyebrow">Market data · entered manually</div>
          <p>
            Transcribed from Linerlytica and Sea-Intelligence, not derived from
            the article corpus below. Daily figures are entered a week at a
            time; a day with no entry is omitted rather than shown as zero.
          </p>
        </div>
        {canCurate && (
          <button type="button" className="btn btn-sm btn-primary" onClick={openGrid}>
            ✎ Enter week
          </button>
        )}
      </div>

      {/*
        Beside the grid, not instead of it. Typing straight into the grid is
        faster when the figures are already on screen; a spreadsheet is better
        when someone else does the transcription, or when a whole week arrives
        at once. Both write the same three tables on the same keys.
      */}
      {canCurate && (
        <OperationalUpload
          week={week}
          portVocabulary={ports}
          congestion={congestion}
          fleet={fleet}
          portCongestion={portCongestion}
        />
      )}

      <div className="chart-grid">
        {congestion.length > 0 ? (
          <CongestionCard
            week={week}
            rows={congestion}
            onEdit={canCurate ? openGrid : undefined}
          />
        ) : (
          canCurate && (
            <MissingCard title="Port congestion" period={week.label} onAdd={openGrid} label="✎ Enter week" />
          )
        )}

        {fleet.length > 0 ? (
          <FleetStatusCard week={week} rows={fleet} onEdit={canCurate ? openGrid : undefined} />
        ) : (
          canCurate && (
            <MissingCard title="Fleet status" period={week.label} onAdd={openGrid} label="✎ Enter week" />
          )
        )}
      </div>

      <div className="chart-grid" style={{ gridTemplateColumns: "1fr" }}>
        {portCongestion.length > 0 ? (
          <PortCongestionCard
            week={week}
            rows={portCongestion}
            onEdit={canCurate ? openGrid : undefined}
          />
        ) : (
          canCurate && (
            <MissingCard title="Congestion by port" period={week.label} onAdd={openGrid} label="✎ Enter week" />
          )
        )}
      </div>

      {/*
        Full width, but inside a .chart-grid rather than a plain block. Recharts'
        ResponsiveContainer measures its parent, and in a plain block wrapper it
        measured 0 and drew no chart at all — figures present, axes and bars
        absent. Keeping every chart in the same layout context removes that
        whole class of problem.
      */}
      <div className="chart-grid" style={{ gridTemplateColumns: "1fr" }}>
        {reliability ? (
          <ReliabilityCard
            week={week}
            row={reliability}
            onEdit={canCurate ? () => setMonthOpen(true) : undefined}
          />
        ) : (
          canCurate && (
            <MissingCard
              title="Schedule reliability"
              period="any month yet"
              onAdd={() => setMonthOpen(true)}
              label="✎ Enter month"
            />
          )
        )}
      </div>

      {gridOpen && (
        <OperationalGrid
          week={week}
          days={weekDays(week)}
          ports={ports}
          congestion={congestion}
          fleet={fleet}
          portCongestion={portCongestion}
          onClose={() => setGridOpen(false)}
        />
      )}

      <OperationalEditModal
        open={monthOpen}
        title="Schedule reliability"
        // Spelled out because the grain differs from the rest of the panel:
        // this writes a MONTH while the selector is on a week.
        periodLabel={`${formatMonth(reliabilityMonth)} — a whole month, not the selected week`}
        busy={busy}
        initial={reliabilityInitial}
        groups={RELIABILITY_GROUPS}
        onCancel={() => setMonthOpen(false)}
        onSave={(values) => {
          setBusy(true);
          startTransition(async () => {
            const res = await saveScheduleReliability({
              monthStart: reliabilityMonth,
              glpIssueNumber: values.glp_issue_number,
              globalReliabilityPct: values.global_reliability_pct,
              avgDelayDays: values.avg_delay_days,
              alliances: Object.fromEntries(
                RELIABILITY_ALLIANCES.map((a) => [a, values[a]])
              ),
            });
            setBusy(false);
            if (res.ok) {
              setMonthOpen(false);
              toast.success("Saved.");
            } else {
              toast.error(res.error);
            }
          });
        }}
      />
    </>
  );
}

const RELIABILITY_GROUPS: FieldGroup[] = [
  {
    title: "Report",
    fields: [
      {
        key: "glp_issue_number",
        label: "GLP issue number",
        hint: "Which Global Liner Performance issue these figures came from.",
      },
    ],
  },
  {
    title: "Global",
    fields: [
      { key: "global_reliability_pct", label: "On-time arrivals", unit: "%" },
      { key: "avg_delay_days", label: "Average delay for late arrivals", unit: "days" },
    ],
  },
  {
    title: "By alliance",
    hint: "On-time arrival percentage. 2M is kept so historical months stay editable.",
    fields: RELIABILITY_ALLIANCES.map((a) => ({ key: a, label: a, unit: "%" })),
  },
];
