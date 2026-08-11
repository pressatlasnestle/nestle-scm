"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getSessionContext } from "@/lib/auth";
import { toActionError, type ActionResult } from "@/lib/actions/result";

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
