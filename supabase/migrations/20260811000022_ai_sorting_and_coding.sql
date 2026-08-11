-- ============================================================================
-- nestle-scm — AI Brain: sorting (Stage 1) + coding (Stage 2) columns
--
-- Two separate AI passes over an article, deliberately kept apart because they
-- run at different times, for different reasons, with different cost profiles:
--
--   Stage 1 — SORTING. Automatic, fires after every ingestion run on the rows
--     that run inserted. One cheap call per article asking a single question:
--     is this actually about ocean freight / container shipping? This is a
--     genuine relevance judgement, NOT a re-run of the regex two-gate in
--     match.ts — the gate decides capture, this decides whether the capture
--     looks right. It ANNOTATES ONLY. It never touches articles.status, so a
--     flagged article stays 'active' and fully visible; the analyst decides.
--
--   Stage 2 — CODING. Manual, batched, period-scoped, triggered by an analyst
--     from the Articles panel after they have reviewed and excluded by hand.
--     One call per article producing sentiment + themes. This one costs real
--     money per run, which is why nothing fires it automatically.
--
-- No CHECK constraints on the status/reasoning text fields, matching the
-- precedent set by articles.source_channel in migration 0018: the write path
-- is code, not a form, and a CHECK here buys nothing but a migration whenever
-- the vocabulary moves.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Stage 1 — sorting
-- ---------------------------------------------------------------------------
alter table public.articles
  add column ai_sorting_status    text default 'pending',   -- 'pending' | 'complete'
  add column ai_sorting_flagged   boolean default false,    -- true = AI questions relevance
  add column ai_sorting_reasoning text;                     -- why flagged, or why confirmed

comment on column public.articles.ai_sorting_status is
  'Stage 1 relevance pass: ''pending'' until the sorting engine has judged this row, then ''complete''. Drives the npm run sort backfill''s idempotency — it only ever picks up ''pending''.';

comment on column public.articles.ai_sorting_flagged is
  'true = the AI questions whether this article belongs in an ocean-freight corpus. ADVISORY ONLY. Never gates capture and never changes articles.status; a flagged row stays active and visible. Distinct from matched_negative_keywords, which flags proximity to an exclusion term — two different flags for two different reasons, do not conflate them in the UI.';

comment on column public.articles.ai_sorting_reasoning is
  'One-line justification from the sorting pass — populated whether flagged or confirmed, so a confirmation is auditable too, not just a rejection.';

-- ---------------------------------------------------------------------------
-- Stage 2 — coding
--
-- ai_sentiment / ai_summary / ai_relevance_score already exist from migration
-- 0001 and have never been written by anything. The coding engine is the first
-- writer of ai_sentiment. ai_category and ai_tags also date from 0001 and stay
-- unused — ai_themes is added rather than reusing ai_tags because themes carry
-- a specific contract (1-3 short phrases, chosen to GROUP cleanly across
-- articles so storylines can be derived from them), which a general-purpose
-- tag bag does not.
-- ---------------------------------------------------------------------------
alter table public.articles
  add column coded_status text default 'pending',           -- 'pending' | 'coded'
  add column ai_themes    text[];                           -- 1-3 themes per article

comment on column public.articles.coded_status is
  'Stage 2 coding pass: ''pending'' until an analyst has run AI Analysis over this row, then ''coded''. The coding batch filters on this, so re-running AI Analysis over an overlapping period never re-codes and never re-bills for an already-coded article.';

comment on column public.articles.ai_themes is
  '1-3 short thematic phrases. The grouping key for storylines, which are computed at query time from shared themes within a period — there is deliberately no storylines table, for the same staleness reason the live dashboard queries exist alongside the frozen reports.stats_snapshot.';

-- ---------------------------------------------------------------------------
-- Partial indexes on the two work queues.
--
-- Both engines ask exactly one question — "what is still pending?" — over a
-- table that will be overwhelmingly non-pending once backfill has run. Partial
-- indexes stay small because they only ever hold the outstanding work.
-- ---------------------------------------------------------------------------
create index articles_sorting_pending_idx
  on public.articles (ingested_at)
  where ai_sorting_status = 'pending';

create index articles_coding_pending_idx
  on public.articles (published_at)
  where coded_status = 'pending';

-- ---------------------------------------------------------------------------
-- Per-stage model selection.
--
-- The API key stays in integration_secrets.gemini (Vault-backed, service-role
-- decrypt). Only the model id moves here, and it splits in two because the two
-- stages have genuinely different economics: sorting runs automatically on
-- every ingested article and wants the cheapest model that can judge relevance;
-- coding runs on analyst-triggered batches and can afford a stronger one.
--
-- integration_secrets.gemini.model_id is superseded by these two keys. The
-- column is left in place (other providers still use it, and dropping it would
-- churn the status view + its grants) but the Gemini card no longer edits it.
--
-- Written through the same admin-only app_settings RLS path as universe_mode.
-- Read fresh on every run — never cached — so an admin's model change takes
-- effect on the next sorting/coding call with no redeploy.
--
-- Idempotent: on conflict do nothing, so re-running never clobbers a model an
-- operator has since changed in the admin panel.
-- ---------------------------------------------------------------------------
insert into public.app_settings (key, value) values
  ('sorting_model_id', '"gemini-3.5-flash-lite"'::jsonb),
  ('coding_model_id',  '"gemini-3.6-flash"'::jsonb)
on conflict (key) do nothing;
