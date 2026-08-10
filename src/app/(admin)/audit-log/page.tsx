import { createClient } from "@/lib/supabase/server";
import { requireAdmin } from "@/lib/auth";
import { AuditTable, type AuditRow } from "./AuditTable";

export const dynamic = "force-dynamic";

type Row = {
  id: string;
  created_at: string;
  action: string | null;
  target_type: string | null;
  target_id: string | null;
  metadata: Record<string, unknown> | null;
  profiles: { email: string | null } | null;
};

/** Derives a compact, human-readable target from the row's metadata. */
function describeTarget(r: Row): string {
  const m = r.metadata ?? {};
  if (typeof m.provider === "string") {
    if (typeof m.new_model_id !== "undefined") {
      return `provider: ${m.provider} · model → ${m.new_model_id ?? "—"}`;
    }
    return `provider: ${m.provider}`;
  }
  if (typeof m.name === "string") return m.name;
  if (typeof m.keyword === "string") return `"${m.keyword}"`;
  if (r.target_type) {
    return r.target_id ? `${r.target_type}: ${r.target_id.slice(0, 8)}…` : r.target_type;
  }
  return "—";
}

export default async function AuditLogPage() {
  await requireAdmin();
  const supabase = await createClient();

  const { data } = await supabase
    .from("audit_log")
    .select("id, created_at, action, target_type, target_id, metadata, profiles(email)")
    .order("created_at", { ascending: false })
    .limit(500);

  const rows: AuditRow[] = ((data as Row[] | null) ?? []).map((r) => ({
    id: r.id,
    created_at: r.created_at,
    actor_email: r.profiles?.email ?? null,
    action: r.action,
    target: describeTarget(r),
  }));

  return <AuditTable rows={rows} />;
}
