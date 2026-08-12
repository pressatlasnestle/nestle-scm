import { fetchSource, type FetchSourceResult } from "./fetch";
import { upsertArticle, type SourceChannel } from "./dedup";
import { loadKeywords, matchArticle, type KeywordSet } from "./match";
import { sortArticles } from "@/lib/analysis/sorting";
import type {
  FeedItem,
  IngestionClient,
  IngestionWindow,
  SourceRow,
} from "./types";

/**
 * Phase 4 — run orchestration. Every run type funnels through executeRun(), so
 * fetch (Phase 1), matching (Phase 3) and dedup (Phase 2) exist in exactly one
 * place; a run type only decides which sources and which window.
 */

export type RunType =
  | "backfill"
  | "scheduled"
  | "manual"
  | "source_added"
  | "google_news_sweep"
  | "newsapi_ai_sweep";

export type UniverseMode = "whole_universe" | "positive_only";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Sources fetched at once.
 *
 * Was 5, on the reasoning that a low number keeps us a polite client. That
 * reasoning does not apply here and the number was costing us the whole run.
 * Politeness is a per-HOST concern, and every source is a different host —
 * one fetch each, never several at one publisher — so raising this widens how
 * many DIFFERENT servers are talked to at once, not how hard any one of them
 * is hit.
 *
 * The cost was concrete. 71 sources in the universe, 30 of them currently
 * failing, and a failing source burns the full FETCH_TIMEOUT_MS (15s) before
 * it gives up. A batch takes as long as its slowest member, so at concurrency
 * 5 that is ceil(71/5) = 15 batches, most of them containing at least one
 * timeout: comfortably past the route's 60s maxDuration. The first scheduled
 * run after the cron was fixed died exactly that way — it captured 27 articles
 * and was then killed mid-flight, leaving its ingestion_runs row stuck at
 * 'running' because closeRun() never got to execute.
 *
 * At 24 that is 3 batches, so the timeout-dominated worst case is ~45s rather
 * than ~225s, and a run finishes inside the request that started it.
 *
 * This is a tuning fix, not a structural one. A universe several times larger,
 * or a slower FETCH_TIMEOUT_MS, would push past 60s again — at which point the
 * answer is to stop doing the whole universe in one request rather than to
 * keep raising this. The CLI (npm run ingest) has no such limit and is the
 * right tool for anything large, which is why the backfill runs there.
 */
const FETCH_CONCURRENCY = 24;

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export const WINDOW_BACKFILL_MS = 7 * DAY_MS;
export const WINDOW_SCHEDULED_MS = 1 * DAY_MS;

export type RunCounters = {
  sourcesChecked: number;
  articlesFound: number;
  articlesNew: number;
  articlesDuplicate: number;
  articlesSkippedPaywall: number;
  articlesSuppressedExclusion: number;
  /**
   * Pulls discarded because the stored row was already coded. Counted, not
   * silent: this is the accepted cost of the coded-article lock in dedup.ts,
   * and an accepted cost that nobody can see is just an undiscovered bug.
   */
  articlesSkippedCoded: number;
  /**
   * Ids of the rows this run inserted. Not a counter, but it rides on the same
   * accumulator every run type already threads through ingestItems() — which
   * is what makes the Stage 1 sorting pass fire for the Google News and
   * newsapi.ai sweeps too, not just the per-source path.
   */
  insertedArticleIds: string[];
};

export type RunError = { source: string; sourceId: string | null; error: string };

export type RunSummary = RunCounters & {
  runId: string | null;
  runType: RunType;
  status: "ok" | "partial_failure" | "failed";
  errors: RunError[];
};

// ---------------------------------------------------------------------------
// Source selection
// ---------------------------------------------------------------------------

/**
 * Universe mode drives which sources a run pulls (schema-brief table 2):
 * positive_only takes list_type='positive' only; whole_universe takes
 * everything except list_type='negative'. Defaults to whole_universe when the
 * setting is missing, matching the admin panel's own default.
 */
export async function getUniverseMode(
  client: IngestionClient
): Promise<UniverseMode> {
  const { data } = await client
    .from("app_settings")
    .select("value")
    .eq("key", "universe_mode")
    .maybeSingle();

  return data?.value === "positive_only" ? "positive_only" : "whole_universe";
}

export type IngestSource = Pick<SourceRow, "id" | "name" | "rss_url" | "tier">;

/**
 * The one tier value the pipeline reads rather than just displays. Google
 * Alerts feeds are structurally ordinary Atom and fetch identically, so the
 * tier is the only thing that distinguishes an alert entry from a publisher's
 * own article once both are parsed FeedItems.
 */
const GOOGLE_ALERTS_TIER = "Alerts - Google standing search";

/**
 * Which channel a per-source fetch writes. Everything that is not a standing
 * Google Alerts search is a publisher's own feed; a null or unrecognised tier
 * therefore stays 'media_rss', which is what every source before these 18 was
 * and keeps the default correct for every source added later.
 */
export function channelForSource(source: IngestSource): SourceChannel {
  return source.tier === GOOGLE_ALERTS_TIER ? "google_alerts" : "media_rss";
}

export async function selectSources(
  client: IngestionClient,
  mode: UniverseMode
): Promise<IngestSource[]> {
  let query = client
    .from("sources")
    .select("id, name, rss_url, tier")
    .eq("is_active", true);

  query =
    mode === "positive_only"
      ? query.eq("list_type", "positive")
      : query.or("list_type.is.null,list_type.neq.negative");

  const { data, error } = await query.order("name");
  if (error) throw new Error(`Failed to load sources: ${error.message}`);
  return data ?? [];
}

// ---------------------------------------------------------------------------
// Run lifecycle
// ---------------------------------------------------------------------------

/**
 * Exported so the Google News and newsapi.ai sweeps, which manage their own run
 * rows rather than going through executeRun(), start from the same zeroed
 * shape. They each used to inline this literal, which meant adding a counter
 * broke both — the compiler caught it, but the duplication was the bug.
 */
export function emptyCounters(): RunCounters {
  return {
    sourcesChecked: 0,
    articlesFound: 0,
    articlesNew: 0,
    articlesDuplicate: 0,
    articlesSkippedPaywall: 0,
    articlesSuppressedExclusion: 0,
    articlesSkippedCoded: 0,
    insertedArticleIds: [],
  };
}

async function openRun(
  client: IngestionClient,
  runType: RunType,
  window: IngestionWindow,
  triggeredBy: string | null
): Promise<string | null> {
  const { data, error } = await client
    .from("ingestion_runs")
    .insert({
      run_type: runType,
      window_start: window.start.toISOString(),
      window_end: window.end.toISOString(),
      status: "running",
      triggered_by: triggeredBy,
    })
    .select("id")
    .single();

  if (error) {
    // A run that cannot be logged still runs — losing the log entry is better
    // than losing the ingest — but the caller is told the id is missing.
    console.error("[ingestion] could not open run row:", error.message);
    return null;
  }
  return data.id;
}

async function closeRun(
  client: IngestionClient,
  runId: string | null,
  summary: RunSummary
): Promise<void> {
  if (!runId) return;
  await client
    .from("ingestion_runs")
    .update({
      completed_at: new Date().toISOString(),
      status: summary.status,
      sources_checked: summary.sourcesChecked,
      articles_found: summary.articlesFound,
      articles_new: summary.articlesNew,
      articles_duplicate: summary.articlesDuplicate,
      articles_skipped_paywall: summary.articlesSkippedPaywall,
      articles_suppressed_exclusion: summary.articlesSuppressedExclusion,
      articles_skipped_coded: summary.articlesSkippedCoded,
      errors: summary.errors.length > 0 ? summary.errors : null,
    })
    .eq("id", runId);
}

// ---------------------------------------------------------------------------
// The shared pipeline
// ---------------------------------------------------------------------------

/**
 * Runs one already-fetched item list through Phase 3 then Phase 2, folding the
 * outcome into the counters. Shared by the per-source path and the Google News
 * sweep, which supplies items without a source row.
 */
export async function ingestItems(
  client: IngestionClient,
  items: FeedItem[],
  sourceId: string | null,
  keywords: KeywordSet,
  counters: RunCounters,
  channel: SourceChannel
): Promise<void> {
  for (const item of items) {
    counters.articlesFound += 1;

    const decision = matchArticle(
      { headline: item.headline, body: item.body },
      keywords
    );

    if (!decision.captured) {
      // failed_gate leaves no trace by design — it is the overwhelming
      // majority of feed traffic and logging it per article would swamp the
      // ingestion log. suppressed_exclusion gets its own counter so the
      // mechanism stays visible.
      if (decision.reason === "suppressed_exclusion") {
        counters.articlesSuppressedExclusion += 1;
      }
      continue;
    }

    const result = await upsertArticle(
      client,
      item,
      {
        sourceId,
        matchedKeywords: decision.matchedKeywords,
        matchedNegativeKeywords: decision.matchedNegativeKeywords,
        mentionCount: decision.mentionCount,
      },
      channel
    );

    if (result.outcome === "inserted") {
      counters.articlesNew += 1;
      if (result.articleId) counters.insertedArticleIds.push(result.articleId);
    } else {
      // 'updated', 'skipped_tombstoned' and 'skipped_coded' are all "we
      // already knew this story": one enriched an existing row, one hit a
      // curator's tombstone, one hit a coded article's lock. None is new, so
      // all three roll up with plain duplicates.
      counters.articlesDuplicate += 1;

      // ...but the coded lock also gets its own counter, because unlike a
      // plain duplicate it means a pull that MIGHT have been better was
      // dropped on purpose. Logged per occurrence as well so the specific
      // article is identifiable from the run's logs.
      if (result.outcome === "skipped_coded") {
        counters.articlesSkippedCoded += 1;
        console.log(
          `[dedup] kept coded article ${result.articleId} — incoming pull discarded (${item.wordCount} words) to preserve its analysis`
        );
      }
    }
  }
}

export type ExecuteRunOptions = {
  runType: RunType;
  window: IngestionWindow;
  sources: IngestSource[];
  triggeredBy?: string | null;
  /** Pre-loaded to avoid re-reading the keyword table per source. */
  keywords?: KeywordSet;
  /**
   * How to run the post-run Stage 1 sorting pass.
   *
   * Request-scoped callers pass next/server's after(), so the HTTP response is
   * not held open for one Gemini call per new article. The CLI passes nothing
   * and the pass runs inline before the process exits — a script that returned
   * before its work finished would simply lose it, there being no server
   * lifetime to hand the task to.
   */
  defer?: (task: () => Promise<void>) => void;
};

/**
 * Fires Stage 1 sorting over the rows a run just inserted.
 *
 * Never allowed to affect the run: sorting is annotation, and an unset Gemini
 * key or a bad model id must not turn a successful ingest into a failed one.
 * Failures land in the log and the rows stay 'pending', so `npm run sort`
 * picks them up later.
 */
export async function scheduleSorting(
  client: IngestionClient,
  counters: RunCounters,
  defer?: ExecuteRunOptions["defer"]
): Promise<void> {
  const articleIds = [...counters.insertedArticleIds];
  if (articleIds.length === 0) return;

  const task = async () => {
    try {
      const result = await sortArticles(client, articleIds);
      console.log(
        `[sorting] ${result.processed} sorted (${result.flagged} flagged, ${result.confirmed} confirmed), ${result.failed} failed`
      );
      for (const e of result.errors) {
        console.error(`[sorting] ${e.articleId}: ${e.error}`);
      }
    } catch (err) {
      console.error(
        "[sorting] post-ingestion pass failed:",
        err instanceof Error ? err.message : err
      );
    }
  };

  if (defer) defer(task);
  else await task();
}

export async function executeRun(
  client: IngestionClient,
  options: ExecuteRunOptions
): Promise<RunSummary> {
  const { runType, window, sources } = options;
  const runId = await openRun(
    client,
    runType,
    window,
    options.triggeredBy ?? null
  );

  const counters = emptyCounters();
  const errors: RunError[] = [];

  let keywords: KeywordSet;
  try {
    keywords = options.keywords ?? (await loadKeywords(client));
  } catch (err) {
    const summary: RunSummary = {
      ...counters,
      runId,
      runType,
      status: "failed",
      errors: [
        {
          source: "(keywords)",
          sourceId: null,
          error: err instanceof Error ? err.message : String(err),
        },
      ],
    };
    await closeRun(client, runId, summary);
    return summary;
  }

  // Fetched in small parallel batches — a run over 65 sources where several
  // time out at 15s each would not finish inside a serverless request if it
  // went one at a time. Writes stay sequential: the network is the bottleneck,
  // not the database, and serial upserts keep the dedup read-then-write pair
  // from racing itself within a single run.
  for (const batch of chunk(sources, FETCH_CONCURRENCY)) {
    const settled = await Promise.all(
      batch.map(async (source) => {
        try {
          return {
            source,
            fetched: await fetchSource(client, source, window),
            thrown: null as string | null,
          };
        } catch (err) {
          // fetchSource records its own failures; this only catches something
          // unexpected, and one bad source must not abort the whole run.
          return {
            source,
            fetched: null,
            thrown: err instanceof Error ? err.message : String(err),
          };
        }
      })
    );

    for (const { source, fetched, thrown } of settled) {
      counters.sourcesChecked += 1;

      if (!fetched) {
        errors.push({
          source: source.name,
          sourceId: source.id,
          error: thrown ?? "Unknown fetch failure.",
        });
        continue;
      }

      counters.articlesSkippedPaywall += fetched.skippedPaywall;

      if (fetched.error) {
        errors.push({
          source: source.name,
          sourceId: source.id,
          error: fetched.error,
        });
        continue;
      }

      // Per-source channel, not a per-run one: a single run mixes publisher
      // feeds and Google Alerts standing searches, and they must not be
      // labelled the same.
      await ingestItems(
        client,
        fetched.items,
        source.id,
        keywords,
        counters,
        channelForSource(source)
      );
    }
  }

  const status: RunSummary["status"] =
    errors.length === 0
      ? "ok"
      : errors.length >= sources.length && sources.length > 0
        ? "failed"
        : "partial_failure";

  const summary: RunSummary = { ...counters, runId, runType, status, errors };
  await closeRun(client, runId, summary);

  // After closeRun, so the run is already logged as finished before any Gemini
  // call is made — sorting is a separate concern and must not widen the run's
  // recorded duration or its status.
  await scheduleSorting(client, counters, options.defer);

  return summary;
}

// ---------------------------------------------------------------------------
// Run types
// ---------------------------------------------------------------------------

function windowEndingNow(spanMs: number): IngestionWindow {
  const end = new Date();
  return { start: new Date(end.getTime() - spanMs), end };
}

/** One-time seed: all active sources for the current universe mode, 7 days. */
export async function runBackfill(
  client: IngestionClient,
  triggeredBy: string | null = null,
  defer?: ExecuteRunOptions["defer"]
): Promise<RunSummary> {
  const mode = await getUniverseMode(client);
  const sources = await selectSources(client, mode);
  return executeRun(client, {
    runType: "backfill",
    window: windowEndingNow(WINDOW_BACKFILL_MS),
    sources,
    triggeredBy,
    defer,
  });
}

/**
 * Routine run, every 12h on a 24h window. The deliberate overlap re-checks the
 * second half of the previous run; the dedup fingerprint makes it free.
 */
export async function runScheduled(
  client: IngestionClient,
  defer?: ExecuteRunOptions["defer"]
): Promise<RunSummary> {
  const mode = await getUniverseMode(client);
  const sources = await selectSources(client, mode);
  return executeRun(client, {
    runType: "scheduled",
    window: windowEndingNow(WINDOW_SCHEDULED_MS),
    sources,
    defer,
  });
}

/** Operator-triggered re-run; same shape as scheduled, logged separately. */
export async function runManual(
  client: IngestionClient,
  triggeredBy: string | null = null,
  defer?: ExecuteRunOptions["defer"]
): Promise<RunSummary> {
  const mode = await getUniverseMode(client);
  const sources = await selectSources(client, mode);
  return executeRun(client, {
    runType: "manual",
    window: windowEndingNow(WINDOW_SCHEDULED_MS),
    sources,
    triggeredBy,
    defer,
  });
}

/**
 * Fired when a source is added, so a new source is not blank until the next
 * scheduled run. Single source, 7-day window, and it ignores universe mode:
 * the admin just asked for this specific source.
 */
export async function runForSource(
  client: IngestionClient,
  sourceId: string,
  triggeredBy: string | null = null,
  defer?: ExecuteRunOptions["defer"]
): Promise<RunSummary> {
  const { data, error } = await client
    .from("sources")
    .select("id, name, rss_url, tier")
    .eq("id", sourceId)
    .maybeSingle();

  if (error || !data) {
    return {
      ...emptyCounters(),
      runId: null,
      runType: "source_added",
      status: "failed",
      errors: [
        {
          source: sourceId,
          sourceId,
          error: error?.message ?? "Source not found.",
        },
      ],
    };
  }

  return executeRun(client, {
    runType: "source_added",
    window: windowEndingNow(WINDOW_BACKFILL_MS),
    sources: [data],
    triggeredBy,
    defer,
  });
}
