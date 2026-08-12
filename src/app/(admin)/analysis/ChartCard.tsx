"use client";

import type { ReactNode } from "react";

/**
 * The shell every chart on this panel sits in: title, one line of plain-English
 * guidance about what the chart does and does not include, an export button,
 * and the chart itself.
 *
 * The export button lives here rather than in each chart so that "every chart
 * exports" is structural rather than a thing four components each remembered
 * to do. It is never role-gated — a read user exports the same data they can
 * already see.
 */
export function ChartCard({
  title,
  hint,
  onExport,
  exportLabel = "Export CSV",
  empty,
  children,
}: {
  title: string;
  hint: ReactNode;
  onExport?: () => void;
  exportLabel?: string;
  /** Shown instead of the chart when there is nothing to plot. */
  empty?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="chart-card">
      <div className="chart-head">
        <div>
          <h3>{title}</h3>
          <p>{hint}</p>
        </div>
        {onExport && (
          <button
            type="button"
            className="btn btn-sm"
            onClick={onExport}
            disabled={Boolean(empty)}
            title={
              empty
                ? "Nothing to export for this week."
                : "Download exactly what this chart is showing, as CSV."
            }
          >
            ↓ {exportLabel}
          </button>
        )}
      </div>
      {empty ? (
        <div className="empty-state">
          <div className="empty-sub">{empty}</div>
        </div>
      ) : (
        <div className="chart-body">{children}</div>
      )}
    </div>
  );
}
