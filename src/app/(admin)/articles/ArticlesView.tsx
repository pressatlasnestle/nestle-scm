"use client";

import { useEffect, useState, useTransition, type CSSProperties } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { shortDate } from "@/lib/format";
import { useToast } from "@/components/Toast";
import { ConfirmModal } from "@/components/ConfirmModal";
import {
  PERIOD_LABEL,
  PERIOD_KEYS,
  describeRange,
  resolvePeriod,
  type PeriodKey,
} from "@/lib/articles/period";
import type { CodingScope } from "@/lib/analysis/coding-batch";
import {
  excludeArticle,
  deleteArticle,
  bulkExcludeArticles,
  countArticlesToCode,
  runAiCoding,
} from "./actions";

const CHANNEL_OPTIONS: { value: string; label: string }[] = [
  { value: "all", label: "All" },
  { value: "media_rss", label: "RSS" },
  { value: "google_alerts", label: "Google Alerts" },
  { value: "google_news_seed", label: "Google News" },
  { value: "newsapi_ai", label: "newsapi.ai" },
  // Retired in migration 0021 but still has rows; kept so they stay reachable.
  { value: "newsdata", label: "NewsData (retired)" },
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
  ai_sorting_status: string | null;
  ai_sorting_flagged: boolean | null;
  ai_sorting_reasoning: string | null;
  coded_status: string | null;
  ai_sentiment: string | null;
  ai_themes: string[] | null;
  ai_relevance_score: number | null;
  impact_rationale: string | null;
};

export type FilterState = {
  q: string;
  channel: string;
  neg: boolean;
  sflag: boolean;
  status: string;
  period: PeriodKey;
  from: string | null;
  to: string | null;
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

/**
 * The two flags are deliberately NOT interchangeable, and the visual language
 * keeps them apart — different colour, different glyph, different verb:
 *
 *   ⚠ amber  — an exclusion TERM appeared in the text. Lexical, deterministic,
 *              says nothing about what the article is about.
 *   ◆ indigo — the AI questions whether the article is on-topic at all.
 *              A judgement, and the reasoning is attached.
 *
 * An article can carry both, one, or neither, and each means something
 * different to the analyst deciding whether to exclude it.
 */
function negFlag(negs: string[] | null) {
  if (!negs || negs.length === 0) return null;
  return (
    <span
      className="badge"
      title={`Exclusion terms present in the text: ${negs.join(", ")}. Lexical match only — this does not mean the article is off-topic.`}
      style={{ background: "var(--amber-dim)", color: "var(--amber)" }}
    >
      ⚠ term: {negs.slice(0, 2).join(", ")}
      {negs.length > 2 ? ` +${negs.length - 2}` : ""}
    </span>
  );
}

function relevanceFlag(row: ArticleRow) {
  if (row.ai_sorting_status !== "complete") {
    return (
      <span
        className="badge"
        title="Not yet judged by the sorting pass. Runs automatically after ingestion; npm run sort backfills."
        style={{ background: "var(--panel-raised)", color: "var(--text-muted)" }}
      >
        ◇ unsorted
      </span>
    );
  }
  if (!row.ai_sorting_flagged) return null;
  return (
    <span
      className="badge"
      title={
        row.ai_sorting_reasoning
          ? `AI questions relevance: ${row.ai_sorting_reasoning}`
          : "AI questions whether this article belongs in the corpus."
      }
      style={{
        background: "rgba(124,147,240,0.15)",
        color: "var(--indigo)",
      }}
    >
      ◆ off-topic?
    </span>
  );
}

/**
 * The 5-point favourability tier, coloured on a diverging scale so the two
 * unfavourable tiers read as one direction and the two favourable as the
 * other. Deliberately not the same palette as either flag badge — sentiment is
 * a coded value, not a warning.
 */
const TIER_STYLE: Record<string, { bg: string; color: string }> = {
  "Very unfavourable": { bg: "var(--coral-dim)", color: "var(--coral)" },
  Unfavourable: { bg: "var(--coral-dim)", color: "var(--coral)" },
  Neutral: { bg: "var(--panel-raised)", color: "var(--text-muted)" },
  Favourable: { bg: "var(--teal-dim)", color: "var(--teal)" },
  "Very favourable": { bg: "var(--teal-dim)", color: "var(--teal)" },
};

function sentimentCell(row: ArticleRow) {
  if (row.coded_status !== "coded" || !row.ai_sentiment) {
    return <span className="mono-dim">—</span>;
  }
  const style = TIER_STYLE[row.ai_sentiment] ?? {
    bg: "var(--panel-raised)",
    color: "var(--text-muted)",
  };
  const themes = row.ai_themes ?? [];
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4, alignItems: "flex-start" }}>
      <span
        className="badge"
        style={{ background: style.bg, color: style.color }}
        title={
          // The rationale is the only part of the grade a curator can check
          // against the article, so it belongs on the grade itself rather than
          // in a column they have to go looking for.
          row.impact_rationale
            ? `${row.ai_sentiment} — ${row.impact_rationale}`
            : `Favourability for Nestlé AOA container movement: ${row.ai_sentiment}`
        }
      >
        {/* "Very" prefixed tiers get a double mark so the extremes are
            distinguishable at a glance without a second colour. */}
        {row.ai_sentiment.startsWith("Very ") ? "±± " : "± "}
        {row.ai_sentiment}
      </span>
      {row.ai_relevance_score !== null && (
        // Magnitude sits next to direction, because either alone misleads: a
        // 'Very unfavourable' at relevance 5 and one at 95 are not the same
        // story, and the tier cannot tell them apart.
        <span
          className="mono-dim"
          style={{ fontSize: 11 }}
          title="Relevance to Nestlé AOA container movement, 0-100. Magnitude — separate from the direction above."
        >
          relevance {row.ai_relevance_score}
        </span>
      )}
      {themes.length > 0 && (
        <span className="mono-dim" style={{ fontSize: 11 }} title={themes.join(" · ")}>
          {themes.slice(0, 2).join(" · ")}
          {themes.length > 2 ? ` +${themes.length - 2}` : ""}
        </span>
      )}
    </div>
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

  // Bulk selection (curate only). Only rows on the current page are selectable;
  // selection is cleared whenever the view (filters/page) changes.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);
  const filterKey = JSON.stringify(filters);
  useEffect(() => {
    setSelected(new Set());
  }, [filterKey]);

  function toggleRow(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  // Rows on this page that can still be excluded (not already excluded).
  const excludableIds = rows
    .filter((r) => r.status !== "excluded")
    .map((r) => r.id);

  function toggleAll() {
    setSelected((prev) =>
      prev.size >= excludableIds.length && excludableIds.length > 0
        ? new Set()
        : new Set(excludableIds)
    );
  }

  function runBulk() {
    const ids = [...selected];
    if (ids.length === 0) return;
    setBulkBusy(true);
    startTransition(async () => {
      const res = await bulkExcludeArticles(ids);
      setBulkBusy(false);
      setBulkOpen(false);
      setSelected(new Set());
      if (res.ok) toast.success(`Excluded ${res.count ?? ids.length} articles.`);
      else toast.error(res.error);
    });
  }

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : (filters.page - 1) * pageSize + 1;
  const to = Math.min(filters.page * pageSize, total);

  const [qLocal, setQLocal] = useState(filters.q);

  // AI coding. The count is fetched when the modal opens rather than derived
  // from `total`, because the two are different sets: `total` counts what the
  // panel is showing (which may include already-coded articles, and honours
  // the status filter), while coding only ever touches active + uncoded rows.
  const [codingOpen, setCodingOpen] = useState(false);
  const [codingBusy, setCodingBusy] = useState(false);
  const [codingCount, setCodingCount] = useState<number | null>(null);
  const [codingSkipped, setCodingSkipped] = useState(0);
  const [codingCap, setCodingCap] = useState<number | null>(null);
  const [codingError, setCodingError] = useState<string | null>(null);

  const codingScope: CodingScope = {
    period: filters.period,
    from: filters.from,
    to: filters.to,
    channel: filters.channel,
    q: filters.q,
    neg: filters.neg,
    sflag: filters.sflag,
  };

  const rangeLabel = describeRange(
    filters.period,
    resolvePeriod(filters.period, { from: filters.from, to: filters.to })
  );

  function openCoding() {
    setCodingOpen(true);
    setCodingCount(null);
    setCodingSkipped(0);
    setCodingCap(null);
    setCodingError(null);
    startTransition(async () => {
      const res = await countArticlesToCode(codingScope);
      if (res.ok) {
        setCodingCount(res.count);
        setCodingSkipped(res.skippedFlagged);
        setCodingCap(res.cap);
      } else {
        setCodingError(res.error);
      }
    });
  }

  function runCoding() {
    setCodingBusy(true);
    startTransition(async () => {
      const res = await runAiCoding(codingScope);
      setCodingBusy(false);
      setCodingOpen(false);
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      const parts = [`Coded ${res.processed ?? 0} article(s).`];
      if (res.failed) parts.push(`${res.failed} failed (still pending).`);
      if (res.remaining) parts.push(`${res.remaining} left — run again to continue.`);
      toast.success(parts.join(" "));
    });
  }

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
    filters.sflag ||
    filters.period !== "all" ||
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

  const colCount = 8 + (canCurate ? 2 : 0);
  const allOnPageSelected =
    excludableIds.length > 0 && selected.size >= excludableIds.length;

  return (
    <>
      <div className="panel-head">
        <div>
          <h1>Articles</h1>
          <p>
            Every captured story. Excluded and deleted articles are kept as
            tombstones and hidden by default — switch the status filter to review
            them. <strong style={{ color: "var(--indigo)" }}>◆</strong> marks an
            AI relevance doubt;{" "}
            <strong style={{ color: "var(--amber)" }}>⚠</strong> marks an
            exclusion term in the text. Neither hides an article — both are
            advisory, and excluding is always your call.
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
          <select
            style={selectStyle}
            aria-label="Period"
            value={filters.period}
            onChange={(e) => {
              const next = e.target.value as PeriodKey;
              setParams({
                period: next === "all" ? null : next,
                // Custom bounds are meaningless under a preset, and leaving
                // them in the URL would silently re-apply on the next switch
                // back to Custom.
                ...(next === "custom" ? {} : { from: null, to: null }),
              });
            }}
          >
            {PERIOD_KEYS.map((k) => (
              <option key={k} value={k}>
                {PERIOD_LABEL[k]}
              </option>
            ))}
          </select>

          {filters.period === "custom" && (
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              <input
                type="date"
                style={selectStyle}
                aria-label="From date"
                value={filters.from ?? ""}
                max={filters.to ?? undefined}
                onChange={(e) => setParams({ from: e.target.value || null })}
              />
              <span className="cell-sub">to</span>
              <input
                type="date"
                style={selectStyle}
                aria-label="To date"
                value={filters.to ?? ""}
                min={filters.from ?? undefined}
                onChange={(e) => setParams({ to: e.target.value || null })}
              />
            </span>
          )}

          <button
            type="button"
            className="btn btn-sm"
            aria-pressed={filters.neg}
            title="Show only articles containing an exclusion term. Lexical match — not a relevance judgement."
            onClick={() => setParams({ neg: filters.neg ? null : "1" })}
            style={
              filters.neg
                ? { background: "var(--amber-dim)", borderColor: "rgba(240,174,78,0.4)", color: "var(--amber)" }
                : undefined
            }
          >
            ⚠ Exclusion term
          </button>
          <button
            type="button"
            className="btn btn-sm"
            aria-pressed={filters.sflag}
            title="Show only articles the AI sorting pass flagged as possibly off-topic. Hover a row's ◆ badge for its reasoning."
            onClick={() => setParams({ sflag: filters.sflag ? null : "1" })}
            style={
              filters.sflag
                ? {
                    background: "rgba(124,147,240,0.15)",
                    borderColor: "rgba(124,147,240,0.4)",
                    color: "var(--indigo)",
                  }
                : undefined
            }
          >
            ◆ Off-topic?
          </button>
          {canCurate && (
            <button
              type="button"
              className="btn btn-sm btn-primary"
              onClick={openCoding}
              disabled={pending}
              title="Run Gemini sentiment + theme coding over the active, not-yet-coded articles in the current view."
            >
              ✦ AI Analysis
            </button>
          )}
          <span className="cell-sub" style={{ marginLeft: "auto" }}>
            {total === 0
              ? "No articles"
              : filtering
                ? `${from}–${to} of ${total} filtered`
                : `Showing ${from}–${to} of ${total}`}
          </span>
        </div>

        {canCurate && selected.size > 0 && (
          <div
            className="table-toolbar"
            style={{
              justifyContent: "space-between",
              background: "var(--teal-dim)",
              borderBottom: "1px solid var(--line)",
            }}
          >
            <span style={{ color: "var(--teal)", fontWeight: 600, fontSize: 13 }}>
              {selected.size} selected
            </span>
            <div style={{ display: "flex", gap: 8 }}>
              <button className="btn btn-sm" onClick={() => setSelected(new Set())}>
                Clear
              </button>
              <button
                className="btn btn-sm btn-danger"
                onClick={() => setBulkOpen(true)}
              >
                Exclude {selected.size} selected
              </button>
            </div>
          </div>
        )}

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
                  {canCurate && (
                    <th style={{ width: 34 }}>
                      <input
                        type="checkbox"
                        aria-label="Select all on page"
                        checked={allOnPageSelected}
                        ref={(el) => {
                          if (el)
                            el.indeterminate =
                              selected.size > 0 && !allOnPageSelected;
                        }}
                        onChange={toggleAll}
                        disabled={excludableIds.length === 0}
                      />
                    </th>
                  )}
                  <th>Headline</th>
                  <th>Media</th>
                  <th>Published</th>
                  <th>Matched keywords</th>
                  <th title="◆ = AI relevance doubt (hover for reasoning). ⚠ = an exclusion term is present in the text. Two different signals.">
                    Flags
                  </th>
                  <th title="5-point favourability from a cargo owner's perspective, plus the themes storylines group on. Written by AI Analysis.">
                    Sentiment
                  </th>
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
                    {canCurate && (
                      <td>
                        <input
                          type="checkbox"
                          aria-label={`Select ${a.headline}`}
                          checked={selected.has(a.id)}
                          disabled={a.status === "excluded"}
                          onChange={() => toggleRow(a.id)}
                        />
                      </td>
                    )}
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
                    <td>
                      {(() => {
                        const neg = negFlag(a.matched_negative_keywords);
                        const rel = relevanceFlag(a);
                        if (!neg && !rel) return <span className="mono-dim">—</span>;
                        return (
                          <div
                            style={{
                              display: "flex",
                              flexDirection: "column",
                              alignItems: "flex-start",
                              gap: 4,
                            }}
                          >
                            {rel}
                            {neg}
                          </div>
                        );
                      })()}
                    </td>
                    <td>{sentimentCell(a)}</td>
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

      <ConfirmModal
        open={codingOpen}
        title="Run AI coding?"
        confirmLabel={
          codingCount === null
            ? "Checking…"
            : `Run on ${Math.min(codingCount, codingCap ?? codingCount)}`
        }
        busy={codingBusy || codingCount === null}
        onConfirm={runCoding}
        onCancel={() => setCodingOpen(false)}
        body={
          codingError ? (
            <>Could not work out what would be coded: {codingError}</>
          ) : codingCount === null ? (
            <>Working out how many articles this would code…</>
          ) : codingCount === 0 ? (
            <>
              Nothing to code in this view.{" "}
              {codingSkipped > 0 ? (
                <>
                  All {codingSkipped} uncoded article
                  {codingSkipped === 1 ? " is" : "s are"} flagged{" "}
                  <strong style={{ color: "var(--indigo)" }}>◆ off-topic</strong>{" "}
                  by the sorting pass, and flagged articles are not coded. Clear
                  the flag or exclude them.
                </>
              ) : (
                <>
                  Every active article in <strong>{rangeLabel}</strong> matching
                  the current filters has already been coded.
                </>
              )}
            </>
          ) : (
            <>
              Run AI coding on the{" "}
              <strong>
                {Math.min(codingCount, codingCap ?? codingCount)} active article
                {Math.min(codingCount, codingCap ?? codingCount) === 1 ? "" : "s"}
              </strong>{" "}
              in <strong>{rangeLabel}</strong>.{" "}
              <strong>This calls Gemini once per article.</strong>
              <br />
              <br />
              Articles you have excluded are skipped, and anything already coded
              is never re-coded — so re-running over an overlapping period costs
              nothing.
              {codingSkipped > 0 && (
                <>
                  <br />
                  <br />
                  {codingSkipped} further article
                  {codingSkipped === 1 ? " is" : "s are"} flagged{" "}
                  <strong style={{ color: "var(--indigo)" }}>◆ off-topic</strong>{" "}
                  and will <strong>not</strong> be coded — a fixed theme list
                  has no bucket for an off-topic story, so it would land in
                  whichever one is least wrong.
                </>
              )}
              {codingCap !== null && codingCount > codingCap && (
                <>
                  <br />
                  <br />
                  {codingCount} match in total. This run codes the {codingCap}{" "}
                  oldest — a single run is capped so it cannot outlast its
                  request. Run again to continue where it stops.
                </>
              )}
            </>
          )
        }
      />

      <ConfirmModal
        open={bulkOpen}
        title={`Exclude ${selected.size} article${selected.size === 1 ? "" : "s"}?`}
        destructive
        confirmLabel={`Exclude ${selected.size}`}
        busy={bulkBusy}
        onConfirm={runBulk}
        onCancel={() => setBulkOpen(false)}
        body={
          <>
            The selected articles stop appearing in reports and won&apos;t be
            re-captured by future pulls. Each is kept as a tombstone, and each
            exclusion is logged individually to the audit trail.
          </>
        }
      />
    </>
  );
}
