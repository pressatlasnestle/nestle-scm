"use client";

import { useState, useTransition } from "react";
import { useToast } from "@/components/Toast";
import type { Week } from "@/lib/analysis/week-period";
import {
  CONGESTION_REGIONS,
  formatMonth,
  monthOf,
  readNumber,
  readObject,
  RELIABILITY_ALLIANCES,
  WAITING_TIME_PORTS,
  type CongestionRow,
  type ScheduleReliabilityRow,
  type WaitingTimeRow,
} from "@/lib/analysis/operational";
import {
  CongestionCard,
  MissingCard,
  ReliabilityCard,
  WaitingTimeCard,
} from "./OperationalCards";
import { OperationalEditModal, type FieldGroup } from "./OperationalEditModal";
import {
  saveCongestion,
  saveScheduleReliability,
  saveWaitingTime,
} from "./operational-actions";

/**
 * The manually-entered market section: which cards exist, and the dialogs that
 * write them. Rendering lives in OperationalCards.tsx.
 *
 * ABSENT, NOT EMPTY. Congestion and waiting time appear only when the selected
 * week has an entry. There is no such thing as a week with zero congestion, so
 * a card of zeros because nobody has typed the figures yet would be a false
 * statement about the market. A curate user still has a way in — a dashed
 * placeholder offering data entry — and a read user simply sees nothing, which
 * is correct: they could not fill it anyway.
 */

export function OperationalSection({
  week,
  congestion,
  waitingTime,
  reliability,
  canCurate,
}: {
  week: Week;
  congestion: CongestionRow | null;
  waitingTime: WaitingTimeRow | null;
  reliability: ScheduleReliabilityRow | null;
  canCurate: boolean;
}) {
  const toast = useToast();
  const [, startTransition] = useTransition();
  const [editing, setEditing] = useState<
    "congestion" | "waiting" | "reliability" | null
  >(null);
  const [busy, setBusy] = useState(false);

  function run(action: () => Promise<{ ok: boolean; error?: string }>) {
    setBusy(true);
    startTransition(async () => {
      const res = await action();
      setBusy(false);
      if (res.ok) {
        setEditing(null);
        // revalidatePath in the action re-renders the panel, so the new figures
        // are on screen without a manual refresh.
        toast.success("Saved.");
      } else {
        toast.error(res.error ?? "Could not save.");
      }
    });
  }

  // --- Pre-fill, so re-editing is not blind re-entry ------------------------
  const asText = (v: number | null | undefined) =>
    v === null || v === undefined ? "" : String(v);

  const congestionInitial: Record<string, string> = {
    global_teu_waiting: asText(congestion?.global_teu_waiting),
    global_pct_fleet: asText(congestion?.global_pct_fleet),
  };
  for (const r of CONGESTION_REGIONS) {
    congestionInitial[r.key] = asText(
      readNumber(readObject(congestion?.region_data ?? null)[r.key])
    );
  }

  const waitingInitial: Record<string, string> = {};
  for (const p of WAITING_TIME_PORTS) {
    waitingInitial[p] = asText(
      readNumber(readObject(waitingTime?.port_data ?? null)[p])
    );
  }

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

  /**
   * Which month the reliability form writes.
   *
   * The month of the entry on screen when one is showing — so editing a
   * carried-forward July entry from an August week corrects JULY, which is the
   * row being looked at. With nothing on screen, it falls back to the selected
   * week's own month, which is the month someone is most likely entering.
   * Either way the dialog states it outright.
   */
  const reliabilityMonth = reliability?.month_of ?? monthOf(week.start);

  const showPlaceholders = canCurate;

  return (
    <>
      <div className="operational-head">
        <div>
          <div className="eyebrow">Market data · entered manually</div>
          <p>
            Transcribed from Linerlytica and Sea-Intelligence, not derived from
            the article corpus below. A card appears only once its period has
            been entered.
          </p>
        </div>
      </div>

      <div className="chart-grid">
        {congestion ? (
          <CongestionCard
            week={week}
            row={congestion}
            onEdit={canCurate ? () => setEditing("congestion") : undefined}
          />
        ) : (
          showPlaceholders && (
            <MissingCard
              title="Port congestion"
              period={week.label}
              onAdd={() => setEditing("congestion")}
            />
          )
        )}

        {waitingTime ? (
          <WaitingTimeCard
            week={week}
            row={waitingTime}
            onEdit={canCurate ? () => setEditing("waiting") : undefined}
          />
        ) : (
          showPlaceholders && (
            <MissingCard
              title="Vessel waiting time"
              period={week.label}
              onAdd={() => setEditing("waiting")}
            />
          )
        )}
      </div>

      {/*
        Full width, but still inside a .chart-grid rather than a plain block.
        Recharts' ResponsiveContainer measures its parent, and in a plain block
        wrapper it measured 0 and rendered no chart at all — figures and axes
        absent, card otherwise intact. Keeping every chart in the same layout
        context it was designed against removes that whole class of problem
        instead of relying on the measurement working out.
      */}
      {reliability ? (
        <div className="chart-grid" style={{ gridTemplateColumns: "1fr" }}>
          <ReliabilityCard
            week={week}
            row={reliability}
            onEdit={canCurate ? () => setEditing("reliability") : undefined}
          />
        </div>
      ) : (
        showPlaceholders && (
          <div className="chart-grid" style={{ gridTemplateColumns: "1fr" }}>
            <MissingCard
              title="Schedule reliability"
              period="any month yet"
              onAdd={() => setEditing("reliability")}
            />
          </div>
        )
      )}

      <OperationalEditModal
        open={editing === "congestion"}
        title="Port congestion"
        periodLabel={`Week of ${week.label}`}
        busy={busy}
        initial={congestionInitial}
        groups={CONGESTION_GROUPS}
        onCancel={() => setEditing(null)}
        onSave={(values) =>
          run(() =>
            saveCongestion({
              weekStart: week.start,
              globalTeuWaiting: values.global_teu_waiting,
              globalPctFleet: values.global_pct_fleet,
              regions: Object.fromEntries(
                CONGESTION_REGIONS.map((r) => [r.key, values[r.key]])
              ),
            })
          )
        }
      />

      <OperationalEditModal
        open={editing === "waiting"}
        title="Vessel waiting time"
        periodLabel={`Week of ${week.label}`}
        busy={busy}
        initial={waitingInitial}
        groups={WAITING_GROUPS}
        onCancel={() => setEditing(null)}
        onSave={(values) =>
          run(() =>
            saveWaitingTime({
              weekStart: week.start,
              ports: Object.fromEntries(
                WAITING_TIME_PORTS.map((p) => [p, values[p]])
              ),
            })
          )
        }
      />

      <OperationalEditModal
        open={editing === "reliability"}
        title="Schedule reliability"
        // Spelled out because the grain differs from the rest of the panel:
        // this writes a MONTH while the selector is on a week.
        periodLabel={`${formatMonth(reliabilityMonth)} — a whole month, not the selected week`}
        busy={busy}
        initial={reliabilityInitial}
        groups={RELIABILITY_GROUPS}
        onCancel={() => setEditing(null)}
        onSave={(values) =>
          run(() =>
            saveScheduleReliability({
              monthStart: reliabilityMonth,
              glpIssueNumber: values.glp_issue_number,
              globalReliabilityPct: values.global_reliability_pct,
              avgDelayDays: values.avg_delay_days,
              alliances: Object.fromEntries(
                RELIABILITY_ALLIANCES.map((a) => [a, values[a]])
              ),
            })
          )
        }
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// Form definitions
// ---------------------------------------------------------------------------

const CONGESTION_GROUPS: FieldGroup[] = [
  {
    title: "Global",
    fields: [
      { key: "global_teu_waiting", label: "Capacity waiting", unit: "TEU" },
      { key: "global_pct_fleet", label: "Share of total fleet", unit: "%" },
    ],
  },
  {
    title: "By region",
    hint: "Capacity waiting at anchor, in TEU.",
    fields: CONGESTION_REGIONS.map((r) => ({
      key: r.key,
      label: r.label,
      unit: "TEU",
    })),
  },
];

const WAITING_GROUPS: FieldGroup[] = [
  {
    title: "By port cluster",
    hint: "Average days at anchor. Clusters follow Linerlytica's own grouping.",
    fields: WAITING_TIME_PORTS.map((p) => ({ key: p, label: p, unit: "days" })),
  },
];

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
      {
        key: "avg_delay_days",
        label: "Average delay for late arrivals",
        unit: "days",
      },
    ],
  },
  {
    title: "By alliance",
    hint: "On-time arrival percentage. 2M is kept so historical months stay editable.",
    fields: RELIABILITY_ALLIANCES.map((a) => ({ key: a, label: a, unit: "%" })),
  },
];
