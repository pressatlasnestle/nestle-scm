import { createClient } from "@/lib/supabase/server";
import { getSessionContext } from "@/lib/auth";
import {
  applyRange,
  parseIsoDate,
  parsePeriodKey,
  resolvePeriod,
  type PeriodKey,
} from "@/lib/articles/period";
import { ArticlesView, type ArticleRow } from "./ArticlesView";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;

type ArticleStatusFilter = "active" | "excluded" | "deleted" | "all";
type ChannelFilter =
  | "all"
  | "media_rss"
  | "google_alerts"
  | "google_news_seed"
  | "newsapi_ai"
  | "newsdata";
type SortKey = "published" | "mentions";
type SortDir = "asc" | "desc";

type SearchParams = {
  q?: string;
  channel?: string;
  neg?: string;
  sflag?: string;
  status?: string;
  period?: string;
  from?: string;
  to?: string;
  sort?: string;
  dir?: string;
  page?: string;
};

/**
 * newsapi_ai is the live aggregator channel (migration 0021); newsdata is the
 * retired one it replaced. Both are listed because the retired channel still
 * has rows in the table and they must stay reachable — a filter that cannot
 * select an existing value hides data.
 */
const CHANNELS: ChannelFilter[] = [
  "all",
  "media_rss",
  "google_alerts",
  "google_news_seed",
  "newsapi_ai",
  "newsdata",
];
const STATUSES: ArticleStatusFilter[] = ["active", "excluded", "deleted", "all"];

function parse(sp: SearchParams) {
  const status = (STATUSES as string[]).includes(sp.status ?? "")
    ? (sp.status as ArticleStatusFilter)
    : "active";
  const channel = (CHANNELS as string[]).includes(sp.channel ?? "")
    ? (sp.channel as ChannelFilter)
    : "all";
  const sort: SortKey = sp.sort === "mentions" ? "mentions" : "published";
  const dir: SortDir = sp.dir === "asc" ? "asc" : "desc";
  const neg = sp.neg === "1";
  const sflag = sp.sflag === "1";
  const period: PeriodKey = parsePeriodKey(sp.period);
  const from = parseIsoDate(sp.from);
  const to = parseIsoDate(sp.to);
  const q = (sp.q ?? "").trim();
  const page = Math.max(1, Number.parseInt(sp.page ?? "1", 10) || 1);
  return { status, channel, sort, dir, neg, sflag, period, from, to, q, page };
}

export default async function ArticlesPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const ctx = await getSessionContext();
  const supabase = await createClient();
  const f = parse(await searchParams);

  const range = resolvePeriod(f.period, { from: f.from, to: f.to });
  const sortCol = f.sort === "mentions" ? "keyword_mention_count" : "published_at";

  let query = supabase
    .from("articles")
    .select(
      "id, headline, url, media, source_channel, published_at, matched_keywords, matched_negative_keywords, keyword_mention_count, word_count, status, ai_sorting_status, ai_sorting_flagged, ai_sorting_reasoning, coded_status",
      { count: "exact" }
    );

  if (f.status !== "all") query = query.eq("status", f.status);
  if (f.channel !== "all") query = query.eq("source_channel", f.channel);
  if (f.neg) query = query.not("matched_negative_keywords", "is", null);
  if (f.sflag) query = query.eq("ai_sorting_flagged", true);
  if (f.q) query = query.ilike("headline", `%${f.q}%`);
  query = applyRange(query, range);

  const from = (f.page - 1) * PAGE_SIZE;
  const to = from + PAGE_SIZE - 1;

  const { data, count } = await query
    .order(sortCol, { ascending: f.dir === "asc", nullsFirst: false })
    .order("ingested_at", { ascending: false })
    .range(from, to);

  const rows = (data ?? []) as ArticleRow[];
  const total = count ?? 0;

  return (
    <ArticlesView
      rows={rows}
      total={total}
      pageSize={PAGE_SIZE}
      canCurate={ctx.canCurate}
      filters={{
        q: f.q,
        channel: f.channel,
        neg: f.neg,
        sflag: f.sflag,
        status: f.status,
        period: f.period,
        from: f.from,
        to: f.to,
        sort: f.sort,
        dir: f.dir,
        page: f.page,
      }}
    />
  );
}
