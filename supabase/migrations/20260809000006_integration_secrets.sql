-- ============================================================================
-- nestle-scm — integration_secrets (Vault-backed API keys)  [schema-brief table 10]
--
-- Stores a pointer + metadata for each provider API key. The actual secret lives
-- in Supabase Vault (vault.secrets); this table never holds the plaintext, only
-- the vault_secret_id, an is_set flag, and last_four for display.
--
-- Access model:
--   * Writes go ONLY through public.set_integration_secret() (admin-gated,
--     SECURITY DEFINER). No direct INSERT/UPDATE/DELETE policy exists.
--   * The client-facing read surface is the integration_secrets_status VIEW,
--     which excludes vault_secret_id. vault_secret_id is never column-granted to
--     anon/authenticated, so it cannot be read through the base table either.
--   * Decryption for real use (ingestion / analysis Edge Functions) is done by
--     the SERVICE ROLE querying vault.decrypted_secrets directly — service role
--     bypasses RLS/grants, so no authenticated-facing decrypt wrapper exists.
-- ============================================================================

create table public.integration_secrets (
  id              uuid primary key default gen_random_uuid(),
  provider        text not null unique,   -- 'gemini', 'claude', 'resend', ...
  vault_secret_id uuid,                    -- FK into vault.secrets.id
  is_set          boolean not null default false,
  last_four       text,
  updated_by      uuid references public.profiles(id) on delete set null,
  updated_at      timestamptz
);

comment on table public.integration_secrets is
  'Vault-backed provider API keys. Never holds plaintext; vault_secret_id points at vault.secrets. Written only via set_integration_secret().';

-- ---------------------------------------------------------------------------
-- Table privileges: strip default grants, then expose ONLY the safe columns to
-- authenticated. vault_secret_id is deliberately never granted → invisible to
-- clients even on a direct base-table query. Service role is untouched (bypasses).
-- ---------------------------------------------------------------------------
revoke all on public.integration_secrets from anon, authenticated;
grant select (provider, is_set, last_four, updated_by, updated_at)
  on public.integration_secrets to authenticated;

-- ---------------------------------------------------------------------------
-- RLS: enable, and allow SELECT for curate + admin only. No write policies —
-- all writes are funneled through set_integration_secret().
-- ---------------------------------------------------------------------------
alter table public.integration_secrets enable row level security;

create policy integration_secrets_select_curate
  on public.integration_secrets for select to authenticated
  using (public.can_curate());

-- ---------------------------------------------------------------------------
-- Client read surface: a security_invoker view exposing safe columns only.
-- security_invoker=on so the base table's RLS (curate+admin) and column grants
-- apply to the caller — this avoids the SECURITY DEFINER view linter flag while
-- still hiding vault_secret_id.
-- ---------------------------------------------------------------------------
create view public.integration_secrets_status
  with (security_invoker = on) as
  select provider, is_set, last_four, updated_by, updated_at
  from public.integration_secrets;

grant select on public.integration_secrets_status to authenticated;

-- ---------------------------------------------------------------------------
-- set_integration_secret(provider, secret_value)
-- Admin-gated writer. Creates the Vault secret on first write, updates it on
-- subsequent writes, upserts the pointer row, and audit-logs metadata ONLY
-- (provider + last_four) — never the plaintext.
-- ---------------------------------------------------------------------------
create or replace function public.set_integration_secret(
  p_provider     text,
  p_secret_value text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_existing   public.integration_secrets%rowtype;
  v_secret_id  uuid;
  v_row_id     uuid;
  v_last_four  text;
  v_name       text := 'integration_' || p_provider;
  v_desc       text := 'nestle-scm integration key for ' || p_provider;
begin
  -- Gating lives inside the function body (grants allow authenticated to call).
  if not public.is_admin() then
    raise exception 'permission denied: admin role required to set integration secrets'
      using errcode = '42501';
  end if;

  if p_provider is null or btrim(p_provider) = '' then
    raise exception 'provider must not be empty';
  end if;
  if p_secret_value is null or btrim(p_secret_value) = '' then
    raise exception 'secret value must not be empty';
  end if;

  v_last_four := right(p_secret_value, 4);

  select * into v_existing from public.integration_secrets where provider = p_provider;

  if v_existing.id is null then
    -- first write for this provider
    v_secret_id := vault.create_secret(p_secret_value, v_name, v_desc);
    insert into public.integration_secrets
      (provider, vault_secret_id, is_set, last_four, updated_by, updated_at)
    values
      (p_provider, v_secret_id, true, v_last_four, auth.uid(), now())
    returning id into v_row_id;
  else
    -- rotate existing secret in place
    perform vault.update_secret(v_existing.vault_secret_id, p_secret_value, v_name, v_desc);
    v_secret_id := v_existing.vault_secret_id;
    v_row_id    := v_existing.id;
    update public.integration_secrets
      set is_set = true, last_four = v_last_four, updated_by = auth.uid(), updated_at = now()
      where provider = p_provider;
  end if;

  insert into public.audit_log (actor_id, action, target_type, target_id, metadata)
  values (
    auth.uid(),
    'integration_secret.update',
    'integration_secrets',
    v_row_id,
    jsonb_build_object('provider', p_provider, 'last_four', v_last_four)  -- NEVER the full value
  );
end;
$$;

-- Function enforces admin itself; expose to authenticated, deny anon/public.
revoke all on function public.set_integration_secret(text, text) from public, anon;
grant execute on function public.set_integration_secret(text, text) to authenticated;
