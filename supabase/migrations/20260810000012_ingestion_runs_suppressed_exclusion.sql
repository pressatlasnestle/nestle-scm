-- ============================================================================
-- nestle-scm — ingestion_runs.articles_suppressed_exclusion  [schema-brief table 6]
--
-- Exclusion-suppressed articles never become `articles` rows: an article that
-- matches both gates but also hits a negative/Exclusion keyword *without* a
-- Gate 1 anchor in its headline is dropped before insert. Without this counter
-- that whole mechanism is invisible in the Ingestion Logs panel — a run would
-- simply report fewer articles with no indication why.
--
-- Additive, nullable-safe with a default, so existing rows and existing insert
-- statements are unaffected. RLS unchanged (ingestion_runs already has
-- whole-row policies covering this column).
-- ============================================================================

alter table public.ingestion_runs
  add column articles_suppressed_exclusion int default 0;

comment on column public.ingestion_runs.articles_suppressed_exclusion is
  'Articles that passed the two-gate check but were dropped before insert because a negative/Exclusion keyword matched and no Gate 1 anchor appeared in the headline. Aggregate only — suppressed articles leave no row of their own.';
