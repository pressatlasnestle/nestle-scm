"use client";

import { useState, useTransition } from "react";
import { useToast } from "@/components/Toast";
import { ConfirmModal } from "@/components/ConfirmModal";
import { shortDate } from "@/lib/format";
import type { Week } from "@/lib/analysis/week-period";
import type { WeekNarrative } from "@/lib/analysis/narrative";
import type { ThemeStories } from "@/lib/analysis/week-stats";
import { csvFilename, downloadCsv } from "@/lib/analysis/csv";
import { STORY_COLUMNS, type StoryExportRow } from "@/lib/analysis/exports";
import { previewNarrative, regenerateNarrative } from "./actions";
import { POLARITY_COLOR } from "./charts";

/**
 * The written half of the panel: the stored weekly narrative, and the most
 * prominent stories behind each theme it covers.
 *
 * The narrative is READ here, never generated. Regenerate is an explicit,
 * role-gated action behind a confirm modal — same discipline as the Articles
 * panel's AI Analysis button, because it has the same property: it spends real
 * money and it overwrites something a colleague may already have read.
 */

function StoryList({
  title,
  color,
  stories,
}: {
  title: string;
  color: string;
  stories: ThemeStories["positive"];
}) {
  return (
    <div style={{ flex: "1 1 260px", minWidth: 0 }}>
      <div
        className="stat-label"
        style={{ color, marginBottom: 8 }}
      >
        {title}
      </div>
      {stories.length === 0 ? (
        <div className="cell-sub" style={{ fontSize: 12 }}>
          None this week.
        </div>
      ) : (
        <ol style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 10 }}>
          {stories.map((s) => (
            <li key={s.id} style={{ fontSize: 12.5, lineHeight: 1.5 }}>
              {s.url ? (
                <a
                  href={s.url}
                  target="_blank"
                  rel="noreferrer"
                  style={{ fontWeight: 600, color: "var(--text)" }}
                >
                  {s.headline}
                </a>
              ) : (
                <span style={{ fontWeight: 600 }}>{s.headline}</span>
              )}
              <div className="cell-sub" style={{ marginTop: 3 }}>
                {[s.media, shortDate(s.published_at)].filter(Boolean).join(" · ")}
                {" · "}
                <span
                  style={{ fontFamily: "var(--font-mono)" }}
                  title="Keyword mentions — the same prominence measure the Articles panel sorts on."
                >
                  {s.mentions} mention{s.mentions === 1 ? "" : "s"}
                </span>
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

export function NarrativePanel({
  week,
  narrative,
  generatedAt,
  stories,
  canCurate,
  codedTotal,
}: {
  week: Week;
  narrative: WeekNarrative | null;
  generatedAt: string | null;
  stories: ThemeStories[];
  canCurate: boolean;
  codedTotal: number;
}) {
  const toast = useToast();
  const [, startTransition] = useTransition();

  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<
    | { articles: number; withSummary: number; themes: string[]; alreadyExists: boolean }
    | null
  >(null);
  const [previewError, setPreviewError] = useState<string | null>(null);

  function openModal() {
    setOpen(true);
    setPreview(null);
    setPreviewError(null);
    startTransition(async () => {
      const res = await previewNarrative(week.start);
      if (res.ok) {
        setPreview({
          articles: res.articles,
          withSummary: res.withSummary,
          themes: res.themes,
          alreadyExists: res.alreadyExists,
        });
      } else {
        setPreviewError(res.error);
      }
    });
  }

  function run() {
    setBusy(true);
    startTransition(async () => {
      const res = await regenerateNarrative(week.start);
      setBusy(false);
      setOpen(false);
      if (res.ok) {
        toast.success(
          `Narrative written from ${res.articles ?? 0} summaries — ${(res.themes ?? []).join(", ")}.`
        );
      } else {
        toast.error(res.error);
      }
    });
  }

  function exportStories() {
    const rows: StoryExportRow[] = [];
    for (const t of stories) {
      t.positive.forEach((s, i) =>
        rows.push({ ...s, theme: t.theme, direction: "positive", rank: i + 1 })
      );
      t.negative.forEach((s, i) =>
        rows.push({ ...s, theme: t.theme, direction: "negative", rank: i + 1 })
      );
    }
    downloadCsv(csvFilename("top-stories", week.isoLabel), rows, STORY_COLUMNS);
  }

  return (
    <>
      <div className="chart-card" style={{ marginBottom: 18 }}>
        <div className="chart-head">
          <div>
            <h3>The week in brief</h3>
            <p>
              {narrative ? (
                <>
                  Written by Gemini from the {narrative.source_article_count}{" "}
                  article summaries this week produced, and stored — everyone
                  viewing this week reads the same text.
                  {generatedAt && <> Generated {shortDate(generatedAt)}.</>}
                </>
              ) : (
                <>
                  No narrative has been written for this week yet. The charts
                  above do not depend on it.
                </>
              )}
            </p>
          </div>
          {canCurate && (
            <button
              type="button"
              className="btn btn-sm btn-primary"
              onClick={openModal}
              disabled={codedTotal === 0}
              title={
                codedTotal === 0
                  ? "Nothing in this week is coded, so there is nothing to write from."
                  : "Call Gemini to write this week's summary and theme narratives."
              }
            >
              ✦ {narrative ? "Regenerate" : "Generate"}
            </button>
          )}
        </div>

        <div className="chart-body" style={{ padding: "16px 18px 18px" }}>
          {narrative ? (
            <p className="narrative-lede">{narrative.period_summary}</p>
          ) : (
            <div className="cell-sub" style={{ fontSize: 12.5 }}>
              {canCurate
                ? "Use Generate to write it. This calls Gemini once."
                : "Ask a curator or admin to generate it."}
            </div>
          )}
        </div>
      </div>

      {stories.length > 0 && (
        <div className="chart-card" style={{ marginBottom: 18 }}>
          <div className="chart-head">
            <div>
              <h3>Top themes in detail</h3>
              <p>
                The {stories.length} busiest theme
                {stories.length === 1 ? "" : "s"} this week. Stories are ranked
                by keyword mentions — the same prominence measure the Articles
                panel sorts on, not a new score invented here.
              </p>
            </div>
            <button
              type="button"
              className="btn btn-sm"
              onClick={exportStories}
              title="Download every ranked story below, as CSV."
            >
              ↓ Export CSV
            </button>
          </div>

          <div className="chart-body" style={{ padding: "4px 18px 18px" }}>
            {stories.map((t) => {
              const written = narrative?.themes.find((n) => n.theme === t.theme);
              return (
                <div key={t.theme} className="theme-block">
                  <div className="theme-block-head">
                    <h4>{t.theme}</h4>
                    <span className="cell-sub">
                      {t.articles} article{t.articles === 1 ? "" : "s"}
                    </span>
                  </div>
                  {written && <p className="narrative-body">{written.narrative}</p>}
                  <div className="story-columns">
                    <StoryList
                      title="Most prominent favourable"
                      color={POLARITY_COLOR.favourable}
                      stories={t.positive}
                    />
                    <StoryList
                      title="Most prominent unfavourable"
                      color={POLARITY_COLOR.unfavourable}
                      stories={t.negative}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <ConfirmModal
        open={open}
        title={narrative ? "Regenerate this week's narrative?" : "Generate this week's narrative?"}
        confirmLabel={preview === null ? "Checking…" : "Call Gemini"}
        busy={busy || (preview === null && previewError === null)}
        onConfirm={run}
        onCancel={() => setOpen(false)}
        body={
          previewError ? (
            <>Could not work out what would be written: {previewError}</>
          ) : preview === null ? (
            <>Working out what this would be written from…</>
          ) : preview.articles === 0 ? (
            <>
              Nothing in <strong>{week.label}</strong> is coded, so there is
              nothing to write from. Run AI coding on the week first.
            </>
          ) : (
            <>
              Write the period summary and a narrative for{" "}
              <strong>{preview.themes.join(", ")}</strong>, from the{" "}
              <strong>{preview.withSummary} article summaries</strong> in{" "}
              <strong>{week.label}</strong>.{" "}
              <strong>This is one Gemini call.</strong>
              <br />
              <br />
              It reads the summaries the coding pass already wrote, not the
              article bodies — so it costs a fraction of a coding run and reads
              only material that has already been cleaned up for reuse.
              {preview.alreadyExists && (
                <>
                  <br />
                  <br />
                  A narrative for this week <strong>already exists</strong> and
                  will be replaced. The previous text is not kept.
                </>
              )}
            </>
          )
        }
      />
    </>
  );
}
