/**
 * The edition's written sections — one shape for all of them.
 *
 * Five bespoke authored fields became one ordered array of
 * `{ key, title, body, generated_at, edited_at }`, which is what lets there be
 * one generator, one editor, one save path and one renderer instead of five of
 * each. Adding or dropping a section is now a change to SLOTS below rather than
 * a migration.
 *
 * WHO WROTE IT IS THE WHOLE POINT OF THE TIMESTAMPS.
 *
 *   generated_at  the model wrote this body
 *   edited_at     a person wrote or rewrote it
 *
 * `edited_at` set is what makes a section untouchable by the next Generate.
 * That is not a nicety: a curator who watches their rewritten headline vanish
 * because they pressed a button twice stops trusting the tool, and this team
 * has no way to get the text back. Regenerating one section deliberately CLEARS
 * `edited_at`, because asking for a rewrite is asking to give up the edit — but
 * it is asked for one section at a time, in that section's own editor, never as
 * a side effect of a page-level button.
 */

import type { Json } from "@/types/database.types";

export type SectionKey =
  | "headline"
  | "regional"
  | "reliability"
  | "watch_list"
  | "actions";

export type EditionSection = {
  key: SectionKey;
  /** The reader-facing heading. Never an internal name. */
  title: string;
  body: string;
  /** ISO timestamp, or null if no model output stands here. */
  generated_at: string | null;
  /** ISO timestamp, or null if untouched by a person. */
  edited_at: string | null;
};

export type SectionSlot = {
  key: SectionKey;
  title: string;
  /**
   * Shown in the composer above the editor. Written for someone with no
   * media-measurement background: it says what belongs there, in the words they
   * would use themselves.
   */
  hint: string;
  /**
   * What the model is told this section is for. Kept beside the hint on
   * purpose — when the two drift apart, the curator is editing to one brief and
   * the model is writing to another.
   */
  brief: string;
  /**
   * Whether the section can be written at all from the data available. A
   * section whose supporting data is absent is never requested from the model
   * and never rendered.
   */
  needs: "articles" | "regional" | "reliability" | "any";
};

/**
 * The running order, and the whole definition of what an edition contains.
 *
 * `headline`, `watch_list` and `actions` render under their own headings.
 * `regional` and `reliability` are appended INSIDE their data sections, because
 * commentary that sits away from the chart it describes gets read as a separate
 * claim.
 */
export const SECTION_SLOTS: SectionSlot[] = [
  {
    key: "headline",
    title: "Headline read",
    hint: "The three or four sentences at the top. What someone needs to take from this week before they read anything else.",
    brief:
      "THE HEADLINE READ. 3-4 sentences opening the edition. Say what the week's figures and coverage actually show, naming the specific routes, ports, carriers and numbers in front of you. No advice, no forecast, no history.",
    needs: "any",
  },
  {
    key: "regional",
    title: "Regional commentary",
    hint: "Sits under the regional congestion chart. Which regions moved, and whether it changes anything for us.",
    brief:
      "REGIONAL COMMENTARY. 2-3 sentences under the regional congestion chart. Say which regions moved and by how much, using the figures given. Do not mention a region that has no figure.",
    needs: "regional",
  },
  {
    key: "reliability",
    title: "Reliability note",
    hint: "Sits under the schedule reliability chart. This figure is monthly and will read the same for several weeks — say whether it still means anything.",
    brief:
      "RELIABILITY NOTE. 2-3 sentences under the schedule reliability chart. These figures are MONTHLY and published in arrears, so they are the same in consecutive weekly editions. Say what the month's figure shows and, if it is unchanged, say so plainly rather than implying weekly movement.",
    needs: "reliability",
  },
  {
    key: "watch_list",
    title: "Watch list",
    hint: "What to keep an eye on, and over roughly what period. One line each.",
    brief:
      "WATCH LIST. One short line per item, each naming a risk that the week's own articles or figures actually raise, the lanes it touches, and roughly over what period. Two to four items. If the material raises none, return an empty body.",
    needs: "articles",
  },
  {
    key: "actions",
    title: "Recommended actions",
    hint: "What the desk should do about all of it, most important first. One line each.",
    brief:
      "RECOMMENDED ACTIONS. Two to four numbered lines, most important first, each a specific action that follows from something stated above. If nothing in the material supports an action, return an empty body — an invented recommendation is worse than none.",
    needs: "articles",
  },
];

export const SECTION_KEYS: SectionKey[] = SECTION_SLOTS.map((s) => s.key);

export function slotFor(key: SectionKey): SectionSlot | null {
  return SECTION_SLOTS.find((s) => s.key === key) ?? null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isoOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

/**
 * Reads the stored array back, tolerating anything that is not the shape we
 * wrote.
 *
 * Unrecognised keys are DROPPED rather than kept: the slot list is what defines
 * an edition, and a stray key would render nowhere while still counting as a
 * section in the composer. A malformed row therefore renders as a shorter
 * edition rather than a broken page — the same discipline parseStoredNarrative
 * follows, and for the same reason.
 *
 * Stored order is preserved. It is the order the sections were written in, and
 * for any future key not yet in SECTION_SLOTS it is the only order there is.
 */
export function parseSections(value: Json | null | undefined): EditionSection[] {
  if (!Array.isArray(value)) return [];

  const out: EditionSection[] = [];
  const seen = new Set<string>();

  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const row = entry as Record<string, unknown>;
    const key = text(row.key) as SectionKey;
    if (!SECTION_KEYS.includes(key) || seen.has(key)) continue;
    seen.add(key);

    const slot = slotFor(key)!;
    out.push({
      key,
      // The stored title wins so a renamed heading survives, but an absent one
      // falls back to the slot rather than rendering a section with no name.
      title: text(row.title) || slot.title,
      body: typeof row.body === "string" ? row.body : "",
      generated_at: isoOrNull(row.generated_at),
      edited_at: isoOrNull(row.edited_at),
    });
  }

  return out;
}

/** jsonb wants plain JSON, and the column is `not null default '[]'`. */
export function sectionsToJson(sections: EditionSection[]): Json {
  return sections.map((s) => ({
    key: s.key,
    title: s.title,
    body: s.body,
    generated_at: s.generated_at,
    edited_at: s.edited_at,
  })) as unknown as Json;
}

/** A section with nothing in it is not rendered anywhere. */
export function hasBody(section: EditionSection | null | undefined): boolean {
  return Boolean(section && section.body.trim().length > 0);
}

export function findSection(
  sections: EditionSection[],
  key: SectionKey
): EditionSection | null {
  return sections.find((s) => s.key === key) ?? null;
}

/** Only the sections that will actually render, in slot order. */
export function renderableSections(sections: EditionSection[]): EditionSection[] {
  const byKey = new Map(sections.map((s) => [s.key, s]));
  const ordered = SECTION_SLOTS.map((slot) => byKey.get(slot.key)).filter(
    (s): s is EditionSection => hasBody(s)
  );
  // Anything stored under a key not in SECTION_SLOTS keeps its stored position
  // at the end, so a section added to the array before it is added to the slot
  // list is still visible rather than silently discarded.
  const known = new Set(SECTION_SLOTS.map((s) => s.key));
  const extra = sections.filter((s) => !known.has(s.key) && hasBody(s));
  return [...ordered, ...extra];
}

export type SectionMerge = {
  sections: EditionSection[];
  /** Keys whose body was replaced by this generation. */
  written: SectionKey[];
  /** Keys left alone because a person had edited them. */
  keptEdited: SectionKey[];
  /** Keys the model returned empty, which are dropped rather than kept blank. */
  empty: SectionKey[];
};

/**
 * Folds a generation result into the sections already stored.
 *
 * THE RULE THIS EXISTS FOR: a section a person has edited is never overwritten
 * by the whole-edition Generate. It is returned in `keptEdited` so the caller
 * can say so out loud — silently skipping is nearly as bad as silently
 * overwriting, because the curator presses the button, sees no change, and
 * concludes the tool is broken.
 *
 * `force` is how "Regenerate this section" gets past that, and it is scoped to
 * the single key it was asked for.
 */
export function mergeGenerated(
  existing: EditionSection[],
  generated: Partial<Record<SectionKey, string>>,
  generatedAt: string,
  force: SectionKey | null = null
): SectionMerge {
  const byKey = new Map(existing.map((s) => [s.key, { ...s }]));
  const written: SectionKey[] = [];
  const keptEdited: SectionKey[] = [];
  const empty: SectionKey[] = [];

  for (const key of SECTION_KEYS) {
    if (!(key in generated)) continue;
    const body = (generated[key] ?? "").trim();
    const current = byKey.get(key);

    if (current?.edited_at && force !== key) {
      keptEdited.push(key);
      continue;
    }
    if (!body) {
      empty.push(key);
      // Dropped rather than stored blank: an empty body is the model's way of
      // saying the data does not support the section, and a stored empty string
      // would render as an absent section anyway while looking like a value.
      byKey.delete(key);
      continue;
    }

    byKey.set(key, {
      key,
      title: current?.title || slotFor(key)!.title,
      body,
      generated_at: generatedAt,
      // Regenerating a section is asking to give up the edit, so the mark goes.
      edited_at: null,
    });
    written.push(key);
  }

  // Rebuilt in slot order, which is the order the edition renders in — the
  // stored order and the rendered order should not be two different things.
  const ordered = SECTION_KEYS.map((k) => byKey.get(k)).filter(
    (s): s is EditionSection => Boolean(s)
  );
  const known = new Set<string>(SECTION_KEYS);
  const extra = existing.filter((s) => !known.has(s.key));

  return { sections: [...ordered, ...extra], written, keptEdited, empty };
}

/** Applies a person's edit to one section, stamping edited_at. */
export function applyEdit(
  existing: EditionSection[],
  key: SectionKey,
  body: string,
  editedAt: string
): EditionSection[] {
  const trimmed = body.trim();
  const byKey = new Map(existing.map((s) => [s.key, { ...s }]));
  const current = byKey.get(key);

  if (!trimmed) {
    // Clearing a section removes it. The curator deleting the text is the same
    // instruction as the model returning nothing, and it should have the same
    // result rather than leaving an empty heading behind.
    byKey.delete(key);
  } else {
    byKey.set(key, {
      key,
      title: current?.title || slotFor(key)!.title,
      body: trimmed,
      generated_at: current?.generated_at ?? null,
      edited_at: editedAt,
    });
  }

  const ordered = SECTION_KEYS.map((k) => byKey.get(k)).filter(
    (s): s is EditionSection => Boolean(s)
  );
  const known = new Set<string>(SECTION_KEYS);
  return [...ordered, ...existing.filter((s) => !known.has(s.key))];
}
