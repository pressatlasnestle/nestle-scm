"use client";

import { useState, useTransition } from "react";
import { useToast } from "@/components/Toast";
import { setUniverseMode, type UniverseMode } from "./actions";

const COPY: Record<UniverseMode, { title: string; blurb: string }> = {
  whole_universe: {
    title: "Whole Universe",
    blurb:
      "Every source is pulled except those tagged Negative. Positive-tagged sources are always included regardless of mode.",
  },
  positive_only: {
    title: "Positive Only",
    blurb:
      "Only sources tagged Positive are pulled. Neutral and Negative sources are skipped until you switch back to Whole Universe.",
  },
};

export function UniverseModeCard({
  initialMode,
  canEdit,
}: {
  initialMode: UniverseMode;
  canEdit: boolean;
}) {
  const [mode, setMode] = useState<UniverseMode>(initialMode);
  const [pending, startTransition] = useTransition();
  const toast = useToast();

  function choose(next: UniverseMode) {
    if (next === mode || pending || !canEdit) return;
    const prev = mode;
    setMode(next); // optimistic
    startTransition(async () => {
      const res = await setUniverseMode(next);
      if (!res.ok) {
        setMode(prev);
        toast.error(res.error);
      } else {
        toast.success(`Universe mode set to ${COPY[next].title}.`);
      }
    });
  }

  const copy = COPY[mode];

  return (
    <div className="mode-card">
      <div className="mode-card-left">
        <div className="eyebrow">Universe mode</div>
        <h3>{copy.title}</h3>
        <p>{copy.blurb}</p>
      </div>
      <div className={`toggle-group${pending ? " busy" : ""}`}>
        <button
          type="button"
          className={`toggle-opt${mode === "whole_universe" ? " selected" : ""}`}
          onClick={() => choose("whole_universe")}
          disabled={!canEdit || pending}
        >
          Whole Universe
        </button>
        <button
          type="button"
          className={`toggle-opt${mode === "positive_only" ? " selected" : ""}`}
          onClick={() => choose("positive_only")}
          disabled={!canEdit || pending}
        >
          Positive Only
        </button>
      </div>
    </div>
  );
}
