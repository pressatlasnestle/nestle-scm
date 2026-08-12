"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getSessionContext } from "@/lib/auth";
import { toActionError, type ActionResult } from "@/lib/actions/result";
import { codeArticles } from "@/lib/analysis/coding";
import {
  countCodingCandidates,
  loadCodingCandidates,
  MAX_CODING_BATCH,
  type CodingScope,
} from "@/lib/analysis/coding-batch";

const PATH = "/articles";

type StatusChange = "excluded" | "deleted";
const AUDIT_ACTION: Record<StatusChange, string> = {
  excluded: "article.exclude",
  deleted: "article.delete",
};

async function changeStatus(
  ids: string[],
  status: StatusChange
): Promise<ActionResult & { count?: number }> {
  const ctx = await getSessionContext();
  // Independent authorization check. RLS also enforces can_curate() on the
  // update, but gate here too so read users get a clean error and no audit row.
  if (!ctx.canCurate) {
    return { ok: false, error: "You don't have permission to do that." };
  }
  if (ids.length === 0) return { ok: false, error: "Nothing selected." };

  const supabase = await createClient();

  // Soft status change — never a row delete. dedup_key must survive as a
  // tombstone so the ingestion pipeline never re-captures the story.
  const { data, error } = await supabase
    .from("articles")
    .update({
      status,
      status_changed_by: ctx.userId,
      status_changed_at: new Date().toISOString(),
    })
    .in("id", ids)
    .select("id, headline");

  if (error) return { ok: false, error: toActionError(error) };

  const changed = data ?? [];
  if (changed.length > 0) {
    // One audit row PER article, even for a bulk action — accountability stays
    // per-article.
    const rows = changed.map((a) => ({
      actor_id: ctx.userId,
      action: AUDIT_ACTION[status],
      target_type: "article",
      target_id: a.id,
      metadata: { headline: a.headline, status },
    }));
    await supabase.from("audit_log").insert(rows);
  }

  revalidatePath(PATH);
  return { ok: true, count: changed.length };
}

export async function excludeArticle(id: string): Promise<ActionResult> {
  return changeStatus([id], "excluded");
}

export async function deleteArticle(id: string): Promise<ActionResult> {
  return changeStatus([id], "deleted");
}

export async function bulkExcludeArticles(
  ids: string[]
): Promise<ActionResult & { count?: number }> {
  return changeStatus(ids, "excluded");
}

// ---------------------------------------------------------------------------
// Stage 2 — AI coding
// ---------------------------------------------------------------------------

/**
 * How many articles an AI Analysis run would code under the current filters.
 * Called when the confirm modal opens, so the number quoted to the analyst is
 * produced by the same selection the run will use — not an estimate.
 */
export async function countArticlesToCode(
  scope: CodingScope
): Promise<{ ok: true; count: number; cap: number } | { ok: false; error: string }> {
  const ctx = await getSessionContext();
  if (!ctx.canCurate) {
    return { ok: false, error: "You don't have permission to do that." };
  }

  try {
    // The caller's own client: counting is a read, and it should be subject to
    // the same RLS the panel is. Only the run itself needs service role.
    const supabase = await createClient();
    const count = await countCodingCandidates(supabase, scope);
    return { ok: true, count, cap: MAX_CODING_BATCH };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Could not count articles.",
    };
  }
}

export type CodingRunResult = ActionResult & {
  processed?: number;
  failed?: number;
  remaining?: number;
};

/**
 * Runs Stage 2 coding over the currently filtered, still-active, not-yet-coded
 * set. Curate or admin only.
 *
 * Uses the service-role client because get_integration_secret() — the Vault
 * decrypt for the Gemini key — is granted to service_role alone. The
 * authorisation check above is therefore the real gate and runs BEFORE the
 * admin client is constructed, exactly as the ingestion route does it.
 */
export async function runAiCoding(scope: CodingScope): Promise<CodingRunResult> {
  const ctx = await getSessionContext();
  if (!ctx.canCurate) {
    return { ok: false, error: "You don't have permission to do that." };
  }

  try {
    const admin = createAdminClient();
    const { rows, total } = await loadCodingCandidates(admin, scope);

    if (rows.length === 0) {
      return { ok: false, error: "Nothing to code in this view." };
    }

    const summary = await codeArticles(admin, rows);

    // One audit row per run, not per article: coding is an annotation, not a
    // status change, and a row per article would swamp the log for no
    // accountability gain — unlike exclusion, which is per-article by design.
    await admin.from("audit_log").insert({
      actor_id: ctx.userId,
      action: "article.ai_coding",
      target_type: "articles",
      target_id: null,
      metadata: {
        scope,
        candidates: total,
        processed: summary.processed,
        failed: summary.failed,
        by_tier: summary.byTier,
      },
    });

    revalidatePath(PATH);

    return {
      ok: true,
      processed: summary.processed,
      failed: summary.failed,
      // Candidates beyond the cap, plus anything that errored — both are still
      // pending and both are picked up by running again.
      remaining: Math.max(0, total - summary.processed),
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "AI coding failed.",
    };
  }
}
