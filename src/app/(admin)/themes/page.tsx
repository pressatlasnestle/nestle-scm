import { createClient } from "@/lib/supabase/server";
import { getSessionContext } from "@/lib/auth";
import { ThemesTable, type ThemeRow } from "./ThemesTable";

export const dynamic = "force-dynamic";

type Joined = {
  id: string;
  name: string;
  description: string | null;
  is_active: boolean;
  created_at: string;
  profiles: { email: string | null } | null;
};

export default async function ThemesPage() {
  const ctx = await getSessionContext();
  const supabase = await createClient();

  const { data } = await supabase
    .from("themes")
    .select("id, name, description, is_active, created_at, profiles(email)")
    .order("name");

  // Article counts per theme, so a dead bucket is visible in the panel rather
  // than only in a recode report. One read over the coded corpus, counted in
  // memory — ai_themes is an array column, and at this size a round trip per
  // theme would cost more than the whole scan.
  const { data: tagged } = await supabase
    .from("articles")
    .select("ai_themes")
    .eq("status", "active")
    .eq("coded_status", "coded")
    .not("ai_themes", "is", null);

  const counts = new Map<string, number>();
  for (const row of tagged ?? []) {
    for (const theme of row.ai_themes ?? []) {
      counts.set(theme, (counts.get(theme) ?? 0) + 1);
    }
  }

  const rows: ThemeRow[] = ((data as Joined[] | null) ?? []).map((t) => ({
    id: t.id,
    name: t.name,
    description: t.description,
    is_active: t.is_active,
    created_at: t.created_at,
    added_by_email: t.profiles?.email ?? null,
    article_count: counts.get(t.name) ?? 0,
  }));

  return <ThemesTable initialThemes={rows} canEdit={ctx.isAdmin} />;
}
