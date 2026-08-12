import { generateJson, type JsonSchema } from "./gemini";
import type { AnalysisClient } from "./models";
import type { Week } from "./week-period";
import {
  countPolarity,
  polarityOf,
  themeStats,
  topThemes,
  type ThemeStat,
  type WeekArticle,
} from "./week-stats";

/**
 * The Analysis panel's weekly narrative.
 *
 * ONE Gemini call produces both the header period summary and the per-theme
 * narratives. They could have been two calls, and two calls would have been
 * worse: the period summary has to be consistent with what the theme
 * narratives say, and the only way to guarantee that without a second round of
 * prompting is to let the model write them together, seeing the same evidence
 * at once.
 *
 * THE INPUT IS ai_summary, NOT ARTICLE BODIES.
 *
 * Bodies would be roughly two orders of magnitude more tokens for the same
 * week, and they are the wrong input besides. Those summaries were written by
 * the coding pass under an explicit instruction to be reusable prose a curator
 * can paste unedited — factual, de-editorialised, specifics retained. Feeding
 * them back in means this call reasons over material that has already been
 * cleaned of the framing ("this article reports…") that would otherwise leak
 * into the narrative.
 *
 * WHICH MODEL.
 *
 * The `coding` stage model, not a third setting of its own. The economics
 * match — analyst-triggered, paid per run, needs the stronger model — and
 * adding a third app_settings key would mean a third control in the
 * Integrations panel for a distinction no operator has asked to make. If
 * narrative quality ever needs to diverge from coding quality, that is the
 * point to split it.
 */

/** Bumped when the stored shape changes. Read before rendering. */
export const NARRATIVE_VERSION = 1;

/** Themes that get their own narrative paragraph. */
export const NARRATIVE_THEME_COUNT = 3;

/**
 * Ceiling on summary characters sent in one call. A week of ~60 articles at
 * ~350 characters a summary is comfortably inside this; the cap exists so an
 * unusually heavy week degrades by dropping the least prominent articles
 * rather than by failing the request outright.
 */
const MAX_SUMMARY_CHARS = 60_000;

export type ThemeNarrative = {
  theme: string;
  /** Articles tagged with this theme in the week. */
  article_count: number;
  narrative: string;
};

export type WeekNarrative = {
  version: number;
  week_of: string;
  /** Coded articles the narrative was written from. */
  source_article_count: number;
  period_summary: string;
  themes: ThemeNarrative[];
};

function buildSchema(themeNames: string[]): JsonSchema {
  return {
    type: "OBJECT",
    properties: {
      period_summary: { type: "STRING" },
      theme_narratives: {
        type: "ARRAY",
        items: {
          type: "OBJECT",
          properties: {
            // The same closed-vocabulary discipline the coding engine uses: an
            // off-list or invented theme is not discouraged by the prompt, it
            // is unrepresentable in the response.
            theme: { type: "STRING", enum: themeNames },
            narrative: { type: "STRING" },
          },
          required: ["theme", "narrative"],
        },
        minItems: themeNames.length,
        maxItems: themeNames.length,
      },
    },
    required: ["period_summary", "theme_narratives"],
    propertyOrdering: ["period_summary", "theme_narratives"],
  };
}

const SYSTEM = `You write the weekly media-analysis brief for an ocean-freight
monitoring desk. Your reader is a supply-chain manager at a large shipper who
has three minutes and will not read the underlying articles.

You are given article summaries that have already been written and coded. Work
ONLY from them. Do not add context, forecasts, history or advice that is not
present in the material.

PERIOD SUMMARY. 3-5 sentences on what the week's coverage actually said.

  * Lead with the substance — what happened and where — not with the coverage.
    Never write "coverage focused on", "the media reported", "this week saw a
    number of articles about". The reader wants the week, not a description of
    a clipping file.
  * Name the things that carry the week: routes, ports, carriers, figures,
    effective dates.
  * Where the tone is lopsided, say so plainly and say why, in terms of what
    the stories were about. Do not recite the favourable/unfavourable counts —
    the reader has those on screen directly above your text.
  * No advice, no recommendations, no speculation.

THEME NARRATIVES. 2-4 sentences for EACH theme named below, and only those.

  * Cover what that theme's stories said this week, specifically.
  * If the stories within a theme disagree in direction, say what splits them.
  * Do not repeat the period summary's sentences. The reader is reading both.
  * Do not compare against previous weeks — you have not been given them.

Plain declarative prose throughout. No bullet points, no headings, no markdown,
no preamble.`;

function buildPrompt(
  week: Week,
  coded: WeekArticle[],
  top: ThemeStat[]
): { prompt: string; used: number } {
  const counts = countPolarity(coded);

  // Most-mentioned first, so if the cap truncates it drops the least prominent
  // articles rather than whichever happened to sort last.
  const ordered = [...coded].sort(
    (a, b) => (b.keyword_mention_count ?? 0) - (a.keyword_mention_count ?? 0)
  );

  const lines: string[] = [];
  let budget = MAX_SUMMARY_CHARS;
  let used = 0;

  for (const row of ordered) {
    const summary = (row.ai_summary ?? "").trim();
    if (!summary) continue;
    const themes = (row.ai_themes ?? []).join("; ");
    const polarity = polarityOf(row.ai_sentiment) ?? "neutral";
    const entry = `- [${polarity}] [${themes}] ${summary}`;
    if (entry.length > budget) break;
    budget -= entry.length;
    used += 1;
    lines.push(entry);
  }

  const prompt = [
    `PERIOD: ${week.label} (${week.isoLabel})`,
    `CODED ARTICLES: ${coded.length} — ${counts.favourable} favourable, ${counts.neutral} neutral, ${counts.unfavourable} unfavourable.`,
    "",
    `WRITE A NARRATIVE FOR EXACTLY THESE ${top.length} THEMES, and no others:`,
    ...top.map((t) => `  * ${t.theme} (${t.articles} articles this week)`),
    "",
    "ARTICLE SUMMARIES. Each line is one article, tagged with its favourability",
    "and its themes. An article tagged with several themes appears once.",
    "",
    ...lines,
  ].join("\n");

  return { prompt, used };
}

type NarrativeResponse = {
  period_summary?: unknown;
  theme_narratives?: unknown;
};

/**
 * Generates the week's narrative. Does NOT write to the database — the caller
 * owns persistence, so this can be exercised against a real week without
 * leaving a row behind.
 *
 * Throws when the week has nothing to write about. A narrative over zero coded
 * articles would be the model inventing a week, which is the one failure mode
 * that must not be possible here.
 */
export async function generateWeekNarrative(
  client: AnalysisClient,
  week: Week,
  coded: WeekArticle[]
): Promise<WeekNarrative> {
  if (coded.length === 0) {
    throw new Error(
      "No coded articles in this week — there is nothing to write a narrative from. Run AI coding on the week first."
    );
  }

  const top = topThemes(themeStats(coded), NARRATIVE_THEME_COUNT);
  if (top.length === 0) {
    throw new Error(
      "The week's coded articles carry no themes, so there is nothing to summarise per theme."
    );
  }

  const { prompt, used } = buildPrompt(week, coded, top);
  if (used === 0) {
    throw new Error(
      "None of this week's coded articles has a summary to work from. Re-run AI coding so summaries are written."
    );
  }

  const raw = await generateJson<NarrativeResponse>(client, "coding", {
    system: SYSTEM,
    prompt,
    schema: buildSchema(top.map((t) => t.theme)),
  });

  const periodSummary =
    typeof raw.period_summary === "string" ? raw.period_summary.trim() : "";
  if (!periodSummary) {
    throw new Error("The model returned an empty period summary.");
  }

  const returned = Array.isArray(raw.theme_narratives) ? raw.theme_narratives : [];
  const byTheme = new Map<string, string>();
  for (const entry of returned) {
    if (!entry || typeof entry !== "object") continue;
    const { theme, narrative } = entry as { theme?: unknown; narrative?: unknown };
    if (typeof theme !== "string" || typeof narrative !== "string") continue;
    const text = narrative.trim();
    if (text) byTheme.set(theme.trim(), text);
  }

  // Rebuild from OUR ordered top-3 rather than from the response array, so the
  // panel's theme order always matches the chart's and a model that reordered
  // or duplicated entries cannot change what the page shows.
  const themes: ThemeNarrative[] = top.map((t) => ({
    theme: t.theme,
    article_count: t.articles,
    narrative: byTheme.get(t.theme) ?? "",
  }));

  const missing = themes.filter((t) => !t.narrative).map((t) => t.theme);
  if (missing.length > 0) {
    throw new Error(
      `The model returned no narrative for: ${missing.join(", ")}.`
    );
  }

  return {
    version: NARRATIVE_VERSION,
    week_of: week.start,
    source_article_count: used,
    period_summary: periodSummary,
    themes,
  };
}

/**
 * Reads a stored narrative back, tolerating anything that is not the shape we
 * wrote. A malformed or older-version document renders as "no narrative yet"
 * rather than throwing — the panel's charts are the primary content and must
 * not be taken down by a bad narrative row.
 */
export function parseStoredNarrative(value: unknown): WeekNarrative | null {
  if (!value || typeof value !== "object") return null;
  const doc = value as Record<string, unknown>;
  if (doc.version !== NARRATIVE_VERSION) return null;
  if (typeof doc.period_summary !== "string" || !doc.period_summary.trim()) {
    return null;
  }
  if (!Array.isArray(doc.themes)) return null;

  const themes: ThemeNarrative[] = [];
  for (const entry of doc.themes) {
    if (!entry || typeof entry !== "object") continue;
    const t = entry as Record<string, unknown>;
    if (typeof t.theme !== "string" || typeof t.narrative !== "string") continue;
    themes.push({
      theme: t.theme,
      article_count: Number(t.article_count ?? 0),
      narrative: t.narrative,
    });
  }
  if (themes.length === 0) return null;

  return {
    version: NARRATIVE_VERSION,
    week_of: typeof doc.week_of === "string" ? doc.week_of : "",
    source_article_count: Number(doc.source_article_count ?? 0),
    period_summary: doc.period_summary,
    themes,
  };
}
