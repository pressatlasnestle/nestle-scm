/**
 * Stage 1 sorting backfill.
 *
 *   npm run sort                 sort everything still pending (default 500 cap)
 *   npm run sort -- 50           sort at most 50
 *
 * Sorting fires automatically at the end of every ingestion run, so this exists
 * for the articles that predate the feature — and as the recovery path when a
 * post-ingestion pass fails (those rows simply stay 'pending').
 *
 * Idempotent: it only ever selects ai_sorting_status='pending', so running it
 * twice costs nothing the second time. Same shape as npm run ingest, and it
 * needs SUPABASE_SERVICE_ROLE_KEY for the same reason — get_integration_secret()
 * is granted to service_role only.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { sortPendingArticles } from "@/lib/analysis/sorting";

async function main() {
  const [limitArg] = process.argv.slice(2);
  const limit = limitArg ? Number(limitArg) : 500;

  if (!Number.isFinite(limit) || limit <= 0) {
    throw new Error("usage: npm run sort [-- <limit>]");
  }

  const client = createAdminClient();
  const startedAt = Date.now();

  const { count } = await client
    .from("articles")
    .select("id", { count: "exact", head: true })
    .eq("ai_sorting_status", "pending");

  console.log(`${count ?? 0} article(s) pending; sorting up to ${limit}.`);

  const summary = await sortPendingArticles(client, limit);
  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);

  console.log(`\nsorting — done in ${seconds}s`);
  console.log(`  sorted     ${summary.processed}`);
  console.log(`  flagged    ${summary.flagged}`);
  console.log(`  confirmed  ${summary.confirmed}`);
  console.log(`  failed     ${summary.failed}`);

  if (summary.errors.length > 0) {
    console.log(`\n  ${summary.errors.length} error(s):`);
    for (const e of summary.errors) {
      console.log(`    ${e.articleId} — ${e.error}`);
    }
  }

  const remaining = (count ?? 0) - summary.processed;
  if (remaining > 0) {
    console.log(`\n  ${remaining} still pending — run again to continue.`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
