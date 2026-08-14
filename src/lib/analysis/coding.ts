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
 * WHAT favourability is measured against.
 *
 * The single most consequential choice in this file, and deliberately one
 * constant. It was previously "a beneficial cargo owner", which was too loose:
 * measured on 161 rows, that produced 'Very favourable' for a new crane at
 * Antwerp and for a vendor joining a standards body, because both are cheerful
 * news for SOMEONE in container shipping. The subject is now stated as a
 * question about a specific operation, so the model has something it can fail
 * to answer.
 */
const SUBJECT = `NESTLÉ'S ABILITY TO MOVE ITS OWN CONTAINERS THROUGH ASIA,
OCEANIA AND AFRICA (AOA).

The only question is: does this event make Nestlé's container movement in AOA
harder, slower, less predictable or more expensive — or easier, faster, more
predictable or cheaper?

It is NOT whether the news sounds positive.
It is NOT whether it is good for the carrier, the port, the terminal operator,
the technology vendor or the industry.
It is NOT whether the company in the story is doing well or badly.

A carrier being fined, a vendor winning an award, a terminal ordering a crane,
a standards body gaining a member — none of these move a Nestlé box. They are
Neutral, however upbeat or damning the coverage. A terminal investment that
will not change a Nestlé transit time for two years is Neutral too: a benefit
that is not yet real is not a benefit.`;

/**
 * The anchored five-point scale.
 *
 * Every anchor is a real article from this corpus, which matters: an abstract
 * definition ("significant negative impact") is a vocabulary, and the model
 * fills a vocabulary with its own calibration. Worked examples are a SCALE,
 * and they are what stops a crane and a typhoon sharing a grade.
 *
 * Note what sits at Neutral. Three of the five anchors there are stories that
 * previously graded at an extreme, and they are listed with the reason they do
 * not qualify — the point is not that they are unimportant news, but that they
 * name no Nestlé lane.
 */
const GRADE_ANCHORS = `Very unfavourable — a primary AOA lane is severely
  disrupted, right now.
    "Typhoon Dolphin Deepens China Port Congestion, Stranding 2.4M TEUs"
    "US forces strike containership Vela Nova in Gulf of Oman"

Unfavourable — a real, bounded cost or delay on a lane Nestlé uses.
    "Maersk raises Middle East-Pakistan surcharge"
    A named AOA port adding two days of berth waiting time.

Neutral — no identifiable effect on Nestlé's AOA container movement. THIS IS
  THE DEFAULT AND MOST TRADE PRESS BELONGS HERE.
    "MSC fined $6 million over Charleston vessel incident"
      — a penalty on a carrier, in a US port, with no AOA lane consequence.
    "PSA Antwerp adds new STS crane at Noordzee Terminal"
      — a single crane, in Europe, changing no transit time.
    "T-Mining joins DCSA+ to advance Secure Container Release standards"
      — an industry standards programme, years from any operational effect.
    "WaveBL integrates with Evergreen to expand electronic Bill of Lading
     adoption" — a documentation product integration.
    Market commentary, sentiment surveys, appointments, awards, funding rounds,
    corporate results, technology pilots and conference announcements.

Favourable — a real, bounded improvement on a lane Nestlé uses.
    Congestion easing at a named AOA port.
    A carrier restoring a suspended AOA service.

Very favourable — a primary AOA lane materially improves, at scale.
    "Red Sea transits resuming at scale"`;

/**
 * Anchors for the magnitude axis.
 *
 * Kept numeric and separate because direction and magnitude are genuinely
 * different questions, and forcing one five-point field to answer both is what
 * collapsed the old distribution into a barbell: with nowhere to say "bad but
 * trivial", every piece of bad news reached for the bottom of the scale.
 */
const RELEVANCE_ANCHORS = `  0-19   No identifiable effect on Nestlé AOA container movement.
         A crane, a fine, a standards body, an award, a market survey.
         If impact_rationale cannot name a lane, port, service or cost,
         the score BELONGS HERE and the grade is Neutral.
  20-39  Indirect or distant. Affects the industry or a region Nestlé uses,
         with no measurable consequence for a Nestlé shipment.
  40-59  Touches a lane Nestlé uses, with a modest or uncertain effect.
  60-79  Material and measurable: a real cost, delay or capacity change on a
         named AOA lane.
  80-100 Severe: a primary AOA lane disrupted or transformed at scale.
         Reserve 90+ for events measured in millions of TEUs, closed
         corridors, or region-wide capacity loss.`;

function buildSystemPrompt(themes: ThemeOption[]): string {
  const catalogue = themes
    .map((t) => `- ${t.name}: ${t.description ?? "(no guidance supplied)"}`)
    .join("\n");

  return `You are coding ocean-freight news articles for Nestlé's supply chain
media intelligence. You do four things, IN THIS ORDER: assign themes, name the
impact, grade it, and write a summary.

THEMES. Assign 1-3 themes from the fixed list below, most important first.

You may ONLY use these exact names. The list is the vocabulary; there is no
option to invent one. Each entry states what the bucket means and where its
boundaries lie — read the guidance, do not pattern-match the name.

${catalogue}

Assign a second or third theme only when the article genuinely spans them.
Two weakly-relevant themes are worse than one accurate one.

IMPACT RATIONALE. One sentence. Write this BEFORE you grade, and grade from it.

Everything below is judged against ${SUBJECT}

Name the SPECIFIC thing that changes for Nestlé: the lane, the port, the
carrier service, the corridor, or the cost. Be concrete — "Asia-Europe transits
via Suez", "berth waiting at Colombo", "Far East to West Africa capacity".

If you cannot name one, say so plainly — write that the article names no
Nestlé AOA lane, port, service or cost. That is a legitimate and COMMON answer.
When it is the answer, favourability MUST be Neutral and relevance MUST be
below 20. Do not manufacture an impact to justify a grade; the sentence is
evidence for the grade, not decoration on it.

FAVOURABILITY — direction only. Which way does it move Nestlé's AOA container
movement? Magnitude is a separate field; do not let a big number pull the
direction, or a strong direction inflate the number.

${GRADE_ANCHORS}

RELEVANCE — magnitude, 0-100. How much does this matter to Nestlé AOA?

${RELEVANCE_ANCHORS}

Direction and magnitude are independent. A carrier's $6m fine is Neutral and 5.
A typhoon stranding 2.4M TEUs is Very unfavourable and 95. Both are "bad news"
in tone; they are nothing alike in what they mean for Nestlé.

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
      // Themes first: naming what the article is about before judging it
      // steadies everything downstream.
      themes: {
        type: "ARRAY",
        // The closed vocabulary, enforced by the API rather than by the
        // prompt. This is the whole point: an off-list theme is not
        // discouraged, it is unrepresentable in the response.
        items: { type: "STRING", enum: themes.map((t) => t.name) },
        minItems: 1,
        maxItems: 3,
      },
      // BEFORE favourability and relevance, and that ordering is the entire
      // mechanism. propertyOrdering makes the model emit the evidence first,
      // so the grade is written with the rationale already on the page rather
      // than rationalised afterwards. Reverse these two and the forcing
      // function stops forcing anything.
      impact_rationale: { type: "STRING" },
      favourability: { type: "STRING", enum: [...SENTIMENT_TIERS] },
      relevance: { type: "INTEGER", minimum: 0, maximum: 100 },
      summary: { type: "STRING" },
    },
    required: [
      "themes",
      "impact_rationale",
      "favourability",
      "relevance",
      "summary",
    ],
    propertyOrdering: [
      "themes",
      "impact_rationale",
      "favourability",
      "relevance",
      "summary",
    ],
  };
}

/**
 * The 5-point favourability scale stored in articles.ai_sentiment.
 * Ordered worst to best so a UI can sort on the index. The five string values
 * are unchanged, so every downstream reader — week-stats, the newsletter, the
 * Analysis panel — keeps working without modification.
 */
export const SENTIMENT_TIERS = [
  "Very unfavourable",
  "Unfavourable",
  "Neutral",
  "Favourable",
  "Very favourable",
] as const;

export type SentimentTier = (typeof SENTIMENT_TIERS)[number];

/**
 * WHY THE ARITHMETIC WENT.
 *
 * The tier used to be computed: the model graded headline and body separately
 * as positive/neutral/negative, and sentimentTier() added them. That was built
 * for auditability — "headline positive, body negative, net zero, therefore
 * Neutral" is walkable in a way "the model said Neutral" is not — and the
 * reasoning still holds. It was replaced anyway, for two reasons.
 *
 * First, it was a direct cause of the barbell. With each component in
 * {+1, 0, -1}, 'Very unfavourable' needed only (negative, negative), which is
 * what a plainly bad headline over a plainly bad story produces every time.
 * The moderate tiers were reachable ONLY when headline and body disagreed —
 * an uncommon event — so the scale mathematically concentrated at its ends.
 * Measured: 42.2% 'Very unfavourable' against 6.8% 'Unfavourable'. No prompt
 * change could have fixed that, because it was arithmetic, not judgement.
 *
 * Second, the auditability it bought was of the wrong thing. It made the
 * COMBINATION auditable while leaving the two inputs as bare assertions. The
 * replacement — a required impact_rationale naming the affected lane, written
 * before the grade — audits the judgement itself, and a curator can check it
 * against the article. That is a stronger guarantee, not a weaker one.
 */

const TIER_SET: ReadonlySet<string> = new Set(SENTIMENT_TIERS);

function asTier(value: unknown): SentimentTier {
  if (typeof value === "string" && TIER_SET.has(value)) {
    return value as SentimentTier;
  }
  throw new Error(`Coding response had an invalid favourability: ${String(value)}`);
}

/** Clamped rather than rejected — the schema bounds it, this is the backstop. */
function asRelevance(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) {
    throw new Error(`Coding response had an invalid relevance: ${String(value)}`);
  }
  return Math.max(0, Math.min(100, Math.round(n)));
}

/**
 * The consistency rule from the prompt, enforced in code rather than trusted.
 *
 * "No nameable impact" is the single most common correct answer, and it is
 * also the one the model is most tempted to grade around — an upbeat crane
 * story reads as good news, and the pull towards 'Favourable' is exactly what
 * produced 'Very favourable' cranes in the first place. If the rationale says
 * there is no lane impact, the grade is Neutral and the score is capped,
 * whatever the model returned.
 */
const NO_IMPACT = /\b(no|not|does not|doesn't|cannot|can't|none)\b[^.]*\b(identifiable|specific|direct|nestl|aoa|lane|impact|effect|bearing|consequence)/i;

export function looksLikeNoImpact(rationale: string): boolean {
  return NO_IMPACT.test(rationale);
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
  tier: SentimentTier;
  relevance: number;
  impactRationale: string;
  themes: string[];
  summary: string;
};

type CodingResponse = {
  themes?: unknown;
  impact_rationale?: unknown;
  favourability?: unknown;
  relevance?: unknown;
  summary?: unknown;
};

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

  const impactRationale =
    typeof raw.impact_rationale === "string" ? raw.impact_rationale.trim() : "";
  if (!impactRationale) {
    throw new Error("Coding response returned an empty impact_rationale.");
  }

  let tier = asTier(raw.favourability);
  let relevance = asRelevance(raw.relevance);

  // Enforce the no-impact rule rather than trusting it. See looksLikeNoImpact.
  if (looksLikeNoImpact(impactRationale)) {
    if (tier !== "Neutral" || relevance >= 20) {
      console.warn(
        `[coding] rationale names no impact but graded ${tier}/${relevance}; forcing Neutral/<20 — "${impactRationale.slice(0, 120)}"`
      );
    }
    tier = "Neutral";
    relevance = Math.min(relevance, 19);
  }

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

  return { tier, relevance, impactRationale, themes: accepted, summary };
}

export type CodingBatchSummary = {
  processed: number;
  failed: number;
  /** Candidates left uncoded because the batch cap was hit. */
  remaining: number;
  byTier: Record<string, number>;
  byTheme: Record<string, number>;
  /** Relevance banded, so a run shows its magnitude spread not just its direction. */
  byRelevanceBand: Record<string, number>;
  errors: { articleId: string; error: string }[];
};

/** Bands match the anchors in the prompt, so the readout speaks the same scale. */
export function relevanceBand(score: number): string {
  if (score < 20) return "0-19  none";
  if (score < 40) return "20-39 indirect";
  if (score < 60) return "40-59 modest";
  if (score < 80) return "60-79 material";
  return "80-100 severe";
}

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
    byRelevanceBand: {},
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
        ai_relevance_score: result.relevance,
        impact_rationale: result.impactRationale,
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
    const band = relevanceBand(outcome.result.relevance);
    summary.byRelevanceBand[band] = (summary.byRelevanceBand[band] ?? 0) + 1;
    for (const theme of outcome.result.themes) {
      summary.byTheme[theme] = (summary.byTheme[theme] ?? 0) + 1;
    }
  }

  return summary;
}
