"use client";

import { useMemo, useState } from "react";
import { renderReport, type ReportData } from "@/lib/report-template";
import { shortDate } from "@/lib/format";

export type ReportListItem = {
  id: string; // real report id, or "sample"
  isSample: boolean;
  week_of: string | null;
  generated_at: string | null;
  status: string | null;
  article_count: number | null;
  data: ReportData;
};

export function NewsletterPreview({ reports }: { reports: ReportListItem[] }) {
  const [selectedId, setSelectedId] = useState<string>(reports[0]?.id ?? "");

  const selected = useMemo(
    () => reports.find((r) => r.id === selectedId) ?? reports[0],
    [reports, selectedId]
  );

  const html = useMemo(
    () => (selected ? renderReport(selected.data) : ""),
    [selected]
  );

  const sampleMode = selected?.isSample ?? false;

  return (
    <>
      <div className="panel-head">
        <div>
          <h1>Newsletter</h1>
          <p>
            Preview of the Monday digest. The layout is generated from a shared
            template, so this is exactly what recipients receive — design changes
            are made in code (<code>src/lib/report-template.ts</code>), not here.
          </p>
        </div>
      </div>

      {sampleMode && (
        <div
          className="panel-foot-note"
          style={{
            marginTop: 0,
            marginBottom: 16,
            padding: "10px 14px",
            borderRadius: 8,
            background: "var(--amber-dim)",
            border: "1px solid rgba(240,174,78,0.35)",
            color: "var(--amber)",
          }}
        >
          Sample preview — no reports generated yet. This renders the shared
          template against fixture data so the design can be signed off before the
          ingestion/mailer pipeline exists.
        </div>
      )}

      <div style={{ display: "flex", gap: 16, alignItems: "flex-start" }}>
        {/* Report list */}
        <div className="table-card" style={{ width: 260, flexShrink: 0 }}>
          <div
            style={{
              padding: "12px 16px",
              borderBottom: "1px solid var(--line)",
              fontFamily: "var(--font-mono)",
              fontSize: 10.5,
              letterSpacing: "0.6px",
              textTransform: "uppercase",
              color: "var(--text-dim)",
            }}
          >
            {sampleMode ? "Preview" : "Reports"}
          </div>
          <div>
            {reports.map((r) => {
              const active = r.id === selected?.id;
              return (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => setSelectedId(r.id)}
                  style={{
                    display: "block",
                    width: "100%",
                    textAlign: "left",
                    padding: "12px 16px",
                    background: active ? "var(--teal-dim)" : "transparent",
                    border: "none",
                    borderBottom: "1px solid var(--line-soft)",
                    borderLeft: active
                      ? "2px solid var(--teal)"
                      : "2px solid transparent",
                    cursor: "pointer",
                    color: "var(--text)",
                    fontFamily: "var(--font-body)",
                  }}
                >
                  <div style={{ fontWeight: 600, fontSize: 13 }}>
                    {r.isSample
                      ? "Sample digest"
                      : `Week of ${shortDate(r.week_of)}`}
                  </div>
                  <div
                    className="cell-sub"
                    style={{ display: "flex", gap: 8, marginTop: 3 }}
                  >
                    {r.isSample ? (
                      <span>Fixture data</span>
                    ) : (
                      <>
                        <span>{r.article_count ?? 0} articles</span>
                        {r.status && (
                          <span style={{ color: "var(--text-dim)" }}>
                            · {r.status}
                          </span>
                        )}
                      </>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        {/* Preview */}
        <div
          className="table-card"
          style={{ flex: 1, minWidth: 0, padding: 0, overflow: "hidden" }}
        >
          <iframe
            title="Newsletter preview"
            srcDoc={html}
            style={{
              width: "100%",
              height: 760,
              border: "none",
              display: "block",
              background: "#eef2f7",
            }}
          />
        </div>
      </div>
    </>
  );
}
