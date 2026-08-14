"use client";

import { useMemo } from "react";
import {
  allCandidatesByTheme,
  defaultIncludedIds,
  selectPress,
  PRESS_ITEMS_PER_THEME,
  type PressCandidate,
} from "@/lib/newsletter/press";
import { dayLabel } from "@/lib/newsletter/month";

/**
 * The press section's toggles.
 *
 * Shows EVERY candidate the month produced, grouped exactly as the edition
 * groups them, with three visible states: in the edition, toggled out, and held
 * back by the per-theme cap. A picker that showed only what will be sent would
 * make a cap and an empty month look the same, and would make an exclusion
 * indistinguishable from an article that was never captured.
 *
 * The cap applies AFTER exclusions, so toggling one of the five out promotes
 * the sixth rather than leaving a gap — which is why the held-back rows are
 * worth drawing at all.
 */
export function PressPicker({
  candidates,
  included,
  disabled,
  onChange,
}: {
  candidates: PressCandidate[];
  /** Null means nothing has been curated yet and every candidate is in. */
  included: string[] | null;
  disabled: boolean;
  onChange: (included: string[]) => void;
}) {
  const groups = useMemo(() => allCandidatesByTheme(candidates), [candidates]);
  const selection = useMemo(
    () => selectPress(candidates, included),
    [candidates, included]
  );

  const rendered = useMemo(
    () => new Set(selection.themes.flatMap((t) => t.items.map((i) => i.id))),
    [selection]
  );
  const suppressed = useMemo(
    () => new Set(selection.themes.flatMap((t) => t.nearDuplicates.map((i) => i.id))),
    [selection]
  );
  const kept = useMemo(
    () => (included === null ? null : new Set(included)),
    [included]
  );

  function toggle(id: string) {
    // The first toggle materialises the full set minus this one: until then the
    // selection is genuinely "not curated", which is a different state from
    // "everything happens to be ticked".
    const base = included ?? defaultIncludedIds(candidates);
    onChange(
      base.includes(id) ? base.filter((x) => x !== id) : [...base, id]
    );
  }

  const heldBack = selection.themes.reduce((n, t) => n + t.heldBack.length, 0);
  const excluded = selection.themes.reduce((n, t) => n + t.excluded.length, 0);
  const duplicates = selection.themes.reduce(
    (n, t) => n + t.nearDuplicates.length,
    0
  );

  if (candidates.length === 0) {
    return (
      <div className="press-empty">
        No article published in this month is both active and coded, so there is
        no press section to compose. The section will be left out of the edition
        entirely rather than sent as an empty heading.
      </div>
    );
  }

  return (
    <div>
      <div className="press-summary">
        <strong>{selection.shown}</strong> of {selection.candidates} in the
        edition
        {excluded > 0 && <> · {excluded} toggled out</>}
        {duplicates > 0 && <> · {duplicates} suppressed as near-duplicates</>}
        {heldBack > 0 && (
          <>
            {" "}
            · {heldBack} held back by the {PRESS_ITEMS_PER_THEME}-per-theme cap
          </>
        )}
      </div>

      {groups.map((group) => (
        <div key={group.theme} className="press-theme">
          <div className="press-theme-head">
            <span>{group.theme}</span>
            <span className="press-theme-count">
              {group.periodCount} article{group.periodCount === 1 ? "" : "s"}{" "}
              this month carry this theme
            </span>
          </div>

          {group.items.map((item) => {
            const isKept = kept === null || kept.has(item.id);
            const inEdition = rendered.has(item.id);
            return (
              <label
                key={item.id}
                className={`press-item${isKept ? "" : " press-item-out"}`}
              >
                <input
                  type="checkbox"
                  checked={isKept}
                  disabled={disabled}
                  onChange={() => toggle(item.id)}
                />
                <span>
                  <span className="press-headline">{item.headline}</span>
                  {item.summary && (
                    <span className="press-summary-line">{item.summary}</span>
                  )}
                  <span className="press-meta">
                    {/* No outlet is recorded for anything captured through a
                        keyword alert. Shown as an absence rather than as the
                        alert query the corpus actually holds. */}
                    {item.media ?? "outlet not recorded"}
                    {item.publishedAt && <> · {dayLabel(item.publishedAt)}</>}
                    {isKept && suppressed.has(item.id) && (
                      <span className="press-flag">
                        suppressed — near-duplicate of a story above
                      </span>
                    )}
                    {isKept && !inEdition && !suppressed.has(item.id) && (
                      <span className="press-flag">
                        held back — past the {PRESS_ITEMS_PER_THEME}-item cap
                      </span>
                    )}
                    {!isKept && (
                      <span className="press-flag">not in this edition</span>
                    )}
                  </span>
                </span>
              </label>
            );
          })}
        </div>
      ))}
    </div>
  );
}
