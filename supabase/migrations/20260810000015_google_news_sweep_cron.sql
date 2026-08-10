-- ============================================================================
-- nestle-scm — daily Google News sweep schedule
--
-- Separate job from scm-ingestion-scheduled, and deliberately daily rather
-- than every 12h: the Google News feed skews old (median item age of several
-- days), so running it twice a day would spend requests re-reading the same
-- stale items. Reuses trigger_ingestion() and therefore the same base URL and
-- Vault secret — it no-ops until those are configured.
--
-- Runs at 03:00 UTC, off-phase from the 00:00/12:00 scheduled runs so the two
-- never contend for the same serverless capacity.
-- ============================================================================

select cron.unschedule('scm-google-news-sweep')
where exists (
  select 1 from cron.job where jobname = 'scm-google-news-sweep'
);

select cron.schedule(
  'scm-google-news-sweep',
  '0 3 * * *',
  $cron$select public.trigger_ingestion('google_news_sweep')$cron$
);
