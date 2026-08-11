import { fetchSource, type FetchSourceResult } from "./fetch";
import { upsertArticle, type SourceChannel } from "./dedup";
import { loadKeywords, matchArticle, type KeywordSet } from "./match";
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
  | "newsdata_sweep";

export type UniverseMode = "whole_universe" | "positive_only";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Sources fetched at once. Low enough to stay a polite client of each feed. */
const FETCH_CONCURRENCY = 5;

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

export type IngestSource = Pick<SourceRow, "id" | "name" | "rss_url">;

export async function selectSources(
  client: IngestionClient,
  mode: UniverseMode
): Promise<IngestSource[]> {
  let query = client
    .from("sources")
    .select("id, name, rss_url")
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

function emptyCounters(): RunCounters {
  return {
    sourcesChecked: 0,
    articlesFound: 0,
    articlesNew: 0,
    articlesDuplicate: 0,
    articlesSkippedPaywall: 0,
    articlesSuppressedExclusion: 0,
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

    if (result.outcome === "inserted") counters.articlesNew += 1;
    // 'updated' and 'skipped_tombstoned' are both "we already knew this story":
    // one enriched an existing row, one hit a curator's tombstone. Neither is
    // new, so both roll up with plain duplicates.
    else counters.articlesDuplicate += 1;
  }
}

export type ExecuteRunOptions = {
  runType: RunType;
  window: IngestionWindow;
  sources: IngestSource[];
  triggeredBy?: string | null;
  /** Pre-loaded to avoid re-reading the keyword table per source. */
  keywords?: KeywordSet;
};

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

      // Every run type that goes through executeRun reads a curated source's
      // own feed, so they all write the same channel.
      await ingestItems(
        client,
        fetched.items,
        source.id,
        keywords,
        counters,
        "media_rss"
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
  triggeredBy: string | null = null
): Promise<RunSummary> {
  const mode = await getUniverseMode(client);
  const sources = await selectSources(client, mode);
  return executeRun(client, {
    runType: "backfill",
    window: windowEndingNow(WINDOW_BACKFILL_MS),
    sources,
    triggeredBy,
  });
}

/**
 * Routine run, every 12h on a 24h window. The deliberate overlap re-checks the
 * second half of the previous run; the dedup fingerprint makes it free.
 */
export async function runScheduled(
  client: IngestionClient
): Promise<RunSummary> {
  const mode = await getUniverseMode(client);
  const sources = await selectSources(client, mode);
  return executeRun(client, {
    runType: "scheduled",
    window: windowEndingNow(WINDOW_SCHEDULED_MS),
    sources,
  });
}

/** Operator-triggered re-run; same shape as scheduled, logged separately. */
export async function runManual(
  client: IngestionClient,
  triggeredBy: string | null = null
): Promise<RunSummary> {
  const mode = await getUniverseMode(client);
  const sources = await selectSources(client, mode);
  return executeRun(client, {
    runType: "manual",
    window: windowEndingNow(WINDOW_SCHEDULED_MS),
    sources,
    triggeredBy,
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
  triggeredBy: string | null = null
): Promise<RunSummary> {
  const { data, error } = await client
    .from("sources")
    .select("id, name, rss_url")
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
  });
}
