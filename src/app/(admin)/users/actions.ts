"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireAdmin } from "@/lib/auth";
import { toActionError, type ActionResult } from "@/lib/actions/result";

const PATH = "/users";
const ROLES = ["read", "curate", "admin"] as const;
type Role = (typeof ROLES)[number];

export async function setUserRole(
  targetId: string,
  role: string
): Promise<ActionResult> {
  const ctx = await requireAdmin();

  if (!ROLES.includes(role as Role)) {
    return { ok: false, error: "Invalid role." };
  }
  // Guard against self-lockout: an admin cannot change their own role here.
  if (targetId === ctx.userId) {
    return {
      ok: false,
      error: "You can't change your own role. Ask another admin.",
    };
  }

  const supabase = await createClient();
  const { error } = await supabase
    .from("profiles")
    .update({ role })
    .eq("id", targetId);

  if (error) return { ok: false, error: toActionError(error) };
  revalidatePath(PATH);
  return { ok: true };
}
