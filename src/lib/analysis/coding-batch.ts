import { applyRange, resolvePeriod, type PeriodKey } from "@/lib/articles/period";
import type { AnalysisClient } from "./models";
import type { CodableArticle } from "./coding";

/**
 * Selecting what a coding run will touch.
 *
 * This exists as one function because two callers must agree exactly: the
 * confirm modal that tells the analyst "run AI coding on the 43 active
 * articles in this date range", and the batch that then runs. If the count and
 * the batch were derived separately they would drift, and the modal would be
 * quoting a number that is not what gets billed.
 */

/**
 * Per-run cap.
 *
 * Coding is one Gemini call per article and runs inside a server action, which
 * has a wall-clock limit. Sorting measured ~0.42s/article at concurrency 4 on
 * flash-lite; coding uses a larger model and a longer prompt, so the safe
 * budget is well under the full corpus.
 *
 * Hitting the cap is never silent — the summary reports `remaining`, the toast
 * says so, and because coded_status flips per article, running again continues
 * exactly where this one stopped rather than starting over.
 */
export const MAX_CODING_BATCH = 40;

/**
 * The filter state a coding run is scoped by. Mirrors the Articles panel's own
 * filters, minus pagination — coding operates on the whole filtered set, not
 * on the page the analyst happens to be looking at.
 */
export type CodingScope = {
  period: PeriodKey;
  from: string | null;
  to: string | null;
  channel: string;
  q: string;
  neg: boolean;
  sflag: boolean;
};

/**
 * Builds the candidate query.
 *
 * Three conditions are NOT part of the panel's filter state and are always
 * applied, because they are what makes the manual review step meaningful:
 *
 *   status = 'active'      — anything the analyst excluded by hand is out.
 *                            That is the entire point of reviewing first.
 *   coded_status = 'pending' — already-coded articles are never re-coded, so
 *                            re-running over an overlapping period costs
 *                            nothing and cannot change a settled judgement.
 *   ai_sorting_flagged is not true — articles Stage 1 judged off-topic are
 *                            skipped rather than force-fitted into a theme.
 *
 * That last rule is a deliberate operator decision, and it has a real cost
 * worth stating: the sorting flag is advisory everywhere else in this codebase
 * — it never hides an article and never changes its status — but here it does
 * decide whether Gemini is called. The reason is the closed vocabulary: with a
 * fixed enum an air-cargo or trucking article cannot decline to be themed, so
 * it would land in whichever container-shipping bucket is least wrong and
 * pollute that storyline. Skipping is the lesser harm, but it means "code this
 * period" does not mean "code everything in this period".
 *
 * It is never silent: countCodingCandidates reports the skipped count
 * separately, the confirm modal shows it, and the CLI prints it. An analyst who
 * disagrees with a flag can clear it, or exclude the article outright.
 *
 * The panel's status filter is deliberately ignored: an analyst reviewing the
 * 'excluded' view and hitting AI Analysis must not code excluded articles.
 */
/**
 * Self-referential in T so a builder's methods return the builder's own type.
 * A non-generic version would widen to this interface on the first call and
 * stop being compatible with applyRange()'s own constraint.
 */
type Filterable<T> = {
  eq: (col: string, v: string | boolean) => T;
  not: (col: string, op: string, v: null | boolean) => T;
  ilike: (col: string, v: string) => T;
  gte: (col: string, v: string) => T;
  lte: (col: string, v: string) => T;
};

/**
 * Applies the scope to an already-selected query. Takes the query rather than
 * building it so the count path and the load path can select different columns
 * (head-only vs. full rows) while provably sharing every filter — the two must
 * never diverge, and the only way to guarantee that is for the filters to
 * exist in exactly one place.
 */
function applyScope<T extends Filterable<T>>(
  query: T,
  scope: CodingScope,
  options: { onlyFlagged?: boolean } = {}
): T {
  const range = resolvePeriod(scope.period, { from: scope.from, to: scope.to });

  // `not(... is true)` rather than `eq(false)`: an unsorted row has a null
  // flag, and eq(false) would silently exclude it from every coding run.
  let q = query.eq("status", "active").eq("coded_status", "pending");
  q = options.onlyFlagged
    ? q.eq("ai_sorting_flagged", true)
    : q.not("ai_sorting_flagged", "is", true);

  if (scope.channel !== "all") q = q.eq("source_channel", scope.channel);
  if (scope.neg) q = q.not("matched_negative_keywords", "is", null);
  if (scope.sflag) q = q.eq("ai_sorting_flagged", true);
  if (scope.q) q = q.ilike("headline", `%${scope.q}%`);

  return applyRange(q, range);
}

export type CandidateCounts = {
  /** Articles this run would actually code. */
  codable: number;
  /**
   * Active, uncoded articles in the same scope that are skipped ONLY because
   * Stage 1 flagged them off-topic. Surfaced so the skip rule is visible at
   * the point of decision rather than being an invisible behaviour.
   */
  skippedFlagged: number;
};

/** What a run would do right now. Drives the confirm modal. */
export async function countCodingCandidates(
  client: AnalysisClient,
  scope: CodingScope
): Promise<CandidateCounts> {
  const { count, error } = await applyScope(
    client.from("articles").select("id", { count: "exact", head: true }),
    scope
  );
  if (error) throw new Error(`Could not count articles to code: ${error.message}`);

  // The same scope with the flag rule inverted, so the two numbers are
  // guaranteed to be about the same set of articles.
  const { count: flagged } = await applyScope(
    client.from("articles").select("id", { count: "exact", head: true }),
    scope,
    { onlyFlagged: true }
  );

  return { codable: count ?? 0, skippedFlagged: flagged ?? 0 };
}

export type CodingCandidates = {
  rows: CodableArticle[];
  /** Total matching candidates, which may exceed rows.length when capped. */
  total: number;
};

/** Loads up to MAX_CODING_BATCH candidates, oldest first. */
export async function loadCodingCandidates(
  client: AnalysisClient,
  scope: CodingScope
): Promise<CodingCandidates> {
  const { data, count, error } = await applyScope(
    client
      .from("articles")
      .select("id, headline, body, matched_keywords", { count: "exact" }),
    scope
  )
    .order("published_at", { ascending: true, nullsFirst: false })
    .order("ingested_at", { ascending: true })
    .range(0, MAX_CODING_BATCH - 1);

  if (error) throw new Error(`Could not load articles to code: ${error.message}`);

  return {
    rows: (data ?? []) as CodableArticle[],
    total: count ?? 0,
  };
}
