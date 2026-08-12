"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getSessionContext } from "@/lib/auth";
import { toActionError, type ActionResult } from "@/lib/actions/result";
import { applyWeek, resolveWeek, type Week } from "@/lib/analysis/week-period";
import type { AnalysisClient } from "@/lib/analysis/models";
import { analysable, themeStats, topThemes, type WeekArticle } from "@/lib/analysis/week-stats";
import {
  generateWeekNarrative,
  NARRATIVE_THEME_COUNT,
} from "@/lib/analysis/narrative";

const PATH = "/analysis";

const SELECT =
  "id, headline, url, media, published_at, status, coded_status, ai_sorting_flagged, ai_sentiment, ai_themes, ai_summary, matched_keywords, keyword_mention_count";

/**
 * Loads the coded articles a narrative would be written from.
 *
 * Shared by the count (which the confirm modal shows) and the run itself, for
 * the same reason coding-batch.ts shares its scope: the number quoted to the
 * analyst before they authorise a paid call must be produced by the selection
 * the call will actually use, not by an estimate that could drift from it.
 */
async function loadCoded(
  client: AnalysisClient,
  weekStart: string
): Promise<{ week: Week; coded: WeekArticle[] }> {
  const week = resolveWeek(weekStart, new Date());
  const { data, error } = await applyWeek(client.from("articles").select(SELECT), week)
    .order("published_at", { ascending: true })
    .limit(2000);

  if (error) throw new Error(`Could not load the week: ${error.message}`);
  return { week, coded: analysable((data ?? []) as WeekArticle[]) };
}

export type NarrativePreview =
  | {
      ok: true;
      articles: number;
      /** Articles that actually carry a summary — the real input to the call. */
      withSummary: number;
      themes: string[];
      alreadyExists: boolean;
    }
  | { ok: false; error: string };

/**
 * What a regenerate would do right now. Drives the confirm modal, so the
 * analyst sees which themes will be written about before spending anything.
 */
export async function previewNarrative(weekStart: string): Promise<NarrativePreview> {
  const ctx = await getSessionContext();
  if (!ctx.canCurate) {
    return { ok: false, error: "You don't have permission to do that." };
  }

  try {
    // The caller's own client: this is a read and should be subject to the same
    // RLS the panel is. Only the run itself needs service role.
    const supabase = await createClient();
    const week = resolveWeek(weekStart, new Date());

    const { data, error } = await applyWeek(
      supabase.from("articles").select(SELECT),
      week
    ).limit(2000);
    if (error) return { ok: false, error: toActionError(error) };

    const coded = analysable((data ?? []) as WeekArticle[]);
    const top = topThemes(themeStats(coded), NARRATIVE_THEME_COUNT);

    const { data: existing } = await supabase
      .from("reports")
      .select("analysis_generated_at")
      .eq("week_of", week.start)
      .maybeSingle();

    return {
      ok: true,
      articles: coded.length,
      withSummary: coded.filter((r) => (r.ai_summary ?? "").trim().length > 0).length,
      themes: top.map((t) => t.theme),
      alreadyExists: Boolean(existing?.analysis_generated_at),
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Could not inspect the week.",
    };
  }
}

/**
 * Writes (or overwrites) the week's narrative. Curate or admin only.
 *
 * Uses the service-role client for two independent reasons, either of which
 * would be enough on its own:
 *
 *   * get_integration_secret() — the Vault decrypt for the Gemini key — is
 *     granted to service_role alone (migration 0019).
 *   * `reports` has a SELECT policy for every app user and NO insert/update
 *     policy at all, so nothing else can write the row.
 *
 * The authorisation check therefore IS the gate, and it runs before the admin
 * client is constructed — the same ordering the ingestion route and the AI
 * coding action use.
 */
export async function regenerateNarrative(
  weekStart: string
): Promise<ActionResult & { themes?: string[]; articles?: number }> {
  const ctx = await getSessionContext();
  if (!ctx.canCurate) {
    return { ok: false, error: "You don't have permission to do that." };
  }

  try {
    const admin = createAdminClient();
    const { week, coded } = await loadCoded(admin, weekStart);

    const narrative = await generateWeekNarrative(admin, week, coded);

    // Upsert on week_of (unique index, migration 0024). One report row per
    // week: regenerating replaces the narrative rather than accumulating rows
    // that would make "the narrative for week X" ambiguous.
    //
    // Only the analysis_* columns and the identifying week are written.
    // article_count, stats_snapshot and html_content belong to the Monday
    // digest, and a narrative regenerate must not touch them.
    const { error } = await admin
      .from("reports")
      .upsert(
        {
          week_of: week.start,
          analysis_narrative: narrative,
          analysis_generated_at: new Date().toISOString(),
          analysis_generated_by: ctx.userId,
        },
        { onConflict: "week_of" }
      );

    if (error) return { ok: false, error: toActionError(error) };

    await admin.from("audit_log").insert({
      actor_id: ctx.userId,
      action: "analysis.narrative_generate",
      target_type: "report",
      target_id: null,
      metadata: {
        week_of: week.start,
        coded_articles: coded.length,
        summaries_used: narrative.source_article_count,
        themes: narrative.themes.map((t) => t.theme),
      },
    });

    revalidatePath(PATH);

    return {
      ok: true,
      themes: narrative.themes.map((t) => t.theme),
      articles: narrative.source_article_count,
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Narrative generation failed.",
    };
  }
}
