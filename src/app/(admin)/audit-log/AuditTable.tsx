"use client";

import { useMemo, useState } from "react";
import { auditTime } from "@/lib/format";

export type AuditRow = {
  id: string;
  created_at: string;
  actor_email: string | null;
  action: string | null;
  target: string;
};

export function AuditTable({ rows }: { rows: AuditRow[] }) {
  const [filter, setFilter] = useState("");

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) =>
      [r.actor_email, r.action, r.target]
        .filter(Boolean)
        .some((v) => v!.toLowerCase().includes(q))
    );
  }, [rows, filter]);

  return (
    <>
      <div className="panel-head">
        <div>
          <h1>Audit Log</h1>
          <p>
            Every curate/admin action, permanently recorded. Read-only, admin
            visibility only.
          </p>
        </div>
      </div>

      <div className="table-card">
        <div className="table-toolbar">
          <input
            className="search-input"
            placeholder="Filter by actor or action…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          <span className="cell-sub">
            {rows.length} event{rows.length === 1 ? "" : "s"}
          </span>
        </div>

        {rows.length === 0 ? (
          <div className="empty-state">
            <div className="empty-title">No activity yet</div>
            <div className="empty-sub">
              Curate and admin actions — source and keyword changes, key
              rotations, role changes — will appear here as they happen.
            </div>
          </div>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Actor</th>
                  <th>Action</th>
                  <th>Target</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((r) => (
                  <tr key={r.id}>
                    <td className="mono-dim">{auditTime(r.created_at)}</td>
                    <td>{r.actor_email ?? "—"}</td>
                    <td className="audit-action">
                      <span className="verb">{r.action ?? "—"}</span>
                    </td>
                    <td className="mono-dim">{r.target}</td>
                  </tr>
                ))}
                {filtered.length === 0 && (
                  <tr>
                    <td colSpan={4} className="mono-dim">
                      No events match “{filter}”.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
