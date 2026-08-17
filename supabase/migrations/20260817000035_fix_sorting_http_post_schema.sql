-- ============================================================================
-- nestle-scm — fix the Stage 1 sorting cron HTTP function reference
--
-- pg_net installs http_post in the "net" schema. The previous trigger used
-- extensions.net.http_post(), which PostgreSQL parses as a three-part
-- database.schema.function reference and rejects before any HTTP request is
-- made. Use the actual schema-qualified function name.
-- ============================================================================

create or replace function public.trigger_sorting()
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
      'trigger_sorting(): skipped — app_base_url and/or ingestion_cron_secret not configured.';
    return;
  end if;

  perform net.http_post(
    url     := rtrim(v_base_url, '/') || '/api/sorting/run',
    headers := jsonb_build_object(
                 'Content-Type', 'application/json',
                 'x-ingestion-secret', v_secret
               ),
    body    := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
end;
$$;

comment on function public.trigger_sorting() is
  'Cron entry point for Stage 1 sorting: POSTs to /api/sorting/run using net.http_post(), and sorts articles still at ai_sorting_status = ''pending''.';

-- trigger_sorting() is SECURITY DEFINER because it reads a Vault secret.
-- Keep it callable only by the cron owner.
revoke all on function public.trigger_sorting() from public;
revoke all on function public.trigger_sorting() from anon, authenticated;
