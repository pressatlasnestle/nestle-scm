"use client";

import { useMemo, useState, useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useToast } from "@/components/Toast";
import { ConfirmModal } from "@/components/ConfirmModal";
import { WeekSelect } from "@/components/WeekSelect";
import {
  buildEdition,
  dataBlocks,
  subjectLine,
  type BlockState,
  type Edition,
  type EditionInput,
} from "@/lib/newsletter/edition";
import {
  SECTION_SLOTS,
  findSection,
  hasBody,
  type EditionSection,
  type SectionKey,
} from "@/lib/newsletter/sections";
import { renderEditionHtml } from "@/lib/newsletter/email";
import type { EditionSnapshot } from "@/lib/newsletter/snapshot";
import {
  fullDayLabel,
  isRunningWeek,
  weekRangeLabel,
  type Week,
} from "@/lib/newsletter/week";
import {
  generateEdition,
  saveIncludedArticles,
  saveSection,
  sendEdition,
} from "./actions";
import { SectionCard } from "./SectionCard";
import { PressPicker } from "./PressPicker";
import { EditionPreview } from "./EditionPreview";

export type EditionListItem = {
  weekStart: string;
  status: string;
  sentAt: string | null;
};

/**
 * The composer.
 *
 * The AI writes every section from the week's data; the curator edits any
 * section they want to change. Left column: the written sections, each with its
 * own Edit and its own Regenerate. Right column: what the data actually
 * supports, including a plain-English list of anything left out and why.
 *
 * The preview recomputes in the browser from the same buildEdition() the send
 * action runs on the server, so what the curator approves and what gets frozen
 * come from one function rather than two that agree today.
 */
export function NewsletterComposer({
  week,
  weeks,
  weekCounts,
  editions,
  status,
  exists,
  sentAt,
  savedAt,
  sections: initialSections,
  includedArticleIds,
  input,
  truncated,
  loadError,
  snapshot,
  snapshotUnreadable,
  baseUrl,
  canCurate,
  now,
}: {
  week: Week;
  weeks: Week[];
  weekCounts: Record<string, number>;
  editions: EditionListItem[];
  status: "draft" | "sent";
  exists: boolean;
  sentAt: string | null;
  savedAt: string | null;
  sections: EditionSection[];
  includedArticleIds: string[] | null;
  /** Null for a sent edition — it renders from its snapshot and reads nothing. */
  input: EditionInput | null;
  truncated: boolean;
  loadError: string | null;
  snapshot: EditionSnapshot | null;
  snapshotUnreadable: boolean;
  baseUrl: string | null;
  canCurate: boolean;
  /** Server clock, so "in progress" does not depend on the viewer's laptop. */
  now: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const toast = useToast();
  const [navigating, startNavigation] = useTransition();

  const frozen = status === "sent";
  const editable = canCurate && !frozen;
  const rangeLabel = weekRangeLabel(week);
  const nowDate = useMemo(() => new Date(now), [now]);
  const running = isRunningWeek(week, nowDate);

  const [sections, setSections] = useState<EditionSection[]>(initialSections);
  const [included, setIncluded] = useState<string[] | null>(includedArticleIds);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [confirmSend, setConfirmSend] = useState(false);
  // Shut on arrival. The heading and count are visible either way, and the top
  // of the page is calmer for the job that is actually being done here.
  const [articlesOpen, setArticlesOpen] = useState(false);

  const busy = busyKey !== null;

  const edition: Edition | null = useMemo(() => {
    if (frozen) {
      return snapshot
        ? {
            generated: snapshot.generated,
            sections: snapshot.sections,
            blocks: snapshot.blocks ?? dataBlocks(snapshot.generated),
          }
        : null;
    }
    if (!input) return null;
    return buildEdition({ ...input, includedArticleIds: included }, sections);
  }, [frozen, snapshot, input, included, sections]);

  const html = useMemo(() => {
    if (frozen) return snapshot?.html ?? "";
    return edition ? renderEditionHtml(edition, { baseUrl }) : "";
  }, [frozen, snapshot, edition, baseUrl]);

  const droppedBlocks: BlockState[] = (edition?.blocks ?? []).filter(
    (b) => !b.present
  );
  const writtenCount = (edition?.sections ?? []).filter(hasBody).length;
  const nothingToSend =
    (edition?.blocks ?? []).every((b) => !b.present) && writtenCount === 0;

  function selectWeek(start: string) {
    const params = new URLSearchParams(searchParams.toString());
    params.set("week", start);
    startNavigation(() => router.push(`${pathname}?${params.toString()}`));
  }

  /** Every action follows the same shape: mark busy, act, report, refresh. */
  async function run<T extends { ok: boolean; error?: string }>(
    key: string,
    action: () => Promise<T>,
    onOk: (result: T) => void
  ) {
    setBusyKey(key);
    try {
      const result = await action();
      if (result.ok) {
        onOk(result);
        router.refresh();
      } else {
        toast.error(result.error ?? "That did not work.");
      }
    } finally {
      setBusyKey(null);
    }
  }

  async function generateAll() {
    await run("generate", () => generateEdition(week.start), (result) => {
      const kept = result.keptEdited ?? [];
      const wrote = result.written ?? [];
      // Saying what was SKIPPED matters as much as saying what was written. A
      // curator who presses the button, sees their edited headline unchanged
      // and is told nothing concludes the tool is broken.
      toast.success(
        [
          wrote.length
            ? `Wrote ${wrote.length} section${wrote.length === 1 ? "" : "s"}.`
            : "Nothing new was written.",
          kept.length
            ? `Left your edits alone in: ${kept.join(", ")}.`
            : null,
        ]
          .filter(Boolean)
          .join(" ")
      );
      router.refresh();
    });
  }

  async function regenerate(key: SectionKey) {
    await run(key, () => generateEdition(week.start, key), () => {
      toast.success("Section rewritten.");
    });
  }

  async function save(key: SectionKey, body: string) {
    await run(key, () => saveSection(week.start, key, body), () => {
      // Optimistic so the preview below updates on the same click rather than
      // after the round trip — the point of an in-place editor is seeing the
      // change land.
      setSections((current) => {
        const next = current.filter((s) => s.key !== key);
        const trimmed = body.trim();
        if (!trimmed) return next;
        const existing = current.find((s) => s.key === key);
        return [
          ...next,
          {
            key,
            title: existing?.title ?? SECTION_SLOTS.find((s) => s.key === key)!.title,
            body: trimmed,
            generated_at: existing?.generated_at ?? null,
            edited_at: new Date().toISOString(),
          },
        ].sort(
          (a, b) =>
            SECTION_SLOTS.findIndex((s) => s.key === a.key) -
            SECTION_SLOTS.findIndex((s) => s.key === b.key)
        );
      });
      toast.success("Saved.");
    });
  }

  async function saveArticles(next: string[]) {
    setIncluded(next);
    await run("articles", () => saveIncludedArticles(week.start, next), () => {});
  }

  async function send() {
    await run("send", () => sendEdition(week.start), () => {
      setConfirmSend(false);
      toast.success(`${rangeLabel} is final. Copy it out and paste it in.`);
    });
  }

  const statusByWeek = new Map(editions.map((e) => [e.weekStart, e.status]));

  return (
    <>
      <div className="panel-head">
        <div>
          <h1>Newsletter</h1>
          <p>
            The weekly <strong>Ocean Freight Update — AOA</strong>, Monday to
            Sunday. The AI writes each section from this week&apos;s figures and
            articles; edit anything you want to change. Nothing is emailed from
            here — you copy the finished newsletter out at the bottom.
          </p>
        </div>
        {/* Week, Generate and Send together in one bar. They are the three
            things you do to a whole edition; having them in three different
            places was most of why this screen read as three panels. */}
        <div className="composer-bar">
          <div className="composer-bar-row">
            <WeekSelect
              options={weeks.map((w) => {
                const count = weekCounts[w.start] ?? 0;
                const inProgress = isRunningWeek(w, nowDate);
                const state = statusByWeek.get(w.start);
                return {
                  week: w,
                  notes: [
                    inProgress ? "in progress" : null,
                    `${count} coded${inProgress ? " so far" : ""}`,
                    state === "sent" ? "sent" : state ? "draft" : null,
                  ],
                };
              })}
              value={week.start}
              disabled={navigating || busy}
              onChange={selectWeek}
            />
            {editable && (
              <>
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={busy}
                  onClick={generateAll}
                >
                  {busyKey === "generate" ? "Writing…" : "Generate newsletter"}
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-primary"
                  disabled={busy || nothingToSend}
                  title={
                    nothingToSend
                      ? "There is nothing in this newsletter yet."
                      : "Finish this newsletter and get it ready to copy out."
                  }
                  onClick={() => setConfirmSend(true)}
                >
                  Send
                </button>
              </>
            )}
          </div>
          {editable && (
            <div className="composer-bar-note">
              {savedAt
                ? `Last saved ${fullDayLabel(savedAt.slice(0, 10))}.`
                : exists
                  ? "Saved."
                  : "Nothing saved yet."}
            </div>
          )}
        </div>
      </div>

      {snapshotUnreadable && (
        <div className="notice notice-error">
          <div className="eyebrow">This newsletter cannot be shown</div>
          <p>
            The edition for {rangeLabel} was sent, but the copy we saved of it
            cannot be read. It is deliberately <strong>not</strong> rebuilt from
            today&apos;s data — that would quietly replace the record of what was
            actually sent. Someone will need to look at the stored row directly.
          </p>
        </div>
      )}

      {loadError && (
        <div className="notice notice-error">
          <div className="eyebrow">Could not load this week&apos;s articles</div>
          <p>{loadError}</p>
        </div>
      )}

      {frozen && (
        <div className="notice notice-frozen">
          <div className="eyebrow">Sent — final</div>
          <p>
            Sent{sentAt ? ` on ${fullDayLabel(sentAt.slice(0, 10))}` : ""}
            {snapshot?.sentByName ? ` by ${snapshot.sentByName}` : ""}. This is
            exactly what went out and it will not change. There is no un-send
            and no editing: a correction is a new newsletter that says so.
          </p>
        </div>
      )}

      {running && !frozen && (
        <div className="notice notice-warn">
          <div className="eyebrow">This week is still going</div>
          <p>
            {rangeLabel} has not finished yet, so the article count will keep
            rising until Sunday. The market figures are unaffected — those are
            the most recent day&apos;s readings, not weekly totals. You can still
            send it; see the warning when you do.
          </p>
        </div>
      )}

      {truncated && (
        <div className="notice notice-warn">
          <div className="eyebrow">Too many articles to show them all</div>
          <p>
            This week hit the limit on how many articles we load at once, so the
            list below is not the complete set.
          </p>
        </div>
      )}

      {droppedBlocks.length > 0 && (
        <div className="notice notice-warn">
          <div className="eyebrow">Left out of this newsletter</div>
          <ul className="dropped-list">
            {droppedBlocks.map((b) => (
              <li key={b.key}>
                <b>{b.title}</b> — {b.reason}
              </li>
            ))}
          </ul>
          <p className="cell-sub" style={{ marginTop: 8 }}>
            These are missing because there is no data behind them, not because
            anything is broken. The newsletter simply does not include them — no
            empty headings, no blank charts. This list is only shown here; it is
            not part of what you send.
          </p>
        </div>
      )}

      <div className="composer">
        {/* ---------------- Content ---------------- */}
        <div className="composer-col">
          <div className="composer-col-head">
            <div>
              <div className="eyebrow">Content</div>
              <p>
                Written by the AI from this week&apos;s figures and articles, and
                from nothing else. Edit anything you want to change — an edited
                section is never overwritten by Generate newsletter.
              </p>
            </div>
          </div>

          {SECTION_SLOTS.map((slot) => (
            <SectionCard
              key={slot.key}
              slot={slot}
              section={findSection(edition?.sections ?? sections, slot.key)}
              disabled={!editable}
              busy={busyKey === slot.key}
              onSave={(body) => save(slot.key, body)}
              onRegenerate={() => regenerate(slot.key)}
            />
          ))}
        </div>

        {/* ---------------- Preview ----------------
            Sticky, its own scroll. Deliberately NOT linked to the content
            column beyond showing the current text: no scroll syncing, no
            highlighting the section being edited. That kind of cleverness is
            what makes a simple screen confusing again. */}
        <div className="composer-preview">
          {html ? (
            <EditionPreview
              html={html}
              subject={frozen ? snapshot?.subject ?? subjectLine(week) : subjectLine(week)}
              filename={`ocean-freight-update-${week.isoLabel}.html`}
              frozen={frozen}
            />
          ) : (
            <div className="chart-card">
              <div className="chart-head">
                <div>
                  <h3>Preview</h3>
                  <p>Nothing to show yet.</p>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ---------------- Articles, full width ----------------
          A different job from writing: chosen once, then left alone. It does
          not earn a permanent third of the screen, so it sits underneath — and
          starts shut, with its heading and count visible either way so nobody
          has to open it to see it is not empty. */}
      <div className="articles-panel">
        <div className="articles-head">
          <div>
            <h2>
              Articles in this edition —{" "}
              <span className="articles-count">
                {edition?.generated.press.shown ?? 0} of{" "}
                {edition?.generated.press.candidates ?? 0}
              </span>
            </h2>
            <p>
              Every coded article published {rangeLabel}
              {running ? " so far" : ""}. Switch off anything that should not go
              out — the AI writes from whatever is switched on.
            </p>
          </div>
          <button
            type="button"
            className="btn btn-sm"
            aria-expanded={articlesOpen}
            onClick={() => setArticlesOpen((open) => !open)}
          >
            {articlesOpen ? "Hide articles" : "Show articles"}
          </button>
        </div>
        {articlesOpen && (
          <div className="articles-body">
            {frozen ? (
              <FrozenPress edition={edition} />
            ) : input ? (
              <PressPicker
                candidates={input.press}
                included={included}
                disabled={!editable || busy}
                onChange={saveArticles}
              />
            ) : null}
          </div>
        )}
      </div>

      {!canCurate && (
        <div className="panel-foot-note">
          You have read access. You can read any newsletter and copy out one that
          has been sent; writing and sending need the curate or admin role.
        </div>
      )}

      <ConfirmModal
        open={confirmSend}
        title={`Send the newsletter for ${rangeLabel}?`}
        confirmLabel="Send"
        busy={busy}
        body={
          <>
            {running && (
              <p style={{ marginBottom: 10, color: "var(--amber)" }}>
                <strong>This week isn&apos;t over yet.</strong> Once sent, this
                newsletter is final — you won&apos;t be able to send an updated
                one for {rangeLabel} later.
              </p>
            )}
            <p style={{ marginBottom: 10 }}>
              This saves exactly what you see in the preview and locks it. It
              will not change afterwards, and it cannot be edited or re-sent.
            </p>
            {droppedBlocks.length > 0 && (
              <p>
                <strong>Left out:</strong>{" "}
                {droppedBlocks.map((b) => b.title).join(", ")}.
              </p>
            )}
          </>
        }
        onConfirm={send}
        onCancel={() => setConfirmSend(false)}
      />
    </>
  );
}

/** A sent edition's article list, read back out of the saved copy. */
function FrozenPress({ edition }: { edition: Edition | null }) {
  if (!edition) return null;
  const { press } = edition.generated;

  return (
    <div>
      <div className="press-summary">
        <strong>{press.shown}</strong> of {press.candidates} sent
      </div>
      {press.themes
        .filter((t) => t.items.length > 0)
        .map((t) => (
          <div key={t.theme} className="press-theme">
            <div className="press-theme-head">
              <span>{t.theme}</span>
            </div>
            {t.items.map((item) => (
              <div key={item.id} className="press-item">
                <span>
                  <span className="press-headline">{item.headline}</span>
                  <span className="press-meta">
                    {item.media ?? "outlet not recorded"}
                  </span>
                </span>
              </div>
            ))}
          </div>
        ))}
    </div>
  );
}
