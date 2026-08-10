import { createClient } from "@/lib/supabase/server";
import { getSessionContext } from "@/lib/auth";
import { reportDataFromRow } from "@/lib/report-template";
import { SAMPLE_REPORT } from "@/lib/report-sample";
import { NewsletterPreview, type ReportListItem } from "./NewsletterPreview";

export const dynamic = "force-dynamic";

// All roles may view this panel (same tier as Media Universe / Keywords /
// Recipients). It is read-only for everyone — there are no write actions here.
export default async function NewsletterPage() {
  await getSessionContext();
  const supabase = await createClient();

  const { data } = await supabase
    .from("reports")
    .select("id, week_of, generated_at, sent_at, status, article_count, stats_snapshot")
    .order("week_of", { ascending: false });

  const rows = data ?? [];

  const items: ReportListItem[] =
    rows.length > 0
      ? rows.map((r) => ({
          id: r.id,
          isSample: false,
          week_of: r.week_of,
          generated_at: r.generated_at,
          status: r.status,
          article_count: r.article_count,
          data: reportDataFromRow(r),
        }))
      : [
          {
            id: "sample",
            isSample: true,
            week_of: SAMPLE_REPORT.week_of,
            generated_at: null,
            status: null,
            article_count: SAMPLE_REPORT.article_count,
            data: SAMPLE_REPORT,
          },
        ];

  return <NewsletterPreview reports={items} />;
}
