import { createClient } from "@/lib/supabase/server";
import { requireAdmin } from "@/lib/auth";
import { UsersTable, type UserRow } from "./UsersTable";

export const dynamic = "force-dynamic";

export default async function UsersPage() {
  const ctx = await requireAdmin();
  const supabase = await createClient();

  const { data } = await supabase
    .from("profiles")
    .select("id, full_name, email, role, is_active, created_at")
    .order("created_at", { ascending: true });

  const users = (data ?? []) as UserRow[];

  return <UsersTable initialUsers={users} currentUserId={ctx.userId} />;
}
