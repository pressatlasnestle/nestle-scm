/**
 * Stage 2 coding from the command line, and the storyline readout.
 *
 *   npm run code -- 7d              code active+pending articles in the last 7 days
 *   npm run code -- custom 2025-10-01 2025-12-31
 *   npm run code -- all
 *   npm run code -- storylines 30d  print the grouping, code nothing
 *
 * Coding stays a manual, deliberate act — this is a second manual trigger
 * alongside the Articles panel button, not an automatic one. It exists because
 * it runs the SAME selection and the SAME engine the button does, so what the
 * panel would do can be verified without a browser session.
 *
 * Needs SUPABASE_SERVICE_ROLE_KEY: get_integration_secret() is service_role only.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { codeArticles } from "@/lib/analysis/coding";
import {
  countCodingCandidates,
  loadCodingCandidates,
  MAX_CODING_BATCH,
  type CodingScope,
} from "@/lib/analysis/coding-batch";
import { getStorylines } from "@/lib/analysis/storylines";
import {
  describeRange,
  parsePeriodKey,
  resolvePeriod,
} from "@/lib/articles/period";

const USAGE =
  "usage: npm run code -- <all|today|7d|30d|month|custom <from> <to>>\n" +
  "       npm run code -- storylines <period> [from] [to]";

function scopeFrom(args: string[]): CodingScope {
  const period = parsePeriodKey(args[0]);
  return {
    period,
    from: period === "custom" ? args[1] ?? null : null,
    to: period === "custom" ? args[2] ?? null : null,
    channel: "all",
    q: "",
    neg: false,
    sflag: false,
  };
}

async function showStorylines(args: string[]) {
  const client = createAdminClient();
  const period = parsePeriodKey(args[0]);
  const range = resolvePeriod(period, { from: args[1], to: args[2] });

  const storylines = await getStorylines(client, range);
  const label = describeRange(period, range);

  console.log(`\nStorylines — ${label}\n`);
  if (storylines.length === 0) {
    console.log("  (no coded articles in this period)");
    return;
  }

  const real = storylines.filter((s) => s.articleCount > 1);
  const singles = storylines.length - real.length;

  for (const s of storylines) {
    const marker = s.articleCount > 1 ? "▣" : "·";
    console.log(`  ${marker} ${s.theme}  (${s.articleCount})`);
    console.log(
      `      lead: ${s.lead.headline.slice(0, 78)}` +
        `  [${s.lead.keyword_mention_count ?? 0} mentions, ${s.lead.ai_sentiment ?? "—"}]`
    );
    if (s.articleCount > 1) {
      console.log(
        `      split: ${Object.entries(s.sentimentSplit)
          .map(([t, n]) => `${t} ${n}`)
          .join(", ")}`
      );
    }
  }

  console.log(
    `\n  ${storylines.length} theme(s): ${real.length} with 2+ articles, ${singles} single-article.`
  );
}

async function runCoding(args: string[]) {
  const client = createAdminClient();
  const scope = scopeFrom(args);
  const range = resolvePeriod(scope.period, { from: scope.from, to: scope.to });
  const label = describeRange(scope.period, range);

  const { codable, skippedFlagged } = await countCodingCandidates(client, scope);
  console.log(
    `${codable} active, uncoded article(s) in ${label}; coding up to ${MAX_CODING_BATCH}.`
  );
  if (skippedFlagged > 0) {
    console.log(
      `  (${skippedFlagged} further uncoded article(s) skipped: flagged off-topic by sorting)`
    );
  }
  if (codable === 0) return;

  const { rows, total } = await loadCodingCandidates(client, scope);
  const startedAt = Date.now();
  const summary = await codeArticles(client, rows);
  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);

  console.log(`\ncoding — done in ${seconds}s`);
  console.log(`  coded      ${summary.processed}`);
  console.log(`  failed     ${summary.failed}`);
  console.log("\n  by tier:");
  for (const [tier, n] of Object.entries(summary.byTier).sort()) {
    console.log(`    ${tier.padEnd(20)} ${n}`);
  }
  console.log("\n  by theme:");
  for (const [theme, n] of Object.entries(summary.byTheme).sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0])
  )) {
    console.log(`    ${theme.padEnd(32)} ${n}`);
  }

  if (summary.errors.length > 0) {
    console.log(`\n  ${summary.errors.length} error(s):`);
    for (const e of summary.errors) console.log(`    ${e.articleId} — ${e.error}`);
  }

  const remaining = total - summary.processed;
  if (remaining > 0) {
    console.log(`\n  ${remaining} still pending — run again to continue.`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) throw new Error(USAGE);

  if (args[0] === "storylines") await showStorylines(args.slice(1));
  else await runCoding(args);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
