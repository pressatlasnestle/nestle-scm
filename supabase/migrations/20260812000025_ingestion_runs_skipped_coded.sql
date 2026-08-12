-- ============================================================================
-- nestle-scm — count coded articles a run declined to overwrite
--
-- dedup.ts now refuses to supersede a row whose coded_status is 'coded': its
-- ai_sentiment / ai_themes / ai_summary were derived from the stored body, and
-- replacing that body without re-coding would leave a published analysis
-- describing text the database no longer holds.
--
-- That skip needs its own counter for the same reason
-- articles_suppressed_exclusion got one in migration 0012: a rule that quietly
-- drops input is only defensible while it is COUNTED. Rolled into
-- articles_duplicate it would be indistinguishable from an ordinary re-pull,
-- and "we are declining better copies of coded articles" — the accepted cost
-- of the guard — would be invisible to the operator who accepted it.
--
-- A persistently non-zero count here is the signal that some story keeps
-- arriving longer than the version that was coded, and is worth a look; a zero
-- means the guard has not yet had to fire.
--
-- Defaults to 0 rather than null so existing rows read as "this never
-- happened" instead of "unknown" — they predate the guard, so it genuinely
-- never did.
-- ============================================================================

alter table public.ingestion_runs
  add column if not exists articles_skipped_coded integer not null default 0;

comment on column public.ingestion_runs.articles_skipped_coded is
  'Pulls discarded because the stored article was already coded. The accepted cost of never invalidating a finished analysis — see dedup.ts.';
