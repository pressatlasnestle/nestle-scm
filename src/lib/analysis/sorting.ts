import { generateJson, mapWithConcurrency, type JsonSchema } from "./gemini";
import type { AnalysisClient } from "./models";

/**
 * Stage 1 — sorting. A relevance judgement, not a second keyword pass.
 *
 * match.ts already decided this article was captured: a Gate 1 domain anchor
 * AND a Gate 2 topic term both appeared, and no exclusion term suppressed it.
 * That is a lexical test and it is deliberately blunt — it cannot tell
 * "Maersk raises Asia-Europe rates" from "Maersk's share price target lifted",
 * because both contain the same terms.
 *
 * This stage asks the question the regex cannot: given what the article is
 * actually ABOUT, does it belong in an ocean-freight intelligence corpus?
 *
 * It annotates and nothing more. articles.status is never touched here, so a
 * flagged article stays 'active' and fully visible in the panel — the analyst
 * decides what to do about it. No exclusion happens in this file.
 */

/** Articles sorted at once. Bounded so a large run doesn't burst the API. */
const SORT_CONCURRENCY = 4;

/**
 * Body characters sent per article. Well past the point where more text
 * changes a relevance call, and it caps the cost of the occasional very long
 * feature. The headline is always sent in full.
 */
const MAX_BODY_CHARS = 6_000;

/**
 * The vertical's scope, written from the live keyword taxonomy rather than
 * invented here — Gate 1/Gate 2 clusters give the in-scope list, the Exclusion
 * clusters give the out-of-scope one. If the taxonomy moves, this should move
 * with it.
 */
const SCOPE = `The corpus tracks CONTAINER / LINER OCEAN FREIGHT as a supply-chain
intelligence beat. An article is IN SCOPE when its substance concerns any of:

- Container carriers and their alliances (Maersk, MSC, CMA CGM, Hapag-Lloyd,
  COSCO/OOCL, Evergreen, ONE, HMM, ZIM, Yang Ming, PIL, Wan Hai; Gemini
  Cooperation, Ocean Alliance, Premier Alliance, 2M/THE Alliance)
- Container ports and terminal operators, throughput, congestion, berth and
  yard performance, dwell times
- Ocean freight rates and commercial terms (spot and contract rates, GRIs,
  surcharges, demurrage, indices such as SCFI/WCI/FBX/Xeneta)
- Schedule reliability: blank sailings, port omissions, service rotation
  changes, transit times, vessel bunching, rolled cargo
- Capacity and fleet: orderbook, newbuildings, scrapping, idle fleet,
  overcapacity, ULCVs
- Chokepoints and routing: Suez, Panama, Red Sea/Bab al-Mandeb, Hormuz,
  Malacca, Cape of Good Hope reroutings, transit advisories
- Disruption affecting container movement: port strikes and labour talks,
  weather closures, vessel fires, groundings, containers overboard, piracy,
  drone/missile attacks on shipping, cyberattacks on carriers or ports,
  sanctions and vessel detentions
- Regulation and decarbonisation as they bear on container shipping (IMO,
  MEPC, EU ETS maritime, FuelEU, CII/EEXI, alternative bunker fuels)
- Trade policy and customs where it moves containerised cargo (tariffs,
  Section 301 / USTR port fees, de minimis, export restrictions)
- Freight forwarders, NVOCCs, BCOs, bills of lading, FCL/LCL

An article is OUT OF SCOPE when its substance is really about:

- Other maritime sectors: tankers, crude/VLCC freight, dry bulk, cruise and
  passenger ferries, fishing, naval or military vessels, offshore energy
  (rigs, FPSOs, offshore wind), yachts and recreational boating
- An equity or investor story that merely uses a carrier as its subject —
  share price, price targets, dividends, EPS, IPOs, "is X a buy"
- Corporate PR with no operational content: appointments, promotions, awards,
  board changes, hiring and recruitment
- Marketing and trade-press filler: webinars, whitepapers, sponsored content,
  advertorials, "ultimate guide" / listicle explainers, calls for papers
- A homonym rather than the real thing: software containers (Docker, container
  images), shipping containers repurposed as homes/cafes/storage, e-commerce
  "free shipping" fees, fandom "shipping", TCP/USB ports, mobile or insurance
  carriers, road fleet management, terminal illness, port wine
- Purely historical or commemorative maritime content`;

const SYSTEM = `You screen news articles for an ocean-freight media monitoring corpus.

${SCOPE}

You judge SUBSTANCE, not vocabulary. These articles were captured by a keyword
matcher, so the right terms are present by construction — that tells you nothing.
Ask what the article is actually about.

Critical instruction about short inputs. Most items in this corpus are a
headline plus a short snippet, because they arrive from news alerts and
aggregators rather than as full text. Thin input is NORMAL and is NOT by itself
a reason to flag. Judge on the evidence you have. If a headline plainly
describes an in-scope event, that is sufficient — do not ask for more text.
Flag only when the evidence actually present points AWAY from scope. When the
available evidence is genuinely ambiguous, treat the article as in scope: this
is an advisory flag for a human reviewer, and flagging everything uncertain
would make it useless.

Write reasoning as one sentence, concrete and specific to this article. Name
what the article is about and why that is or isn't ocean freight. Never write
"insufficient information" or restate these instructions.`;

const SCHEMA: JsonSchema = {
  type: "OBJECT",
  properties: {
    // Ordered first on purpose: the model commits to a justification before it
    // commits to a verdict, which measurably steadies borderline calls.
    reasoning: { type: "STRING" },
    in_scope: { type: "BOOLEAN" },
  },
  required: ["reasoning", "in_scope"],
  propertyOrdering: ["reasoning", "in_scope"],
};

export type SortingVerdict = {
  /** true = the AI questions whether this belongs in the corpus. */
  flagged: boolean;
  reasoning: string;
};

type SortingResponse = { reasoning?: string; in_scope?: boolean };

/**
 * Judges one article. Exported on its own so the prompt can be exercised
 * against real text without touching the database — the same reason
 * matchArticle() and fetchArticlesPage() are exported.
 */
export async function sortArticle(
  client: AnalysisClient,
  headline: string,
  body: string | null
): Promise<SortingVerdict> {
  const snippet = (body ?? "").trim().slice(0, MAX_BODY_CHARS);

  const prompt = [
    `HEADLINE: ${headline}`,
    snippet
      ? `BODY: ${snippet}`
      : "BODY: (none supplied — judge from the headline alone)",
  ].join("\n\n");

  const raw = await generateJson<SortingResponse>(client, "sorting", {
    system: SYSTEM,
    prompt,
    schema: SCHEMA,
  });

  if (typeof raw.in_scope !== "boolean") {
    throw new Error("Sorting response omitted in_scope.");
  }

  return {
    flagged: !raw.in_scope,
    reasoning: (raw.reasoning ?? "").trim() || "(no reasoning returned)",
  };
}

export type SortingBatchSummary = {
  processed: number;
  flagged: number;
  confirmed: number;
  failed: number;
  errors: { articleId: string; error: string }[];
};

type PendingArticle = { id: string; headline: string; body: string | null };

/**
 * Sorts a specific set of articles by id. Used by the post-ingestion hook,
 * which knows exactly which rows its run inserted.
 *
 * Rows already marked complete are skipped, so calling this twice over the
 * same ids is free — the same idempotency the backfill relies on.
 */
export async function sortArticles(
  client: AnalysisClient,
  articleIds: string[]
): Promise<SortingBatchSummary> {
  if (articleIds.length === 0) return emptySummary();

  const { data, error } = await client
    .from("articles")
    .select("id, headline, body")
    .in("id", articleIds)
    .eq("ai_sorting_status", "pending");

  if (error) throw new Error(`Could not load articles to sort: ${error.message}`);
  return sortRows(client, data ?? []);
}

/**
 * Sorts everything still pending, oldest first. This is the backfill path
 * (`npm run sort`), and it exists because the articles already captured
 * predate the sorting engine.
 */
export async function sortPendingArticles(
  client: AnalysisClient,
  limit = 500
): Promise<SortingBatchSummary> {
  const { data, error } = await client
    .from("articles")
    .select("id, headline, body")
    .eq("ai_sorting_status", "pending")
    .order("ingested_at", { ascending: true })
    .limit(limit);

  if (error) throw new Error(`Could not load pending articles: ${error.message}`);
  return sortRows(client, data ?? []);
}

function emptySummary(): SortingBatchSummary {
  return { processed: 0, flagged: 0, confirmed: 0, failed: 0, errors: [] };
}

async function sortRows(
  client: AnalysisClient,
  rows: PendingArticle[]
): Promise<SortingBatchSummary> {
  const summary = emptySummary();
  if (rows.length === 0) return summary;

  const outcomes = await mapWithConcurrency(rows, SORT_CONCURRENCY, async (row) => {
    const verdict = await sortArticle(client, row.headline, row.body);

    // Written per article rather than batched at the end: a run that dies
    // halfway should keep the judgements it already paid for, and the next
    // run picks up exactly what is still pending.
    const { error } = await client
      .from("articles")
      .update({
        ai_sorting_status: "complete",
        ai_sorting_flagged: verdict.flagged,
        ai_sorting_reasoning: verdict.reasoning,
      })
      .eq("id", row.id);

    if (error) throw new Error(`Could not save verdict: ${error.message}`);
    return verdict;
  });

  for (const outcome of outcomes) {
    if (outcome.error !== null || !outcome.result) {
      summary.failed += 1;
      summary.errors.push({
        articleId: outcome.item.id,
        error: outcome.error ?? "Unknown sorting failure.",
      });
      continue;
    }
    summary.processed += 1;
    if (outcome.result.flagged) summary.flagged += 1;
    else summary.confirmed += 1;
  }

  return summary;
}
