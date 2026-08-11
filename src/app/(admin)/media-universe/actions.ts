"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getSessionContext } from "@/lib/auth";
import { toActionError, type ActionResult } from "@/lib/actions/result";
import { runForSource } from "@/lib/ingestion/run";

export type UniverseMode = "whole_universe" | "positive_only";
export type ListTypeInput = "neutral" | "positive" | "negative";

const PATH = "/media-universe";

export async function addSource(input: {
  name: string;
  rssUrl: string;
  listType: ListTypeInput;
  category: string;
}): Promise<ActionResult> {
  const name = input.name.trim();
  const rssUrl = input.rssUrl.trim();
  const category = input.category.trim();

  if (!name) return { ok: false, error: "Source name is required." };

  const { userId } = await getSessionContext();
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("sources")
    .insert({
      name,
      rss_url: rssUrl || null,
      list_type: input.listType === "neutral" ? null : input.listType,
      category: category || null,
      added_by: userId,
    })
    .select("id")
    .single();

  if (error) return { ok: false, error: toActionError(error) };

  // source_added run: a newly added source should not sit blank until the next
  // scheduled run. after() defers it past the response so the admin isn't kept
  // waiting on a network fetch, and a failed ingest never fails the add — the
  // run is logged to ingestion_runs either way.
  if (data?.id) {
    const sourceId = data.id;
    after(async () => {
      try {
        // Already inside after(), so the Stage 1 sorting pass can just run
        // inline at the end of the run rather than being deferred again.
        await runForSource(createAdminClient(), sourceId, userId);
      } catch (err) {
        console.error("[ingestion] source_added run failed:", err);
      }
    });
  }

  revalidatePath(PATH);
  return { ok: true };
}

export async function deleteSource(id: string): Promise<ActionResult> {
  const supabase = await createClient();
  const { error } = await supabase.from("sources").delete().eq("id", id);
  if (error) return { ok: false, error: toActionError(error) };
  revalidatePath(PATH);
  return { ok: true };
}

export async function setSourceActive(
  id: string,
  active: boolean
): Promise<ActionResult> {
  const supabase = await createClient();
  const { error } = await supabase
    .from("sources")
    .update({ is_active: active })
    .eq("id", id);
  if (error) return { ok: false, error: toActionError(error) };
  revalidatePath(PATH);
  return { ok: true };
}

export async function setUniverseMode(mode: UniverseMode): Promise<ActionResult> {
  const { userId } = await getSessionContext();
  const supabase = await createClient();

  const { error } = await supabase.from("app_settings").upsert(
    {
      key: "universe_mode",
      value: mode,
      updated_by: userId,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "key" }
  );

  if (error) return { ok: false, error: toActionError(error) };
  revalidatePath(PATH);
  return { ok: true };
}
