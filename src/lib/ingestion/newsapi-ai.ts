import { loadKeywords } from "./match";
import {
  ingestItems,
  emptyCounters,
  type RunCounters,
  type RunError,
  type RunSummary,
} from "./run";
import type { FeedItem, IngestionClient } from "./types";

/**
 * newsapi.ai (Event Registry) sweep — aggregator coverage for the sources that
 * have no usable public feed. Replaces the NewsData.io sweep entirely.
 *
 * This is a different API in every respect, not a renamed one: POST with a JSON
 * body rather than GET with query params, `apiKey` in the body, `sourceUri` as
 * an array with no per-request cap, and native `dateStart`/`dateEnd` filtering.
 * Everything below was measured against the live API on 2026-08-11, and every
 * NewsData number it replaces turned out not to carry over.
 *
 *   * `body` is the FULL ARTICLE TEXT — 304 to 12,377 characters, median 4,294
 *     across a 16-article sample. NewsData's free tier returned a ~320-char
 *     description and put the literal string "ONLY AVAILABLE IN PAID PLANS" in
 *     its content field. There is no such marker here and no truncation to work
 *     around, so the matcher finally sees whole articles rather than summaries.
 *     That cuts both ways and is worth knowing: exclusion terms now have far
 *     more surface to hit, so suppression rates are not comparable to the RSS
 *     channel's.
 *
 *   * There is NO embargo. The newest article returned was 0.35h old, and 0.41h
 *     in a second sample. NewsData's free tier never returned anything under
 *     12h, which is the only reason its sweep needed a 48-hour window. That
 *     number does not carry over and is not reused — see WINDOW_DAYS.
 *
 *   * `dateTimePub` and `dateTime` are two genuinely different clocks, the same
 *     shape NewsData's pubDate/fetched_at had. dateTime (Event Registry's crawl)
 *     ran 0.01-3.51h after dateTimePub (publication) across the sample, never
 *     before it. So dateTimePub is the publication time and is what windowing
 *     uses.
 *
 *   * `isDuplicate` is a real boolean, and visibly working: the sample held two
 *     copies of one China Daily story with identical body lengths, one flagged.
 *     It is counted and logged and then ignored for dedup, exactly as
 *     NewsData's flag was — it is the aggregator's judgement about its own
 *     corpus, not about what we already hold.
 *
 *   * `source` carries BOTH `uri` (the domain) and `title` (the display name):
 *     "reuters.com" / "Reuters", "ft.com" / "Financial Times News". The display
 *     name is what lands in articles.media, and that matters more than it
 *     looks: media is a dedup fingerprint component, so storing the bare domain
 *     would give the same story a different fingerprint here than it gets from
 *     the publisher's own RSS feed, and the cross-channel priority rule would
 *     never fire.
 *
 * Coverage improved sharply. Probing all 40 gap-source candidate domains
 * through /suggestSourcesFast returned 17 as known, against NewsData's 9, and
 * it is a strict superset — nothing that worked before was lost. The eight
 * newly reachable are ambrey.com, drewry.co.uk, lloydslist.com,
 * portofrotterdam.com, hafen-hamburg.de, shippingwatch.com, unctad.org and
 * xeneta.com. Four of those (Lloyd's List, Drewry, ShippingWatch, Xeneta) are
 * exactly the paywalled T1b trade press NewsData could not see at all.
 *
 * Still unknown, and so still uncovered by any channel: alphaliner.com,
 * linerlytica.com, sea-intelligence.com, freightos.com, bimco.org,
 * ics-shipping.org, worldshipping.org, mpa.gov.sg, jnport.gov.in, dpworld.com,
 * globalpsa.com, apmterminals.com, adaniports.com, portofantwerpbruges.com,
 * suezcanal.gov.eg, kuehne-nagel.com, dsv.com, flexport.com, and the four
 * carrier newsrooms. Corporate and institutional newsrooms remain the gap.
 */

const ENDPOINT = "https://eventregistry.org/api/v1/article/getArticles";
const FETCH_TIMEOUT_MS = 20_000;

/**
 * Seven days, matching the backfill window rather than NewsData's 48 hours.
 * That 48 was never a considered choice — it was the smallest window that could
 * clear a 12-hour embargo with room to spare. There is no embargo here, so the
 * window is a real decision again, and a manually-triggered gap-filling sweep
 * wants the same reach as the backfill it complements. Overlap stays free: the
 * dedup fingerprint absorbs it.
 */
const WINDOW_DAYS = 7;

/**
 * Gate 1 anchors, OR-ed. Article bodies are full text here, so an unanchored
 * query over Reuters and the BBC would return their entire output; the anchor
 * set keeps the request on-topic and the matcher applies the second gate
 * afterwards. No length limit to work around — unlike NewsData's 100-character
 * q, these go over as a JSON array.
 */
const ANCHORS = [
  "container shipping",
  "ocean freight",
  "liner shipping",
  "sea freight",
  "shipping line",
];

/** Event Registry accepts up to 100 articles per page; verified at 100. */
const ARTICLES_PER_PAGE = 100;

/**
 * Page cap. `pages` in the response says how many there really are, so hitting
 * this means coverage was truncated and the run reports it rather than
 * quietly returning less than it could have.
 */
const MAX_PAGES = 10;

type EventRegistrySource = {
  uri?: string;
  title?: string;
};

type EventRegistryArticle = {
  uri?: string;
  url?: string;
  title?: string;
  body?: string;
  /** Publication time. */
  dateTimePub?: string | null;
  /** Event Registry's own crawl time — always at or after dateTimePub. */
  dateTime?: string | null;
  source?: EventRegistrySource;
  authors?: { name?: string }[] | null;
  isDuplicate?: boolean;
  lang?: string;
};

type EventRegistryResponse = {
  articles?: {
    results?: EventRegistryArticle[];
    totalResults?: number;
    page?: number;
    pages?: number;
  };
  error?: string | string[];
};

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

function countWords(text: string): number {
  return text ? text.split(/\s+/).filter(Boolean).length : 0;
}

function parseWhen(article: EventRegistryArticle): Date | null {
  const raw = article.dateTimePub ?? article.dateTime;
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export type MappedItem = { item: FeedItem; duplicateFlag: boolean };

/**
 * One API article to a FeedItem. Returns null for anything with no headline or
 * no body, matching the RSS path's contract: a stub is skipped, never stored.
 */
export function mapArticle(article: EventRegistryArticle): MappedItem | null {
  const headline = (article.title ?? "").trim();
  const body = (article.body ?? "").trim();
  if (!headline || !body) return null;

  const byline =
    (article.authors ?? [])
      .map((a) => (a?.name ?? "").trim())
      .filter(Boolean)
      .join(", ") || null;

  return {
    duplicateFlag: article.isDuplicate === true,
    item: {
      headline,
      url: article.url ?? null,
      byline,
      // Display name, never the bare domain — see the header note on media as a
      // fingerprint component.
      media: article.source?.title ?? article.source?.uri ?? null,
      publishedAt: parseWhen(article),
      body,
      wordCount: countWords(body),
    },
  };
}

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

/**
 * One page of results. Exported like fetch.ts exports fetchFeedXml — it is the
 * network unit, and being able to call it without a database is what let the
 * body/date/duplicate behaviour above be measured rather than assumed.
 */
export async function fetchArticlesPage(
  apiKey: string,
  sourceUris: string[],
  windowStart: Date,
  page: number
): Promise<EventRegistryResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
      signal: controller.signal,
      body: JSON.stringify({
        action: "getArticles",
        keyword: ANCHORS,
        keywordOper: "or",
        keywordLoc: "body,title",
        sourceUri: sourceUris,
        lang: "eng",
        dateStart: windowStart.toISOString().slice(0, 10),
        articlesPage: page,
        articlesCount: ARTICLES_PER_PAGE,
        articlesSortBy: "date",
        // -1 asks for the untruncated body. Anything else silently costs the
        // matcher the text it exists to read.
        articlesArticleBodyLen: -1,
        resultType: "articles",
        dataType: ["news"],
        apiKey,
      }),
    });

    const payload = (await res.json()) as EventRegistryResponse;

    // Event Registry answers a bad key or a malformed query with HTTP 200 and
    // an `error` field, so the status code alone is not enough to trust.
    if (payload.error) {
      const message = Array.isArray(payload.error)
        ? payload.error.join("; ")
        : payload.error;
      throw new Error(message);
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);

    return payload;
  } finally {
    clearTimeout(timer);
  }
}

/** Loads the Vault-backed key. service_role only — see migration 19. */
async function loadApiKey(client: IngestionClient): Promise<string> {
  const { data, error } = await client.rpc("get_integration_secret", {
    p_provider: "news_aggregator",
  });
  if (error) {
    throw new Error(`Could not read the newsapi.ai key: ${error.message}`);
  }
  if (!data) {
    throw new Error(
      "No newsapi.ai key is set. Add it under Integrations → news_aggregator."
    );
  }
  return data;
}

export type DomainTarget = { sourceId: string; name: string; domains: string[] };

/**
 * Gap sources with aggregator coverage: active, positive, no usable feed of
 * their own, and a website_domain recorded. website_domain may list several
 * publishers for one row, so it is split on commas.
 */
export async function selectDomainTargets(
  client: IngestionClient
): Promise<DomainTarget[]> {
  const { data, error } = await client
    .from("sources")
    .select("id, name, rss_url, website_domain, list_type, is_active")
    .eq("is_active", true)
    .eq("list_type", "positive")
    .not("website_domain", "is", null)
    .order("name");

  if (error) throw new Error(`Failed to load gap sources: ${error.message}`);

  return (data ?? [])
    .filter((row) => !row.rss_url || !row.rss_url.trim())
    .map((row) => ({
      sourceId: row.id,
      name: row.name,
      domains: (row.website_domain ?? "")
        .split(",")
        .map((d) => d.trim())
        .filter(Boolean),
    }))
    .filter((target) => target.domains.length > 0);
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

export async function runNewsApiAiSweep(
  client: IngestionClient,
  triggeredBy: string | null = null
): Promise<RunSummary> {
  const end = new Date();
  const start = new Date(end.getTime() - WINDOW_DAYS * 24 * 3600 * 1000);

  const counters = emptyCounters();
  const errors: RunError[] = [];

  const { data: runRow } = await client
    .from("ingestion_runs")
    .insert({
      run_type: "newsapi_ai_sweep",
      window_start: start.toISOString(),
      window_end: end.toISOString(),
      status: "running",
      triggered_by: triggeredBy,
    })
    .select("id")
    .single();
  const runId = runRow?.id ?? null;

  let apiKey: string;
  let targets: DomainTarget[];
  try {
    [apiKey, targets] = await Promise.all([
      loadApiKey(client),
      selectDomainTargets(client),
    ]);
  } catch (err) {
    return finish(client, runId, counters, [
      {
        source: "(newsapi.ai setup)",
        sourceId: null,
        error: err instanceof Error ? err.message : String(err),
      },
    ]);
  }

  // sourceUri takes the whole set at once — there is no per-request domain cap
  // to batch around, unlike NewsData's five.
  const domains = [...new Set(targets.flatMap((t) => t.domains))];
  counters.sourcesChecked = domains.length;

  if (domains.length === 0) {
    console.warn(
      "[newsapi.ai] no gap sources have a website_domain set — nothing to sweep."
    );
    return finish(client, runId, counters, errors);
  }

  const keywords = await loadKeywords(client);
  let flaggedDuplicate = 0;
  let truncated = false;

  try {
    let page = 1;
    let totalPages = 1;

    while (page <= totalPages && page <= MAX_PAGES) {
      const payload = await fetchArticlesPage(apiKey, domains, start, page);
      totalPages = payload.articles?.pages ?? 1;

      const articles = payload.articles?.results ?? [];
      if (articles.length === 0) break;

      const items: FeedItem[] = [];
      for (const article of articles) {
        const mapped = mapArticle(article);
        if (!mapped) {
          // No headline, or no body text at all.
          counters.articlesSkippedPaywall += 1;
          continue;
        }
        if (mapped.duplicateFlag) flaggedDuplicate += 1;

        // dateStart is a calendar day, so the first and last day of the range
        // come back whole; the exact bounds are enforced here. Undated items
        // are kept, matching the RSS path — see FeedItem.publishedAt.
        const at = mapped.item.publishedAt;
        if (at && (at < start || at > end)) continue;

        items.push(mapped.item);
      }

      await ingestItems(client, items, null, keywords, counters, "newsapi_ai");
      page += 1;
    }

    if (totalPages > MAX_PAGES) {
      truncated = true;
      errors.push({
        source: "newsapi.ai",
        sourceId: null,
        error: `Stopped at the ${MAX_PAGES}-page cap with ${totalPages} pages available — coverage is incomplete.`,
      });
    }
  } catch (err) {
    errors.push({
      source: "newsapi.ai",
      sourceId: null,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Logged, never acted on. See the header note on isDuplicate.
  console.log(
    `[newsapi.ai] ${flaggedDuplicate} of ${counters.articlesFound} items carried the isDuplicate flag; our fingerprint dedup ran on all of them.` +
      (truncated ? " Page cap reached." : "")
  );

  return finish(client, runId, counters, errors);
}

async function finish(
  client: IngestionClient,
  runId: string | null,
  counters: RunCounters,
  errors: RunError[]
): Promise<RunSummary> {
  // One request covers every domain, so there is no per-domain outcome to be
  // partial about: the sweep either completed or it did not. 'partial_failure'
  // has no meaning here and is deliberately never produced.
  const status: RunSummary["status"] = errors.length === 0 ? "ok" : "failed";

  const summary: RunSummary = {
    ...counters,
    runId,
    runType: "newsapi_ai_sweep",
    status,
    errors,
  };

  if (runId) {
    await client
      .from("ingestion_runs")
      .update({
        completed_at: new Date().toISOString(),
        status,
        sources_checked: counters.sourcesChecked,
        articles_found: counters.articlesFound,
        articles_new: counters.articlesNew,
        articles_duplicate: counters.articlesDuplicate,
        articles_skipped_paywall: counters.articlesSkippedPaywall,
        articles_suppressed_exclusion: counters.articlesSuppressedExclusion,
        articles_skipped_coded: counters.articlesSkippedCoded,
        sources_not_fetched: counters.sourcesNotFetched,
        errors: errors.length > 0 ? errors : null,
      })
      .eq("id", runId);
  }

  // No sorting pass here any more — see the note in google-news.ts's finish()
  // and, for the reasoning, the one in run.ts above ExecuteRunOptions.
  return summary;
}
