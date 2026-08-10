"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdmin } from "@/lib/auth";
import { toActionError, type ActionResult } from "@/lib/actions/result";

const PATH = "/users";
const ROLES = ["read", "curate", "admin"] as const;
type Role = (typeof ROLES)[number];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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

/**
 * Invites a new user by email and assigns their role up front.
 *
 * Uses the service-role admin client (auth.admin.inviteUserByEmail), which
 * bypasses RLS — so authorization is enforced INDEPENDENTLY via requireAdmin()
 * on the caller's own session BEFORE the admin client is ever created. A
 * non-admin caller is redirected by requireAdmin() and never reaches the
 * privileged code path (defense in depth: this action is only linked from the
 * admin-only /users page, and still self-guards here).
 */
export async function inviteUser(input: {
  email: string;
  role: string;
}): Promise<ActionResult> {
  // 1) Authorize the caller on their own session — never trust the admin client for this.
  const ctx = await requireAdmin();

  const email = input.email.trim().toLowerCase();
  const role = input.role;

  if (!EMAIL_RE.test(email)) {
    return { ok: false, error: "Enter a valid email address." };
  }
  if (!ROLES.includes(role as Role)) {
    return { ok: false, error: "Invalid role." };
  }

  // 2) Privileged work with the service-role client (RLS-bypassing).
  let admin: ReturnType<typeof createAdminClient>;
  try {
    admin = createAdminClient();
  } catch {
    return {
      ok: false,
      error:
        "User invites aren't configured on the server yet — the service-role key is missing.",
    };
  }

  const { data, error } = await admin.auth.admin.inviteUserByEmail(email);
  if (error) {
    // Most common: the email already has an account.
    if (/already been registered|already exists|already registered/i.test(error.message)) {
      return { ok: false, error: "That email already has an account." };
    }
    return { ok: false, error: error.message || "Could not send the invite." };
  }

  const newUserId = data.user?.id;
  if (!newUserId) {
    return { ok: false, error: "Invite sent but the new user id was not returned." };
  }

  // 3) Set the chosen role. The on_auth_user_created trigger already inserted the
  //    profile as 'read'; overwrite it so they land in the right role immediately.
  const { error: roleErr } = await admin
    .from("profiles")
    .update({ role })
    .eq("id", newUserId);
  if (roleErr) {
    return {
      ok: false,
      error: `Invite sent, but setting the role failed: ${roleErr.message}. Fix it from the roster.`,
    };
  }

  // 4) Audit the invite (actor = the admin who invited).
  await admin.from("audit_log").insert({
    actor_id: ctx.userId,
    action: "user.invite",
    target_type: "profiles",
    target_id: newUserId,
    metadata: { email, role },
  });

  revalidatePath(PATH);
  return { ok: true };
}
