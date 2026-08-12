import { createClient } from "@/lib/supabase/server";
import { getSessionContext } from "@/lib/auth";
import {
  applyWeek,
  recentWeeks,
  resolveWeek,
  weekDays,
  type Week,
} from "@/lib/analysis/week-period";
import {
  analysable,
  limitWords,
  wordCloudWords,
  overview,
  polarityBreakdown,
  storiesForTopThemes,
  themeStats,
  topThemes,
  volumeByDay,
  type WeekArticle,
} from "@/lib/analysis/week-stats";
import {
  NARRATIVE_THEME_COUNT,
  parseStoredNarrative,
} from "@/lib/analysis/narrative";
import { AnalysisView } from "./AnalysisView";

export const dynamic = "force-dynamic";

/** How many weeks the dropdown offers. Roughly a quarter of history. */
const WEEK_CHOICES = 12;

/**
 * Hard ceiling on rows pulled for one week. PostgREST would cap at 1000
 * anyway; naming it here means a week that somehow exceeded it is a visible
 * number in the UI rather than a chart that is quietly wrong.
 */
const MAX_WEEK_ROWS = 2000;

/**
 * Words drawn in the cloud.
 *
 * A legibility cap, and the honest lever: shrinking the font to fit everything
 * trades one unreadable failure for another, and d3-cloud silently drops
 * whatever it cannot place anyway — so an uncapped cloud is already truncating,
 * just without saying so or choosing which words to lose. Forty legible terms
 * beat a hundred and fifty illegible ones, and the CSV export always carries
 * the full set for anyone who needs it.
 *
 * Tunable. Raise it and re-run the visual harness; do not raise it on the
 * assumption that a smaller font will absorb the difference.
 */
const WORDS_IN_CLOUD = 40;

type SearchParams = { week?: string };

/**
 * All roles may view this panel (same tier as Newsletter). Everything on it is
 * read-only except Regenerate, which checks canCurate in its own server action.
 */
export default async function AnalysisPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const ctx = await getSessionContext();
  const supabase = await createClient();
  const sp = await searchParams;

  const now = new Date();
  const week = resolveWeek(sp.week, now);

  // A deep link can name a week older than the dropdown reaches. Merging it in
  // keeps the select consistent with what is actually being shown, rather than
  // rendering a control whose value matches none of its options.
  const choices: Week[] = recentWeeks(now, WEEK_CHOICES);
  const weeks = choices.some((w) => w.start === week.start)
    ? choices
    : [...choices, week].sort((a, b) => (a.start < b.start ? 1 : -1));

  const [{ data, error }, { data: report }] = await Promise.all([
    applyWeek(
      supabase
        .from("articles")
        .select(
          "id, headline, url, media, published_at, status, coded_status, ai_sorting_flagged, ai_sentiment, ai_themes, ai_summary, matched_keywords, keyword_mention_count"
        ),
      week
    )
      .order("published_at", { ascending: true })
      .limit(MAX_WEEK_ROWS),
    // The narrative is READ, never generated on view — see migration 0024.
    supabase
      .from("reports")
      .select("analysis_narrative, analysis_generated_at")
      .eq("week_of", week.start)
      .maybeSingle(),
  ]);

  const rows = (data ?? []) as WeekArticle[];

  // Every chart is derived from this one set of rows, so they cannot disagree
  // with each other or with the overview — see week-stats.ts.
  const coded = analysable(rows);
  const themes = themeStats(coded);
  const top = topThemes(themes, NARRATIVE_THEME_COUNT);
  const words = wordCloudWords(coded);

  return (
    <AnalysisView
      week={week}
      weeks={weeks}
      overview={overview(rows)}
      volume={volumeByDay(rows, weekDays(week))}
      polarity={polarityBreakdown(coded)}
      themes={themes}
      words={words}
      wordsShown={limitWords(words, WORDS_IN_CLOUD)}
      stories={storiesForTopThemes(coded, top)}
      narrative={parseStoredNarrative(report?.analysis_narrative)}
      narrativeGeneratedAt={report?.analysis_generated_at ?? null}
      codedTotal={coded.length}
      truncated={rows.length >= MAX_WEEK_ROWS}
      loadError={error?.message ?? null}
      canCurate={ctx.canCurate}
    />
  );
}
