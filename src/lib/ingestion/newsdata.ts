import { loadKeywords } from "./match";
import { ingestItems, type RunCounters, type RunError, type RunSummary } from "./run";
import type { FeedItem, IngestionClient } from "./types";

/**
 * NewsData.io sweep — aggregator coverage for the sources that have no usable
 * public feed.
 *
 * Scope. 25 positive source rows have no rss_url; expanded through their
 * slash-grouped names that is ~45 publishers. Probing NewsData's /sources
 * endpoint with all 40 candidate domains returned 9 as indexed (migration 19
 * lists both sets). This channel therefore closes the mainstream-press half of
 * the gap — Reuters, FT, Bloomberg, Guardian, BBC, Economic Times, Business
 * Standard, EC, TradeWinds — and leaves the trade/primary-source half open.
 * Lloyd's List, Drewry, Alphaliner, Linerlytica, Sea-Intelligence, the port and
 * canal authorities and the carrier newsrooms are simply not in the index.
 *
 * The sweep is driven off `sources.website_domain` rather than a list in code,
 * so widening coverage is a data change. Rows with a null domain are skipped.
 *
 * Three things were measured against the live API on 2026-08-11 rather than
 * assumed, because each one would have been wrong if guessed:
 *
 *   * `content` is present on every item but its value is the literal string
 *     "ONLY AVAILABLE IN PAID PLANS" — a plan marker, not text. Anything that
 *     read it naively would store that sentence as an article body and match
 *     keywords against it. It is rejected explicitly; the body is `description`
 *     (0-490 chars, ~320 median).
 *
 *   * `pubDate` is the publisher's real publication time, not a crawl stamp.
 *     The response carries its own `fetched_at`, and across 20 items it ran
 *     0.0-5.2h AFTER pubDate — two genuinely different clocks. So pubDate is
 *     safe for window logic. What is NOT safe is a short window: the newest
 *     item in every probe was >= 12.0h old, the free plan's stated embargo, so
 *     a window under ~13h returns nothing at all. Hence WINDOW_DAYS below.
 *
 *   * `duplicate` is a real boolean (1/10 and 3/10 across the two probes). It
 *     is counted and logged, and then ignored for dedup purposes: it is
 *     NewsData's judgement about its own corpus, made by an algorithm their
 *     docs warn is approximate, and it says nothing about whether we already
 *     hold the story. Our fingerprint runs on every item regardless.
 */

const ENDPOINT = "https://newsdata.io/api/1/latest";
const FETCH_TIMEOUT_MS = 15_000;

/**
 * 48 hours, not the 24 every other recurring run uses. The free plan will not
 * return anything published in the last ~12h, so a 24h window only ever sees
 * the 12-24h slice and any delay in the run starves it further. Doubling it
 * costs nothing — the dedup fingerprint makes the overlap free.
 */
const WINDOW_DAYS = 2;

/** Free and Basic plans cap domainurl at 5 domains per request. */
const DOMAINS_PER_REQUEST = 5;

/**
 * Gate 1 anchors OR-ed into every request. Without it the ten-articles-per
 * -request budget goes on whatever Reuters and the BBC published most
 * recently — measured: an unanchored domainurl query against these same
 * domains came back with Indian politics, a Darwin retrospective and football
 * media rights, none of it ingestible.
 *
 * Anchors only, no Gate 2 topic term: unlike the Google News sweep this query
 * is already narrowed by domain, so the job here is to catch everything
 * shipping-related that these publishers ran, and the matcher applies the
 * second gate afterwards. Five of the taxonomy's Gate 1 terms is as many as
 * the free plan's 100-character q limit allows (this is 95).
 */
const QUERY =
  '"container shipping" OR "ocean freight" OR "liner shipping" OR "sea freight" OR "shipping line"';

/**
 * Pages pulled per domain batch. Each page is one API credit and ten articles;
 * the free plan allows 200 credits a day, so this is nowhere near the ceiling.
 * It exists to stop a runaway nextPage chain, and a batch that hits it is
 * reported rather than silently truncated.
 */
const MAX_PAGES = 5;

/** The literal string the free plan puts in `content`. Never a body. */
const PAID_PLAN_MARKER = "ONLY AVAILABLE IN PAID PLANS";

type NewsDataArticle = {
  article_id?: string;
  title?: string;
  link?: string;
  description?: string | null;
  content?: string | null;
  creator?: string[] | null;
  pubDate?: string | null;
  pubDateTZ?: string | null;
  source_name?: string | null;
  source_id?: string | null;
  duplicate?: boolean;
};

type NewsDataResponse = {
  status?: string;
  totalResults?: number;
  results?: NewsDataArticle[];
  nextPage?: string | null;
  message?: string;
};

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

function countWords(text: string): number {
  return text ? text.split(/\s+/).filter(Boolean).length : 0;
}

/**
 * pubDate comes back as "2026-08-10 19:21:56" with pubDateTZ "UTC" — a space
 * separator and no offset, which Date parses as local time. The offset is
 * appended explicitly so a server in any timezone reads the same instant.
 */
function parsePubDate(
  raw: string | null | undefined,
  tz: string | null | undefined
): Date | null {
  if (!raw) return null;
  const normalised =
    (tz ?? "UTC").toUpperCase() === "UTC" && !/[Z+]|\d-\d\d:\d\d$/.test(raw)
      ? `${raw.replace(" ", "T")}Z`
      : raw;
  const parsed = new Date(normalised);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export type MappedItem = { item: FeedItem; duplicateFlag: boolean };

/**
 * One API article to a FeedItem. Returns null for anything with no headline or
 * no body, matching the RSS path's contract: a stub is skipped, never stored.
 */
export function mapArticle(article: NewsDataArticle): MappedItem | null {
  const headline = (article.title ?? "").trim();

  const content = (article.content ?? "").trim();
  const usableContent = content === PAID_PLAN_MARKER ? "" : content;
  const body = usableContent || (article.description ?? "").trim();

  if (!headline || !body) return null;

  return {
    duplicateFlag: article.duplicate === true,
    item: {
      headline,
      url: article.link ?? null,
      byline: article.creator?.filter(Boolean).join(", ") || null,
      media: article.source_name ?? article.source_id ?? null,
      publishedAt: parsePubDate(article.pubDate, article.pubDateTZ),
      body,
      wordCount: countWords(body),
    },
  };
}

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * One API page. Exported like fetch.ts exports fetchFeedXml — it is the
 * network unit, and being able to call it without a database is what let the
 * `content` / `pubDate` / `duplicate` behaviour above be measured rather than
 * assumed.
 */
export async function fetchNewsDataPage(
  apiKey: string,
  domains: string[],
  page: string | null
): Promise<NewsDataResponse> {
  const params = new URLSearchParams({
    apikey: apiKey,
    q: QUERY,
    domainurl: domains.join(","),
    language: "en",
  });
  if (page) params.set("page", page);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${ENDPOINT}?${params.toString()}`, {
      signal: controller.signal,
      cache: "no-store",
    });
    const payload = (await res.json()) as NewsDataResponse;

    // NewsData answers 4xx with a JSON body naming the problem — an unknown
    // domain, an exhausted credit balance. That message is far more useful in
    // the run log than the status code, so it is preferred when present.
    if (!res.ok || payload.status === "error") {
      throw new Error(
        payload.message ?? `HTTP ${res.status} ${res.statusText}`
      );
    }
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
    throw new Error(`Could not read the NewsData API key: ${error.message}`);
  }
  if (!data) {
    throw new Error(
      "No NewsData API key is set. Add it under Integrations → news_aggregator."
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

export async function runNewsDataSweep(
  client: IngestionClient,
  triggeredBy: string | null = null
): Promise<RunSummary> {
  const end = new Date();
  const start = new Date(end.getTime() - WINDOW_DAYS * 24 * 3600 * 1000);

  const counters: RunCounters = {
    sourcesChecked: 0,
    articlesFound: 0,
    articlesNew: 0,
    articlesDuplicate: 0,
    articlesSkippedPaywall: 0,
    articlesSuppressedExclusion: 0,
  };
  const errors: RunError[] = [];

  const { data: runRow } = await client
    .from("ingestion_runs")
    .insert({
      run_type: "newsdata_sweep",
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
        source: "(newsdata setup)",
        sourceId: null,
        error: err instanceof Error ? err.message : String(err),
      },
    ]);
  }

  if (targets.length === 0) {
    console.warn(
      "[newsdata] no gap sources have a website_domain set — nothing to sweep."
    );
  }

  const keywords = await loadKeywords(client);

  // Batched by the API's 5-domain cap, not by source row, so a row that groups
  // several publishers does not need its own request. The source_id of the
  // first row in a batch is NOT attributed to its articles: a batch mixes
  // publishers, and guessing which source row an item belongs to would put the
  // wrong name in the Media Universe health column. Like the Google News
  // sweep, these rows carry source_id = null and identify their publisher
  // through articles.media.
  const flattened = targets.flatMap((t) =>
    t.domains.map((domain) => ({ domain, name: t.name }))
  );

  let flaggedDuplicate = 0;

  for (const batch of chunk(flattened, DOMAINS_PER_REQUEST)) {
    const domains = batch.map((b) => b.domain);
    counters.sourcesChecked += domains.length;

    try {
      let page: string | null = null;
      let pagesPulled = 0;
      let exhaustedWindow = false;

      while (pagesPulled < MAX_PAGES && !exhaustedWindow) {
        const payload: NewsDataResponse = await fetchNewsDataPage(
          apiKey,
          domains,
          page
        );
        pagesPulled += 1;

        const articles = payload.results ?? [];
        if (articles.length === 0) break;

        const items: FeedItem[] = [];
        for (const article of articles) {
          const mapped = mapArticle(article);
          if (!mapped) {
            // No headline, or a body that was only the paid-plan marker.
            counters.articlesSkippedPaywall += 1;
            continue;
          }
          if (mapped.duplicateFlag) flaggedDuplicate += 1;

          // Undated items are kept, matching the RSS path — see
          // FeedItem.publishedAt.
          const at = mapped.item.publishedAt;
          if (at && at < start) {
            // Results are newest-first, so the first item older than the
            // window means every later page is older still.
            exhaustedWindow = true;
            continue;
          }
          if (at && at > end) continue;

          items.push(mapped.item);
        }

        await ingestItems(client, items, null, keywords, counters, "newsdata");

        page = payload.nextPage ?? null;
        if (!page) break;
      }

      if (pagesPulled >= MAX_PAGES && !exhaustedWindow) {
        errors.push({
          source: `NewsData: ${domains.join(", ")}`,
          sourceId: null,
          error: `Stopped at the ${MAX_PAGES}-page cap with more results in the window — coverage for this batch is incomplete.`,
        });
      }
    } catch (err) {
      errors.push({
        source: `NewsData: ${domains.join(", ")}`,
        sourceId: null,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Logged, never acted on. See the header note on `duplicate`.
  console.log(
    `[newsdata] ${flaggedDuplicate} of ${counters.articlesFound} items carried NewsData's duplicate flag; our fingerprint dedup ran on all of them.`
  );

  return finish(client, runId, counters, errors, flattened.length);
}

async function finish(
  client: IngestionClient,
  runId: string | null,
  counters: RunCounters,
  errors: RunError[],
  domainCount = 0
): Promise<RunSummary> {
  const status: RunSummary["status"] =
    errors.length === 0
      ? "ok"
      : domainCount === 0 || errors.length >= domainCount
        ? "failed"
        : "partial_failure";

  const summary: RunSummary = {
    ...counters,
    runId,
    runType: "newsdata_sweep",
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
        errors: errors.length > 0 ? errors : null,
      })
      .eq("id", runId);
  }

  return summary;
}
