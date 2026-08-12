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
 *   existing coded_status='coded'      → skip entirely, never overwrite
 *
 * The last two rules are what make a decision permanent across every future
 * run, so both are checked before anything else touches the row.
 *
 * On top of that, one cross-channel rule (see CHANNEL_PRIORITY): when the same
 * fingerprint arrives from a different channel than the row was written by,
 * channel priority decides outright and word count is not consulted.
 */

export type DedupOutcome =
  | "inserted"
  | "updated"
  | "duplicate"
  | "skipped_tombstoned"
  /** Locked: the row has been coded, so its stored text must not change. */
  | "skipped_coded";

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
export type SourceChannel =
  | "media_rss"
  | "google_alerts"
  | "google_news_seed"
  | "newsapi_ai";

/**
 * Most-preferred first. The ordering is about provenance, not length:
 *
 *   media_rss         the publisher's own feed — canonical URL, real byline,
 *                     the fullest body that publisher chooses to syndicate
 *   google_alerts     a standing Google Alerts search on a curated term. Still
 *                     Google's summary of somebody else's story, so it loses to
 *                     the publisher's own feed — but it is a live search
 *                     against a term the curator chose and it carries a real
 *                     `sources` row, so it beats both one-shot aggregator seeds
 *   google_news_seed  Google's rendering of somebody else's story: the
 *                     headline carries a " - Publisher" suffix we have to strip
 *                     back off, the link is a Google redirect, and the body is
 *                     a snippet
 *   newsapi_ai        an aggregator's copy. It carries the full article text,
 *                     which the two Google channels do not — but it is still a
 *                     third party's rendering, with the aggregator's own view
 *                     of the byline and canonical URL, so the publisher's feed
 *                     still wins where both have the story
 *
 * Word count therefore cannot arbitrate between channels: newsapi_ai returns
 * whole articles and would beat a publisher's own summary-length RSS entry on
 * length every time, while being the less authoritative record of the two.
 * Within one channel word count still decides, exactly as before — a longer
 * pull of the same story is a better pull.
 *
 * 'newsdata' is deliberately absent. The one article still carrying that value
 * predates the swap to newsapi.ai and is left as historical record; channelRank
 * returns null for it, so it falls through to the word-count rule rather than
 * being ranked against a channel it never competed with.
 */
const CHANNEL_PRIORITY: SourceChannel[] = [
  "media_rss",
  "google_alerts",
  "google_news_seed",
  "newsapi_ai",
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
  coded_status: string | null;
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
    .select("id, status, word_count, url, alt_urls, source_channel, coded_status")
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

  /**
   * Coded articles are locked content — same tier as the tombstone above, and
   * checked before channel priority or word count get a say.
   *
   * ai_sentiment, ai_themes and ai_summary are all derived from the `body` on
   * this row. Superseding the body without re-coding leaves those three
   * describing text that is no longer stored, and nothing anywhere would say
   * so: the charts, the weekly narrative and the newsletter would all keep
   * quoting an analysis of an article that has silently been replaced. Coding
   * costs a Gemini call per article and is a deliberate, analyst-triggered
   * step, so the stale result would also outlive the next several runs.
   *
   * The cost is real and accepted: a genuinely better version of an
   * already-coded article will not be picked up, and its body stays whatever
   * was first captured. That is the right way round. Missing a fuller body on
   * something already analysed is a gap; silently invalidating a finished
   * analysis is a corruption, and only one of the two is visible to the person
   * relying on it.
   *
   * WHY NOT ALSO LOCK ON ai_sorting_status = 'complete'.
   *
   * Because it would lock everything. Sorting fires automatically over every
   * newly inserted row at the end of each run, so an article is 'complete'
   * within minutes of first capture — measured on the live corpus, 122 of 122
   * articles. Locking on it would make shouldSupersede() unreachable and
   * retire the longer-body rule by accident rather than by decision. Sorting's
   * output is also advisory (it flags, it never hides), so a stale relevance
   * judgement is cheap and an analyst can clear it; a stale sentiment tier is
   * not, because it is published.
   *
   * An operator who does want the newer body has a deliberate route: exclude
   * the row, or reset coded_status to 'pending' and let the next run take it.
   */
  if (row.coded_status === "coded") {
    return {
      outcome: "skipped_coded",
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
