"use client";

import { useEffect, useMemo, useRef, useState } from "react";

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
 * substring match would put "Puget Sound/BC (Bellingham)" above "Barcelona"
 * for "b", which is not what a person scanning an alphabetical list expects.
 * A secondary contains-match is appended after the prefix hits so a search for
 * "Ningbo" still finds "Shanghai/Ningbo" — compound names are exactly where
 * prefix-only would fail.
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
  const wrapRef = useRef<HTMLDivElement>(null);

  // Follows the committed value when it changes from outside (carry-forward
  // prefills the whole row at once).
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

  // Closing on an outside click rather than on blur alone: blur fires before
  // the click lands on an option, which would cancel the selection.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) {
        setOpen(false);
        setQuery(value);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open, value]);

  const commit = (name: string) => {
    onChange(name);
    setQuery(name);
    setOpen(false);
  };

  return (
    <div ref={wrapRef} style={{ position: "relative" }}>
      <input
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
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setOpen(true);
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
      {open && matches.length > 0 && (
        <ul className="grid-port-list" role="listbox">
          {matches.map((name, i) => (
            <li
              key={name}
              role="option"
              aria-selected={i === highlight}
              className={i === highlight ? "highlighted" : undefined}
              onMouseEnter={() => setHighlight(i)}
              onMouseDown={(e) => {
                // mousedown, not click: the input blurs on mousedown and the
                // outside-click handler would otherwise close the list first.
                e.preventDefault();
                commit(name);
              }}
            >
              {name}
            </li>
          ))}
        </ul>
      )}
      {open && matches.length === 0 && (
        <ul className="grid-port-list">
          <li className="empty">No port matches “{query}”.</li>
        </ul>
      )}
    </div>
  );
}
