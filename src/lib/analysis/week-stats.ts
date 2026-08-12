/**
 * Aggregation for the Analysis panel.
 *
 * Every number the panel shows is derived here, from one set of rows loaded
 * once per page render. Two reasons it works this way rather than as a pile of
 * count queries:
 *
 *   * The charts have to agree with each other. Volume, sentiment, themes and
 *     keywords are four views of the SAME set of articles, and if each ran its
 *     own query they could disagree the moment a coding run landed between two
 *     of them.
 *   * These functions are pure, so the definitions below — which articles are
 *     analysable, what counts as favourable — can be checked without a
 *     database and re-read without tracing SQL.
 *
 * A week is small (tens of articles), so loading the rows is cheaper than the
 * round trips would be.
 */

import { SENTIMENT_TIERS, type SentimentTier } from "./coding";
import { dayTick } from "./week-period";

/** The columns the Analysis panel loads. Mirrors the select in page.tsx. */
export type WeekArticle = {
  id: string;
  headline: string;
  url: string | null;
  media: string | null;
  published_at: string | null;
  status: string;
  coded_status: string | null;
  ai_sorting_flagged: boolean | null;
  ai_sentiment: string | null;
  ai_themes: string[] | null;
  ai_summary: string | null;
  matched_keywords: string[] | null;
  keyword_mention_count: number | null;
};

/**
 * The set every chart is built from.
 *
 * Three conditions, each excluding something for a different reason:
 *
 *   status = 'active'        — excluded and deleted articles are tombstones.
 *                              An analyst took them out of the corpus by hand;
 *                              putting them back into the analysis would undo
 *                              that decision silently.
 *   not flagged off-topic    — Stage 1 flagged them, so Stage 2 never coded
 *                              them (see coding-batch.ts). Belt and braces:
 *                              the two conditions should already agree, and if
 *                              they ever stop agreeing the charts must follow
 *                              the flag rather than quietly analyse an article
 *                              the operator's own pipeline declined to code.
 *   coded + has a sentiment  — an uncoded article has no theme and no tier, so
 *                              it cannot appear on a sentiment or theme chart
 *                              at all. Including it would either need an
 *                              "unknown" slice that means "not analysed yet",
 *                              which reads as a finding when it is a backlog.
 *
 * All three are counted and surfaced in the overview instead, so nothing
 * disappears without being accounted for somewhere on the page.
 */
export function analysable(rows: WeekArticle[]): WeekArticle[] {
  return rows.filter(
    (r) =>
      r.status === "active" &&
      r.ai_sorting_flagged !== true &&
      r.coded_status === "coded" &&
      typeof r.ai_sentiment === "string" &&
      r.ai_sentiment.length > 0
  );
}

/** Set aside from the analysis: excluded/deleted by hand, or flagged off-topic. */
export function setAside(rows: WeekArticle[]): WeekArticle[] {
  return rows.filter((r) => r.status !== "active" || r.ai_sorting_flagged === true);
}

export type WeekOverview = {
  /** Every article published in the week, whatever its status. */
  total: number;
  /** Coded and analysable — the set behind every chart on the page. */
  coded: number;
  /** Excluded/deleted by an analyst, or flagged off-topic by the sorting pass. */
  setAside: number;
  /**
   * Active, unflagged, but not yet coded. Not a chart input and not "set
   * aside" either — it is a backlog, and conflating it with either would be
   * misleading. Shown as the sub-line on the coded card.
   */
  awaitingCoding: number;
  /** Distinct outlets that produced at least one active article this week. */
  activeSources: number;
};

export function overview(rows: WeekArticle[]): WeekOverview {
  const coded = analysable(rows).length;
  const aside = setAside(rows).length;

  const sources = new Set(
    rows
      .filter((r) => r.status === "active")
      .map((r) => (r.media ?? "").trim())
      .filter((m) => m.length > 0)
  );

  return {
    total: rows.length,
    coded,
    setAside: aside,
    // total = coded + setAside + awaitingCoding, always. The three cards
    // partition the week exactly, so a reader can check the arithmetic.
    awaitingCoding: Math.max(0, rows.length - coded - aside),
    activeSources: sources.size,
  };
}

// ---------------------------------------------------------------------------
// Favourable / Neutral / Unfavourable
// ---------------------------------------------------------------------------

/**
 * The three-way roll-up of the stored 5-point tier.
 *
 * The 5-point scale is what gets coded and stored, because it distinguishes
 * "headline and body both negative" from "one of them negative" — see
 * sentimentTier(). For charting, five slices across a dozen themes is noise, so
 * the two favourable tiers collapse into one and the two unfavourable into one.
 * The 5-point detail is never lost — it is still on every article row and in
 * the Articles panel — but the charts and their exports are three-way, so that
 * a chart and its CSV are always the same numbers.
 */
export type Polarity = "favourable" | "neutral" | "unfavourable";

export const POLARITIES: readonly Polarity[] = [
  "favourable",
  "neutral",
  "unfavourable",
];

export const POLARITY_LABEL: Record<Polarity, string> = {
  favourable: "Favourable",
  neutral: "Neutral",
  unfavourable: "Unfavourable",
};

const TIER_POLARITY: Record<SentimentTier, Polarity> = {
  "Very unfavourable": "unfavourable",
  Unfavourable: "unfavourable",
  Neutral: "neutral",
  Favourable: "favourable",
  "Very favourable": "favourable",
};

/** Null for anything that is not one of the five stored tiers. */
export function polarityOf(tier: string | null): Polarity | null {
  if (!tier) return null;
  return TIER_POLARITY[tier as SentimentTier] ?? null;
}

export function isSentimentTier(value: string | null): value is SentimentTier {
  return (SENTIMENT_TIERS as readonly string[]).includes(value ?? "");
}

export type PolarityCounts = Record<Polarity, number>;

export function emptyPolarityCounts(): PolarityCounts {
  return { favourable: 0, neutral: 0, unfavourable: 0 };
}

export function countPolarity(rows: WeekArticle[]): PolarityCounts {
  const out = emptyPolarityCounts();
  for (const r of rows) {
    const p = polarityOf(r.ai_sentiment);
    if (p) out[p] += 1;
  }
  return out;
}

/**
 * Percentage of `total`, to one decimal. Returns 0 rather than NaN for an
 * empty week — a chart axis cannot render NaN, and "0%" of nothing is the
 * honest reading.
 */
export function percent(count: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((count / total) * 1000) / 10;
}

// ---------------------------------------------------------------------------
// Day-on-day volume
// ---------------------------------------------------------------------------

export type VolumeDay = {
  /** YYYY-MM-DD. */
  date: string;
  /** "Mon 10" — the axis tick. */
  tick: string;
  /** Everything published that day, whatever its status. Bar height. */
  total: number;
  /** The analysable slice — what the sentiment and theme charts are built on. */
  coded: number;
  /**
   * Published that day but not analysed: excluded/deleted by hand, flagged
   * off-topic, or simply not coded yet.
   *
   * Volume is the one chart on this page that shows the WHOLE week rather than
   * only the coded set, and that is deliberate: "how much did we capture on
   * Tuesday" is a question about capture, and answering it with the coded
   * count would under-report the day whenever a coding run had not caught up.
   * Splitting the bar keeps both readings visible at once — the total is the
   * full height, and the analysable portion is the teal part.
   */
  notAnalysed: number;
};

export function volumeByDay(
  rows: WeekArticle[],
  days: string[]
): VolumeDay[] {
  const codedIds = new Set(analysable(rows).map((r) => r.id));

  return days.map((date) => {
    const onDay = rows.filter((r) => r.published_at === date);
    const coded = onDay.filter((r) => codedIds.has(r.id)).length;
    return {
      date,
      tick: dayTick(date),
      total: onDay.length,
      coded,
      notAnalysed: onDay.length - coded,
    };
  });
}

// ---------------------------------------------------------------------------
// Week-level FNU breakdown
// ---------------------------------------------------------------------------

export type PolarityShare = {
  polarity: Polarity;
  label: string;
  articles: number;
  /** Share of the coded set, one decimal. */
  percent: number;
};

/** Always three rows, in F/N/U order, even when some are zero. */
export function polarityBreakdown(coded: WeekArticle[]): PolarityShare[] {
  const counts = countPolarity(coded);
  return POLARITIES.map((p) => ({
    polarity: p,
    label: POLARITY_LABEL[p],
    articles: counts[p],
    percent: percent(counts[p], coded.length),
  }));
}

// ---------------------------------------------------------------------------
// Themes
// ---------------------------------------------------------------------------

export type ThemeStat = {
  theme: string;
  /** Articles tagged with this theme. */
  articles: number;
  /**
   * Share of the coded set. These do NOT sum to 100 — see themeStats().
   */
  percent: number;
  counts: PolarityCounts;
};

/**
 * Article counts per theme, busiest first.
 *
 * An article carries 1-3 themes (coding.ts caps it at three), so it is counted
 * under each of them. The consequence is worth being explicit about because it
 * looks like a bug otherwise: the theme counts sum to MORE than the number of
 * coded articles, and the percentages sum to more than 100%. Every chart built
 * on this states the denominator in its own caption rather than leaving the
 * reader to work out why the slices overflow.
 *
 * The alternative — attributing each article only to its first theme — would
 * make the numbers add up and would throw away the reason a closed vocabulary
 * allows multiple themes at all: a story genuinely spanning two themes belongs
 * in both storylines.
 *
 * Ties break on theme name so the order is stable between renders; a chart
 * whose slices reshuffled on refresh would be unreadable.
 */
export function themeStats(coded: WeekArticle[]): ThemeStat[] {
  const byTheme = new Map<string, WeekArticle[]>();

  for (const row of coded) {
    for (const theme of row.ai_themes ?? []) {
      const name = theme.trim();
      if (!name) continue;
      const bucket = byTheme.get(name);
      if (bucket) bucket.push(row);
      else byTheme.set(name, [row]);
    }
  }

  return [...byTheme.entries()]
    .map(([theme, rows]) => ({
      theme,
      articles: rows.length,
      percent: percent(rows.length, coded.length),
      counts: countPolarity(rows),
    }))
    .sort((a, b) => b.articles - a.articles || a.theme.localeCompare(b.theme));
}

/** The busiest `n` themes. What the narrative and the story lists are built on. */
export function topThemes(stats: ThemeStat[], n = 3): ThemeStat[] {
  return stats.slice(0, n);
}

/** The coded articles carrying a given theme. */
export function articlesForTheme(
  coded: WeekArticle[],
  theme: string
): WeekArticle[] {
  return coded.filter((r) => (r.ai_themes ?? []).some((t) => t.trim() === theme));
}

// ---------------------------------------------------------------------------
// Prominent stories
// ---------------------------------------------------------------------------

export type RankedStory = {
  id: string;
  headline: string;
  url: string | null;
  media: string | null;
  published_at: string | null;
  tier: string | null;
  polarity: Polarity;
  mentions: number;
  summary: string | null;
};

/**
 * The most prominent stories of one polarity within one theme.
 *
 * Ranked by keyword_mention_count, which is how prominence is already defined
 * everywhere else in this codebase — it is the Articles panel's sortable
 * "Mentions" column and it is regex-derived and deterministic (migration 0018).
 * Deliberately NOT a new score: a second definition of "top story" that
 * disagreed with the one an analyst can already sort by would be worse than no
 * ranking at all.
 *
 * Ties break on recency and then on headline, so the list is stable rather
 * than dependent on row order — with small weeks, ties are common.
 */
export function topStories(
  coded: WeekArticle[],
  theme: string,
  polarity: Polarity,
  limit = 3
): RankedStory[] {
  return articlesForTheme(coded, theme)
    .filter((r) => polarityOf(r.ai_sentiment) === polarity)
    .map((r) => ({
      id: r.id,
      headline: r.headline,
      url: r.url,
      media: r.media,
      published_at: r.published_at,
      tier: r.ai_sentiment,
      polarity,
      mentions: r.keyword_mention_count ?? 0,
      summary: r.ai_summary,
    }))
    .sort(
      (a, b) =>
        b.mentions - a.mentions ||
        (b.published_at ?? "").localeCompare(a.published_at ?? "") ||
        a.headline.localeCompare(b.headline)
    )
    .slice(0, limit);
}

export type ThemeStories = {
  theme: string;
  articles: number;
  positive: RankedStory[];
  negative: RankedStory[];
};

// ---------------------------------------------------------------------------
// Keywords by theme
// ---------------------------------------------------------------------------

export type KeywordBubble = {
  keyword: string;
  theme: string;
  /** Summed keyword_mention_count over the articles in this (keyword, theme) cell. */
  mentions: number;
  /** How many articles contributed. */
  articles: number;
  /** 1 = most-mentioned keyword within this theme. The y position. */
  rank: number;
};

/**
 * Keyword volume, grouped by theme.
 *
 * A keyword appears under EVERY theme it shows up in, as its own bubble. That
 * is the intended behaviour, not a duplicate: "Suez" appearing in both
 * `Chokepoints & routing` and `Service network changes` is a real fact about
 * the week, and collapsing it to whichever theme happened to be first would
 * assert a single home the data does not have.
 *
 * The consequence, stated plainly because the chart cannot: summing the
 * `mentions` column across all bubbles double-counts any article that carries
 * more than one theme. Within a single theme's column the totals are sound,
 * which is the comparison the chart is actually for.
 *
 * ATTRIBUTION. keyword_mention_count is per ARTICLE, not per keyword — it is
 * the total number of tracked-term hits in that article's text (migration
 * 0018), and there is no per-keyword breakdown stored anywhere. So an article
 * matching three keywords contributes its full count to each of them. This
 * overstates any individual keyword and is the only option the stored data
 * supports; dividing the count evenly between matched keywords would invent a
 * precision that does not exist. Bubble size is therefore a measure of "how
 * prominent were the articles this keyword appeared in", which is a defensible
 * thing to size on and is NOT "how many times this keyword was written".
 */
type BubbleCell = {
  keyword: string;
  theme: string;
  mentions: number;
  articles: number;
};

export function keywordBubbles(coded: WeekArticle[]): KeywordBubble[] {
  // (theme, keyword) -> accumulator
  const cells = new Map<string, BubbleCell>();

  for (const row of coded) {
    const themes = (row.ai_themes ?? []).map((t) => t.trim()).filter(Boolean);
    const keywords = [
      ...new Set((row.matched_keywords ?? []).map((k) => k.trim()).filter(Boolean)),
    ];
    if (themes.length === 0 || keywords.length === 0) continue;

    const mentions = row.keyword_mention_count ?? 0;

    for (const theme of themes) {
      for (const keyword of keywords) {
        const key = `${theme} ${keyword}`;
        const cell = cells.get(key);
        if (cell) {
          cell.mentions += mentions;
          cell.articles += 1;
        } else {
          cells.set(key, { keyword, theme, mentions, articles: 1 });
        }
      }
    }
  }

  // Rank within each theme, most-mentioned first. Ties break on keyword name so
  // the y positions are stable between renders rather than depending on Map
  // insertion order.
  const byTheme = new Map<string, BubbleCell[]>();
  for (const cell of cells.values()) {
    const bucket = byTheme.get(cell.theme);
    if (bucket) bucket.push(cell);
    else byTheme.set(cell.theme, [cell]);
  }

  const out: KeywordBubble[] = [];
  for (const bucket of byTheme.values()) {
    bucket
      .sort((a, b) => b.mentions - a.mentions || a.keyword.localeCompare(b.keyword))
      .forEach((cell, i) => out.push({ ...cell, rank: i + 1 }));
  }

  return out;
}

/**
 * Trims each theme's column to its top `perTheme` keywords.
 *
 * A week can produce hundreds of (keyword, theme) cells and a bubble chart
 * stops being readable long before that. Truncation is never silent — the
 * chart's caption reports how many bubbles were dropped, and the CSV export
 * carries the FULL set, so the limit is a display decision rather than a data
 * one.
 */
export function limitBubbles(
  bubbles: KeywordBubble[],
  perTheme: number
): KeywordBubble[] {
  return bubbles.filter((b) => b.rank <= perTheme);
}

/** Top 3 favourable and top 3 unfavourable stories for each of the top themes. */
export function storiesForTopThemes(
  coded: WeekArticle[],
  top: ThemeStat[]
): ThemeStories[] {
  return top.map((t) => ({
    theme: t.theme,
    articles: t.articles,
    positive: topStories(coded, t.theme, "favourable"),
    negative: topStories(coded, t.theme, "unfavourable"),
  }));
}
