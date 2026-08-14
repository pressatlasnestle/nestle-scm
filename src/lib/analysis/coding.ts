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

/**
 * Which favourability methodology this file implements.
 *
 * Bumped whenever a change to SUBJECT, GRADE_ANCHORS, RELEVANCE_ANCHORS or the
 * no-impact rule would make a stored grade incomparable with a new one — which
 * is the only kind of change that justifies re-spending on a coded article.
 *
 *   1  the pre-628c50a arithmetic scale, and the 628c50a recode that replaced
 *      it: impact on Nestlé AOA, anchored five-point grade, separate 0-100
 *      relevance, impact_rationale as the forcing function.
 *   2  no methodology change of its own. The bump exists to force one full
 *      pass over a corpus that was never fully on version 1: 161 rows were
 *      recoded then, 114 arrived afterwards under the same prompt but were
 *      never checked against it, and the sorting stall meant a further cohort
 *      had never been coded at all. Same scale, applied to everything, once.
 *   3  the impact test gains a second limb. Version 2's test asked for a named
 *      lane, port, service or cost, which measured the presence of a proper
 *      noun rather than the presence of an impact — so market-wide news, which
 *      names no single lane precisely because it moves all of them, graded
 *      Neutral at relevance 15. It produced 74.3% Neutral and a relevance axis
 *      perfectly correlated with the tier. Market-wide movements are now
 *      impacts in their own right, with direction read from the movement;
 *      relevance is anchored on the size of the effect rather than on whether
 *      anything was named; and the prose-regex forcing function is replaced by
 *      the impact_kind enum.
 *
 * Stored per article, which is what makes a recode resumable — see
 * migration 20260814000033 and scripts/recode.ts.
 */
export const CODING_VERSION = 3;

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
 * THE IMPACT TEST, and why it needed a second limb.
 *
 * The previous version asked for a named lane, port, service or cost, on the
 * reasoning that a grade with nothing concrete behind it is a grade with
 * nothing behind it. That reasoning is sound and the rule still failed,
 * because it measured the wrong thing: it measured whether a PROPER NOUN was
 * present, and market-wide news names no single lane precisely BECAUSE it
 * affects all of them.
 *
 * The result, measured on 268 rows: 199 Neutral (74.3%), 197 of them scored
 * below relevance 20, and 98 rationales carried near-verbatim the same
 * sentence — "The article names no specific Nestlé AOA lane, port, service or
 * cost." Among the stories that sentence was applied to:
 *
 *   "Ocean freight market turns red hot, prompting freight rate rally"
 *   "Ocean freight: early peak season pushes container rates higher"
 *   "Asian port congestion forcing container lines back to the Red Sea"
 *   "Europe's early container peak puts Q4 freight rates at risk"
 *
 * The last of those carried the figure "global schedule reliability fell from
 * 64.5% in May to 62.6% in June" in its body and was still graded Neutral at
 * relevance 15. A quantified deterioration in the reliability of every service
 * Nestlé books was recorded as not mattering, because no berth was named.
 *
 * Rates rising across Asia-Europe names no one lane and matters more than most
 * stories that do. So the test now has two limbs, and the second is stated as
 * an equal rather than as a fallback — the model had been treating
 * absence-of-a-proper-noun as absence-of-impact, and a limb introduced with
 * "or, less strongly," would have been read the same way.
 */
const IMPACT_TEST = `An article names an impact when it identifies EITHER of these.
They are equally valid. The second is NOT a weaker version of the first.

  (a) SPECIFIC — a particular lane, port, terminal, carrier service, surcharge
      or cost. "Berth waiting at Colombo up two days." "Maersk raises its
      Middle East-Pakistan surcharge." "Durban terminal closed by strike."

  (b) MARKET-WIDE — a movement in freight rates, vessel capacity, schedule
      reliability, transit times, or routing, across trades Nestlé AOA
      actually uses (Asia-Europe, Intra-Asia, Asia-Middle East, Asia-Africa,
      Oceania, and the Suez / Red Sea / Cape of Good Hope corridors serving
      them). "Spot rates rally on Asia-Europe." "Global schedule reliability
      falls to 62.6%." "Carriers return to Red Sea routings." "Early peak
      season pushes container rates higher."

Limb (b) requires no proper noun and asking for one is an error. A market-wide
movement affects every lane Nestlé books rather than one of them, which makes
it broader in reach, not vaguer in substance. Do not write that an article
names no specific lane as a reason to call it Neutral when it reports a
market-wide movement — that observation is true and irrelevant.

OUTLOOKS AND FORECASTS. An article framed as an outlook, a forecast, or "what
shapes 2026" is not automatically speculation. Ask what it is built ON:

  * Built on a condition ALREADY IN EFFECT — Red Sea diversions now running,
    congestion now building, a rate trend now under way — the article is
    reporting that live condition and you grade the condition. "Red Sea
    disruption shapes the ocean freight outlook for 2026" reports that Red
    Sea disruption is ongoing and consequential: market_wide, Unfavourable.
  * Built on a condition that DOES NOT YET EXIST — a predicted recession, a
    regulation not yet in force, an orderbook delivering in three years — that
    is speculation and it is 'none'.

The word "outlook" tells you the framing, not the substance. Read past it.

An article fails BOTH limbs when it reports something that does not move
freight at all: a crane delivery, a vendor product integration, a standards
body membership, a fine or penalty on a carrier, corporate earnings, an
appointment, an award, a funding round, a shipbuilding order, a technology
pilot, a conference, or speculation about a year that has not started.`;

/**
 * Direction for market-wide movements, stated as a table.
 *
 * Spelled out because the model was reliably getting direction right for named
 * events and reliably defaulting to Neutral for market ones — having no rule
 * for which way a rate rise cuts, it declined to choose. Direction here is not
 * a judgement call: a cost increase to a shipper is unfavourable to the
 * shipper, whatever it does for the carrier's margins.
 */
const MARKET_DIRECTION = `  rates rising                            Unfavourable
  rates falling                           Favourable
  schedule reliability deteriorating      Unfavourable
  schedule reliability improving          Favourable
  congestion worsening at AOA ports       Unfavourable
  congestion easing at AOA ports          Favourable
  transit times lengthening               Unfavourable
  transit times shortening                Favourable
  capacity withdrawn from a trade         Unfavourable
  capacity added to a trade               Favourable
  routing forced onto a longer corridor   Unfavourable
  routing restored to a shorter corridor  Favourable

Read the direction from what MOVES, not from the tone of the coverage. A rate
rally is cheerful news for carriers and reported as such; it is a cost increase
to Nestlé and therefore Unfavourable.`;

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
const GRADE_ANCHORS = `Very unfavourable — a trade Nestlé AOA uses is severely
  disrupted, at scale, now.
    "Typhoon Dolphin Deepens China Port Congestion, Stranding 2.4M TEUs"
    "US forces strike containership Vela Nova in Gulf of Oman"

Unfavourable — a real cost, delay or reliability loss on those trades. Specific
  or market-wide; both belong here.
    "Maersk raises Middle East-Pakistan surcharge"          (specific)
    A named AOA port adding two days of berth waiting time. (specific)
    "Ocean freight: early peak season pushes container rates higher"
                                                            (market-wide)
    "Container shipping reliability slips as port congestion takes its toll"
                                                            (market-wide)
    "Asian port congestion forcing container lines back to the Red Sea"
                                                            (market-wide)

Neutral — the article does not move Nestlé's freight in EITHER direction.
  Two quite different things land here, and only the first is the common one:

  (i) it fails both limbs of the impact test. Most trade press is this.
    "MSC fined $6 million over Charleston vessel incident"
      — a penalty on a carrier, in a US port, with no AOA consequence.
    "PSA Antwerp adds new STS crane at Noordzee Terminal"
      — a single crane, in Europe, changing no transit time.
    "T-Mining joins DCSA+ to advance Secure Container Release standards"
      — an industry standards programme, years from any operational effect.
    "WaveBL integrates with Evergreen to expand electronic Bill of Lading
     adoption" — a documentation product integration.
    Appointments, awards, funding rounds, corporate results, shipbuilding
    orders, technology pilots, conference announcements, and forecasts about
    conditions that do not yet exist. An outlook built on a disruption
    already running is NOT one of these — see the impact test.

  (ii) it names a real, material effect that genuinely cuts BOTH WAYS, so no
    direction can honestly be assigned. This is uncommon but it is not empty,
    and such an article is Neutral with a HIGH relevance score — the direction
    is unresolved, the stakes are not.
    "Regulators open in-depth probe into carrier merger covering 12% of
     Asia-Europe capacity" — consolidation on a trade Nestlé uses would lift
     rates if cleared and leave the current network in place if blocked; both
     outcomes are live and material. Neutral, relevance 60.
    A strike ballot at a major AOA port before any vote is taken.
    A tariff proposal published for consultation, with no effective date.

Favourable — a real cost, delay or reliability improvement on those trades.
    Congestion easing at a named AOA port.                  (specific)
    A carrier restoring a suspended AOA service.            (specific)
    "Spot rates fall as Asia-Europe capacity returns"       (market-wide)

Very favourable — a trade Nestlé AOA uses materially improves, at scale.
    "Red Sea transits resuming at scale"

Neutral is the default for (i) and must NEVER be reached by way of "no single
lane is named". If the article reports a market-wide movement, grade the
movement.`;

/**
 * Anchors for the magnitude axis.
 *
 * Kept numeric and separate because direction and magnitude are genuinely
 * different questions, and forcing one five-point field to answer both is what
 * collapsed the old distribution into a barbell: with nowhere to say "bad but
 * trivial", every piece of bad news reached for the bottom of the scale.
 */
const RELEVANCE_ANCHORS = `  80-100 A trade Nestlé AOA uses is disrupted RIGHT NOW, at scale.
         Millions of TEUs held, a corridor closed, region-wide capacity loss.
  60-79  A material cost or reliability change on those trades. A rate rally
         across a Nestlé trade. Global schedule reliability moving several
         points. A surcharge on a lane Nestlé books. A major carrier merger
         under regulatory challenge on an Asia-Europe trade.
  40-59  A real but bounded effect, OR a strong signal about the near term.
         An early peak season pushing rates. Congestion building at one AOA
         port. A capacity change on one string.
  20-39  Industry context that informs planning without changing it.
         Orderbook totals, a forecast about conditions not yet in effect, a
         regulation years from effect, a survey of carrier sentiment.
  0-19   No bearing on moving Nestlé's containers. A crane, a fine, an
         appointment, an award, a vendor integration, a standards body.

Score the SIZE of the effect, not whether a proper noun appeared. "Spot rates
across Asia-Europe rally 30%" names no lane and is a 60-79; "Antwerp takes
delivery of a crane" names two proper nouns and is a 0-19.

Reserve 90+ for events measured in millions of TEUs, closed corridors, or
region-wide capacity loss.`;

function buildSystemPrompt(themes: ThemeOption[]): string {
  const catalogue = themes
    .map((t) => `- ${t.name}: ${t.description ?? "(no guidance supplied)"}`)
    .join("\n");

  return `You are coding ocean-freight news articles for Nestlé's supply chain
media intelligence. You do five things, IN THIS ORDER: assign themes, name the
impact, classify what kind of impact it is, grade it, and write a summary.

THEMES. Assign 1-3 themes from the fixed list below, most important first.

You may ONLY use these exact names. The list is the vocabulary; there is no
option to invent one. Each entry states what the bucket means and where its
boundaries lie — read the guidance, do not pattern-match the name.

${catalogue}

Assign a second or third theme only when the article genuinely spans them.
Two weakly-relevant themes are worse than one accurate one.

IMPACT RATIONALE. One sentence. Write this BEFORE you grade, and grade from it.

Everything below is judged against ${SUBJECT}

${IMPACT_TEST}

Write what the article says MOVES. Name the thing and, where the article gives
one, the number: "spot rates on Asia-Europe rallying ahead of an early peak",
"global schedule reliability down from 64.5% to 62.6%", "berth waiting at
Colombo up two days", "carriers returning to Red Sea routings".

This applies EVEN WHEN THE ANSWER IS NEUTRAL. "No impact" on its own is not a
rationale — it describes your conclusion instead of the evidence for it. Write
what the article reports and why that does not move Nestlé's freight:

  BAD   "The article names no specific Nestlé AOA lane, port, service or cost."
  GOOD  "Reports a crane delivery at PSA Antwerp, changing no AOA service."
  GOOD  "Reports MSC's $6m US penalty, which alters no AOA rate or routing."
  BAD   "No identifiable effect on Nestlé AOA container movement."
  GOOD  "Reports Q3 earnings at Hapag-Lloyd, with no rate or capacity change."

Do not manufacture an impact to justify a grade, and do not reach for a stock
phrase to avoid one. The sentence is evidence for the grade, not decoration
on it.

IMPACT KIND. Classify the rationale you just wrote, as one of:

  specific     limb (a) — a named lane, port, terminal, service, surcharge, cost
  market_wide  limb (b) — a movement in rates, capacity, reliability, transit
               times or routing across trades Nestlé AOA uses
  none         neither limb — the article does not move Nestlé's freight

Choose 'none' only when the article genuinely fails BOTH limbs. A story about
rates, capacity, reliability, transit times or routing on Nestlé's trades is
'market_wide' even though it names no single lane. Getting this wrong is the
single most consequential error available to you: 'none' forces the grade to
Neutral and the score below 20.

FAVOURABILITY — direction only. Which way does it move Nestlé's AOA container
movement? Magnitude is a separate field; do not let a big number pull the
direction, or a strong direction inflate the number.

${GRADE_ANCHORS}

For a market_wide impact, direction follows from the movement:

${MARKET_DIRECTION}

RELEVANCE — magnitude, 0-100. How much does this matter to Nestlé AOA?

${RELEVANCE_ANCHORS}

DIRECTION AND MAGNITUDE ARE INDEPENDENT AXES. Decide them separately.

  * A carrier's $6m US fine is Neutral and 5. No direction, no size.
  * A typhoon stranding 2.4M TEUs is Very unfavourable and 95.
  * A merger probe on 12% of Asia-Europe capacity is Neutral and 60 — the
    stakes are large, the direction is genuinely unresolved.
  * A minor surcharge on one small string is Unfavourable and 30 — the
    direction is clear, the size is small.

The last two are the ones to watch. Neutral does not mean unimportant, and a
clear direction does not mean large. If every Neutral you assign scores under
20 and everything you score over 40 has a direction, you are reading one axis
off the other and reporting it twice.

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
      // Between the rationale and the grade, in that order for a reason. The
      // model states the evidence, classifies it against the two-limb test,
      // and only then grades — so the classification is derived from the
      // sentence rather than the sentence being written to fit it.
      impact_kind: { type: "STRING", enum: [...IMPACT_KINDS] },
      favourability: { type: "STRING", enum: [...SENTIMENT_TIERS] },
      relevance: { type: "INTEGER", minimum: 0, maximum: 100 },
      summary: { type: "STRING" },
    },
    required: [
      "themes",
      "impact_rationale",
      "impact_kind",
      "favourability",
      "relevance",
      "summary",
    ],
    propertyOrdering: [
      "themes",
      "impact_rationale",
      "impact_kind",
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
 * Which limb of the impact test the article satisfies.
 *
 * WHY THIS REPLACED A REGEX. The consistency rule used to be enforced by
 * pattern-matching the rationale prose:
 *
 *   /\b(no|not|does not|...)\b[^.]*\b(identifiable|specific|direct|nestl|aoa|
 *     lane|impact|effect|bearing|consequence)/i
 *
 * It was built to stop an upbeat crane story climbing the scale, and it did.
 * It also did far more than that, in two ways that only became visible at 268
 * rows.
 *
 * First, it rewarded a stock phrase. The surest way to satisfy the prompt's
 * "say so plainly" instruction was to write "the article names no specific
 * Nestlé AOA lane, port, service or cost", and 98 of 268 rationales did,
 * near-verbatim. Once a sentence is that reliable it stops being reasoning and
 * becomes a token the model reaches for.
 *
 * Second — and this is what made it dangerous under the new two-limb test — it
 * matched an OBSERVATION, not a CONCLUSION. "Spot rates are rallying across
 * Asia-Europe, though no single lane is named" is a perfectly correct
 * Unfavourable rationale, and that regex would have caught the trailing clause
 * and forced it to Neutral/19. Widening the impact test while keeping the
 * regex would have produced correct grades silently overwritten on their way
 * to the database.
 *
 * An enum cannot be reached for by accident and cannot be triggered by a
 * subordinate clause. The model has to commit to a classification, that
 * classification is stored, and the forcing rule reads it rather than guessing
 * at English.
 */
export const IMPACT_KINDS = ["specific", "market_wide", "none"] as const;

export type ImpactKind = (typeof IMPACT_KINDS)[number];

const IMPACT_KIND_SET: ReadonlySet<string> = new Set(IMPACT_KINDS);

function asImpactKind(value: unknown): ImpactKind {
  if (typeof value === "string" && IMPACT_KIND_SET.has(value)) {
    return value as ImpactKind;
  }
  throw new Error(`Coding response had an invalid impact_kind: ${String(value)}`);
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
  impactKind: ImpactKind;
  themes: string[];
  summary: string;
};

type CodingResponse = {
  themes?: unknown;
  impact_rationale?: unknown;
  impact_kind?: unknown;
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

  const impactKind = asImpactKind(raw.impact_kind);
  let tier = asTier(raw.favourability);
  let relevance = asRelevance(raw.relevance);

  // The one hard rule left. 'none' means the article fails both limbs of the
  // impact test, and an article that moves nothing cannot have a direction or
  // a magnitude. Kept because it is what stops an upbeat crane story climbing
  // the scale — the original failure this file was written to fix.
  //
  // Note what is NOT forced. A 'specific' or 'market_wide' article is free to
  // be Neutral (a two-sided event) and free to score low (a small effect).
  // Adding rules there would re-fuse the axes from the other direction, which
  // is how the last correction over-corrected.
  if (impactKind === "none") {
    if (tier !== "Neutral" || relevance >= 20) {
      console.warn(
        `[coding] impact_kind=none but graded ${tier}/${relevance}; forcing Neutral/<20 — "${impactRationale.slice(0, 120)}"`
      );
    }
    tier = "Neutral";
    relevance = Math.min(relevance, 19);
  } else if (relevance < 20) {
    // Warned, never corrected. An article that moves rates on a Nestlé trade
    // and scores 12 is probably a misclassification, but "probably" is not
    // grounds for overwriting a judgement — and a silent correction here would
    // hide exactly the calibration signal this warning exists to surface.
    console.warn(
      `[coding] impact_kind=${impactKind} but relevance ${relevance} (<20, the "no bearing" band) — "${impactRationale.slice(0, 120)}"`
    );
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

  return {
    tier,
    relevance,
    impactRationale,
    impactKind,
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
  /** Relevance banded, so a run shows its magnitude spread not just its direction. */
  byRelevanceBand: Record<string, number>;
  /**
   * Which limb of the impact test carried each article.
   *
   * Reported because the two-limb test is the change being trusted here, and
   * a rule nobody can count is a rule nobody can check. If market_wide comes
   * back near zero, the second limb is being ignored and the corpus is back
   * where it started — with the difference that this number says so.
   */
  byImpactKind: Record<string, number>;
  /**
   * tier → relevance band → count.
   *
   * The tier table alone hid the real defect last time: it showed a plausible
   * spread of grades while every Neutral sat under 20 and everything else sat
   * over 20, so relevance was being read off the tier rather than measured.
   * A cross-tabulation makes that visible in the shape of the table instead of
   * requiring someone to think to ask.
   */
  crossTab: Record<string, Record<string, number>>;
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
  /**
   * Carried purely so assertSorted() can check it. Not used to code anything.
   *
   * On the type rather than looked up inside codeArticles() on purpose: a
   * caller must SELECT it, which means a new caller cannot accidentally
   * assemble a row that skips the check — the compiler asks for the column
   * before the assertion ever runs.
   */
  ai_sorting_status: string | null;
};

/** Columns every coding caller must select. One list, so they cannot drift. */
export const CODABLE_COLUMNS =
  "id, headline, body, matched_keywords, ai_sorting_status";

/**
 * The relevance gate, enforced at the point of spending money.
 *
 * coding-batch.ts already filters on ai_sorting_status = 'complete', and that
 * filter is the mechanism; this is the assertion that the mechanism is
 * present. The distinction matters because the previous version of that filter
 * looked correct and was not — `not(ai_sorting_flagged is true)` reads like a
 * gate and lets every unsorted row through, which is how 28 articles were
 * coded without ever being screened. A query condition can be quietly wrong.
 * A thrown error cannot be quietly wrong.
 *
 * It throws rather than filtering. Silently dropping the offending rows would
 * make a caller with a broken selection look like a caller with less work to
 * do, which is the exact failure being guarded against: the bug was invisible
 * for days because nothing complained. This complains.
 *
 * Applies to every path — the panel, the CLI, the recode — because it lives
 * here rather than in any one of their selections.
 */
export function assertSorted(rows: CodableArticle[]): void {
  const unsorted = rows.filter((r) => r.ai_sorting_status !== "complete");
  if (unsorted.length === 0) return;

  throw new Error(
    `Coding was handed ${unsorted.length} article(s) that have not been through Stage 1 sorting ` +
      `(ai_sorting_status: ${[...new Set(unsorted.map((r) => r.ai_sorting_status ?? "null"))].join(", ")}). ` +
      `Coding is gated on sorting: an article of unjudged relevance must not be graded for its impact. ` +
      `Run 'npm run sort' first. Offending ids: ${unsorted.slice(0, 5).map((r) => r.id).join(", ")}` +
      `${unsorted.length > 5 ? ` (+${unsorted.length - 5} more)` : ""}.`
  );
}

export function emptyCodingSummary(): CodingBatchSummary {
  return {
    processed: 0,
    failed: 0,
    remaining: 0,
    byTier: {},
    byTheme: {},
    byRelevanceBand: {},
    byImpactKind: {},
    crossTab: {},
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

  // Before loadActiveThemes(), before any Gemini call: a selection that got
  // past its own filter should cost nothing to reject.
  assertSorted(rows);

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
        impact_kind: result.impactKind,
        ai_themes: result.themes,
        ai_summary: result.summary,
        coded_status: "coded",
        // Stamped here rather than by the recode, so EVERY path that codes an
        // article records which methodology produced it. A version written
        // only by the recode would leave normal coding runs indistinguishable
        // from pre-versioning rows, and the next recode would redo them for
        // no reason.
        coding_version: CODING_VERSION,
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
    const kind = outcome.result.impactKind;
    summary.byImpactKind[kind] = (summary.byImpactKind[kind] ?? 0) + 1;
    summary.crossTab[tier] ??= {};
    summary.crossTab[tier][band] = (summary.crossTab[tier][band] ?? 0) + 1;
    for (const theme of outcome.result.themes) {
      summary.byTheme[theme] = (summary.byTheme[theme] ?? 0) + 1;
    }
  }

  return summary;
}
