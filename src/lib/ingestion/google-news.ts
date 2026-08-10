import { fetchFeedXml, parseFeed } from "./fetch";
import { loadKeywords, GATE_2 } from "./match";
import { ingestItems, type RunCounters, type RunError, type RunSummary } from "./run";
import type { FeedItem, IngestionClient, KeywordRow } from "./types";

/**
 * Phase 5 — Google News RSS sweep. A separate daily run that searches Google
 * News rather than reading a named publisher's feed, to catch stories the
 * curated source list missed.
 *
 * Its value is breadth, not freshness: this feed skews old (external testing
 * puts the median item age at several days), so it contributes little to the
 * 24h scheduled runs and articles_new is expected to stay low. It is logged
 * like every other run so that is visible rather than surprising.
 */

const GOOGLE_NEWS_BASE = "https://news.google.com/rss/search";

/** Days of history the sweep considers. Wider than the 12h runs, per above. */
const SWEEP_WINDOW_DAYS = 7;

/**
 * Anchors OR-ed into every query. Google News treats adjacent terms as AND, so
 * each query is "<alert topic> AND (<any domain anchor>)" — the same two-gate
 * shape the matcher enforces, applied at search time so the feed comes back
 * already on-topic. Three anchors rather than one: a single anchor phrase
 * makes several alert topics return almost nothing.
 */
const QUERY_ANCHORS = ["ocean freight", "container shipping", "liner shipping"];

/**
 * Alert-tier Gate 2 keywords only. Fanning out to all 103 Gate 2 terms (let
 * alone all 121 positives) is exactly the unfocused sweep the source data warns
 * against; the taxonomy already marks the topics worth a standing search.
 * Matched case-insensitively so "promote to alert tier" on `schedule
 * reliability` counts — that note is asking for precisely this treatment.
 */
const ALERT_TIER = /alert tier/i;

function quotedVariants(keyword: string): string[] {
  return keyword
    .split("/")
    .map((part) => part.replace(/\([^)]*\)/g, " ").replace(/\s+/g, " ").trim())
    .filter((part) => part.length > 1)
    .map((part) => `"${part}"`);
}

export type SweepQuery = { label: string; url: string };

export function buildSweepQueries(rows: KeywordRow[]): SweepQuery[] {
  const anchorGroup = `(${QUERY_ANCHORS.map((a) => `"${a}"`).join(" OR ")})`;

  return rows
    .filter(
      (row) =>
        row.is_active &&
        row.list_type !== "negative" &&
        row.gate === GATE_2 &&
        ALERT_TIER.test(row.notes ?? "")
    )
    .map((row) => {
      const variants = quotedVariants(row.keyword);
      if (variants.length === 0) return null;
      const topic =
        variants.length === 1 ? variants[0] : `(${variants.join(" OR ")})`;
      const q = `${topic} ${anchorGroup}`;
      return {
        label: row.keyword,
        url: `${GOOGLE_NEWS_BASE}?q=${encodeURIComponent(
          q
        )}&hl=en-US&gl=US&ceid=US:en`,
      };
    })
    .filter((query): query is SweepQuery => query !== null);
}

/**
 * Google News titles arrive as "Headline - Publisher". The suffix is Google's
 * own formatting, not the publisher's headline, and leaving it in place would
 * give the same story a different dedup fingerprint here than it gets from the
 * publisher's own feed. Stripped only when it matches the item's <source>.
 */
export function stripPublisherSuffix(item: FeedItem): FeedItem {
  if (!item.media) return item;
  const suffix = ` - ${item.media}`;
  if (!item.headline.endsWith(suffix)) return item;
  const headline = item.headline.slice(0, -suffix.length).trim();
  return headline ? { ...item, headline } : item;
}

export async function runGoogleNewsSweep(
  client: IngestionClient
): Promise<RunSummary> {
  const end = new Date();
  const start = new Date(end.getTime() - SWEEP_WINDOW_DAYS * 24 * 3600 * 1000);

  const { data: keywordRows, error: keywordError } = await client
    .from("keywords")
    .select("*")
    .eq("is_active", true);

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
      run_type: "google_news_sweep",
      window_start: start.toISOString(),
      window_end: end.toISOString(),
      status: "running",
    })
    .select("id")
    .single();
  const runId = runRow?.id ?? null;

  if (keywordError) {
    return finish(client, runId, counters, [
      { source: "(keywords)", sourceId: null, error: keywordError.message },
    ]);
  }

  const queries = buildSweepQueries(keywordRows ?? []);
  const keywords = await loadKeywords(client);

  for (const query of queries) {
    counters.sourcesChecked += 1;
    try {
      const xml = await fetchFeedXml(query.url);
      // No media fallback: an item whose <source> is missing must not be
      // attributed to "Google News", it is better left null than wrong.
      const parsed = parseFeed(xml, null);
      counters.articlesSkippedPaywall += parsed.skippedPaywall;

      const items = parsed.items
        .map(stripPublisherSuffix)
        .filter(
          (item) =>
            !item.publishedAt ||
            (item.publishedAt >= start && item.publishedAt <= end)
        );

      // source_id stays null: these items belong to no row in `sources`.
      // The publisher name still lands in articles.media.
      await ingestItems(client, items, null, keywords, counters);
    } catch (err) {
      errors.push({
        source: `Google News: ${query.label}`,
        sourceId: null,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return finish(client, runId, counters, errors, queries.length);
}

async function finish(
  client: IngestionClient,
  runId: string | null,
  counters: RunCounters,
  errors: RunError[],
  queryCount = 0
): Promise<RunSummary> {
  const status: RunSummary["status"] =
    errors.length === 0
      ? "ok"
      : queryCount > 0 && errors.length >= queryCount
        ? "failed"
        : errors.length > 0 && queryCount === 0
          ? "failed"
          : "partial_failure";

  const summary: RunSummary = {
    ...counters,
    runId,
    runType: "google_news_sweep",
    status,
    errors,
  };

  if (runId) {
    await client
      .from("ingestion_runs")
      .update({
        completed_at: new Date().toISOString(),
        status,
        // One "source" per query — the sweep has no sources rows to count.
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
