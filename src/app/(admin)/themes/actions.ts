"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getSessionContext } from "@/lib/auth";
import { toActionError, type ActionResult } from "@/lib/actions/result";

const PATH = "/themes";

export async function addTheme(input: {
  name: string;
  description: string;
}): Promise<ActionResult> {
  const name = input.name.trim();
  const description = input.description.trim();

  if (!name) return { ok: false, error: "Enter a theme name." };
  // Not a database constraint — the column is nullable on purpose, matching the
  // rest of the schema — but a theme without guidance is a name the classifier
  // has to guess at, which is the exact failure this table exists to prevent.
  if (!description) {
    return {
      ok: false,
      error:
        "Enter a description. It is sent to the model as classification guidance, not shown as a label.",
    };
  }

  const { userId } = await getSessionContext();
  const supabase = await createClient();

  const { error } = await supabase
    .from("themes")
    .insert({ name, description, added_by: userId });

  if (error) {
    if ((error as { code?: string }).code === "23505") {
      return { ok: false, error: `“${name}” is already a theme.` };
    }
    return { ok: false, error: toActionError(error) };
  }
  revalidatePath(PATH);
  return { ok: true };
}

/**
 * Retire or restore a theme. Forward-only: a deactivated theme stops being
 * offered to the coding engine, and articles already tagged with it keep the
 * tag — the same lifecycle a retired keyword has, where historical
 * matched_keywords are never rewritten.
 */
export async function setThemeActive(
  id: string,
  active: boolean
): Promise<ActionResult> {
  const supabase = await createClient();
  const { error } = await supabase
    .from("themes")
    .update({ is_active: active })
    .eq("id", id);
  if (error) return { ok: false, error: toActionError(error) };
  revalidatePath(PATH);
  return { ok: true };
}

export async function updateThemeDescription(
  id: string,
  description: string
): Promise<ActionResult> {
  const value = description.trim();
  if (!value) return { ok: false, error: "Description cannot be empty." };

  const supabase = await createClient();
  const { error } = await supabase
    .from("themes")
    .update({ description: value })
    .eq("id", id);
  if (error) return { ok: false, error: toActionError(error) };
  revalidatePath(PATH);
  return { ok: true };
}

/**
 * Hard delete. Unlike articles there is no tombstone requirement — nothing
 * dedups against a theme — but articles already tagged keep the raw string in
 * ai_themes, so deleting orphans that value rather than erasing it. Deactivate
 * is the safer default and the UI says so.
 */
export async function deleteTheme(id: string): Promise<ActionResult> {
  const supabase = await createClient();
  const { error } = await supabase.from("themes").delete().eq("id", id);
  if (error) return { ok: false, error: toActionError(error) };
  revalidatePath(PATH);
  return { ok: true };
}
