-- ============================================================================
-- nestle-scm — keyword list_type + article negative-keyword matches
--
-- keywords.list_type: makes a keyword either drive capture ('positive') or only
--   flag already-captured articles ('negative'). No CHECK constraint — same
--   reasoning as sources.list_type: free text avoids a migration for every
--   future variant. Expected values: 'positive', 'negative'. Defaults to
--   'positive' so every existing keyword keeps its current capture behaviour.
--
-- articles.matched_negative_keywords: nullable text[], populated later by the
--   ingestion pipeline (the negative keywords that matched an already-captured
--   article). Added now so the contract is locked before that build starts.
--
-- Ingestion contract to carry forward (NOT enforced here):
--   * positive keywords gate capture; negative keywords never block capture —
--     they only populate matched_negative_keywords on captured articles.
--   * the Articles panel should surface matched_negative_keywords as a
--     flag/badge plus a filter.
-- ============================================================================

alter table public.keywords
  add column list_type text not null default 'positive';

comment on column public.keywords.list_type is
  'Whether the keyword drives capture (''positive'') or only flags already-captured articles (''negative''). Free text (no CHECK); expected values: positive, negative.';

alter table public.articles
  add column matched_negative_keywords text[];

comment on column public.articles.matched_negative_keywords is
  'Negative keywords (keywords.list_type = ''negative'') that matched this already-captured article. Nullable; populated by the ingestion pipeline. Never blocks capture.';
