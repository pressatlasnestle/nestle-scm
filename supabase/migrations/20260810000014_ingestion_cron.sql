-- ============================================================================
-- nestle-scm — scheduled ingestion via pg_cron + pg_net
--
-- The schedule lives in Postgres, not in the hosting provider: pg_cron fires
-- public.trigger_ingestion(), which POSTs to the app's /api/ingestion/run
-- route with a shared secret. Keeping it here means the cadence survives a
-- change of host and is visible in the same place as the data it produces.
--
-- Two pieces of configuration have to be supplied before this does anything;
-- until then trigger_ingestion() logs a notice and returns without calling out:
--
--   1. the app's public base URL
--        insert into public.app_settings (key, value)
--        values ('app_base_url', '"https://<your-app>"')
--        on conflict (key) do update set value = excluded.value;
--
--   2. the shared secret, which must equal the app's INGESTION_CRON_SECRET
--        select vault.create_secret(
--          '<same value as INGESTION_CRON_SECRET>',
--          'ingestion_cron_secret',
--          'Shared secret authenticating cron-triggered ingestion runs'
--        );
--
-- The secret lives in Vault rather than app_settings because app_settings is
-- readable by every authenticated session under its existing RLS policy.
-- ============================================================================

create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

-- ---------------------------------------------------------------------------
-- trigger_ingestion — the only thing the schedule calls
-- ---------------------------------------------------------------------------
create or replace function public.trigger_ingestion(p_run_type text)
returns void
language plpgsql
security definer
set search_path = public, extensions, vault
as $$
declare
  v_base_url text;
  v_secret   text;
begin
  select trim(both '"' from value::text)
    into v_base_url
    from public.app_settings
   where key = 'app_base_url';

  select decrypted_secret
    into v_secret
    from vault.decrypted_secrets
   where name = 'ingestion_cron_secret';

  if v_base_url is null or v_base_url = '' or v_secret is null then
    raise notice
      'trigger_ingestion(%): skipped — app_base_url and/or ingestion_cron_secret not configured.',
      p_run_type;
    return;
  end if;

  perform extensions.net.http_post(
    url     := rtrim(v_base_url, '/') || '/api/ingestion/run',
    headers := jsonb_build_object(
                 'Content-Type', 'application/json',
                 'x-ingestion-secret', v_secret
               ),
    body    := jsonb_build_object('runType', p_run_type),
    timeout_milliseconds := 60000
  );
end;
$$;

comment on function public.trigger_ingestion(text) is
  'Cron entry point: POSTs the given run type to the app ingestion route using the Vault-held shared secret. No-ops with a notice until app_base_url and ingestion_cron_secret are configured.';

-- SECURITY DEFINER reads a Vault secret, so no application role may call it.
-- Only the cron owner (postgres) runs it.
revoke all on function public.trigger_ingestion(text) from public;
revoke all on function public.trigger_ingestion(text) from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Schedule — every 12h, matching the 24h rolling window
-- ---------------------------------------------------------------------------
-- Unscheduled first so re-running this migration is idempotent.
select cron.unschedule('scm-ingestion-scheduled')
where exists (
  select 1 from cron.job where jobname = 'scm-ingestion-scheduled'
);

select cron.schedule(
  'scm-ingestion-scheduled',
  '0 */12 * * *',
  $cron$select public.trigger_ingestion('scheduled')$cron$
);
