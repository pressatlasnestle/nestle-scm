import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export type AppRole = "read" | "curate" | "admin";

export type SessionContext = {
  userId: string;
  email: string | null;
  fullName: string | null;
  /** Authoritative role from current_app_role() — null if inactive/unprovisioned. */
  role: AppRole | null;
  isAdmin: boolean;
  canCurate: boolean;
};

/**
 * Resolves the logged-in user and their app role server-side. Role comes from
 * current_app_role() (SECURITY DEFINER, honours is_active) — never trust a
 * client-supplied role. Redirects to /login if there is no session.
 */
export async function getSessionContext(): Promise<SessionContext> {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  // Authoritative role (respects is_active). Falls back to null.
  const { data: roleData } = await supabase.rpc("current_app_role");
  const role = (roleData as AppRole | null) ?? null;

  // Display fields from the caller's own profile row.
  const { data: profile } = await supabase
    .from("profiles")
    .select("email, full_name")
    .eq("id", user.id)
    .maybeSingle();

  return {
    userId: user.id,
    email: profile?.email ?? user.email ?? null,
    fullName: profile?.full_name ?? null,
    role,
    isAdmin: role === "admin",
    canCurate: role === "curate" || role === "admin",
  };
}

/** Guards an admin-only page. Redirects non-admins to the app root. */
export async function requireAdmin(): Promise<SessionContext> {
  const ctx = await getSessionContext();
  if (!ctx.isAdmin) {
    redirect("/media-universe");
  }
  return ctx;
}
