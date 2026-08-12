-- ============================================================================
-- nestle-scm — the Analysis panel's stored weekly narrative
--
-- The panel's header summary and its per-theme narratives are written by
-- Gemini in ONE call over a week's coded article summaries. That call costs
-- real money, so the result is stored and read back — never regenerated on
-- view. Two people opening the same week must also read the same words: a
-- narrative regenerated per view would quietly differ between them, and a
-- client-facing report cannot work that way.
--
-- WHY A NEW COLUMN AND NOT stats_snapshot / html_content
--
-- Both are already spoken for by the Monday digest: reportDataFromRow() reads
-- a fixed shape out of stats_snapshot, and html_content is the rendered email
-- body. Writing the narrative into either would mean the Analysis panel and the
-- newsletter fighting over one field, and the first regenerate would blank a
-- digest. analysis_narrative is its own jsonb column with its own writer.
--
-- WHY jsonb AND NOT html
--
-- The narrative is structured — a period summary plus one entry per theme —
-- and the panel renders it as components. Storing HTML would force the shape to
-- be re-parsed out of markup by anything that wants the parts (the PDF export
-- and the digest both will), and would put model-authored markup into the DOM.
-- The `version` key inside the document is what lets the shape change later
-- without a migration per revision.
--
-- WHY week_of BECOMES UNIQUE
--
-- The Analysis panel addresses a report BY WEEK — it upserts on week_of and
-- reads back the row for the selected week. Without the constraint a second
-- regenerate would insert a duplicate rather than replace, and "the narrative
-- for week X" would stop being a single well-defined thing.
--
-- It is a full UNIQUE constraint and deliberately NOT a partial unique index
-- on `where week_of is not null`. The partial form looks tidier — a null week
-- is not a week — but Postgres will not accept a partial index as the arbiter
-- for ON CONFLICT (week_of) unless the statement repeats the index predicate,
-- which PostgREST's upsert cannot express. The upsert fails outright with
-- "no unique or exclusion constraint matching the ON CONFLICT specification".
-- A plain unique constraint costs nothing here: Postgres treats NULLs as
-- distinct, so rows with no week_of are still unconstrained, which is the same
-- behaviour the partial index was there to give.
--
-- The table is empty at the time of writing, so this adds no backfill risk.
-- ============================================================================

alter table public.reports
  add column if not exists analysis_narrative jsonb,
  add column if not exists analysis_generated_at timestamptz,
  add column if not exists analysis_generated_by uuid references public.profiles(id) on delete set null;

comment on column public.reports.analysis_narrative is
  'Gemini-written weekly narrative for the Analysis panel: { version, period_summary, themes[] }. Written by the Regenerate action, read on view — never regenerated per render.';
comment on column public.reports.analysis_generated_at is
  'When analysis_narrative was last written. Shown in the panel so a reader can tell a fresh narrative from a stale one.';

alter table public.reports
  add constraint reports_week_of_key unique (week_of);

-- RLS is unchanged and deliberately so. reports already has a SELECT policy for
-- every app user (is_app_user()) and NO insert/update policy at all, so the
-- narrative is readable by read/curate/admin alike while the only writer is the
-- service-role client behind the role-gated Regenerate action. That matches how
-- the Gemini key itself is reachable — service_role only, see migration 0019 —
-- so the write path and the credential path have the same gate.
