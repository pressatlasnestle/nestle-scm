import { createClient } from "@/lib/supabase/server";
import { getSessionContext } from "@/lib/auth";
import { RecipientsTable } from "./RecipientsTable";

export const dynamic = "force-dynamic";

export default async function RecipientsPage() {
  const ctx = await getSessionContext();
  const supabase = await createClient();

  const { data } = await supabase
    .from("report_recipients")
    .select("*")
    .order("created_at", { ascending: true });

  return (
    <RecipientsTable initialRecipients={data ?? []} canEdit={ctx.isAdmin} />
  );
}
