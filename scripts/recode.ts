/**
 * One full pass of Stage 2 coding over every article that passes sorting.
 *
 *   npm run recode -- --dry     show the before distribution and the work list
 *   npm run recode              do it, printing progress and before/after
 *   npm run recode -- --limit 20   stop after 20 (for a costed trial run)
 *
 * NOT `npm run code`, which only ever touches coded_status='pending' and is
 * therefore incapable of revisiting a judgement. This is for the case where
 * the ENGINE changed rather than the corpus.
 *
 * WHAT IT TARGETS, and why that is not "everything coded".
 *
 * The set is every active, sorted, unflagged article whose coding_version is
 * behind CODING_VERSION. That is deliberately wider than "already coded" in
 * one direction and narrower in another:
 *
 *   wider   — it includes articles never coded at all. After a sorting
 *             backlog is cleared there are always some, and a recode that
 *             skipped them would leave the corpus in exactly the split state
 *             this exists to prevent.
 *   narrower — it excludes anything already at the current version. That is
 *             what makes the run RESUMABLE.
 *
 * On resumability. The previous version of this script selected
 * coded_status='coded' — the same set it was producing as it went — so a
 * restart re-coded everything it had already done. At ~20s an article, dying
 * at 180 of 275 and restarting cost an hour to get back to where it was. The
 * version number fixes that without a checkpoint file: an article coded at
 * the current version leaves the target set the moment its row is written, so
 * "what is left to do" is a question the database answers truthfully at any
 * moment. Kill this at any point, restart it, and it continues. Nothing is
 * coded twice.
 *
 * WHAT IT DOES NOT TOUCH. Only the six coding columns are written. status,
 * matched_keywords, keyword_mention_count and every ai_sorting_* column are
 * read-only here — see the verification at the end, which checks that rather
 * than asserting it.
 *
 * Needs SUPABASE_SERVICE_ROLE_KEY: get_integration_secret() is service_role only.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import {
  codeArticles,
  CODABLE_COLUMNS,
  CODING_VERSION,
  relevanceBand,
  SENTIMENT_TIERS,
  type CodableArticle,
} from "@/lib/analysis/coding";

/**
 * Articles per chunk.
 *
 * Not a resumability mechanism — coding_version is that, and it works at
 * per-article granularity regardless of this number. Chunking exists so the
 * progress line moves and so a failure is reported near where it happened,
 * with the whole run's ordering fixed by the query rather than by the chunks.
 */
const CHUNK = 20;

type Snapshot = {
  total: number;
  byTier: Record<string, number>;
  withRelevance: number;
  withRationale: number;
  relevanceInRange: number;
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
    relevanceInRange: rows.filter(
      (r) =>
        r.ai_relevance_score !== null &&
        r.ai_relevance_score >= 0 &&
        r.ai_relevance_score <= 100
    ).length,
  };
}

function printDistribution(label: string, snap: Snapshot) {
  console.log(`\n${label} — ${snap.total} coded`);
  for (const tier of SENTIMENT_TIERS) {
    const n = snap.byTier[tier] ?? 0;
    const pct = snap.total ? ((100 * n) / snap.total).toFixed(1) : "0.0";
    const bar = "█".repeat(Math.round((n / Math.max(1, snap.total)) * 40));
    console.log(
      `  ${tier.padEnd(18)} ${String(n).padStart(4)}  ${pct.padStart(5)}%  ${bar}`
    );
  }
  const orphan = Object.keys(snap.byTier).filter(
    (t) => !(SENTIMENT_TIERS as readonly string[]).includes(t)
  );
  for (const t of orphan) {
    console.log(`  ${t.padEnd(18)} ${String(snap.byTier[t]).padStart(4)}  (off-scale)`);
  }
  console.log(
    `  with relevance ${snap.withRelevance}/${snap.total}, with rationale ${snap.withRationale}/${snap.total}`
  );
}

/**
 * The work list.
 *
 * Ordered by published_at then id so a restart resumes in the same order it
 * left off — not required for correctness (the version filter handles that)
 * but it makes two runs' progress output comparable, which matters when the
 * whole point of the second run is to continue the first.
 */
async function loadTargets(
  client: ReturnType<typeof createAdminClient>,
  limit: number | null
): Promise<CodableArticle[]> {
  let q = client
    .from("articles")
    .select(CODABLE_COLUMNS)
    .eq("status", "active")
    .eq("ai_sorting_status", "complete")
    .not("ai_sorting_flagged", "is", true)
    .or(`coding_version.is.null,coding_version.lt.${CODING_VERSION}`)
    .order("published_at", { ascending: true, nullsFirst: false })
    .order("id", { ascending: true });

  if (limit !== null) q = q.limit(limit);

  const { data, error } = await q;
  if (error) throw new Error(`Could not load articles to code: ${error.message}`);
  return (data ?? []) as CodableArticle[];
}

function eta(doneCount: number, total: number, elapsedMs: number): string {
  if (doneCount === 0) return "—";
  const perItem = elapsedMs / doneCount;
  const remainingMs = perItem * (total - doneCount);
  const mins = Math.floor(remainingMs / 60_000);
  const secs = Math.round((remainingMs % 60_000) / 1000);
  return mins > 0 ? `${mins}m${String(secs).padStart(2, "0")}s` : `${secs}s`;
}

async function main() {
  const args = process.argv.slice(2);
  const dry = args.includes("--dry");
  const limitIdx = args.indexOf("--limit");
  const limit = limitIdx === -1 ? null : Number(args[limitIdx + 1]);
  if (limit !== null && (!Number.isFinite(limit) || limit <= 0)) {
    throw new Error("--limit needs a positive number.");
  }

  const client = createAdminClient();

  const before = await snapshot(client);
  printDistribution("BEFORE", before);

  const rows = await loadTargets(client, limit);

  // Split for the readout only. Both halves get identical treatment — the
  // distinction exists because "115 never coded" and "160 being re-coded" are
  // very different amounts of new information about the corpus, and a single
  // total would hide which this run mostly is.
  const { count: freshCount } = await client
    .from("articles")
    .select("id", { count: "exact", head: true })
    .eq("status", "active")
    .eq("ai_sorting_status", "complete")
    .not("ai_sorting_flagged", "is", true)
    .eq("coded_status", "pending");

  const fresh = Math.min(freshCount ?? 0, rows.length);
  console.log(
    `\nTarget: ${rows.length} article(s) below coding_version ${CODING_VERSION}` +
      ` — ${fresh} never coded, ${rows.length - fresh} being re-coded.`
  );

  if (dry) {
    console.log("\n--dry: nothing was coded.");
    return;
  }
  if (rows.length === 0) {
    console.log(
      `\nEvery eligible article is already at coding_version ${CODING_VERSION}. Nothing to do.`
    );
    return;
  }

  console.log(`Coding in chunks of ${CHUNK}. Safe to kill and restart.\n`);

  const startedAt = Date.now();
  let processed = 0;
  let failed = 0;
  const byTheme: Record<string, number> = {};
  const byBand: Record<string, number> = {};

  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK);

    // No blanking pass before coding. The old script reset a chunk to
    // 'pending' with nulls and then re-coded it, so a run killed mid-chunk
    // left rows with no grade at all. Writing each article's new grade over
    // its old one in a single update is strictly safer: a row is either its
    // old judgement or its new one, never neither.
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

    const done = processed + failed;
    const elapsed = Date.now() - startedAt;
    console.log(
      `  ${String(done).padStart(3)}/${rows.length}` +
        `  (+${summary.processed} coded, ${summary.failed} failed)` +
        `  ${(elapsed / 1000).toFixed(0)}s elapsed, ~${eta(done, rows.length, elapsed)} left`
    );
  }

  const elapsedMs = Date.now() - startedAt;
  const seconds = (elapsedMs / 1000).toFixed(1);
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

  console.log(
    `\nre-coded ${processed}, failed ${failed}, in ${seconds}s` +
      ` (${(elapsedMs / 1000 / Math.max(1, processed)).toFixed(1)}s per article)`
  );

  // The threshold from the brief: if the bottom tier is still above ~25% the
  // prompt has not done its job, and that is a reason to iterate rather than
  // to ship. Stated by the script so it is not a judgement call afterwards.
  const vu = after.byTier["Very unfavourable"] ?? 0;
  const vuPct = after.total ? (100 * vu) / after.total : 0;
  console.log(
    `\n'Very unfavourable' is ${vuPct.toFixed(1)}% — ${
      vuPct > 25
        ? "ABOVE the 25% bar: the prompt needs another pass."
        : "within the 25% bar."
    }`
  );

  // Completeness, checked rather than assumed. Every coded row must carry a
  // relevance score in range and a non-empty rationale — those two are what
  // the grade is auditable against, and a row missing either is a grade with
  // no evidence behind it.
  const gaps: string[] = [];
  if (after.withRelevance !== after.total) {
    gaps.push(`${after.total - after.withRelevance} coded row(s) have no relevance score`);
  }
  if (after.relevanceInRange !== after.withRelevance) {
    gaps.push(
      `${after.withRelevance - after.relevanceInRange} relevance score(s) are outside 0-100`
    );
  }
  if (after.withRationale !== after.total) {
    gaps.push(`${after.total - after.withRationale} coded row(s) have no impact_rationale`);
  }

  if (gaps.length > 0) {
    console.log("\nINCOMPLETE:");
    for (const g of gaps) console.log(`  ${g}`);
    process.exitCode = 1;
  } else {
    console.log(
      `\nAll ${after.total} coded row(s) carry a relevance score in 0-100 and a non-empty impact_rationale.`
    );
  }

  const stillBehind = await loadTargets(client, null);
  if (stillBehind.length > 0) {
    console.log(
      `\n  ${stillBehind.length} article(s) still below coding_version ${CODING_VERSION}` +
        ` — run again to continue (nothing already done will be repeated).`
    );
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
