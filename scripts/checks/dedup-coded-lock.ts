/**
 * The coded-article lock, exercised against a real database.
 *
 *   npx tsx --env-file=.env.local scripts/checks/dedup-coded-lock.ts
 *
 * scripts/checks/dedup.ts already pins the fingerprint and the supersede rules
 * without a database. This one cannot be done that way: the thing being
 * checked is that upsertArticle() READS coded_status off the stored row and
 * refuses to write, which only means anything against a real row that a real
 * query returns.
 *
 * It builds its own fixtures, asserts, and removes them again — including on
 * failure. Nothing it creates outlives the run, and it never touches a row it
 * did not insert (every fixture carries a run-specific marker in its headline).
 *
 * The scenario is the exact one that motivated the guard: an article is coded,
 * then a LONGER version of the same story arrives on a HIGHER-priority channel
 * — both conditions that would otherwise force a supersede.
 */
import { createAdminClient } from "../../src/lib/supabase/admin";
import { computeDedupKey, upsertArticle } from "../../src/lib/ingestion/dedup";
import type { FeedItem } from "../../src/lib/ingestion/types";

const MARKER = `zzdedupcheck${Date.now()}`;

const SHORT_BODY = "Maersk reroutes two Asia-Europe strings via the Cape. ".repeat(4);
const LONG_BODY = "Maersk reroutes two Asia-Europe strings via the Cape. ".repeat(60);

function item(overrides: Partial<FeedItem>): FeedItem {
  const body = overrides.body ?? SHORT_BODY;
  return {
    headline: `${MARKER} Maersk reroutes Asia-Europe strings`,
    url: "https://example.test/original",
    byline: "Test Byline",
    media: "Example Shipping Wire",
    publishedAt: new Date("2026-08-11T00:00:00Z"),
    body,
    wordCount: body.split(/\s+/).filter(Boolean).length,
    ...overrides,
  } as FeedItem;
}

const MATCH = {
  sourceId: null,
  matchedKeywords: ["Maersk", "Asia-Europe"],
  matchedNegativeKeywords: [],
  mentionCount: 7,
};

async function main() {
  const client = createAdminClient();
  let failures = 0;
  const check = (ok: boolean, msg: string) => {
    if (!ok) failures += 1;
    console.log(`${ok ? "PASS" : "FAIL"}  ${msg}`);
  };

  const createdIds: string[] = [];

  try {
    // --- Fixture: an article captured, then coded --------------------------
    const first = item({});
    const inserted = await upsertArticle(client, first, MATCH, "google_news_seed");
    if (!inserted.articleId) {
      throw new Error(`Could not insert the fixture: ${inserted.error}`);
    }
    createdIds.push(inserted.articleId);
    check(inserted.outcome === "inserted", `fixture inserted (${inserted.outcome})`);

    // Code it, exactly as the Stage 2 engine would.
    const CODED = {
      coded_status: "coded",
      ai_sentiment: "Very unfavourable",
      ai_themes: ["Chokepoints & routing", "Service network changes"],
      ai_summary:
        "Maersk has rerouted two Asia-Europe strings via the Cape of Good Hope, adding transit days.",
      ai_sorting_status: "complete",
    };
    const { error: codeError } = await client
      .from("articles")
      .update(CODED)
      .eq("id", inserted.articleId);
    if (codeError) throw new Error(`Could not code the fixture: ${codeError.message}`);

    const before = await load(client, inserted.articleId);
    check(
      before.coded_status === "coded" && before.word_count === first.wordCount,
      `fixture is coded, body ${before.word_count} words, sentiment "${before.ai_sentiment}"`
    );

    // --- The pull that would previously have overwritten it ----------------
    // Longer body AND a higher-priority channel (media_rss beats
    // google_news_seed), so both supersede paths are triggered at once. Same
    // headline/media/date/byline, so it is the same fingerprint.
    const better = item({ body: LONG_BODY, url: "https://example.test/fuller" });
    check(
      better.wordCount > first.wordCount,
      `incoming pull is genuinely longer (${better.wordCount} vs ${first.wordCount} words)`
    );
    check(
      computeDedupKey(better) === computeDedupKey(first),
      "incoming pull has the same dedup fingerprint (it IS the same story)"
    );

    const result = await upsertArticle(client, better, MATCH, "media_rss");
    check(
      result.outcome === "skipped_coded",
      `pull was refused with outcome "${result.outcome}" (expected skipped_coded)`
    );
    check(
      result.articleId === inserted.articleId,
      "the refusal still identifies which article it protected"
    );

    // --- The actual point: nothing on the row changed ----------------------
    const after = await load(client, inserted.articleId);

    check(after.body === before.body, "body unchanged");
    check(after.word_count === before.word_count, `word_count unchanged (${after.word_count})`);
    check(after.url === before.url, `url unchanged (${after.url})`);
    check(
      after.source_channel === before.source_channel,
      `source_channel unchanged (${after.source_channel}) — provenance not rewritten`
    );
    check(
      after.ai_sentiment === before.ai_sentiment,
      `ai_sentiment unchanged (${after.ai_sentiment})`
    );
    check(
      JSON.stringify(after.ai_themes) === JSON.stringify(before.ai_themes),
      `ai_themes unchanged (${JSON.stringify(after.ai_themes)})`
    );
    check(after.ai_summary === before.ai_summary, "ai_summary unchanged");
    check(after.coded_status === "coded", "coded_status still 'coded'");
    check(
      JSON.stringify(after.alt_urls) === JSON.stringify(before.alt_urls),
      "alt_urls unchanged — the refused url was not even recorded as a variant"
    );

    // --- Control: the guard must not have broken ordinary superseding ------
    // Same setup, NOT coded. The longer pull must still win, or the fix would
    // have retired the longer-body rule instead of narrowing it.
    const controlItem = item({
      headline: `${MARKER} Control uncoded story`,
      url: "https://example.test/control-original",
    });
    const control = await upsertArticle(
      client,
      controlItem,
      MATCH,
      "google_news_seed"
    );
    if (!control.articleId) throw new Error("Could not insert the control fixture.");
    createdIds.push(control.articleId);

    const controlBetter = item({
      headline: `${MARKER} Control uncoded story`,
      url: "https://example.test/control-fuller",
      body: LONG_BODY,
    });
    const controlResult = await upsertArticle(
      client,
      controlBetter,
      MATCH,
      "media_rss"
    );
    const controlAfter = await load(client, control.articleId);
    check(
      controlResult.outcome === "updated",
      `control (uncoded) still supersedes normally (${controlResult.outcome})`
    );
    check(
      controlAfter.word_count === controlBetter.wordCount,
      `control body WAS replaced (${controlAfter.word_count} words) — the longer-body rule still works`
    );

    // --- Control 2: tombstones still win, and are reported as tombstones ---
    const { error: excludeError } = await client
      .from("articles")
      .update({ status: "excluded", coded_status: "coded" })
      .eq("id", control.articleId);
    if (excludeError) throw new Error(excludeError.message);

    const tombstoned = await upsertArticle(
      client,
      controlBetter,
      MATCH,
      "media_rss"
    );
    check(
      tombstoned.outcome === "skipped_tombstoned",
      `an excluded AND coded row reports skipped_tombstoned, not skipped_coded (${tombstoned.outcome}) — the tombstone check stays first`
    );
  } finally {
    // Always clean up, including after an assertion failure.
    if (createdIds.length > 0) {
      const { error } = await client.from("articles").delete().in("id", createdIds);
      console.log(
        error
          ? `\nWARNING: could not remove fixtures ${createdIds.join(", ")}: ${error.message}`
          : `\nRemoved ${createdIds.length} fixture row(s).`
      );
    }
    // Belt and braces: nothing carrying this run's marker may survive.
    const { count } = await client
      .from("articles")
      .select("id", { count: "exact", head: true })
      .ilike("headline", `%${MARKER}%`);
    console.log(`Fixtures remaining with marker: ${count ?? 0}`);
  }

  console.log(failures === 0 ? "\nAll coded-lock checks passed." : `\n${failures} FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

async function load(client: ReturnType<typeof createAdminClient>, id: string) {
  const { data, error } = await client
    .from("articles")
    .select(
      "body, word_count, url, alt_urls, source_channel, coded_status, ai_sentiment, ai_themes, ai_summary"
    )
    .eq("id", id)
    .single();
  if (error) throw new Error(`Could not read article ${id}: ${error.message}`);
  return data;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
