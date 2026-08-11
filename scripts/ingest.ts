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
 * This is the one-time manual trigger for the backfill: it runs the same code
 * the cron and the route run, against the same database, so it needs
 * SUPABASE_SERVICE_ROLE_KEY in .env.local. Useful before the app is deployed
 * anywhere, and for re-seeding afterwards.
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
  "usage: npm run ingest -- <backfill|scheduled|manual|source <uuid>|google-news|newsapi-ai>";

async function main() {
  const [command, argument] = process.argv.slice(2);
  const client = createAdminClient();

  let summary: RunSummary;
  const startedAt = Date.now();

  switch (command) {
    case "backfill":
      summary = await runBackfill(client);
      break;
    case "scheduled":
      summary = await runScheduled(client);
      break;
    case "manual":
      summary = await runManual(client);
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
