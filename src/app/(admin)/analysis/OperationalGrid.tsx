"use client";

import { useMemo, useRef, useState, type KeyboardEvent, type ClipboardEvent } from "react";
import { useToast } from "@/components/Toast";
import { dayTick, type Week } from "@/lib/analysis/week-period";
import {
  CONGESTION_REGIONS,
  FLEET_STATUSES,
  PORT_METRICS,
  PORTS_PER_DAY,
  carriedPorts,
  type CongestionRow,
  type FleetStatusRow,
  type PortCongestionRow,
} from "@/lib/analysis/operational";
import { PortCombobox } from "./PortCombobox";
import { saveOperationalWeek, type DayEntry } from "./operational-actions";

/**
 * One grid per week: days across the top, metrics down the side.
 *
 * This replaces three separate modals, and the reason is arithmetic. A week is
 * roughly 300 hand-transcribed values read off screenshots. Seven visits to a
 * dialog is the version that gets abandoned inside a fortnight, and a stale
 * chart with nothing marking it stale is worse than no chart at all. So the
 * grid is built for the transcription, not for the schema:
 *
 *   * Native Tab moves along a row, because the cells are rendered row-major —
 *     a whole metric across seven days is enterable without the mouse.
 *   * Arrow keys move between cells; Left/Right only when the caret is already
 *     at the end of the text, so they still work for editing inside a cell.
 *   * PASTE FILLS. A row copied out of Linerlytica's table, tab- or
 *     comma-separated, lands in one action from the anchor cell rightwards.
 *     Multi-row pastes fill downwards too. This is the single affordance that
 *     decides whether the feature is used.
 *   * The five ports carry forward from the most recent entered day, since the
 *     watchlist is stable for weeks at a time. Changing one is a dropdown.
 *
 * Schedule reliability is deliberately NOT here. It is monthly and from a
 * different report; folding it in would invite entering it seven times.
 */

type CellRef = { row: number; col: number };

/** A metric row: a label, and how to read/write its value for a given day. */
type RowSpec = {
  key: string;
  label: string;
  unit?: string;
  group: string;
  /** Port rows carry which port slot they belong to. */
  portSlot?: number;
};

function buildRows(): RowSpec[] {
  const rows: RowSpec[] = [
    { key: "cong.global_teu_waiting", label: "Capacity waiting", unit: "TEU", group: "Port congestion" },
    { key: "cong.global_pct_fleet", label: "Share of fleet", unit: "%", group: "Port congestion" },
    ...CONGESTION_REGIONS.map((r) => ({
      key: `cong.region.${r.key}`,
      label: r.label,
      unit: "TEU",
      group: "Port congestion",
    })),
  ];

  for (const status of FLEET_STATUSES) {
    // No `unit` on these two: the label already ends in "ships" / "TEU", and
    // setting it as well rendered "Ships at port — TEU TEU".
    rows.push({ key: `fleet.${status}.ships`, label: `${status} — ships`, group: "Fleet status" });
    rows.push({ key: `fleet.${status}.teu`, label: `${status} — TEU`, group: "Fleet status" });
  }

  for (let slot = 0; slot < PORTS_PER_DAY; slot += 1) {
    for (const metric of PORT_METRICS) {
      rows.push({
        key: `port.${slot}.${metric.key}`,
        label: metric.label,
        unit: metric.unit,
        group: `Port ${slot + 1}`,
        portSlot: slot,
      });
    }
  }

  return rows;
}

export function OperationalGrid({
  week,
  days,
  ports,
  congestion,
  fleet,
  portCongestion,
  onClose,
}: {
  week: Week;
  /** The seven ISO days of the selected week. */
  days: string[];
  /** The full 180-name vocabulary. */
  ports: string[];
  congestion: CongestionRow[];
  fleet: FleetStatusRow[];
  portCongestion: PortCongestionRow[];
  onClose: () => void;
}) {
  const toast = useToast();
  const rows = useMemo(buildRows, []);
  const [busy, setBusy] = useState(false);

  /**
   * Which port occupies each slot.
   *
   * Carried forward from the most recent day that has any port rows, because
   * the watchlist is fixed for a week and usually longer. Re-picking five
   * ports every Monday would be five avoidable interactions.
   */
  const initialPorts = useMemo(
    () => carriedPorts(portCongestion),
    [portCongestion]
  );

  const [slotPorts, setSlotPorts] = useState<string[]>(initialPorts);

  /**
   * Cell values, keyed "rowKey|day". Seeded from what is already stored so a
   * re-edit is a correction rather than blind re-entry.
   */
  const [values, setValues] = useState<Record<string, string>>(() => {
    const seed: Record<string, string> = {};
    const text = (v: number | null | undefined) =>
      v === null || v === undefined ? "" : String(v);

    for (const row of congestion) {
      seed[`cong.global_teu_waiting|${row.day_of}`] = text(row.global_teu_waiting);
      seed[`cong.global_pct_fleet|${row.day_of}`] = text(row.global_pct_fleet);
      const regions = (row.region_data ?? {}) as Record<string, unknown>;
      for (const r of CONGESTION_REGIONS) {
        const v = regions[r.key];
        seed[`cong.region.${r.key}|${row.day_of}`] =
          v === null || v === undefined ? "" : String(v);
      }
    }
    for (const row of fleet) {
      const statuses = (row.status_data ?? {}) as Record<string, { ships?: unknown; teu?: unknown }>;
      for (const status of FLEET_STATUSES) {
        const entry = statuses[status] ?? {};
        seed[`fleet.${status}.ships|${row.day_of}`] =
          entry.ships === null || entry.ships === undefined ? "" : String(entry.ships);
        seed[`fleet.${status}.teu|${row.day_of}`] =
          entry.teu === null || entry.teu === undefined ? "" : String(entry.teu);
      }
    }
    for (const row of portCongestion) {
      const slot = initialPorts.indexOf(row.port_name);
      if (slot === -1) continue;
      for (const metric of PORT_METRICS) {
        seed[`port.${slot}.${metric.key}|${row.day_of}`] = text(
          row[metric.key as keyof PortCongestionRow] as number | null
        );
      }
    }
    return seed;
  });

  const inputs = useRef(new Map<string, HTMLInputElement>());
  const cellId = (r: number, c: number) => `${r}:${c}`;

  const focusCell = ({ row, col }: CellRef) => {
    const el = inputs.current.get(cellId(row, col));
    if (el) {
      el.focus();
      el.select();
    }
  };

  const setValue = (rowKey: string, day: string, value: string) =>
    setValues((v) => ({ ...v, [`${rowKey}|${day}`]: value }));

  /**
   * Fills from the anchor cell rightwards, and downwards for multi-row pastes.
   *
   * Splits on tab first, then comma, so "1,240" pasted as a single number is
   * not torn into two cells when tabs are present — a Linerlytica row copied
   * out of a table is tab-separated, and thousands separators inside it are
   * common.
   */
  const handlePaste = (
    e: ClipboardEvent<HTMLInputElement>,
    rowIndex: number,
    colIndex: number
  ) => {
    const text = e.clipboardData.getData("text/plain");
    if (!text) return;
    const lines = text.replace(/\r/g, "").split("\n").filter((l) => l.length > 0);
    const hasTabs = text.includes("\t");
    const grid = lines.map((line) =>
      hasTabs ? line.split("\t") : line.split(",")
    );
    // A single value with no separators is an ordinary paste; leave it alone.
    if (grid.length === 1 && grid[0].length === 1) return;

    e.preventDefault();
    setValues((current) => {
      const next = { ...current };
      grid.forEach((line, dr) => {
        const row = rows[rowIndex + dr];
        if (!row) return;
        line.forEach((raw, dc) => {
          const day = days[colIndex + dc];
          if (!day) return;
          next[`${row.key}|${day}`] = raw.trim();
        });
      });
      return next;
    });
  };

  const handleKeyDown = (
    e: KeyboardEvent<HTMLInputElement>,
    row: number,
    col: number
  ) => {
    const el = e.currentTarget;
    const atEnd = el.selectionStart === el.value.length && el.selectionEnd === el.value.length;
    const atStart = el.selectionStart === 0 && el.selectionEnd === 0;

    if (e.key === "ArrowDown" || e.key === "Enter") {
      e.preventDefault();
      focusCell({ row: Math.min(row + 1, rows.length - 1), col });
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      focusCell({ row: Math.max(row - 1, 0), col });
    } else if (e.key === "ArrowRight" && atEnd) {
      // Only at the caret's end, so arrows still edit text inside a cell.
      e.preventDefault();
      focusCell({ row, col: Math.min(col + 1, days.length - 1) });
    } else if (e.key === "ArrowLeft" && atStart) {
      e.preventDefault();
      focusCell({ row, col: Math.max(col - 1, 0) });
    }
  };

  async function save() {
    setBusy(true);
    const entries: DayEntry[] = days.map((day) => {
      const get = (key: string) => values[`${key}|${day}`] ?? "";
      return {
        day,
        congestion: {
          globalTeuWaiting: get("cong.global_teu_waiting"),
          globalPctFleet: get("cong.global_pct_fleet"),
          regions: Object.fromEntries(
            CONGESTION_REGIONS.map((r) => [r.key, get(`cong.region.${r.key}`)])
          ),
        },
        fleet: Object.fromEntries(
          FLEET_STATUSES.map((s) => [
            s,
            { ships: get(`fleet.${s}.ships`), teu: get(`fleet.${s}.teu`) },
          ])
        ),
        ports: slotPorts
          .map((portName, slot) =>
            portName
              ? {
                  portName,
                  ships_anchorage: get(`port.${slot}.ships_anchorage`),
                  ships_port: get(`port.${slot}.ships_port`),
                  teu_anchorage: get(`port.${slot}.teu_anchorage`),
                  teu_port: get(`port.${slot}.teu_port`),
                  queue_berth_ratio: get(`port.${slot}.queue_berth_ratio`),
                }
              : null
          )
          .filter((p): p is NonNullable<typeof p> => p !== null),
      };
    });

    const res = await saveOperationalWeek(entries);
    setBusy(false);
    if (res.ok) {
      toast.success(
        `Saved ${res.daysWritten ?? 0} day(s) and ${res.portRowsWritten ?? 0} port row(s).`
      );
      onClose();
    } else {
      toast.error(res.error);
    }
  }

  let lastGroup = "";

  return (
    <div className="modal-overlay" onClick={() => !busy && onClose()}>
      <div
        className="modal grid-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Enter operational data"
        onClick={(e) => e.stopPropagation()}
      >
        <h2>Operational data — week of {week.label}</h2>

        <div className="grid-scroll">
          <table className="entry-grid">
            <thead>
              <tr>
                <th className="metric-col">Metric</th>
                {days.map((day) => (
                  <th key={day}>{dayTick(day)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, rowIndex) => {
                const newGroup = row.group !== lastGroup;
                lastGroup = row.group;
                const slot = row.portSlot;

                return (
                  <>
                    {newGroup && (
                      <tr key={`${row.group}-head`} className="group-row">
                        <th colSpan={days.length + 1}>
                          {slot === undefined ? (
                            row.group
                          ) : (
                            <span className="port-picker">
                              <span>Port {slot + 1}</span>
                              <PortCombobox
                                value={slotPorts[slot] ?? ""}
                                ports={ports}
                                disabled={busy}
                                onChange={(name) =>
                                  setSlotPorts((s) =>
                                    s.map((v, i) => (i === slot ? name : v))
                                  )
                                }
                              />
                            </span>
                          )}
                        </th>
                      </tr>
                    )}
                    <tr key={row.key}>
                      <th className="metric-col">
                        {row.label}
                        {row.unit && <span className="unit"> {row.unit}</span>}
                      </th>
                      {days.map((day, colIndex) => (
                        <td key={day}>
                          <input
                            ref={(el) => {
                              if (el) inputs.current.set(cellId(rowIndex, colIndex), el);
                              else inputs.current.delete(cellId(rowIndex, colIndex));
                            }}
                            inputMode="decimal"
                            disabled={busy}
                            aria-label={`${row.label}, ${dayTick(day)}`}
                            value={values[`${row.key}|${day}`] ?? ""}
                            onChange={(e) => setValue(row.key, day, e.target.value)}
                            onKeyDown={(e) => handleKeyDown(e, rowIndex, colIndex)}
                            onPaste={(e) => handlePaste(e, rowIndex, colIndex)}
                          />
                        </td>
                      ))}
                    </tr>
                  </>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className="cell-sub" style={{ fontSize: 11.5, marginTop: 10 }}>
          Paste a tab- or comma-separated row into any cell to fill it and the
          cells to its right. Tab and the arrow keys move between cells. A blank
          cell is not saved — blank is not zero, and a day left entirely blank
          creates no row at all. Saving replaces only the days shown here.
        </div>

        <div className="modal-actions">
          <button className="btn btn-sm" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn btn-sm btn-primary" onClick={save} disabled={busy}>
            {busy ? "Saving…" : "Save week"}
          </button>
        </div>
      </div>
    </div>
  );
}
