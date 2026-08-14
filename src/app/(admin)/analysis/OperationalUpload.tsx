"use client";

import { useId, useMemo, useRef, useState, useTransition } from "react";
import { useToast } from "@/components/Toast";
import { csvFilename, parseCsv } from "@/lib/analysis/csv";
import { carriedPorts, type CongestionRow, type FleetStatusRow, type PortCongestionRow } from "@/lib/analysis/operational";
import {
  buildTemplateCsv,
  groupProblems,
  parseUpload,
  planChanges,
  type Change,
  type ExistingData,
  type UploadPlan,
} from "@/lib/analysis/operational-template";
import { weekDays, type Week } from "@/lib/analysis/week-period";
import { applyOperationalUpload } from "./operational-actions";

/**
 * The second way into the same three operational tables. Beside the grid, not
 * instead of it.
 *
 * THE USER NEVER CONSTRUCTS A CSV. They download a template for the selected
 * week with every date, region, status, port and measure already written, and
 * fill in one column. A hand-built file gets a port spelled differently or a
 * date as DD/MM/YYYY, and the usual result is silently skipped rows — which is
 * worse than a rejected file, because nobody notices.
 *
 * NOTHING IS WRITTEN UNTIL SAVE. Dropping a file parses and validates it in the
 * browser and shows what would happen; the database is not touched. A file drop
 * that immediately overwrites a week is not recoverable by anyone here.
 *
 * A ROW PROBLEM REFUSES THE WHOLE FILE. This is not a partial importer. One
 * unrecognised port leaves everything as it was, so the fix is "correct that
 * row and upload again" rather than "work out which of the other 300 went in".
 */

type Stage =
  | { kind: "idle" }
  | {
      kind: "checked";
      filename: string;
      csv: string;
      plan: UploadPlan;
      diff: { changed: Change[]; unchanged: number; added: number };
    };

export function OperationalUpload({
  week,
  portVocabulary,
  congestion,
  fleet,
  portCongestion,
}: {
  week: Week;
  /** Every port name the database will accept. */
  portVocabulary: string[];
  congestion: CongestionRow[];
  fleet: FleetStatusRow[];
  portCongestion: PortCongestionRow[];
}) {
  const toast = useToast();
  const [, startTransition] = useTransition();
  const [stage, setStage] = useState<Stage>({ kind: "idle" });
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  // The label needs an id to reach its input, and a hard-coded one would break
  // the moment two of these render on a page.
  const fileId = useId();

  const days = useMemo(() => weekDays(week), [week]);
  // The same five the grid offers, from the same function, so the template
  // cannot come out describing a different watchlist.
  const ports = useMemo(
    () => carriedPorts(portCongestion).filter(Boolean),
    [portCongestion]
  );
  const data: ExistingData = useMemo(
    () => ({ congestion, fleet, ports: portCongestion }),
    [congestion, fleet, portCongestion]
  );

  const reset = () => {
    setStage({ kind: "idle" });
    if (fileRef.current) fileRef.current.value = "";
  };

  function download() {
    const csv = buildTemplateCsv(days, ports, data);
    // The BOM is what makes Excel read this as UTF-8. Without it every accented
    // port name arrives mangled.
    const blob = new Blob(["﻿", csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    // The same helper every other export uses. week.label is prose — "Aug 10 –
    // Aug 16, 2026" — and spaces and an en dash in a filename survive the
    // download only to be mangled by the next thing that touches it.
    link.download = csvFilename("operational", week.isoLabel);
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  async function choose(file: File | null | undefined) {
    if (!file) return;
    const csv = await file.text();
    const plan = parseUpload(parseCsv(csv), {
      days,
      ports,
      portVocabulary,
    });
    setStage({
      kind: "checked",
      filename: file.name,
      csv,
      plan,
      diff: planChanges(plan, data),
    });
  }

  function save() {
    if (stage.kind !== "checked") return;
    setBusy(true);
    startTransition(async () => {
      const res = await applyOperationalUpload({
        csv: stage.csv,
        days,
        ports,
        filename: stage.filename,
      });
      setBusy(false);
      if (res.ok) {
        toast.success(
          `Saved ${res.valuesWritten} value${res.valuesWritten === 1 ? "" : "s"} across ${res.daysWritten} day${res.daysWritten === 1 ? "" : "s"}.`
        );
        reset();
      } else {
        toast.error(res.error);
      }
    });
  }

  const plan = stage.kind === "checked" ? stage.plan : null;
  const diff = stage.kind === "checked" ? stage.diff : null;
  const blocked = !!plan && (!!plan.structuralError || plan.problems.length > 0);
  const nothingToSave = !!plan && !blocked && plan.values.length === 0;
  const groups = plan ? groupProblems(plan.problems) : [];

  return (
    <section className="upload-panel">
      <div className="upload-head">
        <div>
          <h3>Upload a spreadsheet</h3>
          <p className="upload-lede">
            Download the template for {week.label}, fill in the Value column,
            and upload it back. Every date, port and measure is already written
            for you — the only column to touch is the last one.
          </p>
        </div>
        <button type="button" className="btn btn-sm" onClick={download}>
          ↓ Download template
        </button>
      </div>

      <p className="upload-rule">
        A blank cell is not zero and is not null. It is not written at all, and
        the existing value (if any) is left alone.
      </p>

      <div className="upload-file">
        <label className="btn btn-sm btn-primary" htmlFor={fileId}>
          Choose file…
        </label>
        <input
          id={fileId}
          ref={fileRef}
          type="file"
          accept=".csv,text/csv"
          className="upload-input"
          onChange={(e) => void choose(e.target.files?.[0])}
        />
        <span className="upload-filename">
          {stage.kind === "checked" ? stage.filename : "No file chosen."}
        </span>
      </div>

      {/*
        A STRUCTURAL mistake is shown alone. Forty row failures caused by one
        renamed header is not a report anyone can act on — it buries the single
        thing that needs fixing under its own consequences.
      */}
      {plan?.structuralError ? (
        <p className="upload-structural">{plan.structuralError}</p>
      ) : (
        plan && (
          <>
            <div className="upload-counts">
              <div className={`upload-count${plan.values.length > 0 && !blocked ? " is-ready" : ""}`}>
                <strong>{plan.values.length}</strong>
                {/* Not "ready to save" while something is blocking the save —
                    the three counts have to agree with the button. */}
                <span>{blocked ? "read, but held back" : "ready to save"}</span>
              </div>
              <div className="upload-count">
                <strong>{plan.blank}</strong>
                <span>left blank — not written, existing values kept</span>
              </div>
              <div className={`upload-count${plan.problems.length > 0 ? " is-bad" : ""}`}>
                <strong>{plan.problems.length}</strong>
                <span>not recognised</span>
              </div>
            </div>

            {plan.problems.length > 0 && (
              <div className="upload-problems">
                <p className="upload-problems-lede">
                  Nothing will be saved until these are fixed. Correct them in
                  the spreadsheet and upload it again.
                </p>
                <ul>
                  {groups.slice(0, 10).map((g) => (
                    <li key={g.label}>
                      <strong>{g.label}:</strong> {g.message}
                    </li>
                  ))}
                </ul>
                {groups.length > 10 && (
                  <p className="upload-more">
                    …and {groups.length - 10} other problem
                    {groups.length - 10 === 1 ? "" : "s"}.
                  </p>
                )}
              </div>
            )}

            {!blocked && diff && (
              <div className="upload-preview">
                <p className="upload-preview-lede">
                  {plan.values.length === 0
                    ? "Every cell in that file is empty, so there is nothing to save."
                    : `This will add ${diff.added} new figure${diff.added === 1 ? "" : "s"}, change ${diff.changed.length}, and leave ${diff.unchanged} exactly as ${diff.unchanged === 1 ? "it is" : "they are"} — across ${plan.days.length} day${plan.days.length === 1 ? "" : "s"}.`}
                </p>

                {/*
                  Overwrites are shown with BOTH numbers. Quietly replacing last
                  Tuesday's transcription is how trust in the tool goes; the
                  person pressing Save has to see they are about to do it.
                */}
                {diff.changed.length > 0 && (
                  <div className="upload-changes">
                    <div className="upload-changes-head">
                      Changing {diff.changed.length} figure
                      {diff.changed.length === 1 ? "" : "s"} that {diff.changed.length === 1 ? "is" : "are"} already saved
                    </div>
                    <ul>
                      {diff.changed.slice(0, 20).map((c, i) => (
                        <li key={`${c.date}-${c.label}-${i}`}>
                          <span className="upload-change-when">{c.date}</span>
                          <span className="upload-change-what">{c.label}</span>
                          <span className="upload-change-from">{c.from}</span>
                          <span className="upload-change-arrow">→</span>
                          <span className="upload-change-to">{c.to}</span>
                        </li>
                      ))}
                    </ul>
                    {diff.changed.length > 20 && (
                      <p className="upload-more">
                        …and {diff.changed.length - 20} more.
                      </p>
                    )}
                  </div>
                )}
              </div>
            )}

            <div className="upload-actions">
              <button type="button" className="btn btn-sm" onClick={reset} disabled={busy}>
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-sm btn-primary"
                onClick={save}
                disabled={busy || blocked || nothingToSave}
              >
                {/*
                  Never "Save 51 values" on a file that will save none. A
                  disabled button whose label promises a number is read as the
                  number, not as the disabled state.
                */}
                {busy
                  ? "Saving…"
                  : blocked || nothingToSave
                    ? "Save"
                    : `Save ${plan.values.length} value${plan.values.length === 1 ? "" : "s"}`}
              </button>
            </div>
          </>
        )
      )}
    </section>
  );
}
