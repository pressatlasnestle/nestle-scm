"use client";

import { useEffect, useState, useTransition, type CSSProperties } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { shortDate } from "@/lib/format";
import { useToast } from "@/components/Toast";
import { ConfirmModal } from "@/components/ConfirmModal";
import { excludeArticle, deleteArticle } from "./actions";

const CHANNEL_OPTIONS: { value: string; label: string }[] = [
  { value: "all", label: "All" },
  { value: "media_rss", label: "RSS" },
  { value: "google_alerts", label: "Google Alerts" },
  { value: "google_news_seed", label: "Google News" },
  { value: "newsdata", label: "NewsData" },
];

const STATUS_OPTIONS: { value: string; label: string }[] = [
  { value: "active", label: "Active" },
  { value: "excluded", label: "Excluded" },
  { value: "deleted", label: "Deleted" },
  { value: "all", label: "All" },
];

const selectStyle: CSSProperties = {
  background: "var(--panel-raised)",
  border: "1px solid var(--line)",
  borderRadius: 7,
  padding: "8px 11px",
  fontSize: 12.5,
  color: "var(--text)",
  fontFamily: "var(--font-body)",
};

export type ArticleRow = {
  id: string;
  headline: string;
  url: string | null;
  media: string | null;
  source_channel: string | null;
  published_at: string | null;
  matched_keywords: string[];
  matched_negative_keywords: string[] | null;
  keyword_mention_count: number | null;
  word_count: number | null;
  status: string;
};

export type FilterState = {
  q: string;
  channel: string;
  neg: boolean;
  status: string;
  sort: string;
  dir: string;
  page: number;
};

// One color per ingestion channel, reusing the badge visual language.
const CHANNEL: Record<string, { label: string; bg: string; color: string }> = {
  media_rss: { label: "RSS", bg: "var(--teal-dim)", color: "var(--teal)" },
  google_alerts: { label: "Google Alerts", bg: "var(--amber-dim)", color: "var(--amber)" },
  google_news_seed: { label: "Google News", bg: "rgba(124,147,240,0.15)", color: "var(--indigo)" },
  newsdata: { label: "NewsData", bg: "var(--coral-dim)", color: "var(--coral)" },
};

function channelBadge(channel: string | null) {
  if (!channel) return <span className="mono-dim">—</span>;
  const c = CHANNEL[channel] ?? {
    label: channel,
    bg: "var(--panel-raised)",
    color: "var(--text-muted)",
  };
  return (
    <span className="badge" style={{ background: c.bg, color: c.color }}>
      {c.label}
    </span>
  );
}

const chipStyle: CSSProperties = {
  display: "inline-block",
  fontFamily: "var(--font-mono)",
  fontSize: 11,
  color: "var(--text-muted)",
  background: "var(--panel-raised)",
  border: "1px solid var(--line)",
  borderRadius: 4,
  padding: "2px 7px",
  margin: "2px 4px 2px 0",
  maxWidth: 180,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  verticalAlign: "middle",
};

function keywordChips(keywords: string[]) {
  if (!keywords || keywords.length === 0) return <span className="mono-dim">—</span>;
  const shown = keywords.slice(0, 3);
  const extra = keywords.length - shown.length;
  return (
    <span title={keywords.join(", ")}>
      {shown.map((k) => (
        <span key={k} style={chipStyle}>
          {k}
        </span>
      ))}
      {extra > 0 && (
        <span className="mono-dim" style={{ fontSize: 11 }}>
          +{extra}
        </span>
      )}
    </span>
  );
}

function negFlag(negs: string[] | null) {
  if (!negs || negs.length === 0) return null;
  return (
    <span
      className="badge"
      title={`Contains negative keywords: ${negs.join(", ")}`}
      style={{ background: "var(--amber-dim)", color: "var(--amber)" }}
    >
      ⚠ contains: {negs.slice(0, 2).join(", ")}
      {negs.length > 2 ? ` +${negs.length - 2}` : ""}
    </span>
  );
}

export function ArticlesView({
  rows,
  total,
  pageSize,
  canCurate,
  filters,
}: {
  rows: ArticleRow[];
  total: number;
  pageSize: number;
  canCurate: boolean;
  filters: FilterState;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();
  const toast = useToast();

  const [action, setAction] = useState<
    { row: ArticleRow; kind: "exclude" | "delete" } | null
  >(null);
  const [actionBusy, setActionBusy] = useState(false);

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : (filters.page - 1) * pageSize + 1;
  const to = Math.min(filters.page * pageSize, total);

  const [qLocal, setQLocal] = useState(filters.q);

  // Push params to the URL (server re-queries). Resets to page 1 unless the
  // update is itself a page change.
  function setParams(updates: Record<string, string | null>) {
    const params = new URLSearchParams(searchParams.toString());
    for (const [k, v] of Object.entries(updates)) {
      if (v === null || v === "") params.delete(k);
      else params.set(k, v);
    }
    if (!("page" in updates)) params.set("page", "1");
    startTransition(() => router.push(`${pathname}?${params.toString()}`));
  }

  // Debounce the headline search so we don't navigate on every keystroke.
  useEffect(() => {
    if (qLocal === filters.q) return;
    const t = setTimeout(() => setParams({ q: qLocal || null }), 350);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qLocal]);

  function goToPage(page: number) {
    setParams({ page: String(page) });
  }

  function toggleMentionsSort() {
    if (filters.sort !== "mentions") setParams({ sort: "mentions", dir: "desc" });
    else if (filters.dir === "desc") setParams({ sort: "mentions", dir: "asc" });
    else setParams({ sort: null, dir: null }); // back to default (published desc)
  }

  const mentionsArrow =
    filters.sort === "mentions" ? (filters.dir === "desc" ? " ↓" : " ↑") : "";

  const filtering =
    filters.q !== "" ||
    filters.channel !== "all" ||
    filters.neg ||
    filters.status !== "active";

  function runAction() {
    if (!action) return;
    const { row, kind } = action;
    setActionBusy(true);
    startTransition(async () => {
      const res =
        kind === "exclude"
          ? await excludeArticle(row.id)
          : await deleteArticle(row.id);
      setActionBusy(false);
      setAction(null);
      if (res.ok)
        toast.success(
          `Article ${kind === "exclude" ? "excluded" : "deleted"}.`
        );
      else toast.error(res.error);
    });
  }

  const colCount = 7 + (canCurate ? 1 : 0);

  return (
    <>
      <div className="panel-head">
        <div>
          <h1>Articles</h1>
          <p>
            Every captured story. Excluded and deleted articles are kept as
            tombstones and hidden by default — switch the status filter to review
            them.
          </p>
        </div>
      </div>

      <div className="table-card">
        <div className="table-toolbar" style={{ flexWrap: "wrap", gap: 12 }}>
          <input
            className="search-input"
            placeholder="Search headlines…"
            value={qLocal}
            onChange={(e) => setQLocal(e.target.value)}
          />
          <select
            style={selectStyle}
            aria-label="Channel"
            value={filters.channel}
            onChange={(e) =>
              setParams({ channel: e.target.value === "all" ? null : e.target.value })
            }
          >
            {CHANNEL_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label === "All" ? "All channels" : o.label}
              </option>
            ))}
          </select>
          <select
            style={selectStyle}
            aria-label="Status"
            value={filters.status}
            onChange={(e) =>
              setParams({ status: e.target.value === "active" ? null : e.target.value })
            }
          >
            {STATUS_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label === "All" ? "All statuses" : o.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="btn btn-sm"
            aria-pressed={filters.neg}
            onClick={() => setParams({ neg: filters.neg ? null : "1" })}
            style={
              filters.neg
                ? { background: "var(--amber-dim)", borderColor: "rgba(240,174,78,0.4)", color: "var(--amber)" }
                : undefined
            }
          >
            ⚠ Flagged only
          </button>
          <span className="cell-sub" style={{ marginLeft: "auto" }}>
            {total === 0
              ? "No articles"
              : filtering
                ? `${from}–${to} of ${total} filtered`
                : `Showing ${from}–${to} of ${total}`}
          </span>
        </div>

        {rows.length === 0 ? (
          <div className="empty-state">
            <div className="empty-title">No articles</div>
            <div className="empty-sub">
              Nothing matches the current view yet.
            </div>
          </div>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Headline</th>
                  <th>Media</th>
                  <th>Published</th>
                  <th>Matched keywords</th>
                  <th>Flag</th>
                  <th
                    onClick={toggleMentionsSort}
                    style={{ cursor: "pointer", userSelect: "none" }}
                    title="Sort by mention count"
                  >
                    Mentions{mentionsArrow}
                  </th>
                  <th>Words</th>
                  {canCurate && <th />}
                </tr>
              </thead>
              <tbody>
                {rows.map((a) => (
                  <tr key={a.id}>
                    <td style={{ maxWidth: 360 }}>
                      {a.url ? (
                        <a
                          href={a.url}
                          target="_blank"
                          rel="noreferrer"
                          style={{ fontWeight: 600, color: "var(--text)" }}
                        >
                          {a.headline}
                        </a>
                      ) : (
                        <span style={{ fontWeight: 600 }}>{a.headline}</span>
                      )}
                    </td>
                    <td>
                      <div>{a.media || "—"}</div>
                      <div style={{ marginTop: 4 }}>{channelBadge(a.source_channel)}</div>
                    </td>
                    <td className="mono-dim">{shortDate(a.published_at)}</td>
                    <td>{keywordChips(a.matched_keywords)}</td>
                    <td>{negFlag(a.matched_negative_keywords) ?? <span className="mono-dim">—</span>}</td>
                    <td className="mono-dim">{a.keyword_mention_count ?? "—"}</td>
                    <td className="mono-dim">{a.word_count ?? "—"}</td>
                    {canCurate && (
                      <td>
                        <div className="row-actions">
                          {a.status !== "excluded" && (
                            <button
                              type="button"
                              className="row-delete"
                              style={{ color: "var(--amber)" }}
                              onClick={() => setAction({ row: a, kind: "exclude" })}
                            >
                              Exclude
                            </button>
                          )}
                          {a.status !== "deleted" && (
                            <button
                              type="button"
                              className="row-delete"
                              onClick={() => setAction({ row: a, kind: "delete" })}
                            >
                              Delete
                            </button>
                          )}
                        </div>
                      </td>
                    )}
                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={colCount} className="mono-dim">
                      No articles match the current filter.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}

        {total > pageSize && (
          <div
            className="table-toolbar"
            style={{ justifyContent: "space-between", borderTop: "1px solid var(--line)", borderBottom: "none" }}
          >
            <span className="cell-sub">
              Page {filters.page} of {totalPages}
            </span>
            <div style={{ display: "flex", gap: 8 }}>
              <button
                className="btn btn-sm"
                disabled={filters.page <= 1 || pending}
                onClick={() => goToPage(filters.page - 1)}
              >
                ← Prev
              </button>
              <button
                className="btn btn-sm"
                disabled={filters.page >= totalPages || pending}
                onClick={() => goToPage(filters.page + 1)}
              >
                Next →
              </button>
            </div>
          </div>
        )}
      </div>

      {!canCurate && (
        <div className="panel-foot-note">
          You have read access. Excluding or deleting articles requires the curate
          or admin role.
        </div>
      )}

      <ConfirmModal
        open={action !== null}
        title={
          action
            ? action.kind === "exclude"
              ? "Exclude this article?"
              : "Delete this article?"
            : ""
        }
        destructive={action?.kind === "delete"}
        confirmLabel={action?.kind === "exclude" ? "Exclude article" : "Delete article"}
        busy={actionBusy}
        onConfirm={runAction}
        onCancel={() => setAction(null)}
        body={
          action ? (
            action.kind === "exclude" ? (
              <>
                <strong>{action.row.headline}</strong> stops appearing in reports
                and won&apos;t be re-captured by future pulls. It stays as a
                tombstone; you can restore it by switching its status later.
              </>
            ) : (
              <>
                <strong>{action.row.headline}</strong> is soft-deleted — hidden
                from reports and never re-captured. The record is kept as a
                tombstone (its fingerprint must survive to prevent re-ingestion),
                not removed.
              </>
            )
          ) : null
        }
      />
    </>
  );
}
