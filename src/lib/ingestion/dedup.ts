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

export type ArticleMatchData = {
  sourceId: string | null;
  matchedKeywords: string[];
  matchedNegativeKeywords: string[];
};

type ExistingRow = {
  id: string;
  status: string;
  word_count: number | null;
  url: string | null;
  alt_urls: string[];
};

/**
 * Runs one already-matched feed item through the dedup rules and writes the
 * result. Callers must have cleared Phase 3 first — this function does not
 * gate on keywords, it only decides insert vs update vs discard.
 */
export async function upsertArticle(
  client: IngestionClient,
  item: FeedItem,
  match: ArticleMatchData
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
    return applyToExisting(client, existing.row, item, match, dedupKey);
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
      published_at: toDateOnly(item.publishedAt),
      body: item.body,
      word_count: item.wordCount,
      status: "active",
      matched_keywords: match.matchedKeywords,
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
        return applyToExisting(client, retry.row, item, match, dedupKey);
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
    .select("id, status, word_count, url, alt_urls")
    .eq("dedup_key", dedupKey)
    .maybeSingle();

  if (error) return { row: null, error: error.message };
  return { row: data, error: null };
}

async function applyToExisting(
  client: IngestionClient,
  row: ExistingRow,
  item: FeedItem,
  match: ArticleMatchData,
  dedupKey: string
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

  const isLonger = item.wordCount > (row.word_count ?? 0);
  if (!isLonger) {
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
      // Recomputed from the longer body, so the matches stored alongside it
      // stay consistent with the text they were derived from.
      matched_keywords: match.matchedKeywords,
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
