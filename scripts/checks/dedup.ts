/**
 * Dedup and channel-labelling checks.
 *
 *   npm run check:dedup
 *
 * upsertArticle runs against an in-memory stub of the two Supabase calls it
 * makes, so the cross-channel priority rule, the same-channel word-count
 * tiebreak, the tombstone rule and the written payload can all be pinned
 * without a database.
 */
import { upsertArticle, type SourceChannel } from "@/lib/ingestion/dedup";
import { channelForSource } from "@/lib/ingestion/run";
import type { FeedItem, IngestionClient } from "@/lib/ingestion/types";

type StoredRow = {
  id: string;
  status: string;
  word_count: number | null;
  url: string | null;
  alt_urls: string[];
  source_channel: string | null;
};

let lastInsert: Record<string, unknown> | null = null;
let lastUpdate: Record<string, unknown> | null = null;

function stubClient(existing: StoredRow | null): IngestionClient {
  return {
    from() {
      return {
        select() {
          return {
            eq() {
              return {
                maybeSingle: async () => ({ data: existing, error: null }),
              };
            },
          };
        },
        insert(payload: Record<string, unknown>) {
          lastInsert = payload;
          return {
            select: () => ({
              single: async () => ({ data: { id: "new-id" }, error: null }),
            }),
          };
        },
        update(payload: Record<string, unknown>) {
          lastUpdate = payload;
          return { eq: async () => ({ error: null }) };
        },
      };
    },
  } as unknown as IngestionClient;
}

function item(wordCount: number, url: string): FeedItem {
  return {
    headline: "Port congestion worsens at Rotterdam",
    url,
    byline: "A Reporter",
    media: "Splash247",
    publishedAt: new Date("2026-08-10T09:00:00Z"),
    body: "body ".repeat(wordCount).trim(),
    wordCount,
  };
}

const match = {
  sourceId: null,
  matchedKeywords: ["container shipping", "port congestion"],
  matchedNegativeKeywords: [],
  mentionCount: 7,
};

function row(channel: string | null, wordCount: number): StoredRow {
  return {
    id: "existing-id",
    status: "active",
    word_count: wordCount,
    url: "https://old.example/a",
    alt_urls: [],
    source_channel: channel,
  };
}

type Check = {
  name: string;
  existing: StoredRow | null;
  incoming: SourceChannel;
  words: number;
  expect: string;
};

const CHECKS: Check[] = [
  { name: "fresh insert records channel + mention count", existing: null, incoming: "newsapi_ai", words: 40, expect: "inserted" },

  // cross-channel: priority wins outright, in BOTH directions
  { name: "media_rss beats stored newsapi_ai even when SHORTER", existing: row("newsapi_ai", 900), incoming: "media_rss", words: 40, expect: "updated" },
  { name: "newsapi_ai loses to stored media_rss even when LONGER", existing: row("media_rss", 40), incoming: "newsapi_ai", words: 900, expect: "duplicate" },
  { name: "media_rss beats stored google_news_seed when shorter", existing: row("google_news_seed", 500), incoming: "media_rss", words: 30, expect: "updated" },
  { name: "google_news_seed beats stored newsapi_ai when shorter", existing: row("newsapi_ai", 500), incoming: "google_news_seed", words: 30, expect: "updated" },
  { name: "google_news_seed loses to stored media_rss when longer", existing: row("media_rss", 30), incoming: "google_news_seed", words: 500, expect: "duplicate" },

  // google_alerts sits between media_rss and the two aggregator seeds
  { name: "google_alerts beats stored newsapi_ai even when SHORTER", existing: row("newsapi_ai", 900), incoming: "google_alerts", words: 40, expect: "updated" },
  { name: "newsapi_ai loses to stored google_alerts even when LONGER", existing: row("google_alerts", 40), incoming: "newsapi_ai", words: 900, expect: "duplicate" },
  { name: "google_alerts beats stored google_news_seed when shorter", existing: row("google_news_seed", 500), incoming: "google_alerts", words: 30, expect: "updated" },
  { name: "google_alerts loses to stored media_rss even when LONGER", existing: row("media_rss", 40), incoming: "google_alerts", words: 900, expect: "duplicate" },
  { name: "media_rss beats stored google_alerts when shorter", existing: row("google_alerts", 500), incoming: "media_rss", words: 30, expect: "updated" },
  { name: "same channel google_alerts, longer wins", existing: row("google_alerts", 100), incoming: "google_alerts", words: 400, expect: "updated" },

  // same channel: unchanged word-count tiebreak
  { name: "same channel, longer wins", existing: row("media_rss", 100), incoming: "media_rss", words: 400, expect: "updated" },
  { name: "same channel, not longer loses", existing: row("media_rss", 400), incoming: "media_rss", words: 100, expect: "duplicate" },
  { name: "same channel, equal length loses", existing: row("newsapi_ai", 100), incoming: "newsapi_ai", words: 100, expect: "duplicate" },

  // pre-migration rows with no channel fall back to word count
  { name: "null stored channel, longer wins", existing: row(null, 100), incoming: "newsapi_ai", words: 400, expect: "updated" },
  { name: "null stored channel, shorter loses", existing: row(null, 400), incoming: "media_rss", words: 100, expect: "duplicate" },

  // The retired 'newsdata' channel survives on one historical article. It is
  // no longer in CHANNEL_PRIORITY, so it must rank as unknown and fall back to
  // word count rather than being ranked against channels it never competed
  // with — and it must never be treated as unbeatable.
  { name: "retired newsdata channel, longer wins (falls back to word count)", existing: row("newsdata", 100), incoming: "newsapi_ai", words: 400, expect: "updated" },
  { name: "retired newsdata channel, shorter loses (no priority shortcut)", existing: row("newsdata", 400), incoming: "media_rss", words: 100, expect: "duplicate" },

  // tombstones still win over everything
  { name: "excluded tombstone survives a higher-priority channel", existing: { ...row("newsapi_ai", 10), status: "excluded" }, incoming: "media_rss", words: 900, expect: "skipped_tombstoned" },
  { name: "deleted tombstone survives a higher-priority channel", existing: { ...row("newsapi_ai", 10), status: "deleted" }, incoming: "media_rss", words: 900, expect: "skipped_tombstoned" },
];

/** channelForSource: the tier is the only thing distinguishing the two. */
const CHANNEL_LABELS: { tier: string | null; expect: SourceChannel }[] = [
  { tier: "Alerts - Google standing search", expect: "google_alerts" },
  { tier: "T1a - Trade press, feed available", expect: "media_rss" },
  { tier: "T5 - Mainstream (filtered)", expect: "media_rss" },
  { tier: "alerts - google standing search", expect: "media_rss" }, // exact match only
  { tier: null, expect: "media_rss" },
];

let failures = 0;

async function main() {
  for (const check of CHECKS) {
    lastInsert = null;
    lastUpdate = null;
    const result = await upsertArticle(
      stubClient(check.existing),
      item(check.words, "https://new.example/a"),
      match,
      check.incoming
    );
    const ok = result.outcome === check.expect;
    if (!ok) failures += 1;
    console.log(
      `${ok ? "PASS" : "FAIL"}  ${check.name}` +
        (ok ? "" : `  (got ${result.outcome}, want ${check.expect})`)
    );
  }

  for (const label of CHANNEL_LABELS) {
    const got = channelForSource({
      id: "s1",
      name: "a source",
      rss_url: "https://example.com/feed",
      tier: label.tier,
    });
    const ok = got === label.expect;
    if (!ok) failures += 1;
    console.log(
      `${ok ? "PASS" : "FAIL"}  channelForSource(tier=${label.tier ?? "null"}) -> ${got}` +
        (ok ? "" : `, want ${label.expect}`)
    );
  }

  // Payload shape: the columns added in migration 18 must actually be written,
  // on insert and on supersede.
  lastInsert = null;
  await upsertArticle(stubClient(null), item(50, "https://x.example/a"), match, "google_alerts");
  const ins = lastInsert as Record<string, unknown> | null;
  const insOk = ins?.source_channel === "google_alerts" && ins?.keyword_mention_count === 7;
  if (!insOk) failures += 1;
  console.log(
    `${insOk ? "PASS" : "FAIL"}  insert payload: source_channel=${ins?.source_channel} keyword_mention_count=${ins?.keyword_mention_count}`
  );

  lastUpdate = null;
  await upsertArticle(stubClient(row("newsapi_ai", 900)), item(50, "https://x.example/b"), match, "google_alerts");
  const upd = lastUpdate as Record<string, unknown> | null;
  const updOk =
    upd?.source_channel === "google_alerts" &&
    upd?.keyword_mention_count === 7 &&
    JSON.stringify(upd?.alt_urls) === JSON.stringify(["https://old.example/a"]);
  if (!updOk) failures += 1;
  console.log(
    `${updOk ? "PASS" : "FAIL"}  supersede payload: source_channel=${upd?.source_channel} keyword_mention_count=${upd?.keyword_mention_count} alt_urls=${JSON.stringify(upd?.alt_urls)}`
  );

  const total = CHECKS.length + CHANNEL_LABELS.length + 2;
  console.log(`\n${total - failures}/${total} passed`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
