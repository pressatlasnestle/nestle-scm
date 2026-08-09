-- ============================================================================
-- nestle-scm — Seed baseline app_settings
--
-- Seed universe_mode so ingestion never has to null-handle an unset key. It reads
-- this on every run. Default 'whole_universe' = positive sources always in,
-- negative sources excluded, everything else included (fuller-coverage intent
-- from the spec). Flip to 'positive_only' anytime from the admin panel.
--
-- Idempotent: on conflict do nothing, so re-running never clobbers an operator's
-- later change.
-- ============================================================================
insert into public.app_settings (key, value)
values ('universe_mode', '"whole_universe"'::jsonb)
on conflict (key) do nothing;
