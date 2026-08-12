/**
 * Manual ingestion trigger.
 *
 *   npm run ingest -- backfill          all active sources, 7-day window
 *   npm run ingest -- scheduled         all active sources, 24-hour window
 *   npm run ingest -- manual            same as scheduled, logged separately
 *   npm run ingest -- source <uuid>     one source, 7-day window
 *   npm run ingest -- google-news       one-time Google News breadth seed
 *   npm run ingest -- newsapi-ai        newsapi.ai pass over the gap sources
 *
 *   --hours <n>   overrides the window for backfill/scheduled/manual.
 *                 Omitted, each keeps the default above exactly.
 *                 e.g. npm run ingest -- manual --hours 48
 *
 * This is the one-time manual trigger for the backfill: it runs the same code
 * the cron and the route run, against the same database, so it needs
 * SUPABASE_SERVICE_ROLE_KEY in .env.local. Useful before the app is deployed
 * anywhere, and for re-seeding afterwards.
 *
 * WHY A CATCH-UP BELONGS HERE RATHER THAN ON THE HTTP ROUTE. The route runs
 * inside a serverless request capped at 60s, and a widened window fetches the
 * same 71 sources but parses more items from each. The CLI has no such
 * ceiling, so a long catch-up finishes rather than being killed halfway with
 * its run row stranded at 'running'.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import {
  runBackfill,
  runForSource,
  runManual,
  runScheduled,
  type RunSummary,
} from "@/lib/ingestion/run";
import { runGoogleNewsSweep } from "@/lib/ingestion/google-news";
import { runNewsApiAiSweep } from "@/lib/ingestion/newsapi-ai";

const USAGE =
  "usage: npm run ingest -- <backfill|scheduled|manual|source <uuid>|google-news|newsapi-ai> [--hours <n>]";

/**
 * Pulls `--hours <n>` out of argv and returns it with the flag removed, so the
 * positional arguments behind it are unaffected wherever it is written.
 *
 * A malformed value is rejected loudly rather than silently ignored: silently
 * falling back to the default would run the WRONG WINDOW and still report
 * success, and the only symptom would be a catch-up that quietly missed the
 * period it was run to cover.
 */
function takeHours(argv: string[]): { hours: number | null; rest: string[] } {
  const i = argv.indexOf("--hours");
  if (i === -1) return { hours: null, rest: argv };

  const raw = argv[i + 1];
  const hours = Number(raw);
  if (!raw || !Number.isFinite(hours) || hours <= 0) {
    throw new Error(
      `--hours needs a positive number of hours, got ${JSON.stringify(raw ?? null)}.\n${USAGE}`
    );
  }

  const rest = [...argv];
  rest.splice(i, 2);
  return { hours, rest };
}

async function main() {
  const { hours, rest } = takeHours(process.argv.slice(2));
  const [command, argument] = rest;
  const client = createAdminClient();

  const windowOverride = hours === null ? undefined : { hours };
  if (hours !== null) {
    console.log(
      `Window override: ${hours}h (default for this run type is ignored).\n`
    );
  }

  let summary: RunSummary;
  const startedAt = Date.now();

  switch (command) {
    case "backfill":
      summary = await runBackfill(client, null, undefined, windowOverride);
      break;
    case "scheduled":
      summary = await runScheduled(client, undefined, windowOverride);
      break;
    case "manual":
      summary = await runManual(client, null, undefined, windowOverride);
      break;
    case "source":
      if (!argument) throw new Error("source requires a source id.\n" + USAGE);
      summary = await runForSource(client, argument);
      break;
    case "google-news":
      summary = await runGoogleNewsSweep(client);
      break;
    case "newsapi-ai":
      summary = await runNewsApiAiSweep(client);
      break;
    default:
      throw new Error(USAGE);
  }

  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`\n${summary.runType} — ${summary.status} in ${seconds}s`);
  console.log(`  run id                 ${summary.runId ?? "(not logged)"}`);
  console.log(`  sources checked        ${summary.sourcesChecked}`);
  console.log(`  articles found         ${summary.articlesFound}`);
  console.log(`  articles new           ${summary.articlesNew}`);
  console.log(`  articles duplicate     ${summary.articlesDuplicate}`);
  console.log(`  skipped (paywall/stub) ${summary.articlesSkippedPaywall}`);
  console.log(`  suppressed (exclusion) ${summary.articlesSuppressedExclusion}`);
  // The coded-article lock. Printed unconditionally, including when zero, so
  // "nothing was protected" and "the guard never reported" look different.
  console.log(`  kept coded (not overwritten) ${summary.articlesSkippedCoded}`);

  if (summary.errors.length > 0) {
    console.log(`\n  ${summary.errors.length} source error(s):`);
    for (const error of summary.errors) {
      console.log(`    ${error.source} — ${error.error}`);
    }
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
