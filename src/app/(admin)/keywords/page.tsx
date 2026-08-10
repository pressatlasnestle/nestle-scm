import { createClient } from "@/lib/supabase/server";
import { getSessionContext } from "@/lib/auth";
import { KeywordsTable, type KeywordRow } from "./KeywordsTable";

export const dynamic = "force-dynamic";

type Joined = {
  id: string;
  keyword: string;
  is_active: boolean;
  created_at: string;
  profiles: { email: string | null } | null;
};

export default async function KeywordsPage() {
  const ctx = await getSessionContext();
  const supabase = await createClient();

  const { data } = await supabase
    .from("keywords")
    .select("id, keyword, is_active, created_at, profiles(email)")
    .order("created_at", { ascending: true });

  const rows: KeywordRow[] = ((data as Joined[] | null) ?? []).map((k) => ({
    id: k.id,
    keyword: k.keyword,
    is_active: k.is_active,
    created_at: k.created_at,
    added_by_email: k.profiles?.email ?? null,
  }));

  return <KeywordsTable initialKeywords={rows} canEdit={ctx.isAdmin} />;
}
