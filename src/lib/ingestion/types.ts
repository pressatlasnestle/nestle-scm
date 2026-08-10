import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database.types";

/**
 * Every ingestion phase takes the client as an argument rather than creating
 * one, so a single run shares one connection and tests can pass a stub. In
 * production this is always the service-role client (createAdminClient()):
 * cron-triggered runs have no user session, and RLS on `articles` /
 * `ingestion_runs` is written for human callers, not the pipeline.
 */
export type IngestionClient = SupabaseClient<Database>;

export type SourceRow = Database["public"]["Tables"]["sources"]["Row"];
export type KeywordRow = Database["public"]["Tables"]["keywords"]["Row"];

/** A single parsed feed entry, before dedup and before matching. */
export type FeedItem = {
  headline: string;
  url: string | null;
  byline: string | null;
  /** Publication name. Feed title normally; per-item <source> for Google News. */
  media: string | null;
  /** Null when the feed omits a usable date — such items are never window-filtered out. */
  publishedAt: Date | null;
  /** Plain text: HTML stripped, entities decoded, whitespace collapsed. */
  body: string;
  wordCount: number;
};

/** The date range a run targets. Items outside it are dropped at fetch time. */
export type IngestionWindow = {
  start: Date;
  end: Date;
};
