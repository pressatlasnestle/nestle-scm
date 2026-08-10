import { createClient } from "@/lib/supabase/server";
import { getSessionContext } from "@/lib/auth";
import { UniverseModeCard } from "./UniverseModeCard";
import { SourcesTable } from "./SourcesTable";
import type { UniverseMode } from "./actions";

export const dynamic = "force-dynamic";

export default async function MediaUniversePage() {
  const ctx = await getSessionContext();
  const supabase = await createClient();

  const [{ data: sources }, { data: setting }] = await Promise.all([
    supabase
      .from("sources")
      .select("*")
      .order("name", { ascending: true }),
    supabase
      .from("app_settings")
      .select("value")
      .eq("key", "universe_mode")
      .maybeSingle(),
  ]);

  const mode: UniverseMode =
    setting?.value === "positive_only" ? "positive_only" : "whole_universe";

  return (
    <>
      <UniverseModeCard initialMode={mode} canEdit={ctx.isAdmin} />
      <SourcesTable initialSources={sources ?? []} canEdit={ctx.isAdmin} />
    </>
  );
}
