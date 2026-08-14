/**
 * Re-code every already-coded article under the current prompt.
 *
 *   npm run recode -- --dry     show the before distribution and stop
 *   npm run recode              re-code everything, print before/after
 *
 * DISTINCT FROM `npm run code`, which only ever touches coded_status='pending'
 * and is therefore incapable of revisiting a judgement. This exists for the
 * case where the PROMPT changed rather than the corpus: every stored grade was
 * produced by a version of the engine that no longer exists, so leaving them
 * in place would mean the panel showed two incompatible scales at once.
 *
 * It resets in place and re-codes in the same pass, so an interrupted run
 * leaves the remainder as 'pending' — recoverable with `npm run code`, not
 * lost. Nothing outside the five coding fields is touched: status,
 * matched_keywords, keyword_mention_count and the Stage 1 sorting columns are
 * read-only here.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import {
  codeArticles,
  relevanceBand,
  SENTIMENT_TIERS,
  type CodableArticle,
} from "@/lib/analysis/coding";

/** Same bound as a normal coding batch, for the same wall-clock reason. */
const CHUNK = 40;

type Snapshot = {
  total: number;
  byTier: Record<string, number>;
  withRelevance: number;
  withRationale: number;
};

async function snapshot(
  client: ReturnType<typeof createAdminClient>
): Promise<Snapshot> {
  const { data } = await client
    .from("articles")
    .select("ai_sentiment, ai_relevance_score, impact_rationale")
    .eq("coded_status", "coded");

  const rows = data ?? [];
  const byTier: Record<string, number> = {};
  for (const r of rows) {
    const t = r.ai_sentiment ?? "(none)";
    byTier[t] = (byTier[t] ?? 0) + 1;
  }
  return {
    total: rows.length,
    byTier,
    withRelevance: rows.filter((r) => r.ai_relevance_score !== null).length,
    withRationale: rows.filter((r) => (r.impact_rationale ?? "").trim()).length,
  };
}

function printDistribution(label: string, snap: Snapshot) {
  console.log(`\n${label} — ${snap.total} coded`);
  for (const tier of SENTIMENT_TIERS) {
    const n = snap.byTier[tier] ?? 0;
    const pct = snap.total ? ((100 * n) / snap.total).toFixed(1) : "0.0";
    const bar = "█".repeat(Math.round((n / Math.max(1, snap.total)) * 40));
    console.log(`  ${tier.padEnd(18)} ${String(n).padStart(4)}  ${pct.padStart(5)}%  ${bar}`);
  }
  console.log(
    `  with relevance ${snap.withRelevance}/${snap.total}, with rationale ${snap.withRationale}/${snap.total}`
  );
}

async function main() {
  const dry = process.argv.includes("--dry");
  const client = createAdminClient();

  const before = await snapshot(client);
  printDistribution("BEFORE", before);
  if (dry) return;
  if (before.total === 0) {
    console.log("\nNothing coded to re-code.");
    return;
  }

  // Ordered so an interrupted run resumes predictably rather than at random.
  const { data: targets, error } = await client
    .from("articles")
    .select("id, headline, body, matched_keywords")
    .eq("coded_status", "coded")
    .order("published_at", { ascending: true, nullsFirst: false })
    .order("id", { ascending: true });

  if (error) throw new Error(`Could not load coded articles: ${error.message}`);
  const rows = (targets ?? []) as CodableArticle[];

  console.log(`\nRe-coding ${rows.length} article(s) in chunks of ${CHUNK}…\n`);

  const startedAt = Date.now();
  let processed = 0;
  let failed = 0;
  const byTheme: Record<string, number> = {};
  const byBand: Record<string, number> = {};

  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK);

    // Reset immediately before coding the slice, not all at once up front: if
    // the run dies at chunk 3, chunks 4+ keep their old grades rather than
    // being blanked with nothing to replace them.
    const { error: resetError } = await client
      .from("articles")
      .update({
        coded_status: "pending",
        ai_sentiment: null,
        ai_relevance_score: null,
        impact_rationale: null,
        ai_themes: null,
        ai_summary: null,
      })
      .in(
        "id",
        slice.map((r) => r.id)
      );
    if (resetError) throw new Error(`Reset failed: ${resetError.message}`);

    const summary = await codeArticles(client, slice);
    processed += summary.processed;
    failed += summary.failed;
    for (const [k, v] of Object.entries(summary.byTheme)) {
      byTheme[k] = (byTheme[k] ?? 0) + v;
    }
    for (const [k, v] of Object.entries(summary.byRelevanceBand)) {
      byBand[k] = (byBand[k] ?? 0) + v;
    }
    for (const e of summary.errors) {
      console.log(`  ERROR ${e.articleId} — ${e.error}`);
    }
    console.log(
      `  chunk ${i / CHUNK + 1}: ${summary.processed} coded, ${summary.failed} failed  (${processed}/${rows.length})`
    );
  }

  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  const after = await snapshot(client);

  printDistribution("AFTER", after);

  console.log("\nRelevance bands:");
  for (const band of Object.keys(byBand).sort()) {
    console.log(`  ${band.padEnd(16)} ${byBand[band]}`);
  }

  console.log("\nThemes:");
  for (const [theme, n] of Object.entries(byTheme).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${theme.padEnd(34)} ${n}`);
  }

  console.log(`\nre-coded ${processed}, failed ${failed}, in ${seconds}s`);

  // The threshold from the brief: if the bottom tier is still above ~25% the
  // prompt has not done its job, and that is a reason to iterate rather than
  // to ship. Stated by the script so it is not a judgement call afterwards.
  const vu = after.byTier["Very unfavourable"] ?? 0;
  const vuPct = after.total ? (100 * vu) / after.total : 0;
  console.log(
    `\n'Very unfavourable' is ${vuPct.toFixed(1)}% — ${vuPct > 25 ? "ABOVE the 25% bar: the prompt needs another pass." : "within the 25% bar."}`
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
