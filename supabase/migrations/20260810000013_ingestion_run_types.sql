-- ============================================================================
-- nestle-scm — ingestion_runs.run_type: allow the two new run types
--
-- The initial schema locked run_type to ('backfill','scheduled','manual'),
-- written before the pipeline design settled on two more trigger paths:
--   * 'source_added'      — fires from addSource(), single source, 7d window
--   * 'google_news_sweep' — separate daily Google News RSS sweep
--
-- Both must be distinguishable in the Ingestion Logs panel, so they are their
-- own run_type rather than being folded into 'manual'. 'manual' is kept: it
-- still covers an operator re-running the pipeline by hand.
--
-- Constraint is replaced, not dropped — an unconstrained free-text run_type
-- would let a typo silently create a run type nothing filters on.
-- ============================================================================

alter table public.ingestion_runs
  drop constraint ingestion_runs_run_type_check;

alter table public.ingestion_runs
  add constraint ingestion_runs_run_type_check
  check (run_type in ('backfill', 'scheduled', 'manual', 'source_added', 'google_news_sweep'));

comment on column public.ingestion_runs.run_type is
  'backfill = one-time 7d seed; scheduled = 12h cron, 24h window; manual = operator re-run; source_added = auto-fired when a source is added, 7d window, that source only; google_news_sweep = daily Google News RSS keyword sweep.';
