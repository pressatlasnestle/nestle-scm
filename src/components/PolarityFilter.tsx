"use client";

import type { CSSProperties } from "react";

export type PolarityValue = "all" | "positive" | "negative" | "neutral";

export type PolarityOption = { value: PolarityValue; label: string };

// Selected-state fill per option, using the same colors as the .badge-* classes.
const FILL: Record<PolarityValue, CSSProperties> = {
  all: { background: "var(--line)", color: "var(--text)" },
  positive: { background: "var(--teal)", color: "#07211e" },
  negative: { background: "var(--coral)", color: "#2a0f0c" },
  neutral: { background: "var(--panel-raised)", color: "var(--text)" },
};

/**
 * Segmented polarity filter. Selected option is filled with its badge color;
 * unselected options are muted. Options are caller-supplied so Keywords can omit
 * the neutral state (keywords have no neutral list_type).
 */
export function PolarityFilter({
  value,
  onChange,
  options,
}: {
  value: PolarityValue;
  onChange: (v: PolarityValue) => void;
  options: PolarityOption[];
}) {
  return (
    <div
      role="group"
      aria-label="Filter by polarity"
      style={{
        display: "inline-flex",
        gap: 3,
        background: "var(--panel-raised)",
        border: "1px solid var(--line)",
        borderRadius: 8,
        padding: 3,
        flexShrink: 0,
      }}
    >
      {options.map((o) => {
        const selected = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            aria-pressed={selected}
            onClick={() => onChange(o.value)}
            style={{
              border: "none",
              borderRadius: 6,
              padding: "6px 11px",
              fontSize: 12,
              fontWeight: 600,
              cursor: "pointer",
              fontFamily: "var(--font-body)",
              whiteSpace: "nowrap",
              ...(selected
                ? FILL[o.value]
                : { background: "transparent", color: "var(--text-muted)" }),
            }}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
