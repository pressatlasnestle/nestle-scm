/**
 * Column definitions for every Analysis CSV export.
 *
 * These live outside the chart components on purpose. A chart's export button
 * and the check that verifies the export must use the SAME definitions, or the
 * check verifies a second implementation of the export rather than the export
 * itself — and the two would drift the first time a column was renamed.
 *
 * Nothing here imports React or touches the DOM, so a Node check script can
 * build the exact bytes a browser download would contain.
 */

import type { CsvColumn } from "./csv";
import type {
  WordCloudWord,
  PolarityShare,
  RankedStory,
  ThemeStat,
  VolumeDay,
} from "./week-stats";

/** Day-on-day volume. Mirrors the stacked bars: total = coded + not analysed. */
export const VOLUME_COLUMNS: CsvColumn<VolumeDay>[] = [
  { header: "date", value: (d) => d.date },
  { header: "day", value: (d) => d.tick },
  { header: "articles_total", value: (d) => d.total },
  { header: "articles_coded", value: (d) => d.coded },
  { header: "articles_not_analysed", value: (d) => d.notAnalysed },
];

/**
 * Favourability breakdown. `coded_total` is repeated on every row rather than
 * left implicit: a percentage is unreadable without its denominator, and a CSV
 * has nowhere to put a caption.
 */
export function polarityColumns(codedTotal: number): CsvColumn<PolarityShare>[] {
  return [
    { header: "polarity", value: (s) => s.label },
    { header: "articles", value: (s) => s.articles },
    { header: "percent_of_coded", value: (s) => s.percent },
    { header: "coded_total", value: () => codedTotal },
  ];
}

/**
 * Theme distribution, and the same rows serve the per-theme favourability
 * chart — they are two views of one table, so one export covers both and the
 * two can never be exported in disagreement.
 *
 * `percent_of_coded` deliberately sums to more than 100: an article carries up
 * to three themes and is counted under each. `coded_total` is on every row so
 * the denominator travels with the data.
 */
export function themeColumns(codedTotal: number): CsvColumn<ThemeStat>[] {
  return [
    { header: "theme", value: (t) => t.theme },
    { header: "articles", value: (t) => t.articles },
    { header: "percent_of_coded", value: (t) => t.percent },
    { header: "favourable", value: (t) => t.counts.favourable },
    { header: "neutral", value: (t) => t.counts.neutral },
    { header: "unfavourable", value: (t) => t.counts.unfavourable },
    { header: "coded_total", value: () => codedTotal },
  ];
}

/** One row per ranked story, carrying the theme and direction it was ranked in. */
export type StoryExportRow = RankedStory & {
  theme: string;
  direction: "positive" | "negative";
  rank: number;
};

export const STORY_COLUMNS: CsvColumn<StoryExportRow>[] = [
  { header: "theme", value: (s) => s.theme },
  { header: "direction", value: (s) => s.direction },
  { header: "rank", value: (s) => s.rank },
  { header: "headline", value: (s) => s.headline },
  { header: "media", value: (s) => s.media },
  { header: "published_at", value: (s) => s.published_at },
  // The stored 5-point tier, not the roll-up — a story list is where the extra
  // resolution is actually useful.
  { header: "favourability_tier", value: (s) => s.tier },
  { header: "keyword_mention_count", value: (s) => s.mentions },
  { header: "url", value: (s) => s.url },
  { header: "summary", value: (s) => s.summary },
];


/**
 * Keyword word cloud. Exported UNTRIMMED — the chart draws only the top slice
 * for legibility, and the point of an export is to reach what it could not fit.
 *
 * The three weight columns are the evidence behind `dominant_sentiment`.
 * Without them the colour is an assertion; with them a reader can see that a
 * green word was 40/35/25 rather than 90/5/5 and judge it themselves.
 */
export const WORD_CLOUD_COLUMNS: CsvColumn<WordCloudWord>[] = [
  // The canonical taxonomy term, never the abbreviated cloud label. An export
  // whose keyword column read "DP World +5" could not be joined back to the
  // keywords table, which is most of what an export is for.
  { header: "keyword", value: (w) => w.keyword },
  { header: "total_mentions", value: (w) => w.mentions },
  { header: "dominant_sentiment", value: (w) => w.sentiment },
  { header: "article_count", value: (w) => w.articles },
  { header: "weight_favourable", value: (w) => w.weights.favourable },
  { header: "weight_neutral", value: (w) => w.weights.neutral },
  { header: "weight_unfavourable", value: (w) => w.weights.unfavourable },
];
