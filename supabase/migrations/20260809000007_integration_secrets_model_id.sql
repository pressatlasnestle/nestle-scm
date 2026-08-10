-- ============================================================================
-- nestle-scm — integration_secrets.model_id + admin-gated model-swap path
--
-- Adds NON-secret model selection to integration_secrets, editable independently
-- of the API key. Key rotation stays exclusively in set_integration_secret();
-- this is a separate, lighter column-scoped UPDATE path for model swaps only.
--
-- Expected providers (free text, no CHECK — new providers need no migration):
--   'gemini', 'claude', 'resend', 'news_aggregator'
-- ============================================================================

alter table public.integration_secrets add column model_id text;

comment on column public.integration_secrets.model_id is
  'Non-secret model selection for the provider (e.g. claude-opus-5). Editable via a column-scoped admin UPDATE, independent of the Vault-backed key.';

-- ---------------------------------------------------------------------------
-- Rebuild the status view to expose model_id (non-secret, unlike vault_secret_id).
-- DROP + recreate to place model_id logically; re-grant SELECT afterwards.
-- ---------------------------------------------------------------------------
drop view public.integration_secrets_status;

create view public.integration_secrets_status
  with (security_invoker = on) as
  select provider, is_set, last_four, model_id, updated_by, updated_at
  from public.integration_secrets;

grant select on public.integration_secrets_status to authenticated;

-- ---------------------------------------------------------------------------
-- Column-scoped UPDATE: authenticated may only ever SET model_id. is_set,
-- last_four, vault_secret_id, updated_by, updated_at are NOT update-granted, so
-- a direct `UPDATE ... SET is_set = true` fails at the column-privilege check.
-- ---------------------------------------------------------------------------
grant update (model_id) on public.integration_secrets to authenticated;

-- RLS: only admins may run the UPDATE at all (on top of the column grant).
create policy integration_secrets_update_admin
  on public.integration_secrets for update to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- ---------------------------------------------------------------------------
-- BEFORE UPDATE: stamp updated_by/updated_at from the session — never trust the
-- client (and the client can't set them anyway; no column grant). SECURITY
-- INVOKER: only mutates NEW, needs no elevated privilege.
-- ---------------------------------------------------------------------------
create or replace function public.integration_secrets_set_updated()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_by := auth.uid();
  new.updated_at := now();
  return new;
end;
$$;

create trigger integration_secrets_set_updated_biu
  before update on public.integration_secrets
  for each row execute function public.integration_secrets_set_updated();

-- ---------------------------------------------------------------------------
-- AFTER UPDATE: audit a model change. SECURITY DEFINER so the audit row is
-- always written regardless of caller's audit_log RLS; EXECUTE revoked so it is
-- not exposed as an RPC (keeps the linter clean, per migration 3's pattern).
-- ---------------------------------------------------------------------------
create or replace function public.integration_secrets_audit_model_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.model_id is distinct from new.model_id then
    insert into public.audit_log (actor_id, action, target_type, target_id, metadata)
    values (
      auth.uid(),
      'integration_secret.model_change',
      'integration_secrets',
      new.id,
      jsonb_build_object(
        'provider',     new.provider,
        'old_model_id', old.model_id,
        'new_model_id', new.model_id
      )
    );
  end if;
  return null;  -- AFTER trigger: return value ignored
end;
$$;

revoke all on function public.integration_secrets_audit_model_change() from public, anon, authenticated;

create trigger integration_secrets_audit_model_change_aiu
  after update on public.integration_secrets
  for each row execute function public.integration_secrets_audit_model_change();
