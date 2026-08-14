"use client";

import type { CSSProperties } from "react";
import type { Week } from "@/lib/analysis/week-period";
import { weekRangeLabel } from "@/lib/newsletter/week";

/**
 * The week picker, shared by the Analysis panel and the Newsletter composer.
 *
 * ONE control, not two that look alike. These are the only two screens in the
 * app that are addressed by week, the people using them are not technical, and
 * two dropdowns that phrase the same week differently is exactly the kind of
 * small inconsistency that makes a tool feel unreliable to someone who has no
 * way to check which one is right.
 *
 * The label is the compact range — "10–16 Aug 2026" — everywhere. Each option
 * can carry short plain-English notes after it: how many articles are in the
 * week, whether it is still running, whether an edition has been sent. Notes
 * are the caller's business because the two screens genuinely know different
 * things; the FORMAT is not.
 */

export type WeekOption = {
  week: Week;
  /**
   * Short phrases appended after the date range, joined with a middle dot.
   * Written for a reader, not a developer: "in progress", "96 coded so far",
   * "sent". Empty entries are dropped.
   */
  notes?: (string | null | undefined)[];
};

const selectStyle: CSSProperties = {
  background: "var(--panel-raised)",
  border: "1px solid var(--line)",
  borderRadius: 7,
  padding: "8px 11px",
  fontSize: 12.5,
  color: "var(--text)",
  fontFamily: "var(--font-body)",
  maxWidth: "100%",
};

export function WeekSelect({
  options,
  value,
  disabled,
  onChange,
  label = "Week",
}: {
  options: WeekOption[];
  /** The selected week's ISO Monday. */
  value: string;
  disabled?: boolean;
  onChange: (weekStart: string) => void;
  label?: string;
}) {
  return (
    <select
      style={selectStyle}
      aria-label={label}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
    >
      {options.map(({ week, notes }) => {
        const suffix = (notes ?? []).filter(Boolean).join(" · ");
        return (
          <option key={week.start} value={week.start}>
            {weekRangeLabel(week)}
            {suffix ? ` · ${suffix}` : ""}
          </option>
        );
      })}
    </select>
  );
}
