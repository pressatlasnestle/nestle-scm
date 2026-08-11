"use client";

import { useTransition, type CSSProperties } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { shortDate } from "@/lib/format";

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

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : (filters.page - 1) * pageSize + 1;
  const to = Math.min(filters.page * pageSize, total);

  function goToPage(page: number) {
    const params = new URLSearchParams(searchParams.toString());
    params.set("page", String(page));
    startTransition(() => router.push(`${pathname}?${params.toString()}`));
  }

  const colCount = 7;

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
        <div className="table-toolbar" style={{ flexWrap: "wrap" }}>
          <span className="cell-sub">
            {total === 0
              ? "No articles"
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
                  <th>Mentions</th>
                  <th>Words</th>
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
    </>
  );
}
