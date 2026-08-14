/**
 * Stage 1 sorting backfill.
 *
 *   npm run sort                 sort everything still pending (default 500 cap)
 *   npm run sort -- 50           sort at most 50
 *
 * Sorting is its own stage on its own schedule (POST /api/sorting/run, hourly).
 * It no longer runs at the tail of an ingestion run, because sharing that
 * invocation meant sharing its 60-second budget — and the fetch spent it. This
 * command runs the same pass by hand, against the same selection, without the
 * serverless ceiling: the right tool for a backlog that would take an hourly
 * cron several passes to clear.
 *
 * Idempotent: it only ever selects ai_sorting_status='pending', so running it
 * twice costs nothing the second time, and it is safe to run while the cron is
 * also running. Same shape as npm run ingest, and it needs
 * SUPABASE_SERVICE_ROLE_KEY for the same reason — get_integration_secret() is
 * granted to service_role only.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import {
  countPendingArticles,
  sortPendingArticles,
} from "@/lib/analysis/sorting";

async function main() {
  const [limitArg] = process.argv.slice(2);
  const limit = limitArg ? Number(limitArg) : 500;

  if (!Number.isFinite(limit) || limit <= 0) {
    throw new Error("usage: npm run sort [-- <limit>]");
  }

  const client = createAdminClient();
  const startedAt = Date.now();

  const before = await countPendingArticles(client);
  console.log(`${before} article(s) pending; sorting up to ${limit}.`);

  // budgetMs: null — no serverless ceiling here, so the pass runs to the end
  // of what it loaded rather than stopping at 45s like the hourly route.
  const summary = await sortPendingArticles(client, { limit, budgetMs: null });
  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);

  console.log(`\nsorting — done in ${seconds}s`);
  console.log(`  sorted     ${summary.processed}`);
  console.log(`  flagged    ${summary.flagged}`);
  console.log(`  confirmed  ${summary.confirmed}`);
  console.log(`  failed     ${summary.failed}`);

  if (summary.processed > 0) {
    const pct = (100 * summary.flagged) / summary.processed;
    console.log(
      `\n  ${pct.toFixed(1)}% flagged as out of scope, ${(100 - pct).toFixed(1)}% passed the gate.`
    );
  }

  if (summary.errors.length > 0) {
    console.log(`\n  ${summary.errors.length} error(s):`);
    for (const e of summary.errors) {
      console.log(`    ${e.articleId} — ${e.error}`);
    }
  }

  // Re-counted rather than subtracted. A failed article is still pending, so
  // before - processed would under-report the remainder by exactly the number
  // of failures — the one case where the number matters most.
  const remaining = await countPendingArticles(client);
  if (remaining > 0) {
    console.log(`\n  ${remaining} still pending — run again to continue.`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
