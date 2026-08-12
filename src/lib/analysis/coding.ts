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

const SYSTEM = `You are coding ocean-freight news articles for a media
intelligence corpus. You do two things: judge tone, and name themes.

TONE. Judge sentiment from the point of view of ${PERSPECTIVE}

Score the HEADLINE and the BODY separately. They frequently disagree — a
neutral-sounding headline over bad news, or an alarming headline over a routine
update — and that disagreement is information, so do not average them yourself.
Use 'neutral' for genuinely balanced, factual or mixed content; do not use it as
a hedge when the direction is clear.

THEMES. Give 1-3 short noun phrases naming what this article is ABOUT.

Themes exist to group articles into storylines, so they are worthless unless
they are reused across articles covering the same story. Follow these rules:

  * Name the specific ongoing situation, not the broad category. "Red Sea
    return" — not "chokepoints". "Panama Canal draft restrictions" — not
    "routing".
  * Use the conventional industry name for it, the phrase a trade journalist
    would use. Two articles on the same story must land on the same phrase.
  * 2-5 words. No dates, no numbers, no carrier-specific detail unless the
    carrier IS the story.
  * Lowercase unless a proper noun requires otherwise.
  * Prefer an existing conventional phrase over inventing a new one.

Give the most important theme first.`;

const SCHEMA: JsonSchema = {
  type: "OBJECT",
  properties: {
    // Themes first: naming what the article is about before judging its tone
    // steadies the sentiment call, the same way sorting generates its
    // reasoning before its verdict. Costs nothing extra, since themes are
    // stored anyway.
    themes: {
      type: "ARRAY",
      items: { type: "STRING" },
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
  },
  required: ["themes", "headline_sentiment", "body_sentiment"],
  propertyOrdering: ["themes", "headline_sentiment", "body_sentiment"],
};

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
/**
 * Words that end in 's' without being plural. Stripping these would corrupt
 * the term rather than canonicalise it ("logistics" → "logistic",
 * "crisis" → "crisi", "overseas" → "oversea").
 *
 * Note the absence of 'ys': -ays words in this domain ("delays", "ways") are
 * ordinary plurals and must be singularised.
 */
const NOT_PLURAL = /(ss|us|is|ics|ous|as)$/;

/**
 * Singularises the final word only. Themes are noun phrases, so the head noun
 * is what varies — "supply chain disruption" and "supply chain disruptions"
 * must collapse, and doing it on the last word alone avoids mangling modifiers
 * ("rates rally" is not "rate rally").
 */
function singulariseLastWord(phrase: string): string {
  const words = phrase.split(" ");
  const last = words[words.length - 1];
  if (last.length <= 3 || NOT_PLURAL.test(last)) return phrase;
  if (last.endsWith("ies")) words[words.length - 1] = `${last.slice(0, -3)}y`;
  else if (last.endsWith("s")) words[words.length - 1] = last.slice(0, -1);
  return words.join(" ");
}

export function normaliseTheme(theme: string): string {
  const base = theme
    .toLowerCase()
    .replace(/[.,;:!?]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return singulariseLastWord(base);
}

/**
 * Distinct themes already in use, most frequent first.
 *
 * Seeded into the coding prompt so each article is not named in a vacuum.
 * Without this the model reaches for a fresh phrase every time and the same
 * story fragments across "strait of hormuz crisis", "strait of hormuz risk"
 * and "strait of hormuz disruptions" — three singleton groups where there is
 * one storyline. Normalisation alone cannot fix that; only a shared vocabulary
 * can, because these are genuinely different words rather than different
 * spellings.
 *
 * Scoped to active articles so themes belonging only to excluded stories stop
 * being suggested.
 */
export async function loadThemeVocabulary(
  client: AnalysisClient,
  limit = 60
): Promise<string[]> {
  const { data, error } = await client
    .from("articles")
    .select("ai_themes")
    .eq("status", "active")
    .eq("coded_status", "coded")
    .not("ai_themes", "is", null);

  if (error) return [];

  const counts = new Map<string, number>();
  for (const row of data ?? []) {
    for (const theme of row.ai_themes ?? []) {
      if (theme) counts.set(theme, (counts.get(theme) ?? 0) + 1);
    }
  }

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([theme]) => theme);
}

export type CodingResult = {
  headlineSentiment: Sentiment;
  bodySentiment: Sentiment;
  tier: SentimentTier;
  themes: string[];
};

type CodingResponse = {
  themes?: unknown;
  headline_sentiment?: unknown;
  body_sentiment?: unknown;
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
  matchedKeywords: string[] = [],
  vocabulary: string[] = []
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
    // The vocabulary goes last, immediately before the model answers, because
    // it is the instruction most easily lost in the middle of a long body.
    vocabulary.length > 0
      ? `THEMES ALREADY IN USE — reuse one of these EXACT phrases whenever it fits this article, even approximately. Only invent a new theme when none of these describes it:\n${vocabulary
          .map((t) => `- ${t}`)
          .join("\n")}`
      : null,
  ]
    .filter(Boolean)
    .join("\n\n");

  const raw = await generateJson<CodingResponse>(client, "coding", {
    system: SYSTEM,
    prompt,
    schema: SCHEMA,
  });

  const headlineSentiment = asSentiment(raw.headline_sentiment, "headline_sentiment");
  const bodySentiment = asSentiment(raw.body_sentiment, "body_sentiment");

  const themes = Array.isArray(raw.themes)
    ? [
        ...new Set(
          raw.themes
            .filter((t): t is string => typeof t === "string")
            .map(normaliseTheme)
            .filter((t) => t.length > 0)
        ),
      ].slice(0, 3)
    : [];

  if (themes.length === 0) {
    throw new Error("Coding response returned no usable themes.");
  }

  return {
    headlineSentiment,
    bodySentiment,
    tier: sentimentTier(headlineSentiment, bodySentiment),
    themes,
  };
}

export type CodingBatchSummary = {
  processed: number;
  failed: number;
  /** Candidates left uncoded because the batch cap was hit. */
  remaining: number;
  byTier: Record<string, number>;
  errors: { articleId: string; error: string }[];
};

export type CodableArticle = {
  id: string;
  headline: string;
  body: string | null;
  matched_keywords: string[];
};

export function emptyCodingSummary(): CodingBatchSummary {
  return { processed: 0, failed: 0, remaining: 0, byTier: {}, errors: [] };
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

  // Vocabulary grows as the batch proceeds, in fixed-size chunks.
  //
  // Frozen for the whole batch, a cold corpus would get no vocabulary at all
  // for its first 40 articles and fragment badly. Reloaded per article, an
  // article's themes would depend on where concurrency happened to place it,
  // and two runs over the same rows would disagree.
  //
  // Chunking gives both: within a chunk the vocabulary is fixed, and chunk
  // boundaries fall at fixed offsets in a deterministically ORDERED row list
  // (published_at asc, then ingested_at asc — see loadCodingCandidates), so
  // the same input always produces the same vocabulary at the same point.
  const seen = new Set(await loadThemeVocabulary(client));

  for (let i = 0; i < rows.length; i += VOCAB_CHUNK) {
    const slice = rows.slice(i, i + VOCAB_CHUNK);
    const vocabulary = [...seen];

    const outcomes = await mapWithConcurrency(slice, CODE_CONCURRENCY, async (row) => {
      const result = await codeArticle(
        client,
        row.headline,
        row.body,
        row.matched_keywords ?? [],
        vocabulary
      );

      // Written per article, not batched at the end: a run that dies halfway
      // keeps the judgements it already paid Gemini for, and the next run
      // picks up exactly what is still pending.
      const { error } = await client
        .from("articles")
        .update({
          ai_sentiment: result.tier,
          ai_themes: result.themes,
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
      for (const theme of outcome.result.themes) seen.add(theme);
    }
  }

  return summary;
}
