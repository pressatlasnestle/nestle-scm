-- ============================================================================
-- nestle-scm — RLS & role helpers
--
-- Access model:
--   * The ingestion pipeline / cron / report generator run with the SERVICE ROLE
--     key, which BYPASSES RLS entirely. These policies therefore govern only the
--     dashboard + admin panel (authenticated end users).
--   * Roles come from profiles.role, gated by profiles.is_active:
--       read   = view dashboard/reports
--       curate = read + change article status (exclude/delete)
--       admin  = curate + manage users, sources, keywords, settings, recipients
--   * An inactive profile (is_active=false) resolves to NO role → no access.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Role helpers. SECURITY DEFINER so the profiles lookup bypasses RLS and does
-- not recurse when used inside profiles' own policies.
-- ---------------------------------------------------------------------------
create or replace function public.current_app_role()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select role
  from public.profiles
  where id = auth.uid()
    and is_active = true;
$$;

create or replace function public.is_app_user()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.current_app_role() is not null;
$$;

create or replace function public.can_curate()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(public.current_app_role() in ('curate', 'admin'), false);
$$;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(public.current_app_role() = 'admin', false);
$$;

-- Lock these down: they must not be callable by the anonymous/public roles as
-- a data-exfil path, only by authenticated sessions.
revoke all on function public.current_app_role() from public, anon;
revoke all on function public.is_app_user()      from public, anon;
revoke all on function public.can_curate()       from public, anon;
revoke all on function public.is_admin()         from public, anon;
grant execute on function public.current_app_role() to authenticated;
grant execute on function public.is_app_user()      to authenticated;
grant execute on function public.can_curate()       to authenticated;
grant execute on function public.is_admin()         to authenticated;

-- ---------------------------------------------------------------------------
-- Auto-provision a profile row when an auth user is created. Default role is
-- 'read'; an admin promotes to curate/admin afterwards. Bootstrapping the FIRST
-- admin is a manual one-off (see note at bottom of file).
-- ---------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, full_name, role)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'full_name', new.email),
    'read'
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- Enable RLS on every table (deny-by-default until a policy allows).
-- ---------------------------------------------------------------------------
alter table public.profiles          enable row level security;
alter table public.sources           enable row level security;
alter table public.keywords          enable row level security;
alter table public.app_settings      enable row level security;
alter table public.articles          enable row level security;
alter table public.ingestion_runs    enable row level security;
alter table public.reports           enable row level security;
alter table public.report_recipients enable row level security;
alter table public.audit_log         enable row level security;

-- ===========================================================================
-- profiles
--   read: any active app user can see the roster (needed to resolve
--         inviter / actor / status-changed-by names in the UI).
--   self: a user may update their own full_name (not their role/is_active).
--   admin: full management of the roster.
-- ===========================================================================
create policy profiles_select_app_users
  on public.profiles for select
  to authenticated
  using (public.is_app_user());

create policy profiles_update_self
  on public.profiles for update
  to authenticated
  using (id = auth.uid())
  with check (
    id = auth.uid()
    -- prevent self privilege escalation / self-reactivation
    and role = public.current_app_role()
    and is_active = true
  );

create policy profiles_admin_insert
  on public.profiles for insert
  to authenticated
  with check (public.is_admin());

create policy profiles_admin_update
  on public.profiles for update
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

create policy profiles_admin_delete
  on public.profiles for delete
  to authenticated
  using (public.is_admin());

-- ===========================================================================
-- sources / keywords / app_settings / report_recipients
--   read: all active app users (dashboard filters, universe view).
--   write: admin only.
-- ===========================================================================
-- sources
create policy sources_select_app_users
  on public.sources for select to authenticated
  using (public.is_app_user());
create policy sources_admin_write
  on public.sources for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- keywords
create policy keywords_select_app_users
  on public.keywords for select to authenticated
  using (public.is_app_user());
create policy keywords_admin_write
  on public.keywords for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- app_settings
create policy app_settings_select_app_users
  on public.app_settings for select to authenticated
  using (public.is_app_user());
create policy app_settings_admin_write
  on public.app_settings for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- report_recipients
create policy report_recipients_select_app_users
  on public.report_recipients for select to authenticated
  using (public.is_app_user());
create policy report_recipients_admin_write
  on public.report_recipients for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- ===========================================================================
-- articles
--   read: all active app users.
--   update: curate + admin (status change = exclude/delete, and body purge).
--   insert: pipeline only (service role) — no authenticated policy.
--   delete: none via the API — deletion is a soft status change, never a
--           row removal (dedup_key tombstone must persist). A true hard-delete
--           path (legal takedown) is intentionally left out; run it as a
--           deliberate service-role operation if ever needed.
-- ===========================================================================
create policy articles_select_app_users
  on public.articles for select to authenticated
  using (public.is_app_user());

create policy articles_curate_update
  on public.articles for update to authenticated
  using (public.can_curate())
  with check (public.can_curate());

-- ===========================================================================
-- ingestion_runs / reports
--   read: all active app users (Ingestion Logs panel, report history).
--   write: pipeline / cron only (service role) — no authenticated policy.
-- ===========================================================================
create policy ingestion_runs_select_app_users
  on public.ingestion_runs for select to authenticated
  using (public.is_app_user());

create policy reports_select_app_users
  on public.reports for select to authenticated
  using (public.is_app_user());

-- ===========================================================================
-- audit_log
--   read: admin only (accountability review).
--   insert: curate + admin (they generate the auditable actions; actor_id must
--           be the caller). Immutable: no update/delete policy.
-- ===========================================================================
create policy audit_log_admin_select
  on public.audit_log for select to authenticated
  using (public.is_admin());

create policy audit_log_curate_insert
  on public.audit_log for insert to authenticated
  with check (public.can_curate() and actor_id = auth.uid());

-- ---------------------------------------------------------------------------
-- BOOTSTRAP NOTE
-- The DB starts with no admins. After the first user signs up (auto-provisioned
-- as 'read'), promote them once with a service-role query, e.g.:
--     update public.profiles set role = 'admin' where email = 'you@example.com';
-- From then on that admin manages roles through the app.
-- ---------------------------------------------------------------------------
