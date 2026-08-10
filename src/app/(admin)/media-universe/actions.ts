"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getSessionContext } from "@/lib/auth";
import { toActionError, type ActionResult } from "@/lib/actions/result";

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

  const { error } = await supabase.from("sources").insert({
    name,
    rss_url: rssUrl || null,
    list_type: input.listType === "neutral" ? null : input.listType,
    category: category || null,
    added_by: userId,
  });

  if (error) return { ok: false, error: toActionError(error) };
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
