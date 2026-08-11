import { createHash } from "node:crypto";
import type { FeedItem, IngestionClient } from "./types";

/**
 * Phase 2 — dedup. Implements schema-brief table 5 exactly:
 *
 *   no existing row                    → insert, status='active'
 *   existing 'active', longer body     → update body/word_count/url, old url
 *                                        pushed to alt_urls
 *   existing 'active', not longer      → discard the pull
 *   existing 'excluded' or 'deleted'   → skip entirely, never resurrect
 *
 * The last rule is what makes a curator's exclude/delete permanent across
 * every future run, so it is checked before anything else touches the row.
 *
 * On top of that, one cross-channel rule (see CHANNEL_PRIORITY): when the same
 * fingerprint arrives from a different channel than the row was written by,
 * channel priority decides outright and word count is not consulted.
 */

export type DedupOutcome =
  | "inserted"
  | "updated"
  | "duplicate"
  | "skipped_tombstoned";

export type DedupResult = {
  outcome: DedupOutcome;
  dedupKey: string;
  articleId: string | null;
  error: string | null;
};

/**
 * Normalizes one fingerprint component: strips diacritics, drops everything
 * that isn't alphanumeric or a space, collapses whitespace, lowercases. Two
 * renderings of the same headline ("Maersk's Q3 — up 4%" vs "Maersk&#8217;s Q3
 * - up 4%") have to land on the same key, so punctuation cannot survive.
 */
export function normalizeComponent(value: string | null | undefined): string {
  if (!value) return "";
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "") // combining marks from NFKD
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Date component of the fingerprint: calendar day, not timestamp. */
export function toDateOnly(date: Date | null): string | null {
  if (!date || Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

export type FingerprintInput = {
  headline: string;
  media: string | null;
  publishedAt: Date | null;
  byline: string | null;
};

/** sha256 of normalized headline + media + published_date + byline. */
export function computeDedupKey(input: FingerprintInput): string {
  const parts = [
    normalizeComponent(input.headline),
    normalizeComponent(input.media),
    toDateOnly(input.publishedAt) ?? "",
    normalizeComponent(input.byline),
  ];
  return createHash("sha256").update(parts.join("|")).digest("hex");
}

/**
 * Which fetch path produced an item. Recorded on the row and used to break
 * cross-channel ties.
 */
export type SourceChannel = "media_rss" | "google_news_seed" | "newsdata";

/**
 * Most-preferred first. The ordering is about provenance, not length:
 *
 *   media_rss         the publisher's own feed — canonical URL, real byline,
 *                     the fullest body that publisher chooses to syndicate
 *   google_news_seed  Google's rendering of somebody else's story: the
 *                     headline carries a " - Publisher" suffix we have to strip
 *                     back off, the link is a Google redirect, and the body is
 *                     a snippet
 *   newsdata          an aggregator's summary. On the free tier it has no
 *                     `content` field at all, so its body is a description
 *
 * Word count therefore cannot arbitrate between channels: an aggregator that
 * pads a summary would beat the publisher's own feed on length while being
 * strictly worse as a record. Within one channel word count still decides,
 * exactly as before — a longer pull of the same story is a better pull.
 */
const CHANNEL_PRIORITY: SourceChannel[] = [
  "media_rss",
  "google_news_seed",
  "newsdata",
];

/**
 * Lower is better. An unrecognised or missing channel returns null, which the
 * caller reads as "no channel information" and falls back to the word-count
 * rule rather than guessing a rank.
 */
function channelRank(channel: string | null): number | null {
  const index = CHANNEL_PRIORITY.indexOf(channel as SourceChannel);
  return index === -1 ? null : index;
}

export type ArticleMatchData = {
  sourceId: string | null;
  matchedKeywords: string[];
  matchedNegativeKeywords: string[];
  mentionCount: number;
};

type ExistingRow = {
  id: string;
  status: string;
  word_count: number | null;
  url: string | null;
  alt_urls: string[];
  source_channel: string | null;
};

/**
 * Runs one already-matched feed item through the dedup rules and writes the
 * result. Callers must have cleared Phase 3 first — this function does not
 * gate on keywords, it only decides insert vs update vs discard.
 */
export async function upsertArticle(
  client: IngestionClient,
  item: FeedItem,
  match: ArticleMatchData,
  channel: SourceChannel
): Promise<DedupResult> {
  const dedupKey = computeDedupKey(item);

  const existing = await findByDedupKey(client, dedupKey);
  if (existing.error) {
    return {
      outcome: "duplicate",
      dedupKey,
      articleId: null,
      error: existing.error,
    };
  }

  if (existing.row) {
    return applyToExisting(client, existing.row, item, match, dedupKey, channel);
  }

  const { data, error } = await client
    .from("articles")
    .insert({
      dedup_key: dedupKey,
      url: item.url,
      headline: item.headline,
      byline: item.byline,
      media: item.media,
      source_id: match.sourceId,
      source_channel: channel,
      published_at: toDateOnly(item.publishedAt),
      body: item.body,
      word_count: item.wordCount,
      status: "active",
      matched_keywords: match.matchedKeywords,
      keyword_mention_count: match.mentionCount,
      matched_negative_keywords:
        match.matchedNegativeKeywords.length > 0
          ? match.matchedNegativeKeywords
          : null,
    })
    .select("id")
    .single();

  if (error) {
    // 23505: another concurrent run inserted the same fingerprint between our
    // lookup and our insert. Re-read and fall through to the existing-row
    // rules rather than failing the item.
    if (error.code === "23505") {
      const retry = await findByDedupKey(client, dedupKey);
      if (retry.row) {
        return applyToExisting(
          client,
          retry.row,
          item,
          match,
          dedupKey,
          channel
        );
      }
    }
    return {
      outcome: "duplicate",
      dedupKey,
      articleId: null,
      error: error.message,
    };
  }

  return { outcome: "inserted", dedupKey, articleId: data.id, error: null };
}

async function findByDedupKey(
  client: IngestionClient,
  dedupKey: string
): Promise<{ row: ExistingRow | null; error: string | null }> {
  const { data, error } = await client
    .from("articles")
    .select("id, status, word_count, url, alt_urls, source_channel")
    .eq("dedup_key", dedupKey)
    .maybeSingle();

  if (error) return { row: null, error: error.message };
  return { row: data, error: null };
}

/**
 * Does the incoming pull replace the stored one?
 *
 * Different channels → priority decides outright, in both directions. A
 * media_rss pull supersedes a stored newsdata row even when the aggregator's
 * padded summary is longer, and a newsdata pull is discarded against a stored
 * media_rss row even when it is longer. Provenance beats length.
 *
 * Same channel, or no channel recorded on the stored row → the original
 * word-count rule, unchanged. A null here is a row written before
 * source_channel existed; ranking it against a known channel would be
 * inventing provenance, so it falls through to the rule that was in force when
 * it was written.
 */
function shouldSupersede(
  row: ExistingRow,
  item: FeedItem,
  channel: SourceChannel
): boolean {
  const incomingRank = channelRank(channel);
  const storedRank = channelRank(row.source_channel);

  if (incomingRank !== null && storedRank !== null && incomingRank !== storedRank) {
    return incomingRank < storedRank;
  }

  return item.wordCount > (row.word_count ?? 0);
}

async function applyToExisting(
  client: IngestionClient,
  row: ExistingRow,
  item: FeedItem,
  match: ArticleMatchData,
  dedupKey: string,
  channel: SourceChannel
): Promise<DedupResult> {
  // Tombstone: excluded/deleted articles are never revived, never updated,
  // never counted as anything but a skip.
  if (row.status === "excluded" || row.status === "deleted") {
    return {
      outcome: "skipped_tombstoned",
      dedupKey,
      articleId: row.id,
      error: null,
    };
  }

  if (!shouldSupersede(row, item, channel)) {
    return { outcome: "duplicate", dedupKey, articleId: row.id, error: null };
  }

  // A different URL for the same fingerprint is a variant (timestamped or
  // syndicated), so the superseded one is kept in alt_urls rather than lost.
  const altUrls = [...(row.alt_urls ?? [])];
  if (row.url && item.url && row.url !== item.url && !altUrls.includes(row.url)) {
    altUrls.push(row.url);
  }

  const { error } = await client
    .from("articles")
    .update({
      body: item.body,
      word_count: item.wordCount,
      url: item.url ?? row.url,
      alt_urls: altUrls,
      // The row now IS the incoming pull, so its provenance is the incoming
      // channel — otherwise a media_rss row that supersedes a newsdata one
      // would keep claiming it came from the aggregator.
      source_channel: channel,
      // Recomputed from the longer body, so the matches stored alongside it
      // stay consistent with the text they were derived from.
      matched_keywords: match.matchedKeywords,
      keyword_mention_count: match.mentionCount,
      matched_negative_keywords:
        match.matchedNegativeKeywords.length > 0
          ? match.matchedNegativeKeywords
          : null,
    })
    .eq("id", row.id);

  if (error) {
    return {
      outcome: "duplicate",
      dedupKey,
      articleId: row.id,
      error: error.message,
    };
  }

  return { outcome: "updated", dedupKey, articleId: row.id, error: null };
}
