import {
  applyRange,
  resolvePeriod,
  type DateRange,
  type PeriodKey,
} from "@/lib/articles/period";
import type { AnalysisClient } from "./models";

/**
 * Storylines — computed, never stored.
 *
 * A storyline is "the coded articles in this period that share a theme, with
 * the most-mentioned one as the lead". There is deliberately no storylines
 * table, for the same reason the live dashboard queries exist alongside the
 * frozen reports.stats_snapshot: a stored grouping goes stale the moment an
 * analyst excludes an article or a new one is coded, and nothing would tell it
 * to recompute. A snapshot is right when it is a deliberate freeze of a
 * published report; it is wrong as a cache of something still moving.
 *
 * So this is a query-time grouping. It is cheap — one indexed read over a
 * period, grouped in memory — and it is always correct by construction.
 */

export type StorylineArticle = {
  id: string;
  headline: string;
  url: string | null;
  media: string | null;
  published_at: string | null;
  keyword_mention_count: number | null;
  ai_sentiment: string | null;
  ai_themes: string[] | null;
};

export type Storyline = {
  theme: string;
  articleCount: number;
  /** Highest keyword_mention_count in the group. */
  lead: StorylineArticle;
  /** Every article carrying the theme, lead first. */
  articles: StorylineArticle[];
  /** Tier → count, for a sentiment split per storyline. */
  sentimentSplit: Record<string, number>;
};

/**
 * Articles carrying only one theme that nothing else shares are not a
 * storyline — they are a single story. Groups below this size are still
 * returned (the caller may want the tail) but callers that want real
 * storylines should filter on articleCount.
 */
export const MIN_STORYLINE_SIZE = 2;

function compareArticles(a: StorylineArticle, b: StorylineArticle): number {
  // Lead story = most keyword mentions. Ties break on recency, then id, so the
  // ordering is total and stable across calls — an unstable lead would make
  // the same period render differently on two consecutive loads.
  const byMentions = (b.keyword_mention_count ?? 0) - (a.keyword_mention_count ?? 0);
  if (byMentions !== 0) return byMentions;
  const byDate = (b.published_at ?? "").localeCompare(a.published_at ?? "");
  if (byDate !== 0) return byDate;
  return a.id.localeCompare(b.id);
}

/**
 * Groups already-loaded articles by shared theme. Pure, so the grouping rules
 * can be pinned without a database.
 *
 * An article with three themes appears in three groups. That is intended:
 * a story about a Red Sea return that also moves rates belongs to both
 * storylines, and forcing a single primary theme would lose that.
 */
export function groupByTheme(articles: StorylineArticle[]): Storyline[] {
  const byTheme = new Map<string, StorylineArticle[]>();

  for (const article of articles) {
    for (const theme of article.ai_themes ?? []) {
      if (!theme) continue;
      const bucket = byTheme.get(theme);
      if (bucket) bucket.push(article);
      else byTheme.set(theme, [article]);
    }
  }

  const storylines: Storyline[] = [];

  for (const [theme, group] of byTheme) {
    const sorted = [...group].sort(compareArticles);
    const sentimentSplit: Record<string, number> = {};
    for (const a of sorted) {
      const tier = a.ai_sentiment ?? "Uncoded";
      sentimentSplit[tier] = (sentimentSplit[tier] ?? 0) + 1;
    }
    storylines.push({
      theme,
      articleCount: sorted.length,
      lead: sorted[0],
      articles: sorted,
      sentimentSplit,
    });
  }

  // Biggest storyline first; ties alphabetical so the order is total.
  return storylines.sort(
    (a, b) => b.articleCount - a.articleCount || a.theme.localeCompare(b.theme)
  );
}

/**
 * Loads coded, active articles for a period and groups them.
 *
 * Only coded_status='coded' rows participate: an uncoded article has no themes
 * and would contribute nothing but a null group. Only status='active' rows
 * participate, so excluding an article removes it from its storylines on the
 * next read — which is exactly the staleness a stored table could not manage.
 */
export async function getStorylines(
  client: AnalysisClient,
  range: DateRange,
  options: { minSize?: number } = {}
): Promise<Storyline[]> {
  const query = applyRange(
    client
      .from("articles")
      .select(
        "id, headline, url, media, published_at, keyword_mention_count, ai_sentiment, ai_themes"
      )
      .eq("status", "active")
      .eq("coded_status", "coded")
      .not("ai_themes", "is", null),
    range
  );

  const { data, error } = await query;
  if (error) throw new Error(`Could not load storylines: ${error.message}`);

  const grouped = groupByTheme((data ?? []) as StorylineArticle[]);
  const minSize = options.minSize ?? 1;
  return grouped.filter((s) => s.articleCount >= minSize);
}

/** Convenience wrapper taking a period selection rather than resolved bounds. */
export async function getStorylinesForPeriod(
  client: AnalysisClient,
  period: PeriodKey,
  custom: { from?: string | null; to?: string | null } = {},
  options: { minSize?: number } = {}
): Promise<Storyline[]> {
  return getStorylines(client, resolvePeriod(period, custom), options);
}
