/**
 * Writing the edition's sections from the edition's own data.
 *
 * REUSES THE EXISTING LLM PATH AND NOTHING ELSE. generateJson() from
 * lib/analysis/gemini, the "coding" stage model, the Vault-backed key, the
 * retry policy and the temperature-0 structured-output contract are all as the
 * Analysis narrative uses them. A second route would mean a second place for
 * the key to be wrong, a second retry policy to tune and a second model id for
 * an operator to keep in step.
 *
 * THE ONLY INPUT IS THIS EDITION'S DATA.
 *
 * The figures actually entered for the week, and the articles actually in it.
 * Nothing else. The model must not draw on what it knows about shipping,
 * ports, carriers or current events, and the system prompt says so in those
 * words.
 *
 * That is the instruction that matters most here, and it is worth being blunt
 * about why. This text goes to roughly 120 people at Nestlé under the desk's
 * name. A fluent sentence about a chokepoint that no article mentioned will
 * read as MORE authoritative than the transcribed figures around it, because it
 * is written with more confidence than a number can be. There is no reviewer
 * downstream who would catch it. So: if the data does not support a sentence,
 * the sentence does not get written, and the model is given an explicit way to
 * say nothing — an empty body, which drops the section entirely.
 *
 * A SHORT SECTION IS CORRECT. A PADDED ONE IS A FAILURE. Both halves are in the
 * prompt, because a model asked only for brevity still fills space.
 */

import { generateJson, type JsonSchema } from "@/lib/analysis/gemini";
import type { AnalysisClient } from "@/lib/analysis/models";
import {
  asAtLabel,
  formatDelta,
  formatValue,
  type Generated,
} from "./edition";
import { SECTION_SLOTS, type SectionKey, type SectionSlot } from "./sections";
import { dayLabel, weekRangeLabel } from "./week";

/**
 * Ceiling on article characters in one call. A week of ~100 articles at ~350
 * characters a summary sits inside this; the cap exists so an unusually heavy
 * week degrades by dropping the least recent articles rather than failing.
 */
const MAX_ARTICLE_CHARS = 60_000;

const SYSTEM = `You write a weekly ocean-freight update for a large shipper's
supply-chain team. Your reader has three minutes and will not open the
underlying articles.

THE MATERIAL BELOW IS YOUR ONLY SOURCE.

Work exclusively from the figures and article summaries you are given. You must
not use anything you know about shipping, ports, carriers, canals, trade routes,
companies or current events. If it is not in the material, it does not exist for
the purposes of this edition.

  * Name only ports, regions, carriers, routes, figures and dates that appear
    in the material, spelled as they appear there.
  * Do not add background, history, causes, forecasts or comparisons that the
    material does not state.
  * Do not describe the coverage itself. Never write "coverage focused on",
    "several articles reported", "the media highlighted". The reader wants the
    week, not a description of a clipping file.
  * Do not restate a figure's exact value when it is already printed in the
    table beside your text. Say what it means, not what it is.

IF THE MATERIAL DOES NOT SUPPORT A SENTENCE, DO NOT WRITE THE SENTENCE.

A short section is correct. A padded section is a failure. If a section has
nothing to say from this week's material, return it with an empty body — that is
an expected outcome, not an error, and the section is then left out of the
edition entirely. Never fill a section to avoid leaving it empty.

Plain declarative prose. No markdown, no headings, no bold, no bullet
characters, no preamble. Where a section asks for one line per item, use one
line per item separated by newlines.`;

function buildSchema(keys: SectionKey[]): JsonSchema {
  return {
    type: "OBJECT",
    properties: {
      sections: {
        type: "ARRAY",
        items: {
          type: "OBJECT",
          properties: {
            // Closed vocabulary, the same discipline the coding engine and the
            // narrative call use: an invented section key is not discouraged by
            // the prompt, it is unrepresentable in the response.
            key: { type: "STRING", enum: keys },
            body: { type: "STRING" },
          },
          required: ["key", "body"],
        },
        minItems: keys.length,
        maxItems: keys.length,
      },
    },
    required: ["sections"],
  };
}

/** Which sections the data can support at all. */
export function requestableSlots(generated: Generated): SectionSlot[] {
  const hasArticles = generated.press.shown > 0;
  const hasAnything =
    hasArticles ||
    generated.glance.length > 0 ||
    generated.regions.length > 0 ||
    generated.ports.length > 0 ||
    generated.fleet.length > 0 ||
    generated.reliability !== null;

  return SECTION_SLOTS.filter((slot) => {
    switch (slot.needs) {
      case "articles":
        return hasArticles;
      case "regional":
        return generated.regions.length > 0;
      case "reliability":
        return generated.reliability !== null;
      case "any":
        return hasAnything;
    }
  });
}

/**
 * The figures, written out the way the edition prints them.
 *
 * Deltas are included as their RENDERED text — "▲ 20%", "first edition", "no
 * 3–9 Aug figure" — rather than as raw numbers, so the model cannot describe a
 * movement the table does not show. It is reading the same thing the reader is.
 */
function figureLines(generated: Generated): string[] {
  const lines: string[] = [];

  if (generated.glance.length > 0) {
    lines.push("AT A GLANCE (levels on the most recent day entered, not totals):");
    for (const row of generated.glance) {
      const at = asAtLabel(row.asAt);
      lines.push(
        `  * ${row.label}: ${formatValue(row.value, row.unit)} ${row.unit}` +
          `${at ? ` (${at})` : ""} — change: ${formatDelta(row.delta)}` +
          `${row.note ? ` [${row.note}]` : ""}`
      );
    }
    lines.push("");
  }

  if (generated.regions.length > 0) {
    lines.push(
      `REGIONAL CONGESTION, TEU waiting at anchor${
        generated.regionsAsAt ? ` as at ${dayLabel(generated.regionsAsAt)}` : ""
      }:`
    );
    for (const r of generated.regions) {
      lines.push(
        `  * ${r.label}${r.home ? "" : " (outside AOA)"}: ${formatValue(r.value, "TEU")} TEU — change: ${formatDelta(r.delta)}`
      );
    }
    lines.push("");
  }

  if (generated.ports.length > 0) {
    lines.push("PORT WATCH (queue/berth ratio is as published, never derived):");
    for (const p of generated.ports) {
      const parts = [
        p.teuAnchorage === null ? null : `${formatValue(p.teuAnchorage, "TEU")} TEU at anchorage`,
        p.shipsAnchorage === null ? null : `${p.shipsAnchorage} ships at anchorage`,
        p.shipsPort === null ? null : `${p.shipsPort} ships at port`,
        p.queueBerthRatio === null ? null : `queue/berth ${p.queueBerthRatio}`,
        p.teuDelta ? `change: ${formatDelta(p.teuDelta)}` : null,
      ].filter(Boolean);
      lines.push(`  * ${p.port} (as at ${dayLabel(p.asAt)}): ${parts.join(", ")}`);
    }
    lines.push("");
  }

  if (generated.fleet.length > 0) {
    lines.push(
      "FLEET STATUS — THESE CATEGORIES OVERLAP. Ships at port and ships at " +
        "anchorage are both subsets of active ships. Never add them together or " +
        "describe them as parts of a whole."
    );
    for (const f of generated.fleet) {
      lines.push(
        `  * ${f.status}: ${f.ships === null ? "—" : formatValue(f.ships, "ships")} ships` +
          `${f.teu === null ? "" : `, ${formatValue(f.teu, "TEU")} TEU`}`
      );
    }
    lines.push("");
  }

  const rel = generated.reliability;
  if (rel) {
    lines.push(
      `SCHEDULE RELIABILITY — MONTHLY, published in arrears. These are ${rel.monthLabel} figures` +
        `${rel.glpIssue ? `, Global Liner Performance issue ${rel.glpIssue}` : ""}` +
        `${rel.carriedForward ? `, NOT ${rel.weekMonthLabel} figures` : ""}. ` +
        `Changes below are against ${rel.priorMonthLabel ?? "no earlier month"}, not against last week.`
    );
    if (rel.globalPct !== null) {
      lines.push(
        `  * On time globally: ${rel.globalPct}%${
          rel.globalDelta ? ` — change: ${formatDelta(rel.globalDelta)}` : ""
        }`
      );
    }
    if (rel.avgDelayDays !== null) {
      lines.push(`  * Average delay on late arrivals: ${rel.avgDelayDays} days`);
    }
    for (const a of rel.alliances) {
      lines.push(
        `  * ${a.name}: ${a.value}%${a.delta ? ` — change: ${formatDelta(a.delta)}` : ""}`
      );
    }
    lines.push("");
  }

  return lines;
}

/** The articles the curator actually kept, newest first, within the cap. */
function articleLines(generated: Generated): { lines: string[]; used: number } {
  const lines: string[] = [];
  let budget = MAX_ARTICLE_CHARS;
  let used = 0;

  for (const theme of generated.press.themes) {
    if (theme.items.length === 0) continue;
    const header = `  [${theme.theme}]`;
    if (header.length > budget) break;
    budget -= header.length;
    lines.push(header);

    for (const item of theme.items) {
      const meta = [item.media, item.publishedAt ? dayLabel(item.publishedAt) : null]
        .filter(Boolean)
        .join(", ");
      const entry = `    - ${item.headline}${meta ? ` (${meta})` : ""}. ${item.summary}`;
      if (entry.length > budget) return { lines, used };
      budget -= entry.length;
      used += 1;
      lines.push(entry);
    }
  }

  return { lines, used };
}

export type GenerationResult = {
  bodies: Partial<Record<SectionKey, string>>;
  /** Sections the model was asked for. */
  requested: SectionKey[];
  /** Articles that fitted in the prompt. */
  articlesUsed: number;
};

/**
 * Generates the requested sections. Does NOT write to the database — the caller
 * owns persistence, so this can be exercised against a real week without
 * leaving a row behind, exactly as generateWeekNarrative() is.
 *
 * `only` restricts the call to one section, which is what "Regenerate this
 * section" uses. The prompt still carries the whole week's data, because a
 * headline written without sight of the port figures is a different and worse
 * headline than one written with them.
 */
export async function generateSections(
  client: AnalysisClient,
  generated: Generated,
  only: SectionKey | null = null
): Promise<GenerationResult> {
  let slots = requestableSlots(generated);
  if (only) slots = slots.filter((s) => s.key === only);

  if (slots.length === 0) {
    throw new Error(
      only
        ? "There is no data behind that section this week, so there is nothing to write from."
        : "This week has no figures entered and no coded articles, so there is nothing to write from. Enter the week's figures on the Analysis panel first."
    );
  }

  const { lines: articles, used } = articleLines(generated);
  const figures = figureLines(generated);

  if (figures.length === 0 && articles.length === 0) {
    throw new Error(
      "This week has no figures entered and no coded articles, so there is nothing to write from."
    );
  }

  const prompt = [
    `WEEK: ${weekRangeLabel(generated.week)}, Monday to Sunday inclusive.`,
    generated.partialWeek
      ? "THIS WEEK IS STILL RUNNING. The articles below are only those published so far, so do not describe the week as complete or compare its article count with an earlier week."
      : "",
    "",
    "WRITE EXACTLY THESE SECTIONS, and no others. Return every one of them, using",
    "an empty body for any you cannot write from the material.",
    "",
    ...slots.map((s) => `--- ${s.key} ---\n${s.brief}`),
    "",
    "================ THE WEEK'S FIGURES ================",
    figures.length > 0
      ? figures.join("\n")
      : "No operational figures were entered for this week. Do not refer to congestion, ports, fleet or reliability at all.",
    "================ THE WEEK'S ARTICLES ================",
    articles.length > 0
      ? `${used} article${used === 1 ? "" : "s"}, grouped by theme, newest first within a theme.\n${articles.join("\n")}`
      : "No articles are included in this edition. Do not refer to press coverage at all.",
  ]
    .filter((part) => part !== "")
    .join("\n");

  const keys = slots.map((s) => s.key);
  const raw = await generateJson<{ sections?: unknown }>(client, "coding", {
    system: SYSTEM,
    prompt,
    schema: buildSchema(keys),
  });

  const bodies: Partial<Record<SectionKey, string>> = {};
  // Seeded empty for every requested key, so a section the model omitted
  // entirely is treated as "nothing to say" rather than left at whatever was
  // there before. Omission and an empty body mean the same thing.
  for (const key of keys) bodies[key] = "";

  const returned = Array.isArray(raw.sections) ? raw.sections : [];
  for (const entry of returned) {
    if (!entry || typeof entry !== "object") continue;
    const { key, body } = entry as { key?: unknown; body?: unknown };
    if (typeof key !== "string" || typeof body !== "string") continue;
    if (!keys.includes(key as SectionKey)) continue;
    bodies[key as SectionKey] = cleanBody(body);
  }

  return { bodies, requested: keys, articlesUsed: used };
}

/**
 * Strips the markdown the prompt asked it not to use.
 *
 * Belt and braces: the instruction usually holds, and when it does not, a
 * stray `**` in a client-facing email is the kind of detail that makes the
 * whole thing look unfinished. Only the inline emphasis markers and leading
 * bullets are removed — nothing that would change the words.
 */
function cleanBody(body: string): string {
  return body
    .split("\n")
    .map((line) =>
      line
        .replace(/^\s*[*\-•]\s+/, "")
        .replace(/\*\*(.+?)\*\*/g, "$1")
        .replace(/(^|\s)\*(\S[^*]*?)\*(?=\s|$)/g, "$1$2")
        .replace(/^#{1,6}\s+/, "")
        .trimEnd()
    )
    .join("\n")
    .trim();
}
