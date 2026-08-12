import { generateJson, mapWithConcurrency, type JsonSchema } from "./gemini";
import type { AnalysisClient } from "./models";

/**
 * Stage 2 — coding. Manual, batched, and the only part of the AI Brain that
 * costs real money per run, which is why nothing fires it automatically.
 *
 * Produces three things per article:
 *   * headline sentiment and body sentiment, which feed a DETERMINISTIC
 *     5-point favourability tier (see sentimentTier) — the LLM never picks the
 *     tier itself, so the number is auditable component by component;
 *   * 1-3 themes, normalised for grouping, which are what storylines are
 *     derived from at query time.
 *
 * Keyword counting is NOT done here. matched_keywords and
 * keyword_mention_count are regex-derived, deterministic and already correct
 * (migration 0018); asking an LLM to recount them would trade a reliable
 * number for an unreliable one. The matched keywords are passed IN as context,
 * to steer theme naming toward the tracked taxonomy.
 */

/** Articles coded at once. Same bound as sorting, for the same reason. */
const CODE_CONCURRENCY = 4;

/** Body characters sent per article. */
const MAX_BODY_CHARS = 8_000;

/**
 * Articles coded against one frozen snapshot of the theme vocabulary before it
 * is refreshed. Small enough that a cold corpus starts converging within the
 * first dozen articles, large enough that the vocabulary is stable across a
 * concurrent group.
 */
const VOCAB_CHUNK = 8;

/**
 * WHOSE point of view sentiment is measured from.
 *
 * This is the single most consequential choice in this file and it is
 * deliberately one constant. Ocean-freight news has no intrinsic polarity —
 * a rate spike is good for a carrier and bad for whoever is paying the
 * freight. nestle-scm monitors on behalf of a shipper (the taxonomy tracks
 * "BCO / beneficial cargo owner" as a Gate 1 trade role), so favourability is
 * scored from the cargo owner's seat: cheaper, faster, more reliable and more
 * predictable movement of containerised cargo is favourable.
 *
 * Flip this string and re-run coding to score the corpus from any other seat.
 */
const PERSPECTIVE = `a BENEFICIAL CARGO OWNER (BCO) — a large shipper moving
containerised cargo, who pays freight and depends on predictable transit.
Favourable news means cheaper, faster, more reliable or more predictable
container movement. Unfavourable news means higher cost, longer transit,
congestion, capacity loss, added risk or reduced predictability. Judge from
this seat and no other: a freight-rate increase is UNFAVOURABLE here even
though a carrier's shareholders would welcome it, and overcapacity that
depresses rates is FAVOURABLE here even though it hurts carrier margins.`;

function buildSystemPrompt(themes: ThemeOption[]): string {
  const catalogue = themes
    .map((t) => `- ${t.name}: ${t.description ?? "(no guidance supplied)"}`)
    .join("\n");

  return `You are coding ocean-freight news articles for a media intelligence
corpus. You do three things: assign themes, judge tone, and write a summary.

THEMES. Assign 1-3 themes from the fixed list below, most important first.

You may ONLY use these exact names. The list is the vocabulary; there is no
option to invent one. Each entry states what the bucket means and where its
boundaries lie — read the guidance, do not pattern-match the name.

${catalogue}

Assign a second or third theme only when the article genuinely spans them.
Two weakly-relevant themes are worse than one accurate one.

TONE. Judge sentiment from the point of view of ${PERSPECTIVE}

Score the HEADLINE and the BODY separately. They frequently disagree — a
neutral-sounding headline over bad news, or an alarming headline over a routine
update — and that disagreement is information, so do not average them yourself.
Use 'neutral' for genuinely balanced, factual or mixed content; do not use it as
a hedge when the direction is clear.

SUMMARY. Write 2-3 sentences a newsletter curator can paste in unedited.

  * Report what happened. Lead with the fact, not the article.
  * NEVER write "this article discusses", "the piece reports", "according to
    the report", or any other framing that refers to the coverage rather than
    the event. The reader wants the news, not a description of a news story.
  * No editorialising, no adjectives of judgement, no advice, no speculation
    beyond what the source states.
  * Keep the specifics that make it useful: named carriers, ports, routes,
    figures, percentages, dates, effective-from timings.
  * Plain declarative prose. No bullet points, no headline-style fragments.
  * If the source is only a headline with no body, write one factual sentence
    from it rather than padding to three.`;
}

function buildSchema(themes: ThemeOption[]): JsonSchema {
  return {
    type: "OBJECT",
    properties: {
      // Themes first: naming what the article is about before judging its tone
      // and writing its summary steadies both, the same way sorting generates
      // its reasoning before its verdict.
      themes: {
        type: "ARRAY",
        // The closed vocabulary, enforced by the API rather than by the
        // prompt. This is the whole point: an off-list theme is not
        // discouraged, it is unrepresentable in the response.
        items: { type: "STRING", enum: themes.map((t) => t.name) },
        minItems: 1,
        maxItems: 3,
      },
      headline_sentiment: {
        type: "STRING",
        enum: ["positive", "neutral", "negative"],
      },
      body_sentiment: {
        type: "STRING",
        enum: ["positive", "neutral", "negative"],
      },
      summary: { type: "STRING" },
    },
    required: ["themes", "headline_sentiment", "body_sentiment", "summary"],
    propertyOrdering: [
      "themes",
      "headline_sentiment",
      "body_sentiment",
      "summary",
    ],
  };
}

export type Sentiment = "positive" | "neutral" | "negative";

/**
 * The 5-point favourability scale stored in articles.ai_sentiment.
 * Ordered worst to best so a UI can sort on the index.
 */
export const SENTIMENT_TIERS = [
  "Very unfavourable",
  "Unfavourable",
  "Neutral",
  "Favourable",
  "Very favourable",
] as const;

export type SentimentTier = (typeof SENTIMENT_TIERS)[number];

const POINTS: Record<Sentiment, number> = {
  positive: 1,
  neutral: 0,
  negative: -1,
};

/**
 * Maps a (headline, body) sentiment pair to one of five tiers.
 *
 * Deterministic and additive, in the spirit of the CARMA favourability model:
 * the LLM supplies only the two component judgements, and the tier is
 * arithmetic on top. That is what makes the result explainable — "headline
 * positive, body negative, net zero, therefore Neutral" is something a client
 * can be walked through, which "the model said Favourable" is not.
 *
 * Headline and body are weighted EQUALLY. The sum spans -2..+2, which is
 * exactly five values, so every score maps to exactly one tier with no
 * bucketing judgement hidden in the boundaries.
 *
 * The consequence worth understanding: when headline and body genuinely
 * disagree the article codes as Neutral, not as whichever side is louder.
 * A mixed article is a mixed article.
 */
export function sentimentTier(headline: Sentiment, body: Sentiment): SentimentTier {
  const score = POINTS[headline] + POINTS[body];
  // score -2..+2 → index 0..4
  return SENTIMENT_TIERS[score + 2];
}

/**
 * Normalises a theme for grouping. Storylines are a GROUP BY over these
 * strings, so "Red Sea return", "red sea return " and "Red  Sea  Return" must
 * collapse to one key or the grouping silently fragments.
 *
 * Proper-noun casing is sacrificed deliberately: a display layer can title-case
 * for presentation, but grouping needs one canonical form.
 */
export type ThemeOption = { name: string; description: string | null };

/**
 * The active theme vocabulary, in a fixed order.
 *
 * Read fresh on every batch and never cached at module scope, the same
 * discipline as getStageModel(): an admin adding a theme in the panel must see
 * it offered on the very next coding run, and a warm serverless instance must
 * not keep serving yesterday's list.
 *
 * Ordered by name so the compiled enum is stable — an enum whose member order
 * shifted between runs would change the prompt for no reason.
 */
export async function loadActiveThemes(
  client: AnalysisClient
): Promise<ThemeOption[]> {
  const { data, error } = await client
    .from("themes")
    .select("name, description")
    .eq("is_active", true)
    .order("name");

  if (error) throw new Error(`Could not load themes: ${error.message}`);

  const themes = (data ?? []).filter((t) => t.name?.trim());
  if (themes.length === 0) {
    // Fail loudly. An empty enum would make Gemini's schema unsatisfiable and
    // every article would error one call at a time; better to stop before
    // spending anything.
    throw new Error(
      "No active themes are configured. Add at least one under Settings → Themes before running AI coding."
    );
  }
  return themes;
}

export type CodingResult = {
  headlineSentiment: Sentiment;
  bodySentiment: Sentiment;
  tier: SentimentTier;
  themes: string[];
  summary: string;
};

type CodingResponse = {
  themes?: unknown;
  headline_sentiment?: unknown;
  body_sentiment?: unknown;
  summary?: unknown;
};

const SENTIMENTS: readonly string[] = ["positive", "neutral", "negative"];

function asSentiment(value: unknown, field: string): Sentiment {
  if (typeof value === "string" && SENTIMENTS.includes(value)) {
    return value as Sentiment;
  }
  throw new Error(`Coding response had an invalid ${field}: ${String(value)}`);
}

/**
 * Codes one article. Exported on its own so the prompt can be exercised
 * against real text without touching the database.
 */
export async function codeArticle(
  client: AnalysisClient,
  headline: string,
  body: string | null,
  matchedKeywords: string[],
  themes: ThemeOption[]
): Promise<CodingResult> {
  const snippet = (body ?? "").trim().slice(0, MAX_BODY_CHARS);

  const prompt = [
    `HEADLINE: ${headline}`,
    snippet
      ? `BODY: ${snippet}`
      : "BODY: (none supplied — judge from the headline alone)",
    matchedKeywords.length > 0
      ? `TRACKED TERMS PRESENT: ${matchedKeywords.join(", ")}`
      : null,
  ]
    .filter(Boolean)
    .join("\n\n");

  const raw = await generateJson<CodingResponse>(client, "coding", {
    system: buildSystemPrompt(themes),
    prompt,
    schema: buildSchema(themes),
  });

  const headlineSentiment = asSentiment(raw.headline_sentiment, "headline_sentiment");
  const bodySentiment = asSentiment(raw.body_sentiment, "body_sentiment");

  // Belt and braces over the schema enum. The API enforces the vocabulary
  // server-side, so this should never drop anything — but a theme that somehow
  // arrived off-list must not reach the database, where it would silently
  // become a storyline group of one that no admin can see or retire.
  const allowed = new Set(themes.map((t) => t.name));
  const returned = Array.isArray(raw.themes)
    ? raw.themes.filter((t): t is string => typeof t === "string")
    : [];
  const accepted = [...new Set(returned.filter((t) => allowed.has(t)))].slice(0, 3);

  const rejected = returned.filter((t) => !allowed.has(t));
  if (rejected.length > 0) {
    console.warn(
      `[coding] discarded off-vocabulary theme(s): ${rejected.join(", ")}`
    );
  }

  if (accepted.length === 0) {
    throw new Error(
      `Coding response returned no valid themes${
        returned.length > 0 ? ` (got: ${returned.join(", ")})` : ""
      }.`
    );
  }

  const summary = typeof raw.summary === "string" ? raw.summary.trim() : "";
  if (!summary) throw new Error("Coding response returned an empty summary.");

  return {
    headlineSentiment,
    bodySentiment,
    tier: sentimentTier(headlineSentiment, bodySentiment),
    themes: accepted,
    summary,
  };
}

export type CodingBatchSummary = {
  processed: number;
  failed: number;
  /** Candidates left uncoded because the batch cap was hit. */
  remaining: number;
  byTier: Record<string, number>;
  byTheme: Record<string, number>;
  errors: { articleId: string; error: string }[];
};

export type CodableArticle = {
  id: string;
  headline: string;
  body: string | null;
  matched_keywords: string[];
};

export function emptyCodingSummary(): CodingBatchSummary {
  return {
    processed: 0,
    failed: 0,
    remaining: 0,
    byTier: {},
    byTheme: {},
    errors: [],
  };
}

/**
 * Codes a set of already-selected articles.
 *
 * The caller decides WHICH articles — that is the whole point of the manual
 * review step, and this function must never widen the set it was handed.
 */
export async function codeArticles(
  client: AnalysisClient,
  rows: CodableArticle[]
): Promise<CodingBatchSummary> {
  const summary = emptyCodingSummary();
  if (rows.length === 0) return summary;

  // One immutable vocabulary for the whole batch.
  //
  // Phase 3 grew the vocabulary in chunks as coding proceeded, because themes
  // were free text and a cold corpus had nothing to converge on. A closed
  // vocabulary removes that problem entirely: the list does not depend on what
  // has been coded so far, so every article in a run — and every run — sees
  // exactly the same options. Determinism comes for free rather than from
  // careful chunk boundaries.
  const themes = await loadActiveThemes(client);

  const outcomes = await mapWithConcurrency(rows, CODE_CONCURRENCY, async (row) => {
    const result = await codeArticle(
      client,
      row.headline,
      row.body,
      row.matched_keywords ?? [],
      themes
    );

    // Written per article, not batched at the end: a run that dies halfway
    // keeps the judgements it already paid Gemini for, and the next run picks
    // up exactly what is still pending.
    const { error } = await client
      .from("articles")
      .update({
        ai_sentiment: result.tier,
        ai_themes: result.themes,
        ai_summary: result.summary,
        coded_status: "coded",
      })
      .eq("id", row.id);

    if (error) throw new Error(`Could not save coding: ${error.message}`);
    return result;
  });

  for (const outcome of outcomes) {
    if (outcome.error !== null || !outcome.result) {
      summary.failed += 1;
      summary.errors.push({
        articleId: outcome.item.id,
        error: outcome.error ?? "Unknown coding failure.",
      });
      continue;
    }
    summary.processed += 1;
    const tier = outcome.result.tier;
    summary.byTier[tier] = (summary.byTier[tier] ?? 0) + 1;
    for (const theme of outcome.result.themes) {
      summary.byTheme[theme] = (summary.byTheme[theme] ?? 0) + 1;
    }
  }

  return summary;
}
