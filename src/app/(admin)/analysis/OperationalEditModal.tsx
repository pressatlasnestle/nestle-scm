"use client";

import { useEffect, useState, type CSSProperties } from "react";

/**
 * The inline data-entry dialog for one operational chart.
 *
 * Scoped to a single chart's fields on purpose. One combined "edit all
 * operational data" form would mix three different report sources and two
 * different grains — weekly congestion against monthly reliability — and make
 * every edit look like it touched everything. A chart's own pencil opens only
 * that chart's numbers.
 *
 * Built on the existing .modal shell rather than ConfirmModal, which exists to
 * confirm an action and has no room for inputs.
 */

export type FieldSpec = {
  key: string;
  label: string;
  /** Shown to the right of the input — "TEU", "days", "%". */
  unit?: string;
  hint?: string;
};

export type FieldGroup = {
  title: string;
  hint?: string;
  fields: FieldSpec[];
};

const inputStyle: CSSProperties = {
  background: "var(--panel-raised)",
  border: "1px solid var(--line)",
  borderRadius: 7,
  padding: "7px 10px",
  fontSize: 13,
  color: "var(--text)",
  fontFamily: "var(--font-mono)",
  width: "100%",
};

export function OperationalEditModal({
  open,
  title,
  periodLabel,
  groups,
  initial,
  busy,
  onSave,
  onCancel,
}: {
  open: boolean;
  title: string;
  /**
   * Which period is being written. Always stated, because it is not always the
   * selected week — the reliability form edits a MONTH while the rest of the
   * panel is on a week, and a form that did not say so would be an easy way to
   * overwrite the wrong period.
   */
  periodLabel: string;
  groups: FieldGroup[];
  /** Existing values, so re-editing is not blind re-entry. */
  initial: Record<string, string>;
  busy: boolean;
  onSave: (values: Record<string, string>) => void;
  onCancel: () => void;
}) {
  const [values, setValues] = useState<Record<string, string>>(initial);

  // Re-seeded whenever the dialog opens or the period changes, so switching
  // week and reopening never shows the previous week's numbers.
  const seed = JSON.stringify(initial);
  useEffect(() => {
    if (open) setValues(initial);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, seed]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, busy, onCancel]);

  if (!open) return null;

  return (
    <div className="modal-overlay" onClick={() => !busy && onCancel()}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        style={{ maxWidth: 560, width: "92%" }}
        onClick={(e) => e.stopPropagation()}
      >
        <h2>{title}</h2>
        <div className="modal-body" style={{ maxHeight: "60vh", overflowY: "auto" }}>
          <div
            className="stat-label"
            style={{ color: "var(--teal)", marginBottom: 14 }}
          >
            {periodLabel}
          </div>

          {groups.map((group) => (
            <div key={group.title} style={{ marginBottom: 18 }}>
              <div className="stat-label" style={{ marginBottom: 4 }}>
                {group.title}
              </div>
              {group.hint && (
                <div className="cell-sub" style={{ marginBottom: 9, fontSize: 11.5 }}>
                  {group.hint}
                </div>
              )}
              <div style={{ display: "grid", gap: 9 }}>
                {group.fields.map((field) => (
                  <label
                    key={field.key}
                    style={{
                      display: "grid",
                      gridTemplateColumns: "1fr 132px",
                      alignItems: "center",
                      gap: 10,
                    }}
                  >
                    <span style={{ fontSize: 12.5, color: "var(--text-muted)" }}>
                      {field.label}
                      {field.hint && (
                        <span className="cell-sub" style={{ display: "block", fontSize: 11 }}>
                          {field.hint}
                        </span>
                      )}
                    </span>
                    <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <input
                        style={inputStyle}
                        // Not type="number": it rejects a pasted "1,240" in
                        // some locales and swallows scroll events over the
                        // field. The action parses and validates anyway.
                        inputMode="decimal"
                        placeholder="—"
                        value={values[field.key] ?? ""}
                        onChange={(e) =>
                          setValues((v) => ({ ...v, [field.key]: e.target.value }))
                        }
                      />
                      {field.unit && (
                        <span className="cell-sub" style={{ fontSize: 11 }}>
                          {field.unit}
                        </span>
                      )}
                    </span>
                  </label>
                ))}
              </div>
            </div>
          ))}

          <div className="cell-sub" style={{ fontSize: 11.5 }}>
            Leave a field blank to record no figure for it. Blank is not zero —
            a blank draws no bar, a zero draws one at zero.
          </div>
        </div>

        <div className="modal-actions">
          <button className="btn btn-sm" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button
            className="btn btn-sm btn-primary"
            onClick={() => onSave(values)}
            disabled={busy}
          >
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
