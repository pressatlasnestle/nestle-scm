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
 * timeout: comfortably past the route's 60s maxDuration.
 *
 * At 24 that is 3 batches, so the timeout-dominated worst case is ~45s rather
 * than ~225s.
 *
 * This number is no longer load-bearing, and that is the point. It used to be
 * the ONLY thing standing between a slow fetch and a lost sorting pass, and it
 * failed at that job twice: raising it bought headroom that the next few
 * sources spent. What protects the run now is structural — a deadline that
 * closes the row (see DEFAULT_BUDGET_MS) and a sorting stage that no longer
 * shares this invocation at all.
 */
const FETCH_CONCURRENCY = 24;

/**
 * How long executeRun() may spend fetching before it stops and closes the run.
 *
 * Runs used to have no budget at all. They simply ran until the platform
 * killed them, which produced an ingestion_runs row stuck at 'running' with
 * every counter null — indistinguishable from a run still in flight, which is
 * why two of them sat unnoticed for a day. A run that stops itself can write
 * down what happened; a run that is killed cannot.
 *
 * 45s against the route's 60s maxDuration. The margin covers the in-flight
 * batch (fetches already issued still have up to FETCH_TIMEOUT_MS to drain),
 * the sequential upserts behind it, and closeRun() itself. Callers with no
 * ceiling — the CLI — pass null and are not bounded.
 */
export const DEFAULT_BUDGET_MS = 45_000;

/**
 * How long a run may sit at 'running' before a later run declares it dead.
 *
 * Generous by design. The point is not to catch a slow run early — it is to
 * guarantee that a row abandoned by a killed process is eventually closed,
 * rather than being read forever as "in progress". Nothing legitimate holds a
 * run open for ten minutes: the route is capped at 60s, and a CLI run long
 * enough to pass this closes its own row when it finishes regardless.
 */
export const STALE_RUN_MS = 10 * 60 * 1000;

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
   * Sources in the universe that were deliberately not fetched, because they
   * are marked is_fetchable = false.
   *
   * A counter rather than silence, and that is the whole design. Not fetching
   * something is invisible by nature, so the alternative to counting it is a
   * source that quietly stops being monitored with nothing to show for it.
   * This number belongs next to sourcesChecked: together they account for the
   * entire active universe.
   */
  sourcesNotFetched: number;
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
 * What a run's source selection produced: the rows it will fetch, and how many
 * it deliberately left alone.
 *
 * Two numbers rather than one list, because "not fetched" is a fact about the
 * run that has to survive into ingestion_runs. Returning only the fetchable
 * rows would make the skipped ones unrepresentable at exactly the moment they
 * need reporting.
 */
export type SourceSelection = {
  sources: IngestSource[];
  notFetchable: number;
};

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

/**
 * The active universe for a mode, split into what will be fetched and what
 * will not.
 *
 * The is_fetchable split is the reason `partial_failure` means anything again.
 * Before it, every source in the universe was fetched whether or not it could
 * be: 21 active rows had no feed URL — Lloyd's List, TradeWinds, Drewry and
 * Xeneta are paywalled with no public feed at all; "Evergreen / HMM / Yang
 * Ming / ZIM" and "Port of Rotterdam / Antwerp-Bruges / Hamburg" are grouping
 * rows naming several publishers, which no single URL can represent. Each one
 * logged "No RSS URL configured." on every run, forever, so every scheduled
 * run reported partial_failure and the status stopped carrying information.
 *
 * Marking them not-fetchable is not the same as deactivating them: they stay
 * in the universe, visible in the Media Universe panel, still eligible for
 * whatever coverage the Google News and newsapi.ai sweeps give them. They are
 * simply no longer asked for a feed they do not have.
 *
 * Note what is NOT filtered here. A source marked fetchable that has no URL
 * still goes to fetchSource() and still errors — that combination is a genuine
 * misconfiguration (someone added a source and forgot the URL) and must stay
 * loud. The filter suppresses the declared case, not the accidental one.
 */
export async function selectSources(
  client: IngestionClient,
  mode: UniverseMode
): Promise<SourceSelection> {
  let query = client
    .from("sources")
    .select("id, name, rss_url, tier, is_fetchable")
    .eq("is_active", true);

  query =
    mode === "positive_only"
      ? query.eq("list_type", "positive")
      : query.or("list_type.is.null,list_type.neq.negative");

  const { data, error } = await query.order("name");
  if (error) throw new Error(`Failed to load sources: ${error.message}`);

  const rows = data ?? [];
  const sources = rows.filter((s) => s.is_fetchable !== false);
  return { sources, notFetchable: rows.length - sources.length };
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
    sourcesNotFetched: 0,
  };
}

/**
 * Closes ingestion_runs rows abandoned by a process that never came back.
 *
 * The deadline in executeRun() handles the expected case — a run that is
 * merely slow stops itself and writes down why. This handles the case a
 * running process cannot handle at all: an OOM, a deploy mid-run, a platform
 * kill that does not unwind the stack. No in-process mechanism can close a row
 * after the process is gone, so something outside it has to.
 *
 * Called at the start of every run, which makes the pipeline self-healing
 * without a separate janitor to schedule and forget about: the next run
 * cleans up after the last one. The two rows stranded on 13 and 14 August are
 * exactly what this exists to prevent, and it closes them on its first pass.
 *
 * Never allowed to fail a run — a reaper that stops an ingest is worse than
 * the stale rows it was cleaning up.
 */
export async function reapStaleRuns(
  client: IngestionClient,
  staleMs: number = STALE_RUN_MS
): Promise<number> {
  const cutoff = new Date(Date.now() - staleMs).toISOString();

  try {
    const { data, error } = await client
      .from("ingestion_runs")
      .update({
        status: "failed",
        completed_at: new Date().toISOString(),
        errors: [
          {
            source: "(runtime)",
            sourceId: null,
            error: `Run left open for more than ${Math.round(staleMs / 60_000)} minutes with no completion; the process did not survive to close it. Marked failed by the next run.`,
          },
        ],
      })
      .eq("status", "running")
      .lt("started_at", cutoff)
      .select("id");

    if (error) {
      console.error("[ingestion] could not reap stale runs:", error.message);
      return 0;
    }

    const reaped = data ?? [];
    for (const row of reaped) {
      console.warn(`[ingestion] reaped stale run ${row.id} → failed`);
    }
    return reaped.length;
  } catch (err) {
    console.error(
      "[ingestion] could not reap stale runs:",
      err instanceof Error ? err.message : err
    );
    return 0;
  }
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
      sources_not_fetched: summary.sourcesNotFetched,
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

/**
 * WHERE SORTING WENT.
 *
 * Stage 1 sorting used to run at the end of this file, handed to next/server's
 * after() so the HTTP response was not held open for one Gemini call per new
 * article. That worked as described and still lost the sorting, because
 * after() defers past the RESPONSE, not past maxDuration: the deferred task
 * runs inside the same invocation and inherits whatever is left of its 60
 * seconds. As the fetch grew to fill the budget, sorting was left with the
 * remainder and then killed mid-pass.
 *
 * The failure is worth naming precisely, because it did not look like a
 * failure. The scheduled run of 14 August 12:00 captured 31 articles, closed
 * cleanly, and sorted none of them — 57 seconds of fetch left nothing for the
 * sort. Two runs either side of it were killed outright. The visible symptom
 * in every case was the same: articles present, sorting pending, days later.
 *
 * So sorting no longer shares this invocation with anything. It has its own
 * route and its own schedule, and it selects by ai_sorting_status = 'pending'
 * rather than by the ids a particular run inserted — which means it recovers
 * from a missed pass on its own, whatever caused the miss. See
 * src/app/api/sorting/run/route.ts and sortPendingArticles().
 *
 * The concrete gain is that a slow fetch now costs exactly a slow fetch. It
 * cannot cost the sort, because the sort is not in the same budget.
 */
export type ExecuteRunOptions = {
  runType: RunType;
  window: IngestionWindow;
  sources: IngestSource[];
  triggeredBy?: string | null;
  /** Pre-loaded to avoid re-reading the keyword table per source. */
  keywords?: KeywordSet;
  /** Reported on the run row; see RunCounters.sourcesNotFetched. */
  notFetchable?: number;
  /**
   * Wall-clock budget for fetching, in ms. null = unbounded (the CLI).
   *
   * Enforced between batches rather than mid-batch: fetches already in flight
   * are allowed to drain, so the real ceiling is this plus one FETCH_TIMEOUT_MS
   * — which is what the margin against maxDuration is for.
   */
  budgetMs?: number | null;
};

export async function executeRun(
  client: IngestionClient,
  options: ExecuteRunOptions
): Promise<RunSummary> {
  const { runType, window, sources } = options;

  // Before opening a row, not after: a run that is about to add a row to this
  // table is the natural moment to notice the last one never closed.
  await reapStaleRuns(client);

  const runId = await openRun(
    client,
    runType,
    window,
    options.triggeredBy ?? null
  );

  const counters = emptyCounters();
  counters.sourcesNotFetched = options.notFetchable ?? 0;
  const errors: RunError[] = [];

  const budgetMs = options.budgetMs === undefined ? null : options.budgetMs;
  const deadline = budgetMs === null ? null : Date.now() + budgetMs;
  let truncated = false;

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
    // Checked before starting a batch, never in the middle of one. Abandoning
    // fetches already issued would lose their articles for nothing; the whole
    // value of stopping here is that the run gets to write down where it got
    // to, and that requires reaching closeRun() under its own power.
    if (deadline !== null && Date.now() >= deadline) {
      truncated = true;
      const unchecked = sources.length - counters.sourcesChecked;
      errors.push({
        source: "(runtime)",
        sourceId: null,
        error: `Run stopped at its ${Math.round(budgetMs! / 1000)}s budget with ${unchecked} of ${sources.length} source(s) unchecked. Articles captured before the stop are kept. Re-run, or use the CLI (npm run ingest), which has no budget.`,
      });
      break;
    }

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

  // A truncated run is 'failed' outright, not 'partial_failure'. The two mean
  // different things and conflating them would undo the point of this change:
  // partial_failure says "the universe was covered, some sources are broken",
  // which is a source-health signal. A run that stopped early did not cover
  // the universe at all, and nothing it reports about coverage can be trusted.
  const status: RunSummary["status"] = truncated
    ? "failed"
    : errors.length === 0
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

/**
 * Optional window override, in hours.
 *
 * Every window-based run type takes one, and every one of them ignores it when
 * absent — the defaults below are exactly what they were. It exists because a
 * catch-up after an outage is a real operation with no fixed size: when the
 * 12-hourly cron was down for two days the gap was 48 hours, which is neither
 * the backfill's 7 days nor the scheduled run's 24. Passing the number beats
 * editing a constant and redeploying to run a one-off.
 *
 * The window only widens what is FETCHED. Dedup still decides what is stored,
 * so an over-wide window costs fetch time and finds duplicates rather than
 * creating them — which is why this is safe to guess high on.
 */
export type WindowOverride = { hours?: number | null };

const HOUR_MS = 60 * 60 * 1000;

/**
 * Resolves an override to a span, falling back to the run type's own default.
 * A non-finite or non-positive value falls back rather than producing an
 * inverted or empty window — "0 hours" is far more likely to be a parsing slip
 * than a request to fetch nothing.
 */
export function resolveWindowMs(
  fallbackMs: number,
  override?: WindowOverride
): number {
  const hours = override?.hours;
  if (typeof hours !== "number" || !Number.isFinite(hours) || hours <= 0) {
    return fallbackMs;
  }
  return hours * HOUR_MS;
}

/**
 * The wall-clock budget a run type gets.
 *
 * Every entry point takes it as a parameter rather than reading a constant,
 * because the ceiling is a property of the CALLER, not of the run type: the
 * same runScheduled() is bounded at 45s under the route and unbounded under
 * the CLI. Defaulting to DEFAULT_BUDGET_MS makes the safe case the one you get
 * by not thinking about it, and null is how the CLI opts out explicitly.
 */
export type RunOptions = WindowOverride & { budgetMs?: number | null };

/** One-time seed: all active sources for the current universe mode, 7 days. */
export async function runBackfill(
  client: IngestionClient,
  triggeredBy: string | null = null,
  options?: RunOptions
): Promise<RunSummary> {
  const mode = await getUniverseMode(client);
  const { sources, notFetchable } = await selectSources(client, mode);
  return executeRun(client, {
    runType: "backfill",
    window: windowEndingNow(resolveWindowMs(WINDOW_BACKFILL_MS, options)),
    sources,
    notFetchable,
    triggeredBy,
    budgetMs: options?.budgetMs ?? DEFAULT_BUDGET_MS,
  });
}

/**
 * Routine run, every 12h on a 24h window. The deliberate overlap re-checks the
 * second half of the previous run; the dedup fingerprint makes it free.
 */
export async function runScheduled(
  client: IngestionClient,
  options?: RunOptions
): Promise<RunSummary> {
  const mode = await getUniverseMode(client);
  const { sources, notFetchable } = await selectSources(client, mode);
  return executeRun(client, {
    runType: "scheduled",
    window: windowEndingNow(resolveWindowMs(WINDOW_SCHEDULED_MS, options)),
    sources,
    notFetchable,
    budgetMs: options?.budgetMs ?? DEFAULT_BUDGET_MS,
  });
}

/**
 * Operator-triggered re-run; same shape as scheduled, logged separately.
 *
 * This is the natural home for a catch-up after an outage: it is deliberate
 * rather than automatic, so its run row does not muddy the scheduled cadence
 * when someone later asks how the cron has been performing.
 */
export async function runManual(
  client: IngestionClient,
  triggeredBy: string | null = null,
  options?: RunOptions
): Promise<RunSummary> {
  const mode = await getUniverseMode(client);
  const { sources, notFetchable } = await selectSources(client, mode);
  return executeRun(client, {
    runType: "manual",
    window: windowEndingNow(resolveWindowMs(WINDOW_SCHEDULED_MS, options)),
    sources,
    notFetchable,
    triggeredBy,
    budgetMs: options?.budgetMs ?? DEFAULT_BUDGET_MS,
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
  options?: { budgetMs?: number | null }
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
    budgetMs: options?.budgetMs ?? DEFAULT_BUDGET_MS,
  });
}
