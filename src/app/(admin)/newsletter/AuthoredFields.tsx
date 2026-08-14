"use client";

import type { WatchListEntry } from "@/lib/newsletter/edition";

/**
 * The authored half of an edition.
 *
 * NOTHING HERE IS EVER PREFILLED FROM ANYTHING GENERATED. There is no
 * "suggested" paragraph assembled from the figures for the curator to lightly
 * edit, and that absence is the design rather than a gap in it: a prefilled
 * draft reliably becomes the shipped text, and this commentary is the one part
 * of the edition carrying judgement about Nestlé's lanes. An empty box and a
 * placeholder saying what belongs in it is the whole intervention.
 *
 * A field left empty drops its section from the edition entirely. That is said
 * next to the field rather than discovered at the preview.
 */

export function AuthoredTextarea({
  label,
  hint,
  placeholder,
  rows,
  value,
  disabled,
  onChange,
}: {
  label: string;
  hint: string;
  placeholder: string;
  rows: number;
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <div className="authored-field">
      <div className="authored-label">{label}</div>
      <div className="authored-hint">{hint}</div>
      <textarea
        className="authored-input"
        rows={rows}
        value={value}
        disabled={disabled}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
      <div className="authored-foot">
        {value.trim().length === 0
          ? "Empty — this section will be left out of the edition."
          : `${value.trim().length} characters`}
      </div>
    </div>
  );
}

const WATCH_FIELDS: {
  key: keyof WatchListEntry;
  label: string;
  placeholder: string;
}[] = [
  { key: "risk", label: "Risk", placeholder: "What could go wrong" },
  { key: "lanes", label: "Lanes", placeholder: "Which corridors it touches" },
  { key: "window", label: "Window", placeholder: "Over what horizon" },
  {
    key: "direction",
    label: "Direction",
    placeholder: "Which way it is trending, and what would confirm it",
  },
];

const BLANK_WATCH: WatchListEntry = {
  risk: "",
  lanes: "",
  window: "",
  direction: "",
};

export function WatchListEditor({
  entries,
  disabled,
  onChange,
}: {
  entries: WatchListEntry[];
  disabled: boolean;
  onChange: (entries: WatchListEntry[]) => void;
}) {
  function update(index: number, key: keyof WatchListEntry, value: string) {
    onChange(entries.map((e, i) => (i === index ? { ...e, [key]: value } : e)));
  }

  return (
    <div className="authored-field">
      <div className="authored-label">Watch list</div>
      <div className="authored-hint">
        What the desk is watching and over what horizon. One entry per risk — a
        row left entirely blank is dropped on save rather than sent as an empty
        card.
      </div>

      {entries.map((entry, index) => (
        <div key={index} className="watch-row">
          <div className="watch-row-head">
            <span className="watch-row-index">{index + 1}</span>
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              disabled={disabled}
              onClick={() => onChange(entries.filter((_, i) => i !== index))}
            >
              Remove
            </button>
          </div>
          {WATCH_FIELDS.map((field) => (
            <label key={field.key} className="watch-field">
              <span>{field.label}</span>
              <input
                className="authored-input"
                value={entry[field.key]}
                disabled={disabled}
                placeholder={field.placeholder}
                onChange={(e) => update(index, field.key, e.target.value)}
              />
            </label>
          ))}
        </div>
      ))}

      <button
        type="button"
        className="btn btn-sm"
        disabled={disabled}
        onClick={() => onChange([...entries, { ...BLANK_WATCH }])}
      >
        + Add a risk
      </button>

      {entries.length === 0 && (
        <div className="authored-foot">
          Empty — the watch list will be left out of the edition.
        </div>
      )}
    </div>
  );
}

export function ActionsEditor({
  actions,
  disabled,
  onChange,
}: {
  actions: string[];
  disabled: boolean;
  onChange: (actions: string[]) => void;
}) {
  function move(index: number, by: number) {
    const target = index + by;
    if (target < 0 || target >= actions.length) return;
    const next = actions.slice();
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
  }

  return (
    <div className="authored-field">
      <div className="authored-label">Recommended actions</div>
      <div className="authored-hint">
        What the desk should do about all of the above. The order is the
        priority and is sent exactly as arranged here.
      </div>

      {actions.map((action, index) => (
        <div key={index} className="action-row">
          <span className="action-index">{index + 1}.</span>
          <input
            className="authored-input"
            value={action}
            disabled={disabled}
            placeholder="One action — specific enough to be picked up"
            onChange={(e) =>
              onChange(actions.map((a, i) => (i === index ? e.target.value : a)))
            }
          />
          <div className="action-controls">
            <button
              type="button"
              className="icon-btn"
              title="Move up"
              disabled={disabled || index === 0}
              onClick={() => move(index, -1)}
            >
              ↑
            </button>
            <button
              type="button"
              className="icon-btn"
              title="Move down"
              disabled={disabled || index === actions.length - 1}
              onClick={() => move(index, 1)}
            >
              ↓
            </button>
            <button
              type="button"
              className="icon-btn"
              title="Remove"
              disabled={disabled}
              onClick={() => onChange(actions.filter((_, i) => i !== index))}
            >
              ✕
            </button>
          </div>
        </div>
      ))}

      <button
        type="button"
        className="btn btn-sm"
        disabled={disabled}
        onClick={() => onChange([...actions, ""])}
      >
        + Add an action
      </button>

      {actions.length === 0 && (
        <div className="authored-foot">
          Empty — recommended actions will be left out of the edition.
        </div>
      )}
    </div>
  );
}
