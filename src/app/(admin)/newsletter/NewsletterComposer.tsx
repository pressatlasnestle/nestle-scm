"use client";

import { useMemo, useState, useTransition, type CSSProperties } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useToast } from "@/components/Toast";
import { ConfirmModal } from "@/components/ConfirmModal";
import {
  buildGenerated,
  sectionStates,
  subjectLine,
  type Authored,
  type Edition,
  type EditionInput,
  type SectionState,
  type WatchListEntry,
} from "@/lib/newsletter/edition";
import { renderEditionHtml } from "@/lib/newsletter/email";
import type { EditionSnapshot } from "@/lib/newsletter/snapshot";
import { fullDayLabel, weekRangeLabel, type Week } from "@/lib/newsletter/week";
import { saveEdition, sendEdition } from "./actions";
import { ActionsEditor, AuthoredTextarea, WatchListEditor } from "./AuthoredFields";
import { PressPicker } from "./PressPicker";
import { EditionPreview } from "./EditionPreview";

export type EditionListItem = {
  weekStart: string;
  status: string;
  sentAt: string | null;
};

const selectStyle: CSSProperties = {
  background: "var(--panel-raised)",
  border: "1px solid var(--line)",
  borderRadius: 7,
  padding: "8px 11px",
  fontSize: 12.5,
  color: "var(--text)",
  fontFamily: "var(--font-body)",
};

/**
 * The composer.
 *
 * TWO HALVES THAT NEVER BLEND, and the layout says so: everything on the left
 * is typed by a person, everything on the right is read from the database and
 * recomputed on every keystroke. No authored box is ever seeded from a
 * generated value.
 *
 * The preview recomputes in the browser from the same buildGenerated() the send
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
  authored: initialAuthored,
  includedArticleIds,
  input,
  truncated,
  loadError,
  snapshot,
  snapshotUnreadable,
  baseUrl,
  canCurate,
}: {
  week: Week;
  weeks: Week[];
  /** ISO Monday → coded-article count, so a thin week is visible unopened. */
  weekCounts: Record<string, number>;
  editions: EditionListItem[];
  status: "draft" | "sent";
  exists: boolean;
  sentAt: string | null;
  savedAt: string | null;
  authored: Authored;
  includedArticleIds: string[] | null;
  /** Null for a sent edition — it renders from its snapshot and reads nothing. */
  input: EditionInput | null;
  truncated: boolean;
  loadError: string | null;
  snapshot: EditionSnapshot | null;
  snapshotUnreadable: boolean;
  baseUrl: string | null;
  canCurate: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const toast = useToast();
  const [navigating, startNavigation] = useTransition();

  const frozen = status === "sent";
  const editable = canCurate && !frozen;
  const rangeLabel = weekRangeLabel(week);

  const [headlineRead, setHeadlineRead] = useState(initialAuthored.headlineRead);
  const [regionalCommentary, setRegionalCommentary] = useState(
    initialAuthored.regionalCommentary
  );
  const [reliabilityNote, setReliabilityNote] = useState(
    initialAuthored.reliabilityNote
  );
  const [watchList, setWatchList] = useState<WatchListEntry[]>(
    initialAuthored.watchList
  );
  const [actions, setActions] = useState<string[]>(
    initialAuthored.recommendedActions
  );
  const [included, setIncluded] = useState<string[] | null>(includedArticleIds);

  const [busy, setBusy] = useState(false);
  const [confirmSend, setConfirmSend] = useState(false);

  const authored: Authored = useMemo(
    () => ({
      headlineRead,
      regionalCommentary,
      reliabilityNote,
      watchList,
      recommendedActions: actions,
    }),
    [headlineRead, regionalCommentary, reliabilityNote, watchList, actions]
  );

  /**
   * The live edition.
   *
   * A sent edition is NOT rebuilt — it reads its snapshot and nothing else. A
   * fallback that recomputed when the snapshot could not be parsed would be the
   * silent change the freeze exists to prevent, so an unreadable snapshot says
   * so instead.
   */
  const edition: Edition | null = useMemo(() => {
    if (frozen) {
      return snapshot
        ? {
            generated: snapshot.generated,
            authored: snapshot.authored,
            sections: snapshot.sections,
          }
        : null;
    }
    if (!input) return null;
    const generated = buildGenerated({ ...input, includedArticleIds: included });
    return { generated, authored, sections: sectionStates(generated, authored) };
  }, [frozen, snapshot, input, included, authored]);

  const html = useMemo(() => {
    if (frozen) return snapshot?.html ?? "";
    return edition ? renderEditionHtml(edition, { baseUrl }) : "";
  }, [frozen, snapshot, edition, baseUrl]);

  const dropped: SectionState[] = (edition?.sections ?? []).filter(
    (s) => !s.present
  );
  const nothingToSend = (edition?.sections ?? []).every((s) => !s.present);

  function selectWeek(start: string) {
    const params = new URLSearchParams(searchParams.toString());
    params.set("week", start);
    startNavigation(() => router.push(`${pathname}?${params.toString()}`));
  }

  function draftPayload() {
    return {
      weekStart: week.start,
      headlineRead,
      regionalCommentary,
      reliabilityNote,
      watchList,
      recommendedActions: actions,
      includedArticleIds: included,
    };
  }

  async function save() {
    setBusy(true);
    try {
      const result = await saveEdition(draftPayload());
      if (result.ok) {
        toast.success(`Draft for ${rangeLabel} saved.`);
        router.refresh();
      } else {
        toast.error(result.error);
      }
    } finally {
      setBusy(false);
    }
  }

  async function send() {
    setBusy(true);
    try {
      const result = await sendEdition(draftPayload());
      if (result.ok) {
        setConfirmSend(false);
        toast.success(`${rangeLabel} is frozen. Copy it out and paste it in.`);
        router.refresh();
      } else {
        toast.error(result.error);
      }
    } finally {
      setBusy(false);
    }
  }

  const statusByWeek = new Map(editions.map((e) => [e.weekStart, e.status]));

  return (
    <>
      <div className="panel-head">
        <div>
          <h1>Newsletter</h1>
          <p>
            The weekly <strong>Ocean Freight Update — AOA</strong>, Monday to
            Sunday inclusive. Everything on the right is read from the database
            and recomputed as you work; everything on the left is yours to
            write. Sending freezes the edition and exports it — nothing is
            mailed from here.
          </p>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <select
            style={selectStyle}
            aria-label="Week"
            value={week.start}
            disabled={navigating || busy}
            onChange={(e) => selectWeek(e.target.value)}
          >
            {weeks.map((w) => {
              const state = statusByWeek.get(w.start);
              // The coded count is in the option itself so a quiet week is
              // visible before it is opened rather than after.
              const count = weekCounts[w.start] ?? 0;
              return (
                <option key={w.start} value={w.start}>
                  {weekRangeLabel(w)} · {count} coded
                  {state === "sent" ? " · sent" : state ? " · draft" : ""}
                </option>
              );
            })}
          </select>
        </div>
      </div>

      {snapshotUnreadable && (
        <div className="notice notice-error">
          <div className="eyebrow">This edition cannot be rendered</div>
          <p>
            The edition for {rangeLabel} is marked sent but its snapshot could
            not be read. It is deliberately <strong>not</strong> recomputed from
            today&apos;s data — that would silently replace the record of what
            was actually sent. The stored row needs looking at directly.
          </p>
        </div>
      )}

      {loadError && (
        <div className="notice notice-error">
          <div className="eyebrow">Could not load the week&apos;s coverage</div>
          <p>{loadError}</p>
        </div>
      )}

      {frozen && (
        <div className="notice notice-frozen">
          <div className="eyebrow">Sent — frozen</div>
          <p>
            Sent{sentAt ? ` on ${fullDayLabel(sentAt.slice(0, 10))}` : ""}
            {snapshot?.sentByName ? ` by ${snapshot.sentByName}` : ""}. Every
            figure below is the one that went out and will not move again. There
            is no un-send and no edit: a correction is a new edition that says
            it is one.
          </p>
        </div>
      )}

      {truncated && (
        <div className="notice notice-warn">
          <div className="eyebrow">Partial week</div>
          <p>
            This week hit the per-week row ceiling, so the press candidates below
            are not the complete set.
          </p>
        </div>
      )}

      <div className="composer">
        {/* ---------------- Authored ---------------- */}
        <div className="composer-col">
          <div className="composer-col-head">
            <div className="eyebrow">Written by you</div>
            <p>
              Nothing here is drafted for you. These are the parts of the
              edition that carry judgement about our lanes, and a suggested
              paragraph is a shipped paragraph.
            </p>
          </div>

          {frozen ? (
            <FrozenAuthored authored={edition?.authored ?? initialAuthored} />
          ) : (
            <>
              <AuthoredTextarea
                label="Headline read"
                hint="Three or four sentences. What a cargo owner needs to take from this week before reading anything else."
                placeholder="The read on the week — not a summary of the figures below, but what they mean for us."
                rows={5}
                value={headlineRead}
                disabled={!editable || busy}
                onChange={setHeadlineRead}
              />

              <AuthoredTextarea
                label="Regional commentary"
                hint="Sits under the regional congestion chart. Which corridors moved, and whether it changes anything for the desk."
                placeholder="What the regional picture means for our lanes this week."
                rows={4}
                value={regionalCommentary}
                disabled={!editable || busy}
                onChange={setRegionalCommentary}
              />

              <AuthoredTextarea
                label="Reliability note"
                hint="Sits under the schedule reliability chart. That figure is monthly and in arrears, so it will read the same for several weeks running — this is where you say whether it still means anything."
                placeholder="How reliability is behaving on the lanes that matter, and what buffer it implies."
                rows={4}
                value={reliabilityNote}
                disabled={!editable || busy}
                onChange={setReliabilityNote}
              />

              <WatchListEditor
                entries={watchList}
                disabled={!editable || busy}
                onChange={setWatchList}
              />

              <ActionsEditor
                actions={actions}
                disabled={!editable || busy}
                onChange={setActions}
              />
            </>
          )}
        </div>

        {/* ---------------- Generated ---------------- */}
        <div className="composer-col">
          <div className="composer-col-head">
            <div className="eyebrow">Read from the data</div>
            <p>
              Figures are levels on the most recent day entered in the week,
              compared against the most recent day of the week before. Nothing
              here is summed or averaged over the week, and nothing absent is
              shown as zero. Schedule reliability is monthly and compared
              against the previous month — the section says so.
            </p>
          </div>

          {dropped.length > 0 && (
            <div className="notice notice-warn">
              <div className="eyebrow">
                {dropped.length} section{dropped.length === 1 ? "" : "s"} will be
                left out
              </div>
              <ul className="dropped-list">
                {dropped.map((s) => (
                  <li key={s.key}>
                    <b>{s.title}</b> — {s.reason}
                  </li>
                ))}
              </ul>
              <p className="cell-sub" style={{ marginTop: 8 }}>
                A section with no data is omitted from the edition entirely — no
                empty heading, no zero-fill, no &ldquo;not available&rdquo; row.
              </p>
            </div>
          )}

          <div className="composer-block">
            <div className="authored-label">What moved in the press</div>
            <div className="authored-hint">
              Every coded article published {rangeLabel}, Monday to Sunday
              inclusive. Themes run busiest first and stories newest first within
              a theme; an article carrying several themes appears once, under its
              busiest. Toggle out anything that should not go.
            </div>
            {frozen ? (
              <FrozenPress edition={edition} />
            ) : input ? (
              <PressPicker
                candidates={input.press}
                included={included}
                disabled={!editable || busy}
                onChange={setIncluded}
              />
            ) : null}
          </div>
        </div>
      </div>

      {html && (
        <div style={{ marginTop: 20 }}>
          <EditionPreview
            html={html}
            subject={frozen ? snapshot?.subject ?? subjectLine(week) : subjectLine(week)}
            filename={`ocean-freight-update-${week.isoLabel}.html`}
            frozen={frozen}
          />
        </div>
      )}

      {editable && (
        <div className="composer-actions">
          <div className="cell-sub">
            {savedAt
              ? `Draft last saved ${fullDayLabel(savedAt.slice(0, 10))}.`
              : exists
                ? "Draft saved."
                : "Not saved yet."}
          </div>
          <div style={{ display: "flex", gap: 10 }}>
            <button
              type="button"
              className="btn btn-sm"
              disabled={busy}
              onClick={save}
            >
              {busy ? "Saving…" : "Save draft"}
            </button>
            <button
              type="button"
              className="btn btn-sm btn-primary"
              disabled={busy || nothingToSend}
              title={
                nothingToSend
                  ? "Nothing authored and no figures entered — there is nothing to freeze."
                  : "Freeze this edition and export it."
              }
              onClick={() => setConfirmSend(true)}
            >
              Freeze &amp; send
            </button>
          </div>
        </div>
      )}

      {!canCurate && (
        <div className="panel-foot-note">
          You have read access. You can read every edition and export a sent one;
          composing and sending need the curate or admin role.
        </div>
      )}

      <ConfirmModal
        open={confirmSend}
        title={`Send the edition for ${rangeLabel}?`}
        confirmLabel="Freeze and send"
        busy={busy}
        body={
          <>
            <p style={{ marginBottom: 10 }}>
              This writes every figure currently on screen into the edition and
              <strong> freezes it permanently</strong>. A sent edition is the
              record of what the client received: it will never recompute, and
              the database refuses any later edit.
            </p>
            <p style={{ marginBottom: 10 }}>
              There is no un-send. If a correction is needed afterwards, it is a
              new edition that says so.
            </p>
            {dropped.length > 0 && (
              <p>
                <strong>
                  {dropped.length} section{dropped.length === 1 ? "" : "s"} will
                  be left out:
                </strong>{" "}
                {dropped.map((s) => s.title).join(", ")}.
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

/** A sent edition's authored text, read-only, from the snapshot. */
function FrozenAuthored({ authored }: { authored: Authored }) {
  const blocks: [string, string][] = [
    ["Headline read", authored.headlineRead],
    ["Regional commentary", authored.regionalCommentary],
    ["Reliability note", authored.reliabilityNote],
  ];

  return (
    <>
      {blocks
        .filter(([, value]) => value)
        .map(([label, value]) => (
          <div key={label} className="authored-field">
            <div className="authored-label">{label}</div>
            <div className="frozen-text">{value}</div>
          </div>
        ))}

      {authored.watchList.length > 0 && (
        <div className="authored-field">
          <div className="authored-label">Watch list</div>
          {authored.watchList.map((w, i) => (
            <div key={i} className="watch-row">
              <div className="frozen-text">
                <b>{w.risk}</b>
                {w.lanes && <div>Lanes — {w.lanes}</div>}
                {w.window && <div>Window — {w.window}</div>}
                {w.direction && <div>Direction — {w.direction}</div>}
              </div>
            </div>
          ))}
        </div>
      )}

      {authored.recommendedActions.length > 0 && (
        <div className="authored-field">
          <div className="authored-label">Recommended actions</div>
          <ol className="frozen-actions">
            {authored.recommendedActions.map((a, i) => (
              <li key={i}>{a}</li>
            ))}
          </ol>
        </div>
      )}
    </>
  );
}

/** A sent edition's press selection, read back out of the snapshot. */
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
