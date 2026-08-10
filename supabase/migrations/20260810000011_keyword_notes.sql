-- ============================================================================
-- nestle-scm — keywords.notes  [schema-brief table 3]
--
-- Additive only, no behavior change. Single nullable free-text column holding
-- operationally significant per-keyword notes (stem/spelling variants, homonym
-- warnings, full-phrase disambiguation rules e.g. "Gemini Cooperation") that
-- have nowhere else to live. Not machine-parsed; informational for import and
-- future matching intent. No new RLS/grant surface — keywords already has
-- whole-row RLS covering this column.
-- ============================================================================

alter table public.keywords add column notes text;
