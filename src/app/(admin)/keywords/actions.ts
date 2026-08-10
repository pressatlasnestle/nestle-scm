"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getSessionContext } from "@/lib/auth";
import { toActionError, type ActionResult } from "@/lib/actions/result";

const PATH = "/keywords";

export async function addKeyword(keyword: string): Promise<ActionResult> {
  const value = keyword.trim();
  if (!value) return { ok: false, error: "Enter a keyword." };

  const { userId } = await getSessionContext();
  const supabase = await createClient();

  const { error } = await supabase
    .from("keywords")
    .insert({ keyword: value, added_by: userId });

  if (error) {
    if ((error as { code?: string }).code === "23505") {
      return { ok: false, error: `“${value}” is already in the list.` };
    }
    return { ok: false, error: toActionError(error) };
  }
  revalidatePath(PATH);
  return { ok: true };
}

export async function deleteKeyword(id: string): Promise<ActionResult> {
  const supabase = await createClient();
  const { error } = await supabase.from("keywords").delete().eq("id", id);
  if (error) return { ok: false, error: toActionError(error) };
  revalidatePath(PATH);
  return { ok: true };
}

export async function setKeywordActive(
  id: string,
  active: boolean
): Promise<ActionResult> {
  const supabase = await createClient();
  const { error } = await supabase
    .from("keywords")
    .update({ is_active: active })
    .eq("id", id);
  if (error) return { ok: false, error: toActionError(error) };
  revalidatePath(PATH);
  return { ok: true };
}
