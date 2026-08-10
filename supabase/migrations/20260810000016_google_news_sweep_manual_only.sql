-- ============================================================================
-- nestle-scm — drop the daily Google News sweep schedule
--
-- Migration 15 scheduled this daily on the assumption, carried from the build
-- brief, that the feed "skews old" by a few days. Measuring it says otherwise:
-- across the ten sweep queries, 457 items came back with a median age of 227
-- days — 3 within a week, 8 within a month, 195 older than a year — and of the
-- 113 items clearing both gates, none were newer than 30 days.
--
-- Google News returns relevance-ranked evergreen results for standing topical
-- queries rather than a recency feed, so a daily job would re-read the same
-- stale set forever and insert nothing new after the first pass. The sweep is
-- therefore a one-time breadth seed, run manually:
--
--   POST /api/ingestion/run  {"runType": "google_news_sweep"}
--
-- The run type, the route and the ingestion_runs logging all stay — only the
-- schedule goes. Ingested items keep their true published_at, so a report
-- querying a recent window will not surface them.
-- ============================================================================

select cron.unschedule('scm-google-news-sweep')
where exists (
  select 1 from cron.job where jobname = 'scm-google-news-sweep'
);
