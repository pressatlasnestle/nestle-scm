-- ============================================================================
-- nestle-scm — articles.keyword_mention_count + articles.source_channel
--
-- Two additive columns, both written by the pipeline, neither gating capture.
--
-- keyword_mention_count: how many times the matched keywords actually occur in
-- headline + body. matched_keywords already says WHICH terms hit; it cannot
-- distinguish a story about port congestion from a story that mentions it once
-- in a closing paragraph. Informational only — capture is still the two-gate
-- rule, and a count of 1 is as captured as a count of 40. It exists so the
-- relevance model and the curator have a cheap density signal to sort on.
--
-- source_channel: which fetch path produced the row.
--   media_rss         — a curated `sources` row's own RSS/Atom feed
--   google_news_seed  — the one-time Google News breadth sweep
--   newsdata          — the NewsData.io aggregator, covering sources with no
--                       usable public feed
-- Deliberately not a check constraint: new channels are expected, and a
-- constraint here would mean a migration for each one. The write path is code,
-- not a form, so a typo is a code review problem rather than a data problem.
--
-- Both nullable with no default: existing rows are backfilled below, and a
-- null on a future row means "channel not recorded", not "media_rss".
--
-- RLS unchanged — articles already has whole-row policies covering both.
-- ============================================================================

alter table public.articles add column keyword_mention_count int;
alter table public.articles add column source_channel text;

comment on column public.articles.keyword_mention_count is
  'Total occurrences of the matched keywords across headline + body, counted at match time. Informational density signal — never gates capture.';

comment on column public.articles.source_channel is
  'Fetch path that produced this row: media_rss | google_news_seed | newsdata. Extend as channels are added. Drives cross-channel dedup priority (media_rss > google_news_seed > newsdata).';

-- Backfill. Only two channels have ever written to this table, and they are
-- distinguishable: the Google News sweep is the one path that ingests with a
-- null source_id (its items belong to no `sources` row), every other run
-- ingests per-source. Done as a backfill rather than left null so the dedup
-- priority rule has a channel to compare against on day one.
update public.articles
set source_channel = case
  when source_id is null then 'google_news_seed'
  else 'media_rss'
end
where source_channel is null;

-- keyword_mention_count is deliberately NOT backfilled: it can only be
-- recomputed from body text against the keyword set as it stood at match time,
-- and both have moved since. Existing rows keep null until they are next
-- updated by a longer-body pull.

create index articles_source_channel_idx on public.articles (source_channel);
