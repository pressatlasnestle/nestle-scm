"use client";

import { useEffect, useState } from "react";
import type { EditionSection, SectionSlot } from "@/lib/newsletter/sections";

/**
 * Roughly how many characters fit on one line of the editor at the column width
 * the composer uses. Approximate on purpose — it only has to be close enough
 * that the box opens showing all of its text.
 */
const CHARS_PER_LINE = 66;

/**
 * Tall enough to show the whole section without scrolling.
 *
 * Counting newlines is not enough: a headline read is two paragraphs and three
 * newline-delimited lines, but about eight WRAPPED ones, so a newline count
 * opened a five-row box over text that needed eight and the curator had to
 * scroll inside a small window to read what they were editing. Capped at 20 so
 * an unusually long section does not push the Save button off the screen.
 */
function rowsFor(text: string): number {
  const wrapped = text
    .split("\n")
    .reduce((n, line) => n + Math.max(1, Math.ceil(line.length / CHARS_PER_LINE)), 0);
  return Math.min(20, Math.max(5, wrapped + 1));
}

/**
 * One written section, read mode and edit mode.
 *
 * ONE card for every section, because there is now one section shape. Click
 * Edit, the text becomes a plain box with Save and Cancel. No modal, no
 * rich-text toolbar, no markdown to learn — the people using this do not work
 * in this field and should not have to learn a syntax to change a sentence.
 *
 * The line under the title says who wrote what is on screen. That is not
 * decoration: "edited by you" is exactly the state that Generate newsletter
 * will leave alone, and the curator needs to be able to see that without
 * pressing anything.
 */
export function SectionCard({
  slot,
  section,
  disabled,
  busy,
  onSave,
  onRegenerate,
}: {
  slot: SectionSlot;
  section: EditionSection | null;
  disabled: boolean;
  /** True while any action on this card is in flight. */
  busy: boolean;
  onSave: (body: string) => Promise<void>;
  onRegenerate: () => Promise<void>;
}) {
  const body = section?.body ?? "";
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(body);

  // Re-seeded whenever the stored text changes underneath — a regenerate lands
  // while the card is closed, and reopening must show the new text rather than
  // whatever was in the box last time.
  useEffect(() => {
    if (!editing) setDraft(body);
  }, [body, editing]);

  const edited = Boolean(section?.edited_at);
  const written = Boolean(section?.generated_at);

  /**
   * Kept to two or three words on purpose.
   *
   * It sits opposite the buttons on one line, and the longer version — "Edited
   * by you, Generate newsletter will leave this alone" — wrapped at the column
   * width and pushed the buttons onto a second row, so the edited card was
   * visibly a different shape from every other card. The explanation is worth
   * saying, so it says itself under the hint instead, where it has a full line.
   */
  const provenance = edited
    ? "Edited by you"
    : written
      ? "Written by AI"
      : "Not written yet";

  return (
    <div className="section-card">
      <div className="section-card-head">
        <div>
          <div className="authored-label" style={{ marginBottom: 3 }}>
            {slot.title}
          </div>
          <div className={`section-provenance${edited ? " edited" : ""}`}>
            {provenance}
          </div>
        </div>
        {!editing && (
          <div className="section-card-actions">
            <button
              type="button"
              className="btn btn-sm"
              disabled={disabled || busy}
              onClick={() => {
                setDraft(body);
                setEditing(true);
              }}
            >
              Edit
            </button>
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              disabled={disabled || busy}
              title="Ask the AI to write this section again from this week's data. Only this section changes."
              onClick={onRegenerate}
            >
              {busy ? "Writing…" : "Regenerate this section"}
            </button>
          </div>
        )}
      </div>

      <div className="authored-hint">
        {slot.hint}
        {edited && (
          <span className="section-protected">
            {" "}
            Generate newsletter will leave this exactly as you wrote it.
          </span>
        )}
      </div>

      {editing ? (
        <>
          <textarea
            className="authored-input"
            rows={rowsFor(draft)}
            value={draft}
            disabled={busy}
            autoFocus
            placeholder="Type the text for this section. Leave it empty to remove the section from the newsletter."
            onChange={(e) => setDraft(e.target.value)}
          />
          <div className="section-card-actions" style={{ marginTop: 9 }}>
            <button
              type="button"
              className="btn btn-sm btn-primary"
              disabled={busy}
              onClick={async () => {
                await onSave(draft);
                setEditing(false);
              }}
            >
              {busy ? "Saving…" : "Save"}
            </button>
            <button
              type="button"
              className="btn btn-sm"
              disabled={busy}
              onClick={() => {
                setDraft(body);
                setEditing(false);
              }}
            >
              Cancel
            </button>
          </div>
        </>
      ) : body ? (
        <div className="section-body">{body}</div>
      ) : (
        <div className="section-empty">
          Nothing here yet. Press <b>Generate newsletter</b> above, or press{" "}
          <b>Edit</b> to write it yourself. If it stays empty it is simply left
          out of the newsletter.
        </div>
      )}
    </div>
  );
}
