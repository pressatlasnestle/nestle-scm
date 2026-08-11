import { createClient } from "@/lib/supabase/server";
import { getSessionContext } from "@/lib/auth";
import { ArticlesView, type ArticleRow } from "./ArticlesView";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;

type ArticleStatusFilter = "active" | "excluded" | "deleted" | "all";
type ChannelFilter =
  | "all"
  | "media_rss"
  | "google_alerts"
  | "google_news_seed"
  | "newsdata";
type SortKey = "published" | "mentions";
type SortDir = "asc" | "desc";

type SearchParams = {
  q?: string;
  channel?: string;
  neg?: string;
  status?: string;
  sort?: string;
  dir?: string;
  page?: string;
};

const CHANNELS: ChannelFilter[] = [
  "all",
  "media_rss",
  "google_alerts",
  "google_news_seed",
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
  const q = (sp.q ?? "").trim();
  const page = Math.max(1, Number.parseInt(sp.page ?? "1", 10) || 1);
  return { status, channel, sort, dir, neg, q, page };
}

export default async function ArticlesPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const ctx = await getSessionContext();
  const supabase = await createClient();
  const f = parse(await searchParams);

  const sortCol = f.sort === "mentions" ? "keyword_mention_count" : "published_at";

  let query = supabase
    .from("articles")
    .select(
      "id, headline, url, media, source_channel, published_at, matched_keywords, matched_negative_keywords, keyword_mention_count, word_count, status",
      { count: "exact" }
    );

  if (f.status !== "all") query = query.eq("status", f.status);
  if (f.channel !== "all") query = query.eq("source_channel", f.channel);
  if (f.neg) query = query.not("matched_negative_keywords", "is", null);
  if (f.q) query = query.ilike("headline", `%${f.q}%`);

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
        status: f.status,
        sort: f.sort,
        dir: f.dir,
        page: f.page,
      }}
    />
  );
}
