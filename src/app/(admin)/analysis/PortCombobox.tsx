"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

/**
 * Typeahead over the 180-name port vocabulary.
 *
 * NEVER PERMITS A FREE-TEXT VALUE. The input is a filter, not a field: on blur
 * or Escape it reverts to the last valid selection, and only a click or Enter
 * on a listed option commits. A name outside `ports` would be refused by the
 * foreign key anyway, but failing at save time — after a whole week has been
 * typed — is a bad way to learn it.
 *
 * Filters on PREFIX, matching how someone reaching for "Rotterdam" types. A
 * secondary contains-match is appended after the prefix hits so a search for
 * "Ningbo" still finds "Shanghai/Ningbo" — compound names are exactly where
 * prefix-only would fail.
 *
 * THE LIST IS RENDERED IN A PORTAL, and that is not a style choice.
 *
 * This combobox sits inside the entry grid's scroll container, which carries
 * `overflow: auto` so 42 metric rows can scroll. An absolutely-positioned
 * descendant of an overflowing box is CLIPPED BY THAT BOX, and no z-index
 * escapes a clip — z-index orders painting, it does not defeat overflow. The
 * first version rendered the list in place and it came out shredded: a sliver
 * of its own scrollbar visible and the options themselves cut off behind the
 * grid cells.
 *
 * So the list is portalled to document.body and positioned `fixed` against the
 * input's viewport rect, which puts it outside every ancestor's clip and
 * stacking context. The rect is recomputed on scroll and resize, because a
 * fixed element does not follow an input that scrolls away underneath it.
 */
export function PortCombobox({
  value,
  ports,
  onChange,
  disabled,
}: {
  value: string;
  ports: string[];
  onChange: (name: string) => void;
  disabled?: boolean;
}) {
  const [query, setQuery] = useState(value);
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const [rect, setRect] = useState<{ left: number; top: number; width: number } | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  // Follows the committed value when it changes from outside (carry-forward
  // prefills every slot at once).
  useEffect(() => setQuery(value), [value]);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return ports.slice(0, 40);
    const prefix = ports.filter((p) => p.toLowerCase().startsWith(q));
    const contains = ports.filter(
      (p) => !p.toLowerCase().startsWith(q) && p.toLowerCase().includes(q)
    );
    return [...prefix, ...contains].slice(0, 40);
  }, [query, ports]);

  useEffect(() => setHighlight(0), [query]);

  /** Viewport position of the input, which the fixed list anchors to. */
  const measure = useCallback(() => {
    const el = inputRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setRect({ left: r.left, top: r.bottom + 3, width: Math.max(r.width, 260) });
  }, []);

  useEffect(() => {
    if (!open) return;
    measure();
    // `true` for capture: the grid's own scroll container does not bubble its
    // scroll event, and that is precisely the one that moves this input.
    window.addEventListener("scroll", measure, true);
    window.addEventListener("resize", measure);
    return () => {
      window.removeEventListener("scroll", measure, true);
      window.removeEventListener("resize", measure);
    };
  }, [open, measure]);

  // Closing on an outside click rather than on blur alone: blur fires before
  // the click lands on an option, which would cancel the selection. The list
  // is portalled, so it is not inside the input's subtree and has to be
  // checked separately.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (inputRef.current?.contains(target) || listRef.current?.contains(target)) return;
      setOpen(false);
      setQuery(value);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open, value]);

  const commit = (name: string) => {
    onChange(name);
    setQuery(name);
    setOpen(false);
  };

  const list =
    open && rect
      ? createPortal(
          <ul
            ref={listRef}
            className="grid-port-list"
            role="listbox"
            style={{ left: rect.left, top: rect.top, width: rect.width }}
          >
            {matches.length === 0 ? (
              <li className="empty">No port matches “{query}”.</li>
            ) : (
              matches.map((name, i) => (
                <li
                  key={name}
                  role="option"
                  aria-selected={i === highlight}
                  className={i === highlight ? "highlighted" : undefined}
                  onMouseEnter={() => setHighlight(i)}
                  onMouseDown={(e) => {
                    // mousedown, not click: the input blurs on mousedown and
                    // the outside handler would otherwise close the list first.
                    e.preventDefault();
                    commit(name);
                  }}
                >
                  {name}
                </li>
              ))
            )}
          </ul>,
          document.body
        )
      : null;

  return (
    <>
      <input
        ref={inputRef}
        className="grid-port-input"
        value={query}
        disabled={disabled}
        placeholder="Select port…"
        aria-label="Port"
        role="combobox"
        aria-expanded={open}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
          measure();
        }}
        onFocus={() => {
          setOpen(true);
          measure();
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setOpen(true);
            measure();
            setHighlight((h) => Math.min(h + 1, matches.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setHighlight((h) => Math.max(h - 1, 0));
          } else if (e.key === "Enter") {
            e.preventDefault();
            if (open && matches[highlight]) commit(matches[highlight]);
          } else if (e.key === "Escape") {
            e.preventDefault();
            setOpen(false);
            setQuery(value);
          } else if (e.key === "Tab") {
            // Leaving without choosing reverts. A half-typed filter is not a
            // value, and letting it look like one would fail at save.
            setOpen(false);
            setQuery(value);
          }
        }}
      />
      {list}
    </>
  );
}
